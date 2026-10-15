import test from 'node:test';
import assert from 'node:assert/strict';

const CORE_DIST = new URL('../dist/index.js', import.meta.url).href;

const { parseKnownMatrix, lookupKnownMatrix, loadBundledKnownMatrix, entryAllowedForDoctor } = await import(CORE_DIST);

const GOOD = {
  host: { version: '0.1.1-rc.2' },
  plugin: { name: 'plugin-a', version: '1.0.0' },
  decision: 'allow',
  verification: 'static-baseline',
  reason: 'verified',
  source: 's',
  verifiedAt: '2026-09-07T00:00:00Z',
};

function broken(override, label) {
  const entry = { ...GOOD, ...override };
  return parseKnownMatrix(JSON.stringify({ version: 1, entries: [entry] })).error !== null
    ? null
    : `${label} must be rejected`;
}

test('every malformed entry shape is rejected wholesale', () => {
  const failures = [
    broken({ host: undefined }, 'missing host'),
    // A host selector with neither exact version nor range has nothing to match.
    broken({ host: {} }, 'empty host selector'),
    broken({ host: { version: '0.1' } }, 'bad host version'),
    broken({ host: { range: '>= garbage !!' } }, 'bad host range'),
    broken({ plugin: undefined }, 'missing plugin'),
    broken({ plugin: { version: '1.0.0' } }, 'missing plugin name'),
    broken({ plugin: { name: 'Bad Name!', version: '1.0.0' } }, 'bad plugin name'),
    broken({ plugin: { name: 'p' } }, 'plugin selector without version or range'),
    broken({ plugin: { name: 'p', version: '1.x' } }, 'bad plugin version'),
    broken({ plugin: { name: 'p', range: 'x-garbage!' } }, 'bad plugin range'),
    broken({ decision: 'degraded' }, 'degraded is not a v1 data decision'),
    broken({ decision: 'DENY' }, 'decision is case sensitive'),
    broken({ verification: '' }, 'empty verification'),
    broken({ reason: '' }, 'empty reason'),
    broken({ source: '' }, 'empty source'),
    broken({ verifiedAt: '' }, 'empty verifiedAt'),
    broken({ verifiedAt: 'not a date' }, 'unparseable verifiedAt'),
    broken({ artifactDigest: '' }, 'empty artifactDigest'),
    broken({ artifactDigest: 42 }, 'non-string artifactDigest'),
    broken({ maxAgeDays: 0 }, 'zero maxAgeDays'),
    broken({ maxAgeDays: 1.5 }, 'fractional maxAgeDays'),
    broken({ maxAgeDays: -3 }, 'negative maxAgeDays'),
    broken({ minDoctorVersion: 'v1' }, 'bad minDoctorVersion'),
  ].filter((failure) => failure !== null);

  assert.deepEqual(failures, [], 'every malformed entry must be rejected');
});

test('document-level malformation is rejected with a load error', () => {
  assert.ok(parseKnownMatrix('not json').error?.message.includes('valid JSON'));
  assert.ok(parseKnownMatrix('[]').error?.message.includes('root'));
  assert.ok(parseKnownMatrix('{"version":2,"entries":[]}').error?.message.includes('version'));
  assert.ok(parseKnownMatrix('{"version":1}').error?.message.includes('entries'));
});

test('a well-formed matrix parses with normalized optional fields', () => {
  const { matrix, error } = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [
        { ...GOOD, artifactDigest: 'sha512-abc', maxAgeDays: 90, minDoctorVersion: '0.0.1' },
      ],
    }),
  );
  assert.equal(error, null);
  assert.equal(matrix.entries[0].decision, 'allow');
  assert.equal(matrix.entries[0].maxAgeDays, 90);
});

