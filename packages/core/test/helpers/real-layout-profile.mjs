import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Build a throwaway profile that uses the *real* dsh layout
 * (`package.json`, `pnpm-lock.yaml`, `node_modules/<name>/package.json`).
 *
 * Committed fixtures deliberately avoid those names, because the repository
 * boundary check forbids a second lockfile and tracked `node_modules` paths.
 * The CLI end-to-end path, however, must run against the real layout with no
 * injected options, so this builds one in a temp directory instead.
 */
export function createRealLayoutProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-profile-'));
  const pluginDir = path.join(root, 'node_modules', 'cli-fixture-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-cli-fixture',
        private: true,
        dependencies: { 'cli-fixture-plugin': '1.0.0' },
      },
      null,
      2,
    ) + '\n',
  );

  fs.writeFileSync(
    path.join(root, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      '',
      'importers:',
      '  .:',
      '    dependencies:',
      '      cli-fixture-plugin:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '',
      'packages:',
      '  cli-fixture-plugin@1.0.0:',
      '    resolution: {integrity: sha512-CCCC0000000000000000000000000000000000000000000000000000000000000==}',
      '',
      'snapshots:',
      '  cli-fixture-plugin@1.0.0: {}',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: 'cli-fixture-plugin', version: '1.0.0' }, null, 2) + '\n',
  );

  return {
    profilePath: root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
