import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  repoRoot,
  loadJson,
  normalizeText,
  extractFindingCodeRegistry,
  checkFindingCodeRegistry,
  checkIncidentFixture,
  checkThreatModelDoc,
  collectM0Failures
} from '../../scripts/verify-m0.mjs';

const EVIDENCE_TYPES = ['runtime', 'host_api', 'manifest', 'known_matrix', 'lock', 'heuristic'];

const INCIDENT_FILES = [
  {
    file: 'fixtures/incident/k01-agent-teams-0.1.15.json',
    id: 'K01',
    nameFragment: 'agent-teams',
    version: '0.1.15',
    expectedCode: 'missing-host-api'
  },
  {
    file: 'fixtures/incident/k03-task-board-0.3.10.json',
    id: 'K03',
    nameFragment: 'task-board',
    version: '0.3.10',
    expectedCode: 'plugin-engine-mismatch'
  },
  {
    file: 'fixtures/incident/k05-skill-explorer-0.3.10.json',
    id: 'K05',
    nameFragment: 'skill-explorer',
    version: '0.3.10',
    expectedCode: 'plugin-engine-mismatch'
  }
];

test('incident fixtures K01/K03/K05 pin the three-plugin incident on dsh 0.1.1-rc.2', async () => {
  const registryRows = await (async () => {
    const doc = await import('node:fs/promises').then((fs) =>
      fs.readFile(`${repoRoot}/docs/07-m0-contract.md`, 'utf8')
    );
    return extractFindingCodeRegistry(doc);
  })();
  const registryCodes = new Set(registryRows.map((row) => row.code));
  assert.ok(registryCodes.size >= 15, 'docs/07 must define a real finding-code registry');

  const lock = await loadJson('fixtures/sources.lock.json');
  assert.ok(lock, 'fixtures/sources.lock.json must exist');

  for (const incident of INCIDENT_FILES) {
    const fixture = await loadJson(incident.file);
    assert.ok(fixture, `${incident.file} must exist and be valid JSON`);

    const failures = checkIncidentFixture(fixture, lock, registryCodes);
    assert.deepEqual(failures, [], `${incident.file} must pass the incident fixture check`);

    assert.equal(fixture.fixtureVersion, 1);
    assert.equal(fixture.id, incident.id);
    assert.equal(fixture.host.cliVersion, '0.1.1-rc.2', `${incident.id} must pin the incident host baseline`);
    assert.ok(fixture.plugin.name.includes(incident.nameFragment));
    assert.equal(fixture.plugin.version, incident.version);

    // K01/K03/K05 are the zero-false-green hard gates: none of them may conclude green.
    assert.equal(fixture.expected.status, 'incompatible', `${incident.id} must expect incompatible`);
    const codes = fixture.expected.findings.map((finding) => finding.code);
    assert.ok(codes.includes(incident.expectedCode), `${incident.id} must expect ${incident.expectedCode}`);
    for (const finding of fixture.expected.findings) {
      assert.ok(
        registryCodes.has(finding.code),
        `${incident.id} finding code ${finding.code} must be registered in docs/07`
      );
      for (const evidenceType of finding.evidenceTypes) {
        assert.ok(EVIDENCE_TYPES.includes(evidenceType), `evidence type ${evidenceType} must be a known level`);
      }
    }
    assert.ok(fixture.expected.rationale.length >= 20, `${incident.id} must record why other states are excluded`);
  }
});

test('K01 pins the missing host API; K03 pins the engine requirement above the host baseline', async () => {
  const k01 = await loadJson('fixtures/incident/k01-agent-teams-0.1.15.json');
  const k03 = await loadJson('fixtures/incident/k03-task-board-0.3.10.json');
  const k05 = await loadJson('fixtures/incident/k05-skill-explorer-0.3.10.json');
  assert.ok(k01 && k03 && k05);

  assert.ok(
    k01.plugin.apiUsage.includes('subagents.registerContinuableSetup'),
    'K01 must pin the missing host API subagents.registerContinuableSetup'
  );
  assert.equal(k01.expected.smoke.expectation, 'loader-failure');
  assert.deepEqual(k01.expected.smoke.captures, ['registerContinuableSetup']);

  assert.equal(k03.plugin.engines.dsh, '>=0.1.2-alpha.1', 'K03 must pin the engine requirement from the K matrix');
  assert.equal(k03.expected.smoke.expectation, 'must-not-pass');
  assert.equal(k05.expected.smoke.expectation, 'must-not-pass');
});

