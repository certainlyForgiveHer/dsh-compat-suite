import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  repoRoot,
  loadJson,
  readText,
  normalizeText,
  extractStateTableRows,
  extractStateExitMap,
  extractConditionExitRows,
  checkStateExitMap
} from '../../scripts/verify-m0.mjs';

const SIX_STATES = [
  'validated_compatible',
  'declared_compatible',
  'degraded',
  'incompatible',
  'unknown',
  'scan_error'
];

// Frozen expectation: state -> [advisory exit code, strict exit code].
// Must stay consistent with docs/01-cli-design.md section 6 and docs/07-m0-contract.md.
const EXPECTED_EXIT_MAP = {
  validated_compatible: [0, 0],
  declared_compatible: [0, 0],
  degraded: [0, 2],
  unknown: [0, 2],
  incompatible: [1, 1],
  scan_error: [4, 4]
};

const EXPECTED_PRECEDENCE = '70 > 4 > 5 > 1 > 2 > 0';

test('report-v1 schema freezes exactly the six compatibility states in every status enum', async () => {
  const schema = await loadJson('schemas/report-v1.schema.json');
  assert.ok(schema, 'schemas/report-v1.schema.json must exist and be valid JSON');
  assert.match(schema.$schema, /draft-07/);

  const summaryEnum = schema.properties?.summary?.properties?.status?.enum;
  const pluginEnum = schema.properties?.plugins?.items?.properties?.status?.enum;
  const findingEnum = schema.properties?.findings?.items?.properties?.status?.enum;

  assert.deepEqual(summaryEnum, SIX_STATES, 'summary.status enum must be exactly the six states');
  assert.deepEqual(pluginEnum, SIX_STATES, 'plugin.status enum must be exactly the six states');
  assert.deepEqual(findingEnum, SIX_STATES, 'finding.status enum must be exactly the six states');
});

test('docs/07 state table documents all six states with distinct semantics and no-overlap wording', async () => {
  const doc = await readText('docs/07-m0-contract.md');
  assert.ok(doc, 'docs/07-m0-contract.md must exist');

  const rows = extractStateTableRows(doc);
  const states = rows.map((row) => row.state).sort();
  assert.deepEqual(states, [...SIX_STATES].sort(), 'state table must cover exactly the six states');
  for (const row of rows) {
    assert.ok(row.meaning.length >= 8, `state ${row.state} needs a distinct semantic description`);
  }

  const normalized = normalizeText(doc);
  assert.match(
    normalized,
    /六种状态语义互不重叠/,
    'docs/07 must state explicitly that the six state semantics do not overlap'
  );
});

test('docs/07 records the zero-false-green principle: absence of errors can never yield validated_compatible', async () => {
  const doc = await readText('docs/07-m0-contract.md');
  assert.ok(doc);
  const normalized = normalizeText(doc);
  assert.match(
    normalized,
    /没有找到错误不等于兼容/,
    'docs/07 must restate "finding no errors does not imply compatibility"'
  );
  assert.match(
    normalized,
    /不存在错误.{0,40}不能产生\s*validated_compatible/,
    'docs/07 must state that absence of errors cannot produce validated_compatible'
  );
});

test('docs/07 exit-code table covers all six states with the frozen advisory/strict mapping', async () => {
  const doc = await readText('docs/07-m0-contract.md');
  assert.ok(doc);

  const map = extractStateExitMap(doc);
  const failures = checkStateExitMap(map);
  assert.deepEqual(failures, [], 'exit-code table must match the frozen mapping');

  for (const state of SIX_STATES) {
    const codes = map.get(state);
    assert.ok(codes, `exit table must contain a row for ${state}`);
    assert.deepEqual(codes, EXPECTED_EXIT_MAP[state], `exit codes for ${state} must match docs/01 section 6`);
  }

  const conditionRows = extractConditionExitRows(doc);
  const labels = conditionRows.map((row) => row.label).join('\n');
  assert.match(labels, /输入/, 'exit table must document input/contract errors -> 3');
  assert.match(labels, /smoke/, 'exit table must document indeterminate smoke -> 5');
  assert.match(labels, /CLI 内部/, 'exit table must document CLI internal errors -> 70');
  const byLabel = (fragment) => conditionRows.find((row) => row.label.includes(fragment));
  assert.equal(byLabel('输入')?.advisory, 3);
  assert.equal(byLabel('smoke')?.advisory, 5);
  assert.equal(byLabel('CLI 内部')?.advisory, 70);
});

test('exit precedence 70 > 4 > 5 > 1 > 2 > 0 is identical in docs/07 and the design baseline docs/01', async () => {
  const doc07 = await readText('docs/07-m0-contract.md');
  const doc01 = await readText('docs/01-cli-design.md');
  assert.ok(doc07);
  assert.ok(doc01);

  assert.ok(
    doc07.includes(EXPECTED_PRECEDENCE),
    'docs/07 must document the multi-finding exit precedence verbatim'
  );
  assert.ok(
    doc01.includes(EXPECTED_PRECEDENCE),
    'docs/01 section 6 must contain the same precedence (contract cannot redefine it)'
  );
});

test('negative: exit-map checker rejects incomplete or wrong mappings', () => {
  const missingState = new Map(Object.entries(EXPECTED_EXIT_MAP));
  missingState.delete('unknown');
  assert.notEqual(checkStateExitMap(missingState).length, 0, 'a table missing a state must fail');

  const falseGreen = new Map(Object.entries(EXPECTED_EXIT_MAP));
  falseGreen.set('validated_compatible', [1, 1]);
  assert.notEqual(checkStateExitMap(falseGreen).length, 0, 'validated_compatible must never map to a blocking code');

  const wrongStrict = new Map(Object.entries(EXPECTED_EXIT_MAP));
  wrongStrict.set('incompatible', [1, 0]);
  assert.notEqual(checkStateExitMap(wrongStrict).length, 0, 'incompatible must stay blocking in strict mode');
});
