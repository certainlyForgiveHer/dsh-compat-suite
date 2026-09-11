import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { createPermissionDeniedProfile } from './helpers/permission-fixture.mjs';
import { createRealLayoutProfile } from './helpers/real-layout-profile.mjs';

const CORE_DIST = new URL('../dist/index.js', import.meta.url).href;
const CLI_DIST = new URL('../../cli/dist/index.js', import.meta.url).href;
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'profiles');
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/**
 * Synthetic read layout for the fixtures.
 *
 * The fixtures deliberately do NOT use the real artifact names. The repository
 * boundary check (scripts/verify-repository.mjs) enforces exactly one lockfile
 * and forbids tracked `node_modules` paths, because those are runtime-data
 * invariants. Injecting the layout lets the same readers be exercised over
 * committed fixtures without weakening that boundary.
 */
const FIXTURE_LAYOUT = {
  manifest: 'manifest.json',
  lockfile: 'pnpm.lock',
  storeDir: 'store',
  virtualStoreDir: 'store/.virtual',
};

/**
 * Validate a report against the frozen v1 schema using the repository's own
 * M0 validator, so this suite cannot drift from the frozen contract.
 */
async function assertSchemaValid(report, label) {
  const { validateAgainstSchema } = await import(
    new URL('../../../scripts/verify-m0.mjs', import.meta.url).href
  );
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'report-v1.schema.json'), 'utf8'));
  const result = validateAgainstSchema(report, schema);
  assert.equal(result.valid, true, `${label} must satisfy report schema v1: ${JSON.stringify(result.errors)}`);
}

const {
  parseProfileManifest,
  parsePnpmLock,
  parseNodeModules,
  reconcilePlugins,
  scanProfile,
  resolveHost,
  createRedactor,
  buildReport,
  exitCodeFor,
  aggregateStatus,
} = await import(CORE_DIST);

const profilePath = (name) => path.join(FIXTURES, name);

/** Every reader call in this suite reads the synthetic fixture layout. */
const withLayout = (extra = {}) => ({ layout: FIXTURE_LAYOUT, ...extra });

// ---------------------------------------------------------------- redaction

test('redactor aliases dsh home, profile and tmp paths', () => {
  const redact = createRedactor({
    dshHome: '/Users/someone/.dsh',
    profilePath: '/Users/someone/.dsh/profiles/web',
    tmpPaths: ['/var/folders/xy/abc/T'],
  });
  assert.equal(redact('/Users/someone/.dsh/profiles/web/package.json'), '<profile>/package.json');
  assert.equal(redact('/Users/someone/.dsh/settings.yaml'), '<dsh-home>/settings.yaml');
  assert.equal(redact('/var/folders/xy/abc/T/dsh-smoke-1'), '<tmp>/dsh-smoke-1');
});

test('redactor strips secrets, ANSI sequences and bidirectional controls', () => {
  const redact = createRedactor({ dshHome: '/h', profilePath: '/h/p', tmpPaths: [] });
  const dirty = 'token=abc\u001b[31mRED\u001b[0m \u202ebidi\u202c https://x.test/?access_token=zzz';
  const clean = redact(dirty);
  assert.ok(!clean.includes('\u001b'), 'ANSI escape must be removed');
  assert.ok(!clean.includes('\u202e'), 'bidi control must be removed');
  assert.ok(!/access_token=zzz/.test(clean), 'URL token must be removed');
  assert.ok(clean.includes('<redacted>'), 'redaction marker expected');
});

// ---------------------------------------------------------------- manifest

test('parseProfileManifest reads direct dependencies', () => {
  const manifest = parseProfileManifest(profilePath('mixed'), FIXTURE_LAYOUT);
  assert.equal(manifest.name, 'dsh-profile-mixed');
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    'alpha-plugin',
    'beta-plugin',
    'delta-plugin',
    'epsilon-plugin',
  ]);
  assert.equal(manifest.dependencies['beta-plugin'], '2.1.0');
});

// ---------------------------------------------------------------- lock v9

test('parsePnpmLock reads importer resolutions and integrity', () => {
  const lock = parsePnpmLock(profilePath('mixed'), FIXTURE_LAYOUT);
  assert.equal(lock.lockfileVersion, '9.0');
  assert.equal(lock.packages.get('alpha-plugin').version, '1.0.0');
  assert.equal(lock.packages.get('delta-plugin').version, '4.0.0');
  assert.match(lock.packages.get('alpha-plugin').integrity, /^sha512-/);
});

