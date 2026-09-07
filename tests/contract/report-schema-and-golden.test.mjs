import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  repoRoot,
  loadJson,
  validateAgainstSchema,
  checkRedaction,
  checkGoldenReport
} from '../../scripts/verify-m0.mjs';

const SIX_STATES = [
  'validated_compatible',
  'declared_compatible',
  'degraded',
  'incompatible',
  'unknown',
  'scan_error'
];

const GOLDEN_FILES = SIX_STATES.map((state) => ({
  state,
  file: `fixtures/golden/${state.replace(/_/g, '-')}.json`
}));

const clone = (value) => structuredClone(value);

test('all six golden reports exist, validate against report schema v1, and cover each state exactly once', async () => {
  const schema = await loadJson('schemas/report-v1.schema.json');
  assert.ok(schema, 'schemas/report-v1.schema.json must exist');

  const seen = new Set();
  for (const { state, file } of GOLDEN_FILES) {
    const report = await loadJson(file);
    assert.ok(report, `${file} must exist and be valid JSON`);

    const failures = checkGoldenReport(report, schema);
    assert.deepEqual(failures, [], `${file} must pass the full golden conformance check`);

    assert.equal(report.summary.status, state, `${file} must conclude ${state}`);
    assert.ok(!seen.has(state), `state ${state} must be covered by exactly one golden report`);
    seen.add(state);
  }
  assert.equal(seen.size, 6, 'all six states must be covered');
});

