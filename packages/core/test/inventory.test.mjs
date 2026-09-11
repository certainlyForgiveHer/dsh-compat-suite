import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CORE_DIST = new URL('../dist/index.js', import.meta.url).href;
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'profiles');

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
  const manifest = parseProfileManifest(profilePath('mixed'));
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
  const lock = parsePnpmLock(profilePath('mixed'));
  assert.equal(lock.lockfileVersion, '9.0');
  assert.equal(lock.packages.get('alpha-plugin').version, '1.0.0');
  assert.equal(lock.packages.get('delta-plugin').version, '4.0.0');
  assert.match(lock.packages.get('alpha-plugin').integrity, /^sha512-/);
});

test('parsePnpmLock surfaces a corrupted lockfile as a scan error, not a crash', () => {
  const lock = parsePnpmLock(profilePath('broken'));
  assert.ok(lock.error, 'corrupted lock must produce an error record');
  assert.equal(lock.error.code, 'scan-infrastructure-error');
  assert.equal(lock.packages.size, 0);
});

test('parsePnpmLock surfaces an unreadable file as a permission scan error', (t) => {
  if (process.getuid?.() === 0) return t.skip('running as root; chmod 000 is not enforced');
  const lock = parsePnpmLock(profilePath('permissions'));
  assert.ok(lock.error, 'permission failure must produce an error record');
  assert.equal(lock.error.code, 'scan-infrastructure-error');
});

// ---------------------------------------------------------------- node_modules

test('parseNodeModules reads the actual installed version', () => {
  const actual = parseNodeModules(profilePath('consistent'));
  assert.equal(actual.get('alpha-plugin').versions[0], '1.0.0');
  assert.equal(actual.get('beta-plugin').versions[0], '2.1.4');
});

test('parseNodeModules reports every resolved copy when a name resolves ambiguously', () => {
  const actual = parseNodeModules(profilePath('mixed'));
  const eps = actual.get('epsilon-plugin');
  assert.ok(eps, 'epsilon-plugin must be found');
  assert.equal(eps.versions.length, 2, 'two resolved copies expected');
  assert.deepEqual([...eps.versions].sort(), ['5.0.1', '5.0.2']);
});

test('parseNodeModules marks an absent package instead of inventing a version', () => {
  const actual = parseNodeModules(profilePath('missing'));
  assert.equal(actual.get('present-plugin').versions[0], '1.0.0');
  assert.equal(actual.has('missing-plugin'), false, 'absent package must not be fabricated');
});

// ---------------------------------------------------------------- reconcile

test('reconcile reports a fully consistent three-way identity', () => {
  const result = reconcilePlugins(profilePath('consistent'));
  const alpha = result.byName.get('alpha-plugin');
  assert.equal(alpha.manifestSpecifier, '1.0.0');
  assert.equal(alpha.lockVersion, '1.0.0');
  assert.equal(alpha.actualVersion, '1.0.0');
  assert.equal(alpha.reconcileCode, null);
  assert.equal(result.pluginOrder.length, 2);
});

test('reconcile detects a manifest/lock skew', () => {
  const result = reconcilePlugins(profilePath('mixed'));
  const beta = result.byName.get('beta-plugin');
  assert.equal(beta.manifestSpecifier, '2.1.0');
  assert.equal(beta.lockVersion, '2.0.0');
  assert.equal(beta.reconcileCode, 'version-skew-manifest-lock');
});

test('reconcile detects a lock/actual skew', () => {
  const result = reconcilePlugins(profilePath('mixed'));
  const delta = result.byName.get('delta-plugin');
  assert.equal(delta.lockVersion, '4.0.0');
  assert.equal(delta.actualVersion, '4.0.2');
  assert.equal(delta.reconcileCode, 'version-skew-lock-actual');
});

test('reconcile detects a missing package directory', () => {
  const result = reconcilePlugins(profilePath('missing'));
  const missing = result.byName.get('missing-plugin');
  assert.equal(missing.lockVersion, '3.0.0');
  assert.equal(missing.actualVersion, null);
  assert.equal(missing.reconcileCode, 'package-missing');
});

test('reconcile detects ambiguous resolution', () => {
  const result = reconcilePlugins(profilePath('mixed'));
  const eps = result.byName.get('epsilon-plugin');
  assert.equal(eps.ambiguous, true);
  assert.equal(eps.reconcileCode, 'ambiguous-resolution');
});

test('reconcile propagates a corrupted lockfile as a scan error', () => {
  const result = reconcilePlugins(profilePath('broken'));
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
  const scan = scanProfile(profilePath('mixed'));
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
  const scan = scanProfile(profilePath('mixed'));
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
  const scan = scanProfile(profilePath('consistent'));
  for (const plugin of scan.plugins) {
    assert.notEqual(plugin.status, 'validated_compatible');
    assert.notEqual(plugin.status, 'declared_compatible');
    assert.equal(plugin.status, 'unknown', 'discovery alone cannot be green');
    assert.equal(plugin.smokeCoverage.result, 'not-run');
  }
  assert.equal(scan.summary.status, 'unknown');
});

test('scanProfile produces a schema-valid report for every non-missing fixture', () => {
  const fixtures = [
    ['consistent', 'unknown'],
    ['mixed', 'degraded'],
    ['broken', 'scan_error'],
  ];
  for (const [name, expectedStatus] of fixtures) {
    const report = buildReport({
      scan: scanProfile(profilePath(name)),
      host: resolveHost({ binary: '/nonexistent/dsh' }),
      run: {
        id: '00000000-0000-4000-8000-000000000000',
        startedAt: '2026-09-11T00:00:00Z',
        mode: 'scan',
        doctorVersion: '0.0.0',
      },
    });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.summary.status, expectedStatus, `${name} summary status`);
    assert.equal(report.plugins.length, scanProfile(profilePath(name)).plugins.length);
  }
});

test('scan --json is deterministic across runs apart from run metadata', async () => {
  const { runScan } = await import(new URL('../dist/scan.js', import.meta.url).href);
  const fixedRun = {
    id: '00000000-0000-4000-8000-000000000000',
    startedAt: '2026-09-11T00:00:00Z',
    mode: 'scan',
    doctorVersion: '0.0.0',
  };
  const first = runScan({ profile: profilePath('mixed'), host: { binary: '/nonexistent/dsh' }, run: fixedRun });
  const second = runScan({ profile: profilePath('mixed'), host: { binary: '/nonexistent/dsh' }, run: fixedRun });
  assert.equal(first.json, second.json, 'normalized JSON must be byte-identical');
  assert.equal(first.report.run.id, fixedRun.id);
});

test('host resolution does not depend on a running dsh host', () => {
  const host = resolveHost({ binary: '/definitely/not/a/dsh/binary' });
  assert.equal(host.resolved, false);
  assert.equal(host.cliVersion, null);
  assert.equal(host.binaryInput, '<unresolved>');
});

test('scan --json runs without a live dsh process', () => {
  const cli = new URL('../../cli/test/../../cli/dist/index.js', import.meta.url);
  const out = execFileSync(process.execPath, [cli.pathname, 'scan', '--json', '--profile', profilePath('consistent')], {
    encoding: 'utf8',
    env: { ...process.env, DSH_COMPAT_FIXED_RUN: '1' },
  });
  const report = JSON.parse(out);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.run.mode, 'scan');
  assert.ok(!out.includes('/Users/'), 'absolute user paths must be aliased');
});