test('parsePnpmLock surfaces a corrupted lockfile as a scan error, not a crash', () => {
  const lock = parsePnpmLock(profilePath('broken'), FIXTURE_LAYOUT);
  assert.ok(lock.error, 'corrupted lock must produce an error record');
  assert.equal(lock.error.code, 'scan-infrastructure-error');
  assert.equal(lock.packages.size, 0);
});

test('parsePnpmLock surfaces an unreadable file as a permission scan error', (t) => {
  const fixture = createPermissionDeniedProfile();
  if (fixture === null) return t.skip('cannot enforce a POSIX permission denial on this platform/user');
  t.after(() => fixture.cleanup());
  const lock = parsePnpmLock(fixture.profilePath, FIXTURE_LAYOUT);
  assert.ok(lock.error, 'permission failure must produce an error record');
  assert.equal(lock.error.code, 'scan-infrastructure-error');
});
// ---------------------------------------------------------------- node_modules

test('parseNodeModules reads the actual installed version', () => {
  const { actual, errors } = parseNodeModules(profilePath('consistent'), FIXTURE_LAYOUT);
  assert.deepEqual(errors, []);
  assert.equal(actual.get('alpha-plugin').versions[0], '1.0.0');
  assert.equal(actual.get('beta-plugin').versions[0], '2.1.4');
});

test('parseNodeModules reports every resolved copy when a name resolves ambiguously', () => {
  const { actual } = parseNodeModules(profilePath('mixed'), FIXTURE_LAYOUT);
  const eps = actual.get('epsilon-plugin');
  assert.ok(eps, 'epsilon-plugin must be found');
  assert.equal(eps.versions.length, 2, 'two resolved copies expected');
  assert.deepEqual([...eps.versions].sort(), ['5.0.1', '5.0.2']);
});

test('parseNodeModules marks an absent package instead of inventing a version', () => {
  const { actual } = parseNodeModules(profilePath('missing'), FIXTURE_LAYOUT);
  assert.equal(actual.get('present-plugin').versions[0], '1.0.0');
  assert.equal(actual.has('missing-plugin'), false, 'absent package must not be fabricated');
});

// ---------------------------------------------------------------- reconcile

test('reconcile reports a fully consistent three-way identity', () => {
  const result = reconcilePlugins(profilePath('consistent'), FIXTURE_LAYOUT);
  const alpha = result.byName.get('alpha-plugin');
  assert.equal(alpha.manifestSpecifier, '1.0.0');
  assert.equal(alpha.lockVersion, '1.0.0');
  assert.equal(alpha.actualVersion, '1.0.0');
  assert.equal(alpha.reconcileCode, null);
  assert.equal(result.pluginOrder.length, 2);
});

test('reconcile detects a manifest/lock skew', () => {
  const result = reconcilePlugins(profilePath('mixed'), FIXTURE_LAYOUT);
  const beta = result.byName.get('beta-plugin');
  assert.equal(beta.manifestSpecifier, '2.1.0');
  assert.equal(beta.lockVersion, '2.0.0');
  assert.equal(beta.reconcileCode, 'version-skew-manifest-lock');
});

test('reconcile detects a lock/actual skew', () => {
  const result = reconcilePlugins(profilePath('mixed'), FIXTURE_LAYOUT);
  const delta = result.byName.get('delta-plugin');
  assert.equal(delta.lockVersion, '4.0.0');
  assert.equal(delta.actualVersion, '4.0.2');
  assert.equal(delta.reconcileCode, 'version-skew-lock-actual');
});

test('reconcile detects a missing package directory', () => {
  const result = reconcilePlugins(profilePath('missing'), FIXTURE_LAYOUT);
  const missing = result.byName.get('missing-plugin');
  assert.equal(missing.lockVersion, '3.0.0');
  assert.equal(missing.actualVersion, null);
  assert.equal(missing.reconcileCode, 'package-missing');
});

test('reconcile detects ambiguous resolution', () => {
  const result = reconcilePlugins(profilePath('mixed'), FIXTURE_LAYOUT);
  const eps = result.byName.get('epsilon-plugin');
  assert.equal(eps.ambiguous, true);
  assert.equal(eps.reconcileCode, 'ambiguous-resolution');
});

