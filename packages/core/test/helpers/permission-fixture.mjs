import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Build the permission-denied profile fixture at runtime.
 *
 * It cannot be committed: git cannot index a file inside a directory it is
 * unable to traverse, so `chmod 000` on the directory makes the fixture
 * untrackable. Creating it in a temp directory keeps the assertion real while
 * leaving the committed fixtures reproducible on a fresh clone.
 *
 * The read denial is placed on the plugin directory rather than the manifest
 * itself so that the directory entry still exists and can be enumerated.
 *
 * Returns null when the platform or user cannot enforce the denial (root, or
 * a filesystem without POSIX permissions), so the caller can skip instead of
 * reporting a false pass.
 */
export function createPermissionDeniedProfile() {
  if (process.platform === 'win32') return null;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return null;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-perm-'));
  const profile = path.join(root, 'profile');
  const pluginDir = path.join(profile, 'node_modules', 'locked-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });

  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify(
      { name: 'dsh-profile-permissions', private: true, dependencies: { 'locked-plugin': '1.0.0' } },
      null,
      2,
    ) + '\n',
  );

  fs.writeFileSync(
    path.join(profile, 'pnpm-lock.yaml'),
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
      '      locked-plugin:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '',
      'packages:',
      '  locked-plugin@1.0.0:',
      '    resolution: {integrity: sha512-LLLL0000000000000000000000000000000000000000000000000000000000000==}',
      '',
      'snapshots:',
      '  locked-plugin@1.0.0: {}',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: 'locked-plugin', version: '1.0.0' }, null, 2) + '\n',
  );

  fs.chmodSync(pluginDir, 0o000);

  // Verify the denial actually holds before handing the fixture to a test.
  let denied = false;
  try {
    fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8');
  } catch (error) {
    denied = error.code === 'EACCES' || error.code === 'EPERM';
  }
  if (!denied) {
    fs.chmodSync(pluginDir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
    return null;
  }

  return {
    profilePath: profile,
    cleanup() {
      try {
        fs.chmodSync(pluginDir, 0o755);
      } catch {
        /* already restored */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
