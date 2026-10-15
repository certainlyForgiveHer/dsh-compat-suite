import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createRulesProfile,
  createHostCorpus,
  hostIdentity,
  RULES_LAYOUT,
} from './helpers/rules-profile.mjs';

const CORE_DIST = new URL('../dist/index.js', import.meta.url).href;

const {
  scanProfile,
  buildReport,
  exitCodeFor,
  parseKnownMatrix,
  loadBundledKnownMatrix,
  lookupKnownMatrix,
  readPluginManifestRules,
  evaluateRules,
  explainFinding,
  FINDING_CODE_REGISTRY,
} = await import(CORE_DIST);

/** Run the full C1 scan + C2 rule pipeline over a synthetic profile. */
function evaluate(profile, options = {}) {
  const scan = scanProfile(profile.profilePath, { layout: RULES_LAYOUT });
  const result = evaluateRules(
    { scan, host: options.host ?? hostIdentity() },
    {
      matrix: options.matrix ?? loadBundledKnownMatrix(),
      now: options.now,
      hostApiDirs: options.hostApiDirs,
      apiUsageOverrides: options.apiUsageOverrides,
      smokeCoverageByName: options.smokeCoverageByName,
    },
  );
  return { scan, result };
}

const statusesFor = (result) => Object.fromEntries(result.statusByPlugin);

// --------------------------------------------------------- manifest reading

test('readPluginManifestRules extracts dsh.engines.dsh and peer declarations', () => {
  const fixture = createRulesProfile([
    {
      name: 'plugin-full',
      version: '1.0.0',
      enginesDsh: '>=0.1.1-rc.1',
      peers: [
        { name: '@deepseek-ai/dsh-subagent', range: '>=0.1.0' },
        { name: 'react', range: '^18.0.0', optional: true },
      ],
    },
  ]);
  try {
    const rules = readPluginManifestRules([fixture.pluginDir('plugin-full')]);
    assert.equal(rules.enginesDsh, '>=0.1.1-rc.1');
    assert.equal(rules.enginesDshPresent, true);
    assert.deepEqual(rules.peers, [
      { name: '@deepseek-ai/dsh-subagent', range: '>=0.1.0', optional: false },
      { name: 'react', range: '^18.0.0', optional: true },
    ]);
    assert.equal(rules.error, null);
  } finally {
    fixture.cleanup();
  }
});

test('a non-string engines declaration is reported as an unparseable rule input', () => {
  const fixture = createRulesProfile([
    { name: 'plugin-bad', version: '1.0.0', manifestExtra: { dsh: { engines: { dsh: 42 } } } },
  ]);
  try {
    const rules = readPluginManifestRules([fixture.pluginDir('plugin-bad')]);
    assert.equal(rules.enginesDsh, null);
    assert.equal(rules.enginesDshPresent, true, 'the key exists, its value is unusable');
    assert.ok(rules.unparseableInputs.length >= 1, 'unusable declarations must be surfaced, not dropped');
  } finally {
    fixture.cleanup();
  }
});

// ------------------------------------------------------------ engine rules

test('engine range match produces declared_compatible (no smoke claim)', () => {
  const fixture = createRulesProfile([{ name: 'plugin-match', version: '1.0.0', enginesDsh: '>=0.1.1-rc.1 <0.1.2' }]);
  try {
    const { result } = evaluate(fixture);
    assert.equal(statusesFor(result)['plugin-match'], 'declared_compatible');
    const finding = result.findings.find((f) => f.subject === 'plugin-match');
    assert.equal(finding.code, 'engine-range-match');
    assert.equal(finding.status, 'declared_compatible');
    assert.equal(finding.blocking, false);
    assert.equal(finding.evidence[0].type, 'manifest');
  } finally {
    fixture.cleanup();
  }
});