test('reconcile propagates a corrupted lockfile as a scan error', () => {
  const result = reconcilePlugins(profilePath('broken'), FIXTURE_LAYOUT);
  assert.equal(result.error.code, 'scan-infrastructure-error');
});

// ---------------------------------------------------------------- aggregation

test('aggregation follows scan_error > incompatible > degraded > unknown > validated > declared', () => {
  assert.equal(aggregateStatus(['unknown', 'degraded']), 'degraded');
  assert.equal(aggregateStatus(['degraded', 'unknown']), 'degraded');
  assert.equal(aggregateStatus(['unknown', 'validated_compatible']), 'unknown');
  assert.equal(aggregateStatus(['declared_compatible', 'validated_compatible']), 'validated_compatible');
  assert.equal(aggregateStatus(['incompatible', 'degraded']), 'incompatible');
  assert.equal(aggregateStatus(['scan_error', 'incompatible']), 'scan_error');
  assert.equal(aggregateStatus([]), 'unknown');
});

test('advisory and strict exit codes follow the frozen table', () => {
  assert.equal(exitCodeFor('validated_compatible', 'advisory'), 0);
  assert.equal(exitCodeFor('declared_compatible', 'advisory'), 0);
  assert.equal(exitCodeFor('degraded', 'advisory'), 0);
  assert.equal(exitCodeFor('degraded', 'strict'), 2);
  assert.equal(exitCodeFor('unknown', 'advisory'), 0);
  assert.equal(exitCodeFor('unknown', 'strict'), 2);
  assert.equal(exitCodeFor('incompatible', 'advisory'), 1);
  assert.equal(exitCodeFor('incompatible', 'strict'), 1);
  assert.equal(exitCodeFor('scan_error', 'advisory'), 4);
  assert.equal(exitCodeFor('scan_error', 'strict'), 4);
});

// ---------------------------------------------------------------- end to end

test('scanProfile produces an inventory with the manifest/lock/actual triple', () => {
  const scan = scanProfile(profilePath('mixed'), withLayout());
  assert.equal(scan.profile.name, 'dsh-profile-mixed');
  assert.match(scan.profile.manifestDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(scan.profile.lockDigest, /^sha256:[0-9a-f]{64}$/);

  const alpha = scan.plugins.find((p) => p.name === 'alpha-plugin');
  assert.equal(alpha.manifestSpecifier, '1.0.0');
  assert.equal(alpha.lockVersion, '1.0.0');
  assert.equal(alpha.actualVersion, '1.0.0');
  assert.equal(alpha.enabled, true);
});

test('scanProfile yields identity findings with registry codes and evidence', () => {
  const scan = scanProfile(profilePath('mixed'), withLayout());
  const codes = scan.findings.map((f) => f.code).sort();
  assert.deepEqual(codes, [
    'ambiguous-resolution',
    'version-skew-lock-actual',
    'version-skew-manifest-lock',
  ]);
  for (const finding of scan.findings) {
    assert.ok(finding.evidence.length >= 1, `${finding.code} must carry evidence`);
    assert.equal(finding.evidence[0].type, 'lock');
    assert.equal(finding.id, `${finding.subject}:${finding.code}`);
    assert.equal(finding.evidence[0].id, `${finding.id}#1`);
  }
});

test('scanProfile never yields a green status from absence of findings', () => {
  const scan = scanProfile(profilePath('consistent'), withLayout());
  for (const plugin of scan.plugins) {
    assert.notEqual(plugin.status, 'validated_compatible');
    assert.notEqual(plugin.status, 'declared_compatible');
    assert.equal(plugin.status, 'unknown', 'discovery alone cannot be green');
    assert.equal(plugin.smokeCoverage.result, 'not-run');
  }
  assert.equal(scan.summary.status, 'unknown');
});

test('scanProfile produces a schema-valid report for every non-missing fixture', async () => {
  const fixtures = [
    ['consistent', 'unknown'],
    ['mixed', 'degraded'],
    ['broken', 'scan_error'],
  ];
  // An injected resolved identity keeps these expectations independent of
  // whatever dsh happens to be installed on the machine running the tests.
  const resolvedHost = {
    resolved: true,
    binaryInput: '/opt/homebrew/bin/dsh',
    binaryRealpath: '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    cliVersion: '0.1.1-rc.2',
    packageName: '@deepseek-ai/dsh',
    packageRoot: '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
    nodeVersion: '26.5.0',
    corePackages: [{ name: '@deepseek-ai/dsh-web', version: '0.1.1-rc.2' }],
    error: null,
  };
  for (const [name, expectedStatus] of fixtures) {
    const scan = scanProfile(profilePath(name), withLayout());
    const { report } = buildReport({
      scan,
      host: resolvedHost,
      run: {
        id: '00000000-0000-4000-8000-000000000000',
        startedAt: '2026-09-11T00:00:00Z',
        mode: 'scan',
        doctorVersion: '0.0.0',
      },
    });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.summary.status, expectedStatus, `${name} summary status`);
    assert.equal(report.plugins.length, scan.plugins.length);
    await assertSchemaValid(report, `${name} report`);
  }
});

