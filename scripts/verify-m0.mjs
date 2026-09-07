import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SIX_STATES = [
  'validated_compatible',
  'declared_compatible',
  'degraded',
  'incompatible',
  'unknown',
  'scan_error'
];

export const EVIDENCE_LEVELS = ['runtime', 'host_api', 'manifest', 'known_matrix', 'lock', 'heuristic'];

// Frozen advisory/strict exit-code mapping; must equal docs/07-m0-contract.md and docs/01-cli-design.md section 6.
export const FROZEN_EXIT_MAP = {
  validated_compatible: [0, 0],
  declared_compatible: [0, 0],
  degraded: [0, 2],
  unknown: [0, 2],
  incompatible: [1, 1],
  scan_error: [4, 4]
};

// Dominance order for status aggregation: any problem state dominates green states,
// unknown dominates green (zero false green), validated dominates declared (more evidence).
export const AGGREGATION_ORDER = [
  'scan_error',
  'incompatible',
  'degraded',
  'unknown',
  'validated_compatible',
  'declared_compatible'
];

const FINDING_CODE_PATTERN = /^[a-z][a-z0-9]+(-[a-z0-9]+)*$/;
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

const REDACTION_RULES = [
  {
    pattern: /(?:["'`\s(=:]|^)\/(?:Users|home|private|var|opt|root|tmp)\//i,
    label: 'absolute path (must be aliased to <dsh-home>, <profile> or <tmp>)'
  },
  { pattern: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}/, label: 'credential-like token material' },
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'credential-like key material' },
  { pattern: /-----BEGIN (?:RSA|OPENSSH|EC|DSA|PRIVATE) KEY-----/, label: 'private key material' },
  { pattern: /Bearer\s+[A-Za-z0-9._-]{16,}/, label: 'credential-like bearer material' },
  { pattern: /\u001b\[[0-9;]*[A-Za-z]/, label: 'ANSI escape sequence (must be stripped)' },
  { pattern: /[\u202A-\u202E\u2066-\u2069]/, label: 'bidirectional control character' }
];

const readRepoText = async (relativePath) => {
  try {
    return await readFile(path.join(repoRoot, relativePath), 'utf8');
  } catch {
    return null;
  }
};

export const readText = readRepoText;

export async function loadJson(relativePath) {
  const text = await readRepoText(relativePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function normalizeText(text) {
  return text.replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Minimal draft-07 JSON Schema subset validator (zero dependencies).
// Supports: $ref (local #/definitions/*), type (string or array), enum, const,
// required, properties, additionalProperties, items, minItems, minLength,
// minimum, pattern, if/then/else, oneOf, anyOf.
// ---------------------------------------------------------------------------

function resolveRef(schema, root) {
  if (schema && typeof schema === 'object' && typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const node = schema.$ref
      .slice(2)
      .split('/')
      .reduce((acc, segment) => acc[segment.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    return resolveRef(node, root);
  }
  return schema;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function typeMatches(value, type) {
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  return false;
}

function validateNode(value, rawSchema, root, at) {
  const errors = [];
  const schema = resolveRef(rawSchema, root);
  if (!schema || typeof schema !== 'object') return errors;

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((sub) => validateNode(value, sub, root, at).length === 0).length;
    if (matches !== 1) errors.push(`${at}: must match exactly one oneOf branch (matched ${matches})`);
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((sub) => validateNode(value, sub, root, at).length === 0)) {
      errors.push(`${at}: must match at least one anyOf branch`);
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${at}: expected type ${JSON.stringify(schema.type)}, got ${JSON.stringify(value)}`);
      return errors;
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(value, option))) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${at}: ${value} is below minimum ${schema.minimum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: needs at least ${schema.minItems} items, got ${value.length}`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        errors.push(...validateNode(item, schema.items, root, `${at}[${index}]`));
      });
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}: missing required property "${key}"`);
    }
    if (schema.properties !== undefined) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) errors.push(...validateNode(value[key], sub, root, `${at}.${key}`));
      }
    }
    if (schema.additionalProperties === false && schema.properties !== undefined) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${at}: unexpected property "${key}"`);
      }
    }
  }

  if (schema.if !== undefined) {
    const ifValid = validateNode(value, schema.if, root, at).length === 0;
    if (ifValid && schema.then !== undefined) {
      errors.push(...validateNode(value, schema.then, root, at));
    }
    if (!ifValid && schema.else !== undefined) {
      errors.push(...validateNode(value, schema.else, root, at));
    }
  }

  return errors;
}