test('engine range mismatch produces incompatible (0.1.1-rc.2 vs >=0.1.2-alpha.1)', () => {
  const fixture = createRulesProfile([{ name: 'plugin-ahead', version: '2.0.0', enginesDsh: '>=0.1.2-alpha.1' }]);
  try {
    const { result } = evaluate(fixture);
    assert.equal(statusesFor(result)['plugin-ahead'], 'incompatible');
    const finding = result.findings.find((f) => f.subject === 'plugin-ahead');
    assert.equal(finding.code, 'plugin-engine-mismatch');
    assert.ok(finding.observed.includes('>=0.1.2-alpha.1'));
    assert.ok(finding.observed.includes('0.1.1-rc.2'));
  } finally {
    fixture.cleanup();
  }
});

test('an unparseable engine range yields unknown, never a green or a guess', () => {
  const fixture = createRulesProfile([{ name: 'plugin-garbage', version: '1.0.0', enginesDsh: '>= 0.1.x-garbage!!' }]);
  try {
    const { result } = evaluate(fixture);
    assert.equal(statusesFor(result)['plugin-garbage'], 'unknown');
    const finding = result.findings.find((f) => f.subject === 'plugin-garbage');
    assert.equal(finding.code, 'rule-input-unparseable');
    assert.equal(finding.status, 'unknown');
  } finally {
    fixture.cleanup();
  }
});

test('missing engine, missing peers and no matrix entry yield unknown', () => {
  const fixture = createRulesProfile([{ name: 'plugin-plain', version: '1.0.0' }]);
  try {
    const { result } = evaluate(fixture);
    assert.equal(statusesFor(result)['plugin-plain'], 'unknown');
    const finding = result.findings.find((f) => f.subject === 'plugin-plain');
    assert.equal(finding.code, 'engine-declaration-missing');
    assert.equal(finding.status, 'unknown');
    assert.equal(finding.blocking, false);
  } finally {
    fixture.cleanup();
  }
});

test('rules are skipped when the host version is unresolved (identity scan_error governs)', () => {
  const fixture = createRulesProfile([{ name: 'plugin-any', version: '1.0.0', enginesDsh: '>=0.1.0' }]);
  try {
    const { result } = evaluate(fixture, { host: hostIdentity({ resolved: false, cliVersion: null }) });
    assert.deepEqual(result.findings.filter((f) => f.subject === 'plugin-any'), []);
    assert.equal(statusesFor(result)['plugin-any'], 'unknown');
  } finally {
    fixture.cleanup();
  }
});

// -------------------------------------------------------------- peer rules

test('mandatory peer mismatch produces incompatible', () => {
  const fixture = createRulesProfile([
    { name: 'plugin-peer-bad', version: '1.0.0', peers: [{ name: '@deepseek-ai/dsh-subagent', range: '>=0.2.0-rc.2' }] },
  ]);
  try {
    const { result } = evaluate(fixture);
    assert.equal(statusesFor(result)['plugin-peer-bad'], 'incompatible');
    const finding = result.findings.find((f) => f.subject === 'plugin-peer-bad');
    assert.equal(finding.code, 'peer-mismatch-mandatory');
    assert.equal(finding.blocking, true);
    assert.ok(finding.observed.includes('@deepseek-ai/dsh-subagent'));
  } finally {
    fixture.cleanup();
  }
});

test('a satisfied mandatory peer produces no peer finding on its own', () => {
  const fixture = createRulesProfile([
    { name: 'plugin-peer-ok', version: '1.0.0', enginesDsh: '>=0.1.1-rc.1', peers: [{ name: '@deepseek-ai/dsh-subagent', range: '>=0.1.0' }] },
  ]);
  try {
    const { result } = evaluate(fixture);
    const codes = result.findings.filter((f) => f.subject === 'plugin-peer-ok').map((f) => f.code);
    assert.ok(!codes.includes('peer-mismatch-mandatory'));
    assert.ok(!codes.includes('peer-mismatch-optional'));
    assert.equal(statusesFor(result)['plugin-peer-ok'], 'declared_compatible');
  } finally {
    fixture.cleanup();
  }
});

