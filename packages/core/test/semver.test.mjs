import test from 'node:test';
import assert from 'node:assert/strict';

const CORE_DIST = new URL('../dist/index.js', import.meta.url).href;

const {
  parseVersion,
  isStandardVersion,
  isValidRange,
  satisfiesRange,
  compareVersions,
  maxVersion,
  sortVersions,
} = await import(CORE_DIST);

// ------------------------------------------------------------- strict parsing

test('parseVersion accepts exact release and prerelease versions', () => {
  assert.equal(parseVersion('0.1.1-rc.2')?.version, '0.1.1-rc.2');
  assert.equal(parseVersion('0.1.2-alpha.1')?.version, '0.1.2-alpha.1');
  assert.equal(parseVersion('1.0.0')?.version, '1.0.0');
});

test('parseVersion rejects non-standard strings instead of coercing them', () => {
  assert.equal(parseVersion('0.1'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('1.0.0.1'), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion('0.1.1-custom build'), null);
});

test('a v-prefix normalizes per npm tolerance instead of inventing a different identity', () => {
  assert.equal(parseVersion('v1.0.0')?.version, '1.0.0');
});

test('isStandardVersion agrees with parseVersion', () => {
  assert.equal(isStandardVersion('0.1.1-rc.2'), true);
  assert.equal(isStandardVersion('0.1.1-beta.2'), true);
  assert.equal(isStandardVersion('0.1.1-rc.2+build.1'), true, 'build metadata parses as standard semver');
  assert.equal(isStandardVersion('garbage'), false);
});

// ------------------------------------------------------------------- ordering

test('release ordering: rc.2 of 0.1.1 sorts below any 0.1.2 prerelease', () => {
  assert.equal(compareVersions('0.1.1-rc.2', '0.1.2-alpha.1'), -1);
  assert.equal(compareVersions('0.1.2-alpha.1', '0.1.1-rc.2'), 1);
  assert.equal(compareVersions('0.1.1-rc.2', '0.1.1-rc.2'), 0);
});

test('prerelease identifier ordering follows the semver spec', () => {
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-rc.1'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-2', '1.0.0-11'), -1, 'numeric identifiers compare numerically');
});

test('compareVersions returns null for unparseable input instead of guessing', () => {
  assert.equal(compareVersions('0.1.1-rc.2', 'garbage'), null);
  assert.equal(compareVersions('garbage', '0.1.1-rc.2'), null);
  assert.equal(compareVersions('garbage', 'also-garbage'), null);
});

// --------------------------------------------------------------------- ranges

test('isValidRange rejects garbage ranges', () => {
  assert.equal(isValidRange('>=0.1.2-alpha.1'), true);
  assert.equal(isValidRange('^0.1.1'), true);
  assert.equal(isValidRange('0.1.2-rc.1 || 0.1.5-rc.1'), true);
  assert.equal(isValidRange('>= 0.1.x-garbage!!'), false);
  assert.equal(isValidRange(''), false, 'empty string is not a usable range');
});

test('the frozen K gate: 0.1.1-rc.2 does not satisfy >=0.1.2-alpha.1', () => {
  assert.equal(satisfiesRange('0.1.1-rc.2', '>=0.1.2-alpha.1'), false);
});

test('prerelease versions satisfy ranges on the same release tuple', () => {
  assert.equal(satisfiesRange('0.1.2-alpha.2', '>=0.1.2-alpha.1'), true);
  assert.equal(satisfiesRange('0.1.2-rc.1', '>=0.1.2-alpha.1'), true);
  assert.equal(satisfiesRange('0.1.2', '>=0.1.2-alpha.1'), true, 'a release satisfies a prerelease comparator above it');
});

test('prerelease versions are gated on tuples that carry a prerelease comparator', () => {
  assert.equal(satisfiesRange('0.1.1-rc.2', '*'), false, 'npm-standard gating: bare * does not admit prereleases');
  assert.equal(satisfiesRange('0.1.1-rc.2', '^0.1.1'), false);
  assert.equal(satisfiesRange('0.1.1-rc.2', '>=0.0.0'), false);
  assert.equal(satisfiesRange('0.2.1-rc.1', '>=0.2.0-rc.2'), false, 'different tuple, no prerelease comparator: gated');
});

test('exact prerelease alternation ranges match enumerated prerelease versions', () => {
  const range = '0.1.2-rc.1 || 0.1.5-rc.1 || 0.1.5-rc.2';
  assert.equal(satisfiesRange('0.1.5-rc.1', range), true);
  assert.equal(satisfiesRange('0.1.5-rc.2', range), true);
  assert.equal(satisfiesRange('0.1.5-rc.3', range), false);
  assert.equal(satisfiesRange('0.1.6', range), false);
});