test('provenance is verifiable or explicitly limited: no guessed registry identity in the fixture lock', async () => {
  const lock = await loadJson('fixtures/sources.lock.json');
  assert.ok(lock);
  assert.equal(lock.schemaVersion, 1);
  assert.ok(Array.isArray(lock.sources));

  const lockIds = new Set(lock.sources.map((source) => source.id));
  const referencedIds = new Set();

  for (const incident of INCIDENT_FILES) {
    const fixture = await loadJson(incident.file);
    assert.ok(fixture);
    if (fixture.host?.provenance?.lockId) {
      referencedIds.add(fixture.host.provenance.lockId);
    }
    const provenance = fixture.provenance;
    assert.ok(provenance, `${incident.id} must carry a provenance record`);

    if (provenance.status === 'verified') {
      assert.ok(
        lockIds.has(provenance.lockId),
        `${incident.id} verified provenance must reference an existing lock entry`
      );
      const entry = lock.sources.find((source) => source.id === provenance.lockId);
      assert.equal(entry.package, provenance.package);
      assert.equal(entry.version, provenance.version);
      referencedIds.add(provenance.lockId);
    } else {
      assert.equal(provenance.status, 'unverified');
      assert.ok(
        provenance.limitation && provenance.limitation.length >= 10,
        `${incident.id} unverifiable identity must be recorded as a limitation, not guessed`
      );
      assert.ok(!provenance.integrity, 'unverified provenance must not carry a guessed integrity value');
    }
  }

  for (const entry of lock.sources) {
    assert.ok(
      referencedIds.has(entry.id),
      `lock entry ${entry.id} must be referenced by an incident fixture (no orphan provenance)`
    );
  }
});

test('docs/07 finding-code registry is well-formed and closed over the documented evidence levels', async () => {
  const { readFile } = await import('node:fs/promises');
  const doc = await readFile(`${repoRoot}/docs/07-m0-contract.md`, 'utf8');
  const rows = extractFindingCodeRegistry(doc);

  assert.deepEqual(checkFindingCodeRegistry(rows), [], 'registry rows must all be well-formed');
  for (const row of rows) {
    assert.match(row.code, /^[a-z][a-z0-9]+(-[a-z0-9]+)*$/, `code ${row.code} must be kebab-case`);
    assert.ok(
      ['validated_compatible', 'declared_compatible', 'degraded', 'incompatible', 'unknown', 'scan_error'].includes(
        row.minStatus
      ),
      `code ${row.code} must map to a defined minimum state`
    );
    assert.ok(EVIDENCE_TYPES.includes(row.evidenceType), `code ${row.code} must use a defined evidence type`);
  }
});

test('docs/08 threat model confirms the four MVP safety boundaries and a complete threat table', async () => {
  const { readFile } = await import('node:fs/promises');
  const doc = await readFile(`${repoRoot}/docs/08-m0-threat-model.md`, 'utf8');
  assert.ok(doc, 'docs/08-m0-threat-model.md must exist');

  assert.deepEqual(checkThreatModelDoc(doc), [], 'threat model doc must pass its structural check');

  const normalized = normalizeText(doc);
  assert.match(normalized, /不写入任何真实 DSH profile/, 'boundary: no profile writes');
  assert.match(normalized, /不安装、升级、降级或删除插件/, 'boundary: no install/upgrade/downgrade/remove');
  assert.match(normalized, /不重启正式 dsh/, 'boundary: no restart of the real host or supervisor state');
  assert.match(normalized, /不执行任意 shell 命令/, 'boundary: no arbitrary shell execution');
});

test('negative: incident checker rejects false-green expectations and guessed provenance', async () => {
  const registryCodes = new Set(['missing-host-api', 'plugin-engine-mismatch', 'engine-range-match', 'smoke-passed']);
  const lock = { schemaVersion: 1, sources: [] };

  const base = {
    fixtureVersion: 1,
    id: 'K01',
    host: { cliVersion: '0.1.1-rc.2' },
    plugin: {
      name: '@nanmicoder/dsh-agent-teams',
      version: '0.1.15',
      manifestSpecifier: '0.1.15',
      lockVersion: '0.1.15',
      actualVersion: '0.1.15',
      engines: { dsh: '>=0.1.0' },
      bundleLoaders: ['dsh-agent-teams'],
      apiUsage: ['subagents.registerContinuableSetup']
    },
    expected: {
      status: 'incompatible',
      findings: [{ code: 'missing-host-api', status: 'incompatible', evidenceTypes: ['host_api'] }],
      smoke: { expectation: 'loader-failure', captures: ['registerContinuableSetup'] },
      rationale: 'missing host API is a confirmed incompatibility; no declaration can override it'
    },
    provenance: { package: '@nanmicoder/dsh-agent-teams', version: '0.1.15', status: 'unverified', limitation: 'x' }
  };

  const falseGreen = structuredClone(base);
  falseGreen.expected.status = 'declared_compatible';
  assert.notEqual(
    checkIncidentFixture(falseGreen, lock, registryCodes).length,
    0,
    'K01 must never be recorded as a green expectation'
  );

  const guessed = structuredClone(base);
  guessed.provenance = {
    package: '@nanmicoder/dsh-agent-teams',
    version: '0.1.15',
    status: 'verified',
    lockId: 'does-not-exist'
  };
  assert.notEqual(
    checkIncidentFixture(guessed, lock, registryCodes).length,
    0,
    'verified provenance without a real lock entry must be rejected'
  );

  const unregistered = structuredClone(base);
  unregistered.expected.findings[0].code = 'totally-new-code';
  assert.notEqual(
    checkIncidentFixture(unregistered, lock, registryCodes).length,
    0,
    'finding codes outside the registry must be rejected'
  );
});

test('the complete M0 gate (collectM0Failures) passes on the current tree', async () => {
  const failures = await collectM0Failures();
  assert.deepEqual(failures, [], 'verify:m0 must be green: schema structure, golden conformance, fixture lock consistency');
});