test('an unresolvable mandatory peer yields peer-resolution-missing (unknown), not a mismatch', () => {
  const fixture = createRulesProfile([
    { name: 'plugin-peer-ghost', version: '1.0.0', peers: [{ name: '@deepseek-ai/dsh-never-installed', range: '>=1.0.0' }] },
  ]);
  try {
    const { result } = evaluate(fixture);
    assert.equal(statusesFor(result)['plugin-peer-ghost'], 'unknown');
    const finding = result.findings.find((f) => f.subject === 'plugin-peer-ghost');
    assert.equal(finding.code, 'peer-resolution-missing');
  } finally {
    fixture.cleanup();
  }
});

test('optional peer mismatch is recorded without blocking and holds the plugin at unknown', () => {
  const fixture = createRulesProfile([
    {
      name: 'plugin-opt-peer',
      version: '1.0.0',
      enginesDsh: '>=0.1.1-rc.1',
      peers: [{ name: 'react', range: '^19.0.0', optional: true }],
    },
  ]);
  try {
    const { result } = evaluate(fixture);
    const finding = result.findings.find((f) => f.subject === 'plugin-opt-peer');
    assert.equal(finding.code, 'peer-mismatch-optional');
    assert.equal(finding.status, 'unknown');
    assert.equal(finding.blocking, false, 'optional peer mismatch must not block by itself');
    assert.equal(statusesFor(result)['plugin-opt-peer'], 'unknown', 'unknown outranks green');
  } finally {
    fixture.cleanup();
  }
});

test('an unparseable mandatory peer range yields rule-input-unparseable', () => {
  const fixture = createRulesProfile([
    { name: 'plugin-peer-garbage', version: '1.0.0', peers: [{ name: '@deepseek-ai/dsh-subagent', range: 'not a range' }] },
  ]);
  try {
    const { result } = evaluate(fixture);
    const finding = result.findings.find((f) => f.subject === 'plugin-peer-garbage');
    assert.equal(finding.code, 'rule-input-unparseable');
    assert.equal(finding.status, 'unknown');
  } finally {
    fixture.cleanup();
  }
});

// --------------------------------------------------------------- API rules

test('missing host API produces incompatible and survives a broad manifest allow', () => {
  const corpus = createHostCorpus({
    '@deepseek-ai/dsh-subagent/index.d.ts': 'export interface SubagentsService {\n  registerSetup(): void;\n}',
  });
  const fixture = createRulesProfile([
    {
      name: '@nanmicoder/dsh-agent-teams',
      version: '0.1.2',
      enginesDsh: '>=0.1.1-rc.1',
      files: { 'dist/index.js': 'export function activate(ctx) { ctx.subagents.registerContinuableSetup({}); }' },
    },
  ]);
  try {
    const { result } = evaluate(fixture, { hostApiDirs: [corpus.root] });
    const finding = result.findings.find((f) => f.subject === '@nanmicoder/dsh-agent-teams');
    assert.equal(finding.code, 'missing-host-api');
    assert.equal(finding.status, 'incompatible');
    assert.equal(finding.evidence[0].type, 'host_api');
    assert.equal(statusesFor(result)['@nanmicoder/dsh-agent-teams'], 'incompatible', 'engine match must not override missing API');
  } finally {
    corpus.cleanup();
    fixture.cleanup();
  }
});

test('unavailable API corpus with existing references degrades to analysis-incomplete (unknown)', () => {
  const fixture = createRulesProfile([
    { name: 'plugin-api', version: '1.0.0', enginesDsh: '>=0.1.1-rc.1', files: { 'dist/index.js': 'ctx.subagents.registerSetup();' } },
  ]);
  try {
    const { result } = evaluate(fixture, { hostApiDirs: [] });
    const finding = result.findings.find((f) => f.subject === 'plugin-api');
    assert.equal(finding.code, 'analysis-incomplete');
    assert.equal(finding.status, 'unknown');
    assert.equal(statusesFor(result)['plugin-api'], 'unknown');
  } finally {
    fixture.cleanup();
  }
});

// ------------------------------------------------------------ known matrix