export function validateAgainstSchema(instance, schema) {
  const errors = validateNode(instance, schema, schema, '$');
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Markdown contract parsing for docs/07-m0-contract.md
// ---------------------------------------------------------------------------

function parseMarkdownTableRows(doc) {
  const raw = [];
  for (const line of doc.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      // A separator row marks the row collected just before it as the table header.
      if (raw.length > 0) raw[raw.length - 1].header = true;
      continue;
    }
    raw.push({ cells, header: false });
  }
  return raw.filter((row) => !row.header).map((row) => row.cells);
}

// Extract the body of the level-2 section whose title matches titlePattern,
// so contract tables with the same leading cell (e.g. state names) cannot
// leak across sections.
function extractSectionBody(doc, titlePattern) {
  const body = [];
  let capturing = false;
  for (const line of doc.split('\n')) {
    if (/^##\s/.test(line)) {
      if (capturing) break;
      capturing = titlePattern.test(line);
      continue;
    }
    if (capturing) body.push(line);
  }
  return body.join('\n');
}

export function extractStateTableRows(doc) {
  const rows = [];
  const section = extractSectionBody(doc, /兼容状态/);
  for (const cells of parseMarkdownTableRows(section)) {
    if (SIX_STATES.includes(cells[0])) {
      rows.push({ state: cells[0], meaning: cells[1] ?? '' });
    }
  }
  return rows;
}

export function extractStateExitMap(doc) {
  const map = new Map();
  const section = extractSectionBody(doc, /退出码/);
  for (const cells of parseMarkdownTableRows(section)) {
    if (!SIX_STATES.includes(cells[0])) continue;
    const advisory = Number.parseInt(cells[1] ?? '', 10);
    const strict = Number.parseInt(cells[2] ?? '', 10);
    if (Number.isInteger(advisory) && Number.isInteger(strict)) {
      map.set(cells[0], [advisory, strict]);
    }
  }
  return map;
}

export function extractConditionExitRows(doc) {
  const rows = [];
  const section = extractSectionBody(doc, /退出码/);
  for (const cells of parseMarkdownTableRows(section)) {
    if (SIX_STATES.includes(cells[0])) continue;
    const advisory = Number.parseInt(cells[1] ?? '', 10);
    const strict = Number.parseInt(cells[2] ?? '', 10);
    if (Number.isInteger(advisory) && Number.isInteger(strict)) {
      rows.push({ label: cells[0], advisory, strict });
    }
  }
  return rows;
}

export function checkStateExitMap(map) {
  const failures = [];
  for (const state of SIX_STATES) {
    const codes = map.get(state);
    if (!codes) {
      failures.push(`exit-code table is missing state ${state}`);
      continue;
    }
    const [advisory, strict] = codes;
    const [expectedAdvisory, expectedStrict] = FROZEN_EXIT_MAP[state];
    if (advisory !== expectedAdvisory || strict !== expectedStrict) {
      failures.push(`exit codes for ${state} must be [${expectedAdvisory}, ${expectedStrict}], got [${advisory}, ${strict}]`);
    }
  }
  return failures;
}

export function extractFindingCodeRegistry(doc) {
  const rows = [];
  const section = extractSectionBody(doc, /[Ff]inding code/);
  for (const cells of parseMarkdownTableRows(section)) {
    if (cells.length >= 4 && FINDING_CODE_PATTERN.test(cells[0]) && !SIX_STATES.includes(cells[0])) {
      rows.push({ code: cells[0], semantics: cells[1] ?? '', minStatus: cells[2] ?? '', evidenceType: cells[3] ?? '' });
    }
  }
  return rows;
}

