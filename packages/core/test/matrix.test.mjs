import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createHostCorpus, hostIdentity, RULES_LAYOUT } from './helpers/rules-profile.mjs';

const CORE_DIST = new URL('../dist/index.js', import.meta.url).href;
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const RULES_FIXTURES = path.join(import.meta.dirname, 'fixtures', 'rules');

const { scanProfile, buildReport, exitCodeFor, runScan, loadBundledKnownMatrix } = await import(CORE_DIST);

/** Validate a report against the frozen v1 schema using the repository validator. */
async function assertSchemaValid(report, label) {
  const { validateAgainstSchema } = await import(
    new URL('../../../scripts/verify-m0.mjs', import.meta.url).href
  );
  const schema = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'report-v1.schema.json'), 'utf8'),
  );
  const result = validateAgainstSchema(report, schema);
  assert.equal(result.valid, true, `${label} must satisfy report schema v1: ${JSON.stringify(result.errors)}`);
}

const HOST = hostIdentity();

/** Full pipeline over a committed K fixture; host API corpus injected for K01. */
function scanK(caseName, options = {}) {
  const scan = scanProfile(path.join(RULES_FIXTURES, caseName), {
    layout: RULES_LAYOUT,
    dshHome: path.join(RULES_FIXTURES, caseName),
  });
  return buildReport({
    scan,
    host: options.host ?? HOST,
    run: {
      id: '00000000-0000-4000-8000-000000000000',
      startedAt: '2026-01-01T00:00:00Z',
      mode: 'scan',
      doctorVersion: '0.0.0',
    },
    ...(options.buildOptions ?? {}),
  });
}

const codesFor = (built, subject) =>
  built.report.findings.filter((f) => f.subject === subject).map((f) => f.code);

const statusFor = (built, subject) => {
  const plugin = built.report.plugins.find((p) => p.name === subject);
  assert.ok(plugin, `plugin ${subject} must be in the report`);
  return plugin.status;
};

// K01 — AgentTeams 0.1.15 on 0.1.1-rc.2 must never be green (hard gate).

test('K01: agent-teams 0.1.15 on 0.1.1-rc.2 is incompatible via known matrix deny and missing host API', async () => {
  const corpus = createHostCorpus({
    '@deepseek-ai/dsh-subagent/index.d.ts': fs.readFileSync(
      path.join(RULES_FIXTURES, 'host-corpus', '@deepseek-ai', 'dsh-subagent', 'index.d.ts'),
      'utf8',
    ),
  });
  try {
    const built = scanK('k01-agent-teams-0-1-15', {
      buildOptions: { rules: { hostApiDirs: [corpus.root] } },
    });
    const codes = codesFor(built, '@nanmicoder/dsh-agent-teams');
    assert.ok(codes.includes('known-matrix-deny'), `deny expected, got ${codes.join(', ')}`);
    assert.ok(codes.includes('missing-host-api'), `missing API expected, got ${codes.join(', ')}`);
    assert.ok(!codes.includes('engine-declaration-missing'), 'a matching matrix entry suppresses the declaration-missing finding');
    assert.equal(statusFor(built, '@nanmicoder/dsh-agent-teams'), 'incompatible');
    assert.equal(built.report.summary.status, 'incompatible');
    assert.equal(exitCodeFor(built.report.summary.status, 'advisory'), 1);
    assert.equal(exitCodeFor(built.report.summary.status, 'strict'), 1);
    await assertSchemaValid(built.report, 'K01');
  } finally {
    corpus.cleanup();
  }
});

test('K01 without an API corpus stays incompatible through the matrix deny (zero false green)', () => {
  const built = scanK('k01-agent-teams-0-1-15');
  const codes = codesFor(built, '@nanmicoder/dsh-agent-teams');
  assert.ok(codes.includes('known-matrix-deny'));
  assert.ok(codes.includes('analysis-incomplete'), 'references without a corpus must surface as incomplete');
  assert.equal(statusFor(built, '@nanmicoder/dsh-agent-teams'), 'incompatible');
});

// K02 — matrix-recognized baseline is declared_compatible.

test('K02: agent-teams 0.1.2 on 0.1.1-rc.2 is declared_compatible through the bundled matrix', async () => {
  const built = scanK('k02-agent-teams-0-1-2');
  const codes = codesFor(built, '@nanmicoder/dsh-agent-teams');
  assert.ok(codes.includes('known-matrix-allow'), `allow expected, got ${codes.join(', ')}`);
  assert.equal(statusFor(built, '@nanmicoder/dsh-agent-teams'), 'declared_compatible');
  assert.equal(exitCodeFor(built.report.summary.status, 'advisory'), 0);
  await assertSchemaValid(built.report, 'K02');
});

// K03/K05 — engine and mandatory peer mismatches are incompatible (hard gates).

test('K03: task-board 0.3.10 on 0.1.1-rc.2 is incompatible (engine >=0.1.2-alpha.1)', async () => {
  const built = scanK('k03-task-board-0-3-10');
  const codes = codesFor(built, '@linxin666/dsh-client-ui-task-board');
  assert.ok(codes.includes('plugin-engine-mismatch'));
  assert.equal(statusFor(built, '@linxin666/dsh-client-ui-task-board'), 'incompatible');
  assert.equal(built.report.summary.status, 'incompatible');
  assert.equal(exitCodeFor(built.report.summary.status, 'advisory'), 1);
  await assertSchemaValid(built.report, 'K03');
});