test('parseKnownMatrix validates entries and rejects malformed data wholesale', () => {
  const valid = JSON.stringify({
    version: 1,
    entries: [
      {
        host: { version: '0.1.1-rc.2' },
        plugin: { name: 'plugin-a', version: '1.0.0' },
        decision: 'deny',
        verification: 'incident-static',
        reason: 'because',
        source: 'fixtures/sources.lock.json',
        verifiedAt: '2026-09-07T00:00:00Z',
      },
    ],
  });
  const parsed = parseKnownMatrix(valid);
  assert.equal(parsed.error, null);
  assert.equal(parsed.matrix.entries.length, 1);

  for (const broken of ['not json', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ host: {}, plugin: { name: 'p' }, decision: 'deny', verification: 'v', reason: 'r', source: 's', verifiedAt: '2026-09-07T00:00:00Z' }] })]) {
    const bad = parseKnownMatrix(broken);
    assert.ok(bad.error !== null, `malformed matrix must be rejected: ${broken.slice(0, 40)}`);
    assert.equal(bad.matrix, null);
  }
});

test('lookupKnownMatrix matches host and plugin sides and reports expired allows', () => {
  const matrix = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [
        {
          host: { version: '0.1.1-rc.2' },
          plugin: { name: 'plugin-a', version: '1.0.0' },
          decision: 'deny',
          verification: 'incident-static',
          reason: 'because',
          source: 's',
          verifiedAt: '2026-09-07T00:00:00Z',
        },
        {
          host: { version: '0.1.1-rc.2' },
          plugin: { name: 'plugin-b', version: '1.0.0' },
          decision: 'allow',
          verification: 'static-baseline',
          reason: 'verified baseline',
          source: 's',
          verifiedAt: '2026-01-01T00:00:00Z',
          maxAgeDays: 30,
        },
      ],
    }),
  ).matrix;

  const deny = lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'plugin-a', pluginVersions: ['1.0.0'] }, { now: new Date('2026-10-14T00:00:00Z') });
  assert.equal(deny.length, 1);
  assert.equal(deny[0].decision, 'deny');
  assert.equal(deny[0].expired, false, 'denies do not expire into green');

  const freshAllow = lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'plugin-b', pluginVersions: ['1.0.0'] }, { now: new Date('2026-01-10T00:00:00Z') });
  assert.equal(freshAllow.length, 1);
  assert.equal(freshAllow[0].expired, false);

  const staleAllow = lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'plugin-b', pluginVersions: ['1.0.0'] }, { now: new Date('2026-10-14T00:00:00Z') });
  assert.equal(staleAllow.length, 1);
  assert.equal(staleAllow[0].expired, true, 'a stale allow must be visible as expired to the caller');
});

test('a matching matrix deny overrides a matching engine range', () => {
  const fixture = createRulesProfile([{ name: 'plugin-doomed', version: '1.0.0', enginesDsh: '>=0.1.0' }]);
  const matrix = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [
        {
          host: { version: '0.1.1-rc.2' },
          plugin: { name: 'plugin-doomed', version: '1.0.0' },
          decision: 'deny',
          verification: 'incident-static',
          reason: 'known bad combination',
          source: 's',
          verifiedAt: '2026-09-07T00:00:00Z',
        },
      ],
    }),
  ).matrix;
  try {
    const { result } = evaluate(fixture, { matrix });
    const finding = result.findings.find((f) => f.subject === 'plugin-doomed');
    assert.equal(finding.code, 'known-matrix-deny');
    assert.equal(finding.status, 'incompatible');
    assert.equal(finding.evidence[0].type, 'known_matrix');
    assert.equal(statusesFor(result)['plugin-doomed'], 'incompatible', 'deny outranks manifest allow');
  } finally {
    fixture.cleanup();
  }
});

