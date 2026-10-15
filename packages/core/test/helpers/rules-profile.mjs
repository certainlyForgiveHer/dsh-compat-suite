import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Synthetic profile builder for C2 rule-engine tests.
 *
 * Uses the same non-runtime artifact names as the committed C1 fixtures
 * (`manifest.json`, `pnpm.lock`, `store/`) so the repository boundary check
 * keeps forbidding real lockfiles and `node_modules` paths while the rule
 * engine exercises the real readers.
 */
export const RULES_LAYOUT = {
  manifest: 'manifest.json',
  lockfile: 'pnpm.lock',
  storeDir: 'store',
  virtualStoreDir: path.join('store', '.virtual'),
};

/**
 * Host identity fixture for rule evaluation.
 *
 * `cliVersion` is the frozen C2 baseline; core packages cover the peer
 * resolution sources the real ecosystem uses (`@deepseek-ai/*` packages
 * shipped inside the host install).
 */
export function hostIdentity(overrides = {}) {
  return {
    resolved: true,
    binaryInput: 'dsh',
    binaryRealpath: '/opt/dsh/bin/dsh',
    cliVersion: '0.1.1-rc.2',
    packageName: '@deepseek-ai/dsh',
    packageRoot: null,
    nodeVersion: '26.0.0',
    corePackages: [
      { name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' },
      { name: '@deepseek-ai/dsh-subagent', version: '0.1.1-rc.2' },
    ],
    error: null,
    ...overrides,
  };
}

/**
 * Build a throwaway profile with synthetic plugins.
 *
 * Each plugin spec: { name, version, enginesDsh?, peers?: [{name, range, optional?}],
 * peerMeta?: {...}, files?: { relativePath: content }, manifestExtra? }.
 * Plugin package manifests land in `store/`, wired through a minimal v9-style
 * lockfile so the C1 readers resolve the same identity the rules judge.
 */
export function createRulesProfile(plugins, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-rules-'));

  const dependencies = {};
  const lockPackages = [];
  for (const plugin of plugins) {
    dependencies[plugin.name] = plugin.version;
    lockPackages.push(`  ${plugin.name}@${plugin.version}:`);
    lockPackages.push(`    resolution: {integrity: sha512-${'F'.repeat(52)}}`);
    lockPackages.push('');
  }

  fs.writeFileSync(
    path.join(root, RULES_LAYOUT.manifest),
    JSON.stringify({ name: 'dsh-profile-rules-fixture', private: true, dependencies }, null, 2) + '\n',
  );

  fs.writeFileSync(
    path.join(root, RULES_LAYOUT.lockfile),
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '  .:',
      '    dependencies:',
      ...plugins.map(
        (plugin) =>
          `      ${plugin.name}:\n        specifier: ${plugin.version}\n        version: ${plugin.version}`,
      ),
      '',
      'packages:',
      ...lockPackages,
    ].join('\n'),
  );

  // Extra non-plugin packages become resolvable peers when a rule needs one.
  for (const extra of options.store ?? []) {
    const extraDir = path.join(root, RULES_LAYOUT.storeDir, ...extra.name.split('/'));
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(
      path.join(extraDir, 'package.json'),
      JSON.stringify({ name: extra.name, version: extra.version }, null, 2) + '\n',
    );
  }

  for (const plugin of plugins) {
    const pluginDir = path.join(root, RULES_LAYOUT.storeDir, ...plugin.name.split('/'));
    fs.mkdirSync(pluginDir, { recursive: true });

    const manifest = {
      name: plugin.name,
      version: plugin.version,
      ...(plugin.enginesDsh === undefined
        ? {}
        : { dsh: { ...(plugin.manifestDshExtra ?? {}), engines: { dsh: plugin.enginesDsh } } }),
      ...(plugin.peers === undefined || plugin.peers.length === 0
        ? {}
        : {
            peerDependencies: Object.fromEntries(plugin.peers.map((peer) => [peer.name, peer.range])),
            peerDependenciesMeta: Object.fromEntries(
              plugin.peers
                .filter((peer) => peer.optional === true)
                .map((peer) => [peer.name, { optional: true }]),
            ),
          }),
      ...plugin.manifestExtra,
    };
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

    for (const [relativePath, content] of Object.entries(plugin.files ?? {})) {
      const filePath = path.join(pluginDir, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
  }

  return {
    profilePath: root,
    pluginDir(name) {
      return path.join(root, RULES_LAYOUT.storeDir, ...name.split('/'));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Build a throwaway directory tree that stands in for installed host packages. */
export function createHostCorpus(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-corpus-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