export function checkFindingCodeRegistry(rows) {
  const failures = [];
  const seen = new Set();
  for (const row of rows) {
    if (!FINDING_CODE_PATTERN.test(row.code)) failures.push(`finding code ${row.code} is not kebab-case`);
    if (seen.has(row.code)) failures.push(`finding code ${row.code} is registered twice`);
    seen.add(row.code);
    if (row.semantics.length < 6) failures.push(`finding code ${row.code} needs a semantic description`);
    if (!SIX_STATES.includes(row.minStatus)) failures.push(`finding code ${row.code} has an undefined minimum state`);
    if (!EVIDENCE_LEVELS.includes(row.evidenceType)) {
      failures.push(`finding code ${row.code} uses an undefined evidence level`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Redaction checking
// ---------------------------------------------------------------------------

export function checkRedaction(text) {
  const violations = [];
  for (const rule of REDACTION_RULES) {
    const match = text.match(rule.pattern);
    if (match) violations.push(`${rule.label}: ${JSON.stringify(match[0].slice(0, 40))}`);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Golden report conformance
// ---------------------------------------------------------------------------

const rank = (state) => AGGREGATION_ORDER.indexOf(state);

export function checkGoldenReport(report, schema) {
  const failures = [];
  const result = validateAgainstSchema(report, schema);
  failures.push(...result.errors.map((error) => `schema: ${error}`));

  const findingIds = new Set();
  const evidenceIds = new Set();
  for (const finding of report.findings ?? []) {
    if (findingIds.has(finding.id)) failures.push(`finding id ${finding.id} is not unique`);
    findingIds.add(finding.id);
    for (const [index, evidence] of (finding.evidence ?? []).entries()) {
      if (evidence.id !== `${finding.id}#${index + 1}`) {
        failures.push(`evidence id ${evidence.id} must be ${finding.id}#${index + 1}`);
      }
      evidenceIds.add(evidence.id);
    }
  }

  const pluginNames = new Set((report.plugins ?? []).map((plugin) => plugin.name));
  for (const finding of report.findings ?? []) {
    if (finding.subject !== 'host' && !pluginNames.has(finding.subject)) {
      failures.push(`finding ${finding.id} subject ${finding.subject} matches no plugin in the report`);
    }
  }

  for (const plugin of report.plugins ?? []) {
    for (const evidenceId of [...(plugin.evidenceIds ?? []), ...(plugin.smokeCoverage?.evidenceIds ?? [])]) {
      if (!evidenceIds.has(evidenceId)) failures.push(`plugin ${plugin.name} references missing evidence ${evidenceId}`);
    }
    const pluginFindings = (report.findings ?? []).filter((finding) => finding.subject === plugin.name);
    const aggregated = pluginFindings.length
      ? pluginFindings.map((finding) => finding.status).reduce((a, b) => (rank(a) <= rank(b) ? a : b))
      : 'unknown';
    if (plugin.status !== aggregated) {
      failures.push(`plugin ${plugin.name} status ${plugin.status} must equal the aggregated finding state ${aggregated}`);
    }
  }

  const hostFindings = (report.findings ?? []).filter((finding) => finding.subject === 'host');
  const candidates = [
    ...hostFindings.map((finding) => finding.status),
    ...(report.plugins ?? []).map((plugin) => plugin.status)
  ];
  const summaryStatus = candidates.length
    ? candidates.reduce((a, b) => (rank(a) <= rank(b) ? a : b))
    : 'unknown';
  if (report.summary?.status !== summaryStatus) {
    failures.push(`summary.status ${report.summary?.status} must equal the aggregated state ${summaryStatus}`);
  }

  const blocking = (report.findings ?? []).filter((finding) => finding.blocking).length;
  const review = (report.findings ?? []).filter((f) => f.severity === 'review' && !f.blocking).length;
  if (report.summary?.blocking !== blocking) failures.push(`summary.blocking must equal ${blocking}`);
  if (report.summary?.review !== review) failures.push(`summary.review must equal ${review}`);

  failures.push(...checkRedaction(JSON.stringify(report)).map((violation) => `redaction: ${violation}`));
  return failures;
}

// ---------------------------------------------------------------------------
// Incident fixture conformance
// ---------------------------------------------------------------------------

export function checkIncidentFixture(fixture, lock, registryCodes) {
  const failures = [];
  const codes = registryCodes instanceof Set ? registryCodes : new Set(registryCodes ?? []);

  if (fixture?.fixtureVersion !== 1) failures.push('fixtureVersion must be 1');
  if (!/^K[0-9]{2}$/.test(fixture?.id ?? '')) failures.push('id must match K##');
  if (!EXACT_VERSION_PATTERN.test(fixture?.host?.cliVersion ?? '')) failures.push('host.cliVersion must be an exact semver');
  if (fixture?.host?.provenance?.lockId) {
    const entry = (lock?.sources ?? []).find((source) => source.id === fixture.host.provenance.lockId);
    if (!entry) failures.push(`host provenance lockId ${fixture.host.provenance.lockId} does not exist`);
  }
  if (!PACKAGE_NAME_PATTERN.test(fixture?.plugin?.name ?? '')) failures.push('plugin.name must be a valid package name');
  if (!EXACT_VERSION_PATTERN.test(fixture?.plugin?.version ?? '')) failures.push('plugin.version must be an exact semver');

  const expected = fixture?.expected ?? {};
  if (!SIX_STATES.includes(expected.status)) failures.push('expected.status must be one of the six states');
  if (expected.status === 'validated_compatible' || expected.status === 'declared_compatible') {
    failures.push('an incident fixture must not expect a green conclusion');
  }
  if (!Array.isArray(expected.findings) || expected.findings.length === 0) {
    failures.push('expected.findings must be a non-empty array');
  } else {
    let hasDominant = false;
    for (const finding of expected.findings) {
      if (!codes.has(finding.code)) failures.push(`finding code ${finding.code} is not in the docs/07 registry`);
      if (!SIX_STATES.includes(finding.status)) failures.push(`finding ${finding.code} has an undefined status`);
      if (!Array.isArray(finding.evidenceTypes) || finding.evidenceTypes.length === 0) {
        failures.push(`finding ${finding.code} must bind at least one evidence level`);
      } else {
        for (const evidenceType of finding.evidenceTypes) {
          if (!EVIDENCE_LEVELS.includes(evidenceType)) {
            failures.push(`finding ${finding.code} uses undefined evidence level ${evidenceType}`);
          }
        }
      }
      if (finding.status === expected.status) hasDominant = true;
    }
    if (!hasDominant) failures.push('at least one expected finding must carry the expected overall status');
  }
  if (!expected.smoke?.expectation) failures.push('expected.smoke.expectation must be recorded');
  if (!Array.isArray(expected.smoke?.captures)) failures.push('expected.smoke.captures must be an array');
  if (!expected.rationale || expected.rationale.length < 20) {
    failures.push('expected.rationale must explain why other states are excluded');
  }

  const provenance = fixture?.provenance;
  if (!provenance || !['verified', 'unverified'].includes(provenance.status)) {
    failures.push('provenance.status must be verified or unverified');
  } else if (provenance.status === 'verified') {
    const entry = (lock?.sources ?? []).find((source) => source.id === provenance.lockId);
    if (!entry) {
      failures.push(`verified provenance must reference an existing lock entry (got ${provenance.lockId})`);
    } else {
      if (entry.package !== provenance.package) failures.push('provenance package must match the lock entry');
      if (entry.version !== provenance.version) failures.push('provenance version must match the lock entry');
    }
  } else {
    if (!provenance.limitation || provenance.limitation.length < 10) {
      failures.push('unverified provenance must record a limitation instead of guessing identity');
    }
    if (provenance.integrity) failures.push('unverified provenance must not carry a guessed integrity value');
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Threat model doc conformance
// ---------------------------------------------------------------------------

export function checkThreatModelDoc(doc) {
  const failures = [];
  const normalized = normalizeText(doc);

  const boundaries = [
    ['不写入任何真实 DSH profile', 'no profile writes'],
    ['不安装、升级、降级或删除插件', 'no install/upgrade/downgrade/remove'],
    ['不重启正式 dsh', 'no restart of the real host or supervisor state'],
    ['不执行任意 shell 命令', 'no arbitrary shell execution']
  ];
  for (const [phrase, label] of boundaries) {
    if (!normalized.includes(phrase)) failures.push(`missing MVP boundary commitment: ${label}`);
  }

  const threatRows = parseMarkdownTableRows(doc).filter((cells) => /^T[0-9]{2}$/.test(cells[0] ?? ''));
  if (threatRows.length < 10) failures.push(`threat catalog needs at least 10 rows, found ${threatRows.length}`);
  for (const cells of threatRows) {
    if (cells.length < 5 || cells.slice(0, 5).some((cell) => cell.length === 0)) {
      failures.push(`threat row ${cells[0]} must fill id, threat, impact, mitigation and verification`);
    }
  }
  if (!/非目标/.test(doc)) failures.push('threat model must contain a non-goals section');
  return failures;
}

// ---------------------------------------------------------------------------
// Full M0 gate
// ---------------------------------------------------------------------------

export async function collectM0Failures() {
  const failures = [];
  const fail = (message) => failures.push(message);

  const schema = await loadJson('schemas/report-v1.schema.json');
  if (!schema) {
    fail('schemas/report-v1.schema.json must exist and be valid JSON');
    return failures;
  }
  if (!String(schema.$schema ?? '').includes('draft-07')) fail('report schema must declare draft-07');
  const summaryEnum = schema.properties?.summary?.properties?.status?.enum;
  const pluginEnum = schema.properties?.plugins?.items?.properties?.status?.enum;
  const findingEnum = schema.properties?.findings?.items?.properties?.status?.enum;
  for (const [name, enumValue] of [
    ['summary.status', summaryEnum],
    ['plugin.status', pluginEnum],
    ['finding.status', findingEnum]
  ]) {
    if (JSON.stringify(enumValue) !== JSON.stringify(SIX_STATES)) {
      fail(`schema ${name} enum must be exactly the six compatibility states`);
    }
  }

  const doc07 = await readRepoText('docs/07-m0-contract.md');
  if (!doc07) {
    fail('docs/07-m0-contract.md must exist');
    return failures;
  }
  const stateRows = extractStateTableRows(doc07);
  if (stateRows.length !== 6) fail(`docs/07 state table must cover exactly six states, found ${stateRows.length}`);
  failures.push(...checkStateExitMap(extractStateExitMap(doc07)).map((f) => `docs/07: ${f}`));
  const conditionRows = extractConditionExitRows(doc07);
  for (const [fragment, code] of [['输入', 3], ['smoke', 5], ['CLI 内部', 70]]) {
    const row = conditionRows.find((candidate) => candidate.label.includes(fragment));
    if (!row || row.advisory !== code) fail(`docs/07 exit table must map ${fragment} errors to ${code}`);
  }
  if (!doc07.includes('70 > 4 > 5 > 1 > 2 > 0')) fail('docs/07 must document the exit precedence verbatim');
  const normalized07 = normalizeText(doc07);
  if (!normalized07.includes('六种状态语义互不重叠')) fail('docs/07 must state the six semantics do not overlap');
  if (!normalized07.includes('没有找到错误不等于兼容')) fail('docs/07 must restate the zero-false-green principle');
  if (!/不存在错误.{0,40}不能产生\s*validated_compatible/.test(normalized07)) {
    fail('docs/07 must state absence of errors cannot produce validated_compatible');
  }
  if (!doc07.includes(AGGREGATION_ORDER.join(' > '))) {
    fail('docs/07 must document the aggregation order verbatim');
  }
  const registryRows = extractFindingCodeRegistry(doc07);
  failures.push(...checkFindingCodeRegistry(registryRows).map((f) => `docs/07 registry: ${f}`));
  if (registryRows.length < 15) fail(`docs/07 finding-code registry needs at least 15 codes, found ${registryRows.length}`);
  const registryCodes = new Set(registryRows.map((row) => row.code));

  const doc08 = await readRepoText('docs/08-m0-threat-model.md');
  if (!doc08) {
    fail('docs/08-m0-threat-model.md must exist');
  } else {
    failures.push(...checkThreatModelDoc(doc08).map((f) => `docs/08: ${f}`));
  }

  const goldenDir = path.join(repoRoot, 'fixtures/golden');
  const expectedGoldens = new Map(
    SIX_STATES.map((state) => [state.replace(/_/g, '-'), state])
  );
  if (!existsSync(goldenDir)) {
    fail('fixtures/golden/ must exist');
  } else {
    const entries = await readdir(goldenDir);
    for (const entry of entries) {
      if (entry === 'README.md') continue;
      if (!entry.endsWith('.json')) continue;
      if (!expectedGoldens.has(entry.replace(/\.json$/, ''))) fail(`unexpected golden file: ${entry}`);
    }
    const covered = new Set();
    for (const [stem, state] of expectedGoldens) {
      const file = `fixtures/golden/${stem}.json`;
      const report = await loadJson(file);
      if (!report) {
        fail(`${file} must exist and be valid JSON`);
        continue;
      }
      failures.push(...checkGoldenReport(report, schema).map((f) => `${file}: ${f}`));
      if (report.summary?.status !== state) fail(`${file} must conclude ${state}`);
      if (covered.has(state)) fail(`state ${state} is covered by more than one golden report`);
      covered.add(state);
    }
    if (covered.size !== 6) fail(`all six states must be covered by golden reports, covered ${covered.size}`);
  }

  const lock = await loadJson('fixtures/sources.lock.json');
  if (!lock) {
    fail('fixtures/sources.lock.json must exist and be valid JSON');
  } else {
    if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources)) {
      fail('fixtures/sources.lock.json must start at schemaVersion 1 with a sources array');
    } else {
      const lockSchema = await loadJson('schemas/fixture-source-lock.schema.json');
      if (!lockSchema) {
        fail('schemas/fixture-source-lock.schema.json must exist');
      } else {
        // The "$schema" key in the lock file is an editor hint, not instance data;
        // the frozen G0 schema does not declare it, so strip it before strict validation.
        const { $schema: lockHint, ...lockInstance } = lock;
        const lockResult = validateAgainstSchema(lockInstance, lockSchema);
        failures.push(...lockResult.errors.map((error) => `fixture lock: ${error}`));
      }
    }
    if (!existsSync(path.join(repoRoot, 'fixtures/incident/README.md'))) {
      fail('fixtures/incident/README.md must explain inputs, expected findings and excluded states');
    }
    if (!existsSync(path.join(repoRoot, 'fixtures/golden/README.md'))) {
      fail('fixtures/golden/README.md must explain determinism, redaction and per-state rationale');
    }
  }

  const incidentFiles = [
    'fixtures/incident/k01-agent-teams-0.1.15.json',
    'fixtures/incident/k03-task-board-0.3.10.json',
    'fixtures/incident/k05-skill-explorer-0.3.10.json'
  ];
  const referencedLockIds = new Set();
  for (const file of incidentFiles) {
    const fixture = await loadJson(file);
    if (!fixture) {
      fail(`${file} must exist and be valid JSON`);
      continue;
    }
    failures.push(...checkIncidentFixture(fixture, lock, registryCodes).map((f) => `${file}: ${f}`));
    if (fixture.host?.provenance?.lockId) referencedLockIds.add(fixture.host.provenance.lockId);
    if (fixture.provenance?.status === 'verified' && fixture.provenance?.lockId) {
      referencedLockIds.add(fixture.provenance.lockId);
    }
  }
  for (const source of lock?.sources ?? []) {
    if (!referencedLockIds.has(source.id)) fail(`lock entry ${source.id} is not referenced by any incident fixture`);
  }

  return failures;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const failures = await collectM0Failures();
  if (failures.length > 0) {
    console.error('M0 contract verification failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('M0 contract verification passed.');
    console.log('- report schema: schemas/report-v1.schema.json (six states, evidence binding, smoke coverage)');
    console.log('- golden reports: six states, deterministic, redacted');
    console.log('- incident fixtures: K01 / K03 / K05 on dsh 0.1.1-rc.2 with verified provenance');
    console.log('- contract docs: docs/07-m0-contract.md, docs/08-m0-threat-model.md');
    console.log('- fixture lock: fixtures/sources.lock.json consistent with incident fixtures');
  }
}