test('a matrix allow supports declared_compatible and suppresses engine-declaration-missing', () => {
  const fixture = createRulesProfile([{ name: 'plugin-blessed', version: '1.0.0' }]);
  const matrix = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [
        {
          host: { version: '0.1.1-rc.2' },
          plugin: { name: 'plugin-blessed', version: '1.0.0' },
          decision: 'allow',
          verification: 'static-baseline',
          reason: 'verified static baseline',
          source: 's',
          verifiedAt: '2026-10-01T00:00:00Z',
        },
      ],
    }),
  ).matrix;
  try {
    const { result } = evaluate(fixture, { matrix });
    const codes = result.findings.filter((f) => f.subject === 'plugin-blessed').map((f) => f.code);
    assert.ok(codes.includes('known-matrix-allow'));
    assert.ok(!codes.includes('engine-declaration-missing'), 'the matrix is the other decidable evidence');
    assert.equal(statusesFor(result)['plugin-blessed'], 'declared_compatible');
  } finally {
    fixture.cleanup();
  }
});

test('an expired matrix allow degrades to unknown instead of keeping green', () => {
  const fixture = createRulesProfile([{ name: 'plugin-stale', version: '1.0.0' }]);
  const matrix = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [
        {
          host: { version: '0.1.1-rc.2' },
          plugin: { name: 'plugin-stale', version: '1.0.0' },
          decision: 'allow',
          verification: 'static-baseline',
          reason: 'verified long ago',
          source: 's',
          verifiedAt: '2026-01-01T00:00:00Z',
          maxAgeDays: 30,
        },
      ],
    }),
  ).matrix;
  try {
    const { result } = evaluate(fixture, { matrix, now: new Date('2026-10-14T00:00:00Z') });
    assert.equal(statusesFor(result)['plugin-stale'], 'unknown', 'stale allow must not stay green');
    const finding = result.findings.find((f) => f.subject === 'plugin-stale');
    assert.equal(finding.code, 'engine-declaration-missing');
  } finally {
    fixture.cleanup();
  }
});

test('entries below the minimum doctor version are ignored', () => {
  const fixture = createRulesProfile([{ name: 'plugin-future', version: '1.0.0' }]);
  const matrix = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [
        {
          host: { version: '0.1.1-rc.2' },
          plugin: { name: 'plugin-future', version: '1.0.0' },
          decision: 'allow',
          verification: 'static-baseline',
          reason: 'verified',
          source: 's',
          verifiedAt: '2026-10-01T00:00:00Z',
          minDoctorVersion: '99.0.0',
        },
      ],
    }),
  ).matrix;
  try {
    const { result } = evaluate(fixture, { matrix });
    assert.equal(statusesFor(result)['plugin-future'], 'unknown');
  } finally {
    fixture.cleanup();
  }
});

test('a corrupted matrix file degrades rules to manifest-only judgement, never green', () => {
  const fixture = createRulesProfile([{ name: 'plugin-plain', version: '1.0.0' }]);
  try {
    const { result } = evaluate(fixture, { matrix: { version: 1, entries: [] } });
    const finding = result.findings.find((f) => f.subject === 'plugin-plain');
    assert.equal(finding.code, 'engine-declaration-missing');
    assert.equal(statusesFor(result)['plugin-plain'], 'unknown');
  } finally {
    fixture.cleanup();
  }
});

// ------------------------------------------------------------- smoke seam

test('smoke passed over positive manifest evidence produces validated_compatible', () => {
  const fixture = createRulesProfile([{ name: 'plugin-validated', version: '1.0.0', enginesDsh: '>=0.1.1-rc.1' }]);
  try {
    const { result } = evaluate(fixture, {
      smokeCoverageByName: new Map([
        ['plugin-validated', { result: 'passed', scope: ['startup'], notCovered: ['业务探针'], evidenceIds: [] }],
      ]),
    });
    const finding = result.findings.find((f) => f.subject === 'plugin-validated');
    assert.ok(finding.code === 'smoke-passed', `expected smoke-passed, got ${finding.code}`);
    assert.equal(finding.status, 'validated_compatible');
    assert.equal(finding.evidence[0].type, 'runtime');
    assert.equal(statusesFor(result)['plugin-validated'], 'validated_compatible');
  } finally {
    fixture.cleanup();
  }
});