test('a report built against the real local dsh is schema-valid', async () => {
  const host = resolveHost({ binary: process.env.DSH_COMPAT_DSH ?? 'dsh' });
  const scan = scanProfile(profilePath('consistent'), withLayout());
  const { report } = buildReport({
    scan,
    host,
    run: {
      id: '00000000-0000-4000-8000-000000000000',
      startedAt: '2026-09-11T00:00:00Z',
      mode: 'scan',
      doctorVersion: '0.0.0',
    },
  });
  // Schema validity must hold whether or not dsh could be resolved here.
  await assertSchemaValid(report, 'local-host report');
  assert.equal(report.run.mode, 'scan');
});

test('scan --json is deterministic across runs apart from run metadata', async () => {
  const { runScan } = await import(new URL('../dist/scan.js', import.meta.url).href);
  const fixedRun = {
    id: '00000000-0000-4000-8000-000000000000',
    startedAt: '2026-09-11T00:00:00Z',
    mode: 'scan',
    doctorVersion: '0.0.0',
  };
  const first = runScan({
      profile: profilePath('mixed'),
      host: { binary: '/nonexistent/dsh' },
      run: fixedRun,
      layout: FIXTURE_LAYOUT,
    });
  const second = runScan({
      profile: profilePath('mixed'),
      host: { binary: '/nonexistent/dsh' },
      run: fixedRun,
      layout: FIXTURE_LAYOUT,
    });
  assert.equal(first.json, second.json, 'normalized JSON must be byte-identical');
  assert.equal(first.report.run.id, fixedRun.id);
});

test('host resolution does not depend on a running dsh host', () => {
  const host = resolveHost({ binary: '/definitely/not/a/dsh/binary' });
  assert.equal(host.resolved, false, 'an unresolvable binary must not claim resolution');
  assert.equal(host.cliVersion, null);
  assert.equal(host.packageRoot, null);
  assert.equal(host.error.code, 'host-identity-unresolved');
  // A scan still completes and reports the unresolved host rather than throwing.
  const scan = scanProfile(profilePath('consistent'), withLayout());
  const { report } = buildReport({
    scan,
    host,
    run: {
      id: '00000000-0000-4000-8000-000000000000',
      startedAt: '2026-09-11T00:00:00Z',
      mode: 'scan',
      doctorVersion: '0.0.0',
    },
  });
  assert.equal(report.host.binaryInput, '<unresolved>');
  assert.equal(report.host.binaryRealpath, '<unresolved>');
  assert.equal(report.summary.status, 'scan_error');
});

test('scan --json runs without a live dsh process', (t) => {
  const fixture = createRealLayoutProfile();
  t.after(() => fixture.cleanup());
  const out = execFileSync(
    process.execPath,
    [new URL(CLI_DIST).pathname, 'scan', '--json', '--profile', fixture.profilePath],
    {
      encoding: 'utf8',
      env: { ...process.env, DSH_COMPAT_FIXED_RUN: '1' },
    },
  );
  const report = JSON.parse(out);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.run.mode, 'scan');
  assert.equal(report.plugins.length, 1);
  assert.equal(report.plugins[0].name, 'cli-fixture-plugin');
  // The real layout reached the end of the pipeline with no injected options.
  assert.equal(report.plugins[0].lockVersion, '1.0.0');
  assert.equal(report.plugins[0].actualVersion, '1.0.0');
  assert.ok(!out.includes('/Users/'), 'absolute user paths must be aliased');
});