test('host matching supports exact version, complementary range, and range-only entries', () => {
  const matrix = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [
        { ...GOOD, plugin: { name: 'exact', version: '1.0.0' } },
        { ...GOOD, host: { version: '0.1.1-rc.2', range: '>=0.1.1-rc.1' }, plugin: { name: 'both', version: '1.0.0' } },
        { ...GOOD, host: { range: '>=0.1.1-rc.1' }, plugin: { name: 'ranged', version: '1.0.0' } },
      ],
    }),
  ).matrix;
  const now = new Date('2026-10-14T00:00:00Z');
  for (const pluginName of ['exact', 'both', 'ranged']) {
    const match = lookupKnownMatrix(
      matrix,
      { hostVersion: '0.1.1-rc.2', pluginName, pluginVersions: ['1.0.0'] },
      { now },
    );
    assert.equal(match.length, 1, `${pluginName} must match its host view`);
  }
  assert.equal(
    lookupKnownMatrix(matrix, { hostVersion: '9.9.9', pluginName: 'exact', pluginVersions: ['1.0.0'] }, { now }).length,
    0,
  );
  assert.equal(
    lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'absent', pluginVersions: ['1.0.0'] }, { now }).length,
    0,
  );
});

test('plugin matching uses exact version inclusion or any satisfied range copy', () => {
  const matrix = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [
        { ...GOOD, plugin: { name: 'exact-plugin', version: '1.2.3' } },
        { ...GOOD, plugin: { name: 'range-plugin', range: '^2.0.0' } },
      ],
    }),
  ).matrix;
  const now = new Date('2026-10-14T00:00:00Z');
  assert.equal(
    lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'exact-plugin', pluginVersions: ['1.2.3', '9.9.9'] }, { now }).length,
    1,
    'exact match against one resolved copy',
  );
  assert.equal(
    lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'exact-plugin', pluginVersions: ['1.2.4'] }, { now }).length,
    0,
  );
  assert.equal(
    lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'range-plugin', pluginVersions: ['garbage', '2.1.0'] }, { now }).length,
    1,
    'a copy within the range matches; garbage copies never do',
  );
  assert.equal(
    lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'exact-plugin', pluginVersions: ['garbage'] }, { now }).length,
    0,
    'unparseable plugin versions match nothing instead of being coerced',
  );
});

test('a deny stays usable past its own expiry while an allow expires by identity', () => {
  const matrix = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [
        { ...GOOD, decision: 'deny', verifiedAt: '2026-01-01T00:00:00Z', maxAgeDays: 30 },
        { ...GOOD, plugin: { name: 'allowee', version: '1.0.0' }, verifiedAt: '2026-01-01T00:00:00Z', maxAgeDays: 30 },
      ],
    }),
  ).matrix;
  const post = new Date('2026-10-14T00:00:00Z');
  const deny = lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'plugin-a', pluginVersions: ['1.0.0'] }, { now: post });
  assert.equal(deny[0].expired, false, 'denies never expire into green');
  const allow = lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'allowee', pluginVersions: ['1.0.0'] }, { now: post });
  assert.equal(allow[0].expired, true);
  assert.equal(
    lookupKnownMatrix(matrix, { hostVersion: null, pluginName: 'allowee', pluginVersions: ['1.0.0'] }, { now: post }).length,
    0,
    'an unresolved host matches nothing',
  );
});


test('complementary host fallbacks: version mismatch falls back to the range view', () => {
  const matrix = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [
        // Exact version misses the running host, but the recorded range hits.
        { ...GOOD, host: { version: '9.9.9', range: '>=0.1.1-rc.1 <0.1.2' }, plugin: { name: 'fallback', version: '1.0.0' } },
        // Range-only entry that does NOT cover the host.
        { ...GOOD, host: { range: '>=9.0.0' }, plugin: { name: 'far-future', version: '1.0.0' } },
      ],
    }),
  ).matrix;
  const now = new Date('2026-10-14T00:00:00Z');
  assert.equal(
    lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'fallback', pluginVersions: ['1.0.0'] }, { now }).length,
    1,
    'a declared exact version may widen to its recorded range view',
  );
  assert.equal(
    lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'far-future', pluginVersions: ['1.0.0'] }, { now }).length,
    0,
  );
});