test('every golden report binds traceable evidence with referential integrity and stable IDs', async () => {
  const schema = await loadJson('schemas/report-v1.schema.json');
  assert.ok(schema);

  for (const { file } of GOLDEN_FILES) {
    const report = await loadJson(file);
    assert.ok(report);

    const findingIds = new Set();
    const evidenceIds = new Set();
    for (const finding of report.findings) {
      assert.ok(!findingIds.has(finding.id), `${file}: finding id ${finding.id} must be unique`);
      findingIds.add(finding.id);
      assert.match(
        finding.id,
        /^(host|(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*):[a-z][a-z0-9]+(-[a-z0-9]+)*$/,
        `${file}: finding id must follow <subject>:<code>`
      );
      for (const evidence of finding.evidence) {
        assert.equal(
          evidence.id,
          `${finding.id}#${finding.evidence.indexOf(evidence) + 1}`,
          `${file}: evidence id must follow <findingId>#<ordinal>`
        );
        evidenceIds.add(evidence.id);
      }
    }

    for (const plugin of report.plugins) {
      for (const evidenceId of [...plugin.evidenceIds, ...plugin.smokeCoverage.evidenceIds]) {
        assert.ok(
          evidenceIds.has(evidenceId),
          `${file}: plugin ${plugin.name} references evidence ${evidenceId} that must exist in a finding`
        );
      }
    }

    const blocking = report.findings.filter((finding) => finding.blocking).length;
    const review = report.findings.filter((f) => f.severity === 'review' && !f.blocking).length;
    assert.equal(report.summary.blocking, blocking, `${file}: summary.blocking must equal blocking finding count`);
    assert.equal(report.summary.review, review, `${file}: summary.review must equal non-blocking review finding count`);
  }
});

test('all golden reports are redacted: no absolute user paths, tokens, or ANSI control sequences', async () => {
  for (const { file } of GOLDEN_FILES) {
    const report = await loadJson(file);
    assert.ok(report);
    const violations = checkRedaction(JSON.stringify(report));
    assert.deepEqual(violations, [], `${file} must contain no redaction violations`);
  }
});

test('schema capability: report v1 can express host version skew', async () => {
  const schema = await loadJson('schemas/report-v1.schema.json');
  const base = await loadJson('fixtures/golden/validated-compatible.json');
  assert.ok(schema && base);

  const report = clone(base);
  report.host.corePackages = [
    { name: '@deepseek-ai/dsh-web', version: '0.1.0-rc.9', expectedVersion: '0.1.1-rc.2' }
  ];
  const result = validateAgainstSchema(report, schema);
  assert.ok(result.valid, `host version skew must be expressible: ${result.errors.join('; ')}`);
});

test('schema capability: report v1 can express manifest/lock/actual three-way version mismatch', async () => {
  const schema = await loadJson('schemas/report-v1.schema.json');
  const base = await loadJson('fixtures/golden/validated-compatible.json');
  assert.ok(schema && base);

  const report = clone(base);
  const plugin = report.plugins[0];
  plugin.manifestSpecifier = '^0.3.0';
  plugin.lockVersion = '0.3.10';
  plugin.actualVersion = '0.3.9';
  const result = validateAgainstSchema(report, schema);
  assert.ok(result.valid, `three-way version mismatch must be expressible: ${result.errors.join('; ')}`);
});

test('schema capability: report v1 can express smoke coverage scope and what it did not cover', async () => {
  const report = await loadJson('fixtures/golden/validated-compatible.json');
  assert.ok(report);

  const coverage = report.plugins[0].smokeCoverage;
  assert.equal(coverage.result, 'passed');
  assert.ok(coverage.scope.length >= 1, 'passed smoke must list the covered scope');
  assert.ok(
    coverage.notCovered.length >= 1,
    'a passed smoke must explicitly list what was not covered (startup validation is not functional validation)'
  );
});

test('negative: validated_compatible without a passed smoke is structurally rejected by the schema', async () => {
  const schema = await loadJson('schemas/report-v1.schema.json');
  const base = await loadJson('fixtures/golden/validated-compatible.json');
  assert.ok(schema && base);

  const noSmoke = clone(base);
  noSmoke.plugins[0].smokeCoverage.result = 'not-run';
  assert.equal(
    validateAgainstSchema(noSmoke, schema).valid,
    false,
    'absence of errors must not be presentable as validated_compatible'
  );

  const emptyScope = clone(base);
  emptyScope.plugins[0].smokeCoverage.notCovered = [];
  assert.equal(
    validateAgainstSchema(emptyScope, schema).valid,
    false,
    'passed smoke without an explicit not-covered list must be rejected'
  );
});

test('negative: unknown states, extra fields, and evidence-less findings are rejected', async () => {
  const schema = await loadJson('schemas/report-v1.schema.json');
  const base = await loadJson('fixtures/golden/declared-compatible.json');
  assert.ok(schema && base);

  const badState = clone(base);
  badState.summary.status = 'mostly_compatible';
  assert.equal(validateAgainstSchema(badState, schema).valid, false, 'invented states must be rejected');

  const extraField = clone(base);
  extraField.notes = 'undocumented extension';
  assert.equal(validateAgainstSchema(extraField, schema).valid, false, 'unknown top-level fields must be rejected');

  const noEvidence = clone(base);
  noEvidence.findings[0].evidence = [];
  assert.equal(validateAgainstSchema(noEvidence, schema).valid, false, 'findings without evidence must be rejected');
});

test('negative: golden conformance check rejects planted absolute paths, tokens, and ANSI sequences', async () => {
  const planted = 'path /Users/handsometu/profiles/web token ' + 'ghp_' + 'A'.repeat(30) + ' ansi \u001b[31mred';
  const violations = checkRedaction(planted);
  assert.ok(violations.length >= 3, 'absolute user path, token, and ANSI must each be flagged');
  assert.ok(violations.some((v) => v.includes('absolute path')), 'absolute user path must be flagged');
  assert.ok(violations.some((v) => v.includes('credential')), 'token-like material must be flagged');
  assert.ok(violations.some((v) => v.includes('ANSI')), 'ANSI escape must be flagged');

  const schema = await loadJson('schemas/report-v1.schema.json');
  const base = await loadJson('fixtures/golden/declared-compatible.json');
  assert.ok(schema && base);
  const leaked = clone(base);
  leaked.findings[0].location = '/Users/handsometu/dsh-home/profiles/web/package.json';
  assert.notEqual(
    checkGoldenReport(leaked, schema).length,
    0,
    'a golden report containing an absolute user path must fail the conformance check'
  );
});