test('caret, tilde, hyphen and OR ranges behave per the semver spec', () => {
  assert.equal(satisfiesRange('1.2.9', '^1.2.3'), true);
  assert.equal(satisfiesRange('1.3.0', '^1.2.3'), true);
  assert.equal(satisfiesRange('2.0.0', '^1.2.3'), false);
  assert.equal(satisfiesRange('1.2.9', '~1.2.3'), true);
  assert.equal(satisfiesRange('1.3.0', '~1.2.3'), false);
  assert.equal(satisfiesRange('1.5.0', '1.2.0 - 1.8.0'), true);
  assert.equal(satisfiesRange('1.9.0', '1.2.0 - 1.8.0'), false);
  assert.equal(satisfiesRange('1.5.0', '^1.2.0 || >=2.0.0'), true);
  assert.equal(satisfiesRange('2.1.0', '^1.2.0 || >=2.0.0'), true);
});

test('satisfiesRange returns null when the range or version is undecidable', () => {
  assert.equal(satisfiesRange('0.1.1-rc.2', 'garbage'), null);
  assert.equal(satisfiesRange('garbage', '>=0.1.0'), null);
  assert.equal(satisfiesRange(null, '>=0.1.0'), null);
});

// ------------------------------------------------------------------ selection

test('maxVersion picks the highest parseable version and ignores garbage', () => {
  assert.equal(maxVersion(['0.1.1-rc.2', '0.1.2-alpha.1', 'garbage']), '0.1.2-alpha.1');
  assert.equal(maxVersion(['0.1.1-rc.2', '0.1.1']), '0.1.1', 'release outranks its prereleases');
  assert.equal(maxVersion(['garbage']), null);
  assert.equal(maxVersion([]), null);
});

test('sortVersions orders parseable versions ascending and keeps garbage stable at the end', () => {
  assert.deepEqual(sortVersions(['0.1.2-alpha.1', '0.1.1-rc.2', '0.1.1']), ['0.1.1-rc.2', '0.1.1', '0.1.2-alpha.1']);
  assert.deepEqual(sortVersions(['zzz', '1.0.0', 'aaa']), ['1.0.0', 'zzz', 'aaa'], 'unparseable entries stay in original order after parseable ones');
  assert.deepEqual(sortVersions([]), []);
});

// ------------------------------------------------------------ property checks
// Deterministic seeded generator; the oracle is the mathematical property of
// the comparison function itself (antisymmetry, transitivity, totality), not a
// second handwritten semver implementation (docs/04 section 8.1).

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRERELEASES = [null, 'rc.1', 'rc.2', 'alpha.1', 'beta.2', 'beta.10'];
const PICK = (random, list) => list[Math.floor(random() * list.length)];

function generateVersion(random) {
  const major = Math.floor(random() * 3);
  const minor = Math.floor(random() * 10);
  const patch = Math.floor(random() * 10);
  const pre = PICK(random, PRERELEASES);
  return pre === null ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch}-${pre}`;
}

test('property: comparison is antisymmetric, total on parseable input, and transitive', () => {
  const random = mulberry32(0x00c2);
  const versions = Array.from({ length: 120 }, () => generateVersion(random));

  for (const a of versions) {
    assert.ok(parseVersion(a) !== null, `generator must only emit parseable versions: ${a}`);
    for (const b of versions) {
      const ab = compareVersions(a, b);
      const ba = compareVersions(b, a);
      assert.ok(ab !== null && ba !== null, `totality on parseable input: ${a} vs ${b}`);
      assert.equal(ab, ba === 0 ? 0 : -ba, `antisymmetry: cmp(${a},${b}) = ${ab} but cmp(${b},${a}) = ${ba}`);
    }
  }

  for (const a of versions) {
    for (const b of versions) {
      const ab = compareVersions(a, b);
      if (ab >= 0) continue;
      for (const c of versions) {
        const bc = compareVersions(b, c);
        if (bc >= 0) continue;
        assert.ok(
          compareVersions(a, c) < 0,
          `transitivity: ${a} < ${b} < ${c} must imply ${a} < ${c}`,
        );
      }
    }
  }
});

test('property: equal parsed versions compare equal and satisfy their own exact range', () => {
  const random = mulberry32(0x00c3);
  for (let index = 0; index < 200; index += 1) {
    const version = generateVersion(random);
    assert.equal(compareVersions(version, version), 0);
    assert.equal(satisfiesRange(version, version), true, `exact range of ${version} must admit ${version}`);
  }
});