test('K05: skill-explorer 0.3.10 on 0.1.1-rc.2 is incompatible (mandatory peer >=0.2.0-rc.2)', async () => {
  const built = scanK('k05-skill-explorer-0-3-10');
  const codes = codesFor(built, '@linxin666/dsh-client-ui-skill-explorer');
  assert.ok(codes.includes('peer-mismatch-mandatory'), `peer mismatch expected, got ${codes.join(', ')}`);
  assert.equal(statusFor(built, '@linxin666/dsh-client-ui-skill-explorer'), 'incompatible');
  assert.equal(built.report.summary.status, 'incompatible');
  assert.equal(exitCodeFor(built.report.summary.status, 'advisory'), 1);
  await assertSchemaValid(built.report, 'K05');
});

// K04/K06 — manifest-level baselines are declared_compatible.

test('K04: task-board 0.2.9 on 0.1.1-rc.2 is declared_compatible (engine range match)', async () => {
  const built = scanK('k04-task-board-0-2-9');
  const codes = codesFor(built, '@linxin666/dsh-client-ui-task-board');
  assert.ok(codes.includes('engine-range-match'));
  assert.equal(statusFor(built, '@linxin666/dsh-client-ui-task-board'), 'declared_compatible');
  assert.equal(exitCodeFor(built.report.summary.status, 'advisory'), 0);
  await assertSchemaValid(built.report, 'K04');
});

test('K06: skill-explorer 0.2.9 on 0.1.1-rc.2 is declared_compatible (engine range match)', async () => {
  const built = scanK('k06-skill-explorer-0-2-9');
  const codes = codesFor(built, '@linxin666/dsh-client-ui-skill-explorer');
  assert.ok(codes.includes('engine-range-match'));
  assert.equal(statusFor(built, '@linxin666/dsh-client-ui-skill-explorer'), 'declared_compatible');
  assert.equal(exitCodeFor(built.report.summary.status, 'advisory'), 0);
  await assertSchemaValid(built.report, 'K06');
});

// Cross-cutting guarantees over the whole matrix.

test('K01/K03/K05 never produce a green state on any policy (zero false green hard gates)', () => {
  for (const [caseName, subject] of [
    ['k01-agent-teams-0-1-15', '@nanmicoder/dsh-agent-teams'],
    ['k03-task-board-0-3-10', '@linxin666/dsh-client-ui-task-board'],
    ['k05-skill-explorer-0-3-10', '@linxin666/dsh-client-ui-skill-explorer'],
  ]) {
    const built = scanK(caseName);
    assert.equal(statusFor(built, subject), 'incompatible', `${caseName} must be incompatible`);
  }
});

test('repeated scans of the same K fixtures produce byte-identical findings', () => {
  for (const caseName of [
    'k01-agent-teams-0-1-15',
    'k02-agent-teams-0-1-2',
    'k03-task-board-0-3-10',
    'k04-task-board-0-2-9',
    'k05-skill-explorer-0-3-10',
    'k06-skill-explorer-0-2-9',
  ]) {
    const first = JSON.stringify(scanK(caseName).report.findings);
    const second = JSON.stringify(scanK(caseName).report.findings);
    assert.equal(first, second, `${caseName} findings must be deterministic`);
  }
});

test('the bundled known matrix carries the frozen incident deny and baseline allow entries', () => {
  const matrix = loadBundledKnownMatrix();
  assert.equal(matrix.version, 1);
  const k01 = matrix.entries.find(
    (e) => e.plugin.name === '@nanmicoder/dsh-agent-teams' && e.plugin.version === '0.1.15',
  );
  assert.ok(k01, 'K01 deny entry must be shipped');
  assert.equal(k01.decision, 'deny');
  assert.match(k01.artifactDigest, /^sha512-/);
  const k02 = matrix.entries.find(
    (e) => e.plugin.name === '@nanmicoder/dsh-agent-teams' && e.plugin.version === '0.1.2',
  );
  assert.ok(k02, 'K02 allow entry must be shipped');
  assert.equal(k02.decision, 'allow');
});

test('runScan threads the rule engine end to end (injected host and layout)', () => {
  const profile = path.join(import.meta.dirname, 'fixtures', 'profiles', 'consistent');
  const result = runScan({
    profile,
    host: HOST,
    layout: {
      ...RULES_LAYOUT,
      // The consistent fixture has no rules-relevant declarations; the scan
      // stays green-free (unknown) exactly like the C1 baseline.
    },
    run: {
      id: '00000000-0000-4000-8000-000000000000',
      startedAt: '2026-01-01T00:00:00Z',
      mode: 'scan',
      doctorVersion: '0.0.0',
    },
    dshHome: profile,
  });
  assert.equal(typeof result.exitCode, 'number');
  const alpha = result.report.plugins.find((p) => p.name === 'alpha-plugin');
  assert.ok(alpha);
  assert.equal(alpha.status, 'unknown', 'no declarations, no matrix entry: unknown, never green');
  const finding = result.report.findings.find((f) => f.subject === 'alpha-plugin');
  assert.equal(finding.code, 'engine-declaration-missing');
});