test('a plugin range consults every resolved copy and rejects non-matching ones', () => {
  const matrix = parseKnownMatrix(
    JSON.stringify({
      version: 1,
      entries: [{ ...GOOD, plugin: { name: 'range-only', range: '>=3.0.0' } }],
    }),
  ).matrix;
  const now = new Date('2026-10-14T00:00:00Z');
  assert.equal(
    lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'range-only', pluginVersions: ['1.0.0', '2.9.9'] }, { now }).length,
    0,
    'no copy inside the range: no match',
  );
});

test('raw matrix literals defend against unusable data at lookup time', () => {
  // Degenerate values that validation would reject cannot be constructed by
  // the loader, but the lookup itself stays total over arbitrary inputs.
  const degenerate = {
    version: 1,
    entries: [
      {
        host: { version: '0.1.1-rc.2' },
        plugin: { name: 'raw', version: '1.0.0' },
        decision: 'allow',
        ...{ verification: 'x', reason: 'y', source: 's' },
        verifiedAt: 'garbage-date',
        maxAgeDays: 1,
      },
    ],
  };
  const match = lookupKnownMatrix(
    degenerate,
    { hostVersion: '0.1.1-rc.2', pluginName: 'raw', pluginVersions: ['1.0.0'] },
  );
  assert.equal(match.length, 1, 'an unusable verifiedAt is not silently dropped');
  assert.equal(match[0].expired, true, 'an unverifiable allow cannot count as fresh');
});

test('lookup defaults to the wall clock and accepts literal matrices', () => {
  const matrix = parseKnownMatrix(JSON.stringify({ version: 1, entries: [GOOD] })).matrix;
  const fresh = lookupKnownMatrix(matrix, { hostVersion: '0.1.1-rc.2', pluginName: 'plugin-a', pluginVersions: ['1.0.0'] });
  assert.equal(fresh.length, 1, 'no injected clock falls back to now');
  const stale = lookupKnownMatrix(
    { version: 1, entries: [{ ...GOOD, maxAgeDays: 30, verifiedAt: '2020-01-01T00:00:00Z' }] },
    { hostVersion: '0.1.1-rc.2', pluginName: 'plugin-a', pluginVersions: ['1.0.0'] },
  );
  assert.equal(stale[0].expired, true, 'the wall clock applies the expiry policy');
});

test('entry filtering tolerates identity inputs beyond the loader grammar', async () => {
  const entry = {
    host: { version: '0.1.1-rc.2' },
    plugin: { name: 'plugin-a', version: '1.0.0' },
    decision: 'allow',
    verification: 'x',
    reason: 'y',
    source: 's',
    verifiedAt: '2026-09-07T00:00:00Z',
    minDoctorVersion: 'garbage-version',
  };
  // entryAllowedForDoctor cannot reject on an unparseable minimum version, so
  // it degrades to "not allowed" instead of crashing the scan.
    assert.equal(entryAllowedForDoctor(entry, '0.0.0'), false);
});

test('non-object entries are rejected by validation', () => {
  const bogus = parseKnownMatrix(JSON.stringify({ version: 1, entries: [42] }));
  assert.ok(bogus.error?.message.includes('must be an object'));
});

test('the bundled matrix is structurally valid and carries the frozen incident entries', () => {
  const matrix = loadBundledKnownMatrix();
  assert.equal(matrix.version, 1);
  assert.ok(matrix.entries.length >= 2);
  for (const entry of matrix.entries) {
    assert.ok(['allow', 'deny'].includes(entry.decision));
    assert.match(entry.verifiedAt, /^\d{4}-\d{2}-\d{2}/);
    assert.ok(entry.source.length > 0);
  }
});
