import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const CORE_DIST = new URL('../dist/index.js', import.meta.url).href;
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'profiles');

const { parseYaml, parseCordisPatch, reconcilePlugins, scanProfile } = await import(CORE_DIST);

/**
 * Synthetic read layout, including the profile's cordis patch layer
 * (docs/01-cli-design.md section 7.2 reads `cordis.patch.yml` for loader
 * entries and disabled state).
 */
const FIXTURE_LAYOUT = {
  manifest: 'manifest.json',
  lockfile: 'pnpm.lock',
  storeDir: 'store',
  virtualStoreDir: 'store/.virtual',
  patchFile: 'cordis.patch.yml',
};

const profilePath = (name) => path.join(FIXTURES, name);
const withLayout = (extra = {}) => ({ layout: FIXTURE_LAYOUT, ...extra });

// ------------------------------------------------------------- YAML blocks

test('yaml: a literal block scalar keeps its line breaks and clips to one', () => {
  assert.deepEqual(parseYaml('a: |\n  one\n  two\n'), { a: 'one\ntwo\n' });
});

test('yaml: a strip indicator removes the trailing break', () => {
  assert.deepEqual(parseYaml('a: |-\n  one\n  two\n'), { a: 'one\ntwo' });
});

test('yaml: a folded block scalar folds single breaks into spaces', () => {
  assert.deepEqual(parseYaml('a: >-\n  one\n  two\n'), { a: 'one two' });
});

test('yaml: a keep indicator preserves trailing blank lines and ends the scalar', () => {
  assert.deepEqual(parseYaml('a: |+\n  one\n\nb: 2\n'), { a: 'one\n\n', b: 2 });
});

test('yaml: block scalars work inside a sequence of mappings', () => {
  const parsed = parseYaml('- insert:\n    - id: r\n      name: p\n      config:\n        text: >-\n          folded value\n');
  assert.deepEqual(parsed, [{ insert: [{ id: 'r', name: 'p', config: { text: 'folded value' } }] }]);
});

test('yaml: a js tag stays an opaque scalar and is never evaluated', () => {
  assert.deepEqual(parseYaml('mode: !!js process.env.DSH_TOOLS_MODE\n'), { mode: '!!js process.env.DSH_TOOLS_MODE' });
});

test('yaml: an unterminated block scalar is still rejected', () => {
  assert.throws(() => parseYaml('a: [unterminated\n'), /unterminated flow collection/);
});

// ------------------------------------------------------- cordis patch rows

test('parseCordisPatch reads insert rows and rows addressed by id', () => {
  const rows = parseCordisPatch(`- insert:
    - id: first
      name: some-plugin
    - id: second
      name: other-plugin
      disabled: true
- id: first
  disabled: true
`);
  assert.deepEqual(rows, [
    { id: 'first', name: 'some-plugin', disabled: false },
    { id: 'second', name: 'other-plugin', disabled: true },
    { id: 'first', name: null, disabled: true },
  ]);
});

test('parseCordisPatch ignores entries that carry no loader id', () => {
  assert.deepEqual(parseCordisPatch('- insert: []\n- not-an-entry: 1\n'), []);
});

test('parseCordisPatch rejects malformed YAML rather than guessing', () => {
  assert.throws(() => parseCordisPatch('a: [unterminated\n'));
});

// -------------------------------------------------- loader state discovery

test('a bundle patch contributes the loader ids that name the plugin', () => {
  const result = reconcilePlugins(profilePath('loaders'), FIXTURE_LAYOUT);
  const bundleA = result.byName.get('bundle-a');
  assert.deepEqual(bundleA.loaderIds, ['a-row-1', 'a-row-2', 'a-shared']);
  assert.equal(bundleA.enabled, true, 'one live row keeps the plugin enabled');
});

test('the profile patch layer disables a row by id', () => {
  const result = reconcilePlugins(profilePath('loaders'), FIXTURE_LAYOUT);
  const bundleB = result.byName.get('bundle-b');
  assert.deepEqual(bundleB.loaderIds, ['b-row']);
  assert.equal(bundleB.enabled, false, 'the profile layer disabled the only row');
});

test('a plugin with no bundle patch keeps the manifest-declared fallback', () => {
  const result = reconcilePlugins(profilePath('loaders'), FIXTURE_LAYOUT);
  const plain = result.byName.get('plain-c');
  assert.deepEqual(plain.loaderIds, []);
  assert.equal(plain.enabled, true);
  assert.equal(plain.reconcileCode, null);
});

test('a missing plugin that is still enabled stays a scan error', () => {
  const plugins = scanProfile(profilePath('missing'), withLayout()).plugins;
  const broken = plugins.find((p) => p.name === 'broken-plugin');
  assert.equal(broken.reconcileCode, 'package-missing');
  assert.equal(broken.enabled, true);
  assert.equal(broken.status, 'scan_error');
});

test('a missing plugin the patch layer disabled degrades instead of failing the scan', () => {
  const plugins = scanProfile(profilePath('loaders'), withLayout()).plugins;
  const missing = plugins.find((p) => p.name === 'bundle-d');
  assert.equal(missing.reconcileCode, 'package-missing');
  assert.equal(missing.enabled, false);
  assert.equal(missing.status, 'degraded', 'docs/01 section 7.3 keys on the bundle state');
});

test('discovering loader rows never turns a scan green', () => {
  const scan = scanProfile(profilePath('loaders'), withLayout());
  for (const plugin of scan.plugins) {
    assert.notEqual(plugin.status, 'validated_compatible');
    assert.notEqual(plugin.status, 'declared_compatible');
  }
});

test('a malformed profile patch is a scan error, not a silently empty loader set', () => {
  const result = reconcilePlugins(profilePath('loaders-broken'), FIXTURE_LAYOUT);
  assert.equal(result.error?.code, 'scan-infrastructure-error');
  assert.equal(scanProfile(profilePath('loaders-broken'), withLayout()).status, 'scan_error');
});