test('smoke passed without a positive manifest declaration stays unknown', () => {
  const fixture = createRulesProfile([{ name: 'plugin-smoke-only', version: '1.0.0' }]);
  try {
    const { result } = evaluate(fixture, {
      smokeCoverageByName: new Map([
        ['plugin-smoke-only', { result: 'passed', scope: ['startup'], notCovered: ['业务探针'], evidenceIds: [] }],
      ]),
    });
    assert.equal(statusesFor(result)['plugin-smoke-only'], 'unknown', 'smoke alone cannot validate an undeclared combination');
    const codes = result.findings.filter((f) => f.subject === 'plugin-smoke-only').map((f) => f.code);
    assert.ok(!codes.includes('smoke-passed'));
  } finally {
    fixture.cleanup();
  }
});

// ------------------------------------------------- determinism and ordering

test('rule findings are byte-identical across repeated evaluations of the same input', () => {
  const fixture = createRulesProfile([
    { name: 'plugin-b', version: '1.0.0', peers: [{ name: '@deepseek-ai/dsh-subagent', range: '>=0.2.0' }] },
    { name: 'plugin-a', version: '1.0.0', enginesDsh: '>=0.1.1-rc.1' },
  ]);
  try {
    const first = JSON.stringify(evaluate(fixture).result.findings);
    const second = JSON.stringify(evaluate(fixture).result.findings);
    assert.equal(first, second, 'finding order and IDs must be stable for the same input');
  } finally {
    fixture.cleanup();
  }
});

test('every C2 finding code is registered with its frozen minimum status and evidence level', () => {
  for (const code of [
    'plugin-engine-mismatch',
    'engine-declaration-missing',
    'engine-range-match',
    'peer-mismatch-mandatory',
    'peer-mismatch-optional',
    'peer-resolution-missing',
    'rule-input-unparseable',
    'missing-host-api',
    'analysis-incomplete',
    'known-matrix-allow',
    'known-matrix-deny',
  ]) {
    const spec = FINDING_CODE_REGISTRY[code];
    assert.ok(spec, `${code} must be present in the registry`);
    assert.ok(spec.semantic.length > 0);
  }
  assert.equal(FINDING_CODE_REGISTRY['plugin-engine-mismatch'].minStatus, 'incompatible');
  assert.equal(FINDING_CODE_REGISTRY['engine-range-match'].minStatus, 'declared_compatible');
  assert.equal(FINDING_CODE_REGISTRY['known-matrix-allow'].minStatus, 'declared_compatible');
  assert.equal(FINDING_CODE_REGISTRY['known-matrix-deny'].minStatus, 'incompatible');
  assert.equal(FINDING_CODE_REGISTRY['missing-host-api'].evidenceLevel, 'host_api');
  assert.equal(FINDING_CODE_REGISTRY['rule-input-unparseable'].minStatus, 'unknown');
  assert.equal(FINDING_CODE_REGISTRY['peer-resolution-missing'].minStatus, 'unknown');
});

// ------------------------------------------------------------- explain data

test('explainFinding expands a finding with its registry row and related findings', () => {
  const fixture = createRulesProfile([
    { name: 'plugin-explain', version: '1.0.0', peers: [{ name: '@deepseek-ai/dsh-subagent', range: '>=0.2.0' }] },
    { name: 'plugin-other', version: '1.0.0' },
  ]);
  try {
    const { result } = evaluate(fixture);
    const target = result.findings.find((f) => f.code === 'peer-mismatch-mandatory');
    const explanation = explainFinding(result.findings, target.id);
    assert.ok(explanation, 'the finding must be explainable');
    assert.equal(explanation.finding.id, target.id);
    assert.equal(explanation.registry.code, 'peer-mismatch-mandatory');
    assert.equal(explanation.registry.minStatus, 'incompatible');
    assert.ok(explanation.precedenceRank >= 1 && explanation.precedenceRank <= 10);
    assert.deepEqual(
      explanation.related.map((f) => f.id),
      result.findings.filter((f) => f.subject === target.subject && f.id !== target.id).map((f) => f.id),
    );
    assert.equal(explainFinding(result.findings, 'plugin-other:nothing'), null);
  } finally {
    fixture.cleanup();
  }
});
