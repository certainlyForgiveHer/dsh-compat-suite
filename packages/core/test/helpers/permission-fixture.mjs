import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Build the permission-denied profile fixture at runtime.
 *
 * It cannot be committed: git cannot index a file inside a directory it is
 * unable to traverse, so `chmod 000` on a directory makes the fixture
 * untrackable. Creating it in a temp directory keeps the assertion real while
 * leaving the committed fixtures reproducible on a fresh clone.
 *
 * The permission denial is applied to a subdirectory holding the profile files,
 * so the directory entry still exists and can be named, but reading through it
 * raises EACCES. Denying a single file would also give EACCES, but with the
 * denial on the directory the same fixture exercises every reader at once.
 *
 * Returns null when the platform or user cannot enforce the denial (root, or a
 * filesystem without POSIX permissions), so the caller can skip instead of
 * reporting a false pass.
 */
export function createPermissionDeniedProfile() {
  if (process.platform === 'win32') return null;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return null;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-perm-'));
  const profile = path.join(root, 'profile');
  const locked = path.join(profile, 'locked');
  fs.mkdirSync(locked, { recursive: true });

  fs.writeFileSync(
    path.join(locked, 'package.json'),
    JSON.stringify(
      { name: 'dsh-profile-permissions', private: true, dependencies: { 'locked-plugin': '1.0.0' } },
      null,
      2,
    ) + '\n',
  );

  fs.writeFileSync(
    path.join(locked, 'pnpm-lock.yaml'),
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

  fs.chmodSync(locked, 0o000);

  // Verify the denial actually holds before handing the fixture to a test.
  let denied = false;
  try {
    fs.readFileSync(path.join(locked, 'pnpm-lock.yaml'), 'utf8');
  } catch (error) {
    denied = error.code === 'EACCES' || error.code === 'EPERM';
  }
  if (!denied) {
    fs.chmodSync(locked, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
    return null;
  }

  return {
    profilePath: locked,
    cleanup() {
      try {
        fs.chmodSync(locked, 0o755);
      } catch {
        /* already restored */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
