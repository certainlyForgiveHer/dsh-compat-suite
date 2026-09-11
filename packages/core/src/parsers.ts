/**
 * Profile readers for C1 environment discovery.
 *
 * Read scope is deliberately narrow, per docs/01-cli-design.md section 7.2:
 * the profile manifest, the lockfile, direct dependency plugin manifests and
 * the cordis patch. Nothing here recurses into plugin data directories,
 * session logs, credentials or workspace sources, and nothing writes.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseYaml, YamlParseError } from './yaml.js';
import { isExactVersion } from './version.js';
import { defaultProfileLayout } from './inventory-types.js';
import type { ActualPackage, ParseError, PnpmLock, ProfileLayout, ProfileManifest } from './inventory-types.js';

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function describeFsError(error: unknown, source: string): ParseError {
  if (isNodeError(error)) {
    const code = error.code ?? 'UNKNOWN';
    const permission = code === 'EACCES' || code === 'EPERM';
    return {
      code: 'scan-infrastructure-error',
      message: permission
        ? `cannot read ${source}: permission denied (${code})`
        : `cannot read ${source}: ${code}`,
      source,
    };
  }
  return { code: 'scan-infrastructure-error', message: `cannot read ${source}`, source };
}

/** Read and parse the profile manifest. A malformed manifest is a scan error. */
export function parseProfileManifest(
  profilePath: string,
  layout: ProfileLayout = defaultProfileLayout(),
): ProfileManifest {
  const source = path.join(profilePath, layout.manifest);
  let raw: string;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch (error) {
    return { path: source, name: null, dependencies: {}, error: describeFsError(error, source) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      path: source,
      name: null,
      dependencies: {},
      error: { code: 'scan-infrastructure-error', message: 'profile manifest is not valid JSON', source },
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      path: source,
      name: null,
      dependencies: {},
      error: { code: 'scan-infrastructure-error', message: 'profile manifest is not an object', source },
    };
  }

  const record = parsed as Record<string, unknown>;
  const dependencies: Record<string, string> = {};
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const group = record[field];
    if (typeof group !== 'object' || group === null || Array.isArray(group)) continue;
    for (const [name, specifier] of Object.entries(group as Record<string, unknown>)) {
      if (typeof specifier === 'string' && !(name in dependencies)) dependencies[name] = specifier;
    }
  }

  return {
    path: source,
    name: typeof record.name === 'string' ? record.name : null,
    dependencies,
    error: null,
  };
}

// ------------------------------------------------------------------ lockfile

/**
 * Parse a v9 `packages:` entry key such as `alpha-plugin@1.0.0`,
 * `@scope/name@1.0.0(peer@2.0.0)`, or a reference-keyed entry such as
 * `name@https://codeload.github.com/.../tar.gz/<sha>` produced for git and
 * tarball dependencies.
 *
 * `isVersion` distinguishes the two: comparing a reference against an installed
 * version would be meaningless and would manufacture a version-skew finding.
 */
export function parseLockPackageKey(key: string): { name: string; version: string; isVersion: boolean } | null {
  const withoutPeers = key.split('(')[0];
  const separator = withoutPeers.lastIndexOf('@');
  if (separator <= 0) return null;
  const name = withoutPeers.slice(0, separator);
  const version = withoutPeers.slice(separator + 1);
  if (name === '' || version === '') return null;
  return { name, version, isVersion: isExactVersion(version) };
}

/**
 * Parse a pnpm lockfile (v9 first). Any failure — unreadable file, malformed
 * YAML, unexpected shape — is returned as `error` and must become
 * `scan-infrastructure-error`; it must never be silently treated as "no
 * packages", because that would turn an infrastructure failure into a clean
 * inventory (docs/07 section 1, zero-false-green).
 */
export function parsePnpmLock(
  profilePath: string,
  layout: ProfileLayout = defaultProfileLayout(),
): PnpmLock {
  const source = path.join(profilePath, layout.lockfile);
  let raw: string;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch (error) {
    return {
      path: source,
      lockfileVersion: null,
      specifiers: new Map(),
      packages: new Map(),
      error: describeFsError(error, source),
    };
  }

  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (error) {
    const line = error instanceof YamlParseError ? `: ${error.message}` : '';
    return {
      path: source,
      lockfileVersion: null,
      specifiers: new Map(),
      packages: new Map(),
      error: { code: 'scan-infrastructure-error', message: `lockfile is not valid YAML${line}`, source },
    };
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return {
      path: source,
      lockfileVersion: null,
      specifiers: new Map(),
      packages: new Map(),
      error: { code: 'scan-infrastructure-error', message: 'lockfile root is not a mapping', source },
    };
  }

  const root = document as Record<string, unknown>;
  const lockfileVersion = typeof root.lockfileVersion === 'string' ? root.lockfileVersion : null;

  const specifiers = new Map<string, string>();
  const importers = root.importers;
  if (typeof importers === 'object' && importers !== null && !Array.isArray(importers)) {
    const rootImporter = (importers as Record<string, unknown>)['.'];
    if (typeof rootImporter === 'object' && rootImporter !== null && !Array.isArray(rootImporter)) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        const group = (rootImporter as Record<string, unknown>)[field];
        if (typeof group !== 'object' || group === null || Array.isArray(group)) continue;
        for (const [name, entry] of Object.entries(group as Record<string, unknown>)) {
          if (typeof entry === 'string') {
            specifiers.set(name, entry);
          } else if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
            const specifier = (entry as Record<string, unknown>).specifier;
            if (typeof specifier === 'string') specifiers.set(name, specifier);
          }
        }
      }
    }
  }

  const packages = new Map<string, { version: string; integrity: string | null }>();
  const packagesSection = root.packages;
  if (typeof packagesSection === 'object' && packagesSection !== null && !Array.isArray(packagesSection)) {
    for (const [key, entry] of Object.entries(packagesSection as Record<string, unknown>)) {
      const parsed = parseLockPackageKey(key);
      if (parsed === null) continue;

      let integrity: string | null = null;
      let declaredVersion: string | null = null;
      if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        const resolution = record.resolution;
        if (typeof resolution === 'object' && resolution !== null && !Array.isArray(resolution)) {
          const value = (resolution as Record<string, unknown>).integrity;
          if (typeof value === 'string') integrity = value;
        }
        // Git, tarball, file and link dependencies are keyed by their reference
        // rather than by a version, so the key is not a version at all. pnpm
        // still records the resolved version in the entry body; prefer it, and
        // fall back to the key for ordinary registry entries.
        if (typeof record.version === 'string') declaredVersion = record.version;
      }

      const resolvedVersion = parsed.isVersion
        ? parsed.version
        : (declaredVersion ?? parsed.version);

      // A name can legitimately appear at several versions and via several
      // references; keep the first mapping per name so the inventory has one
      // stable identity per package.
      if (!packages.has(parsed.name)) {
        packages.set(parsed.name, { version: resolvedVersion, integrity });
      }
    }
  }

  return { path: source, lockfileVersion, specifiers, packages, error: null };
}

// -------------------------------------------------------------- node_modules

function isPackageDirectory(entry: fs.Dirent): boolean {
  return entry.isDirectory() || entry.isSymbolicLink();
}

/**
 * Whether a directory *is* a package (it holds `package.json`) rather than a
 * grouping container.
 *
 * Classification is by content, never by name: the walk therefore stays correct
 * regardless of how the store is named or nested. A directory that cannot be
 * stat'ed is left to the caller, which reports a real failure (such as a
 * permission denial) rather than silently treating it as empty.
 */
function holdsPackageManifest(dirPath: string): boolean {
  try {
    return fs.statSync(path.join(dirPath, 'package.json')).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the actual installed versions of direct dependencies by reading
 * `node_modules/<name>/package.json`.
 *
 * Only direct dependencies are inspected, plus the `.pnpm` virtual store to
 * detect a name that resolves to more than one version. A directory that
 * exists but cannot be read (permission denied) or holds a malformed manifest
 * is reported as a scan error rather than being skipped, and a missing
 * directory is simply absent from the map — absence is never turned into an
 * invented version.
 */
export function parseNodeModules(
  profilePath: string,
  layout: ProfileLayout = defaultProfileLayout(),
): {
  actual: Map<string, ActualPackage>;
  errors: ParseError[];
} {
  const nodeModules = path.join(profilePath, layout.storeDir);
  const byName = new Map<string, Map<string, string>>();
  const errors: ParseError[] = [];

  const add = (name: string, version: string, location: string): void => {
    // Key copies by resolved package directory so that a top-level symlink and
    // the .pnpm store entry it points at count once, instead of looking like an
    // ambiguous resolution.
    let realLocation = location;
    try {
      realLocation = fs.realpathSync(location);
    } catch {
      /* keep the lexical path when the entry cannot be resolved */
    }
    let versions = byName.get(name);
    if (versions === undefined) {
      versions = new Map();
      byName.set(name, versions);
    }
    versions.set(realLocation, version);
  };

  const readVersion = (manifestPath: string, strict: boolean): void => {
    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath, 'utf8');
    } catch (error) {
      // In a best-effort walk an absent manifest is expected (a store entry
      // that does not hold the package at that depth); only report a real
      // infrastructure failure such as a permission denial.
      if (strict || !(isNodeError(error) && error.code === 'ENOENT')) {
        errors.push(describeFsError(error, manifestPath));
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const name = parsed.name;
      const version = parsed.version;
      if (typeof name === 'string' && typeof version === 'string') {
        add(name, version, path.dirname(manifestPath));
      }
    } catch {
      errors.push({
        code: 'scan-infrastructure-error',
        message: 'installed package manifest is not valid JSON',
        source: manifestPath,
      });
    }
  };

  /** Read every package manifest directly inside a container directory. */
  const readContainer = (containerDir: string, strict: boolean): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(containerDir, { withFileTypes: true });
    } catch (error) {
      // A missing store means "nothing installed"; any other failure (notably
      // permission denied) is an infrastructure error, not an empty inventory.
      if (strict && !(isNodeError(error) && error.code === 'ENOENT')) {
        errors.push(describeFsError(error, containerDir));
      }
      return;
    }

    for (const entry of entries) {
      // A container that *is* a package directory holds `package.json` directly;
      // a container that groups packages holds `<name>/package.json`. Both shapes
      // occur, because a pnpm virtual-store entry is the former and a
      // node_modules directory is the latter. Dot-entries are not skipped: the
      // pnpm virtual store is itself a dot-directory.
      if (entry.isFile()) {
        if (entry.name === 'package.json') readVersion(path.join(containerDir, entry.name), strict);
        continue;
      }
      if (!isPackageDirectory(entry)) continue;
      if (entry.name.startsWith('@')) {
        const scopeDir = path.join(containerDir, entry.name);
        let scoped: fs.Dirent[];
        try {
          scoped = fs.readdirSync(scopeDir, { withFileTypes: true });
        } catch (error) {
          if (strict) errors.push(describeFsError(error, scopeDir));
          continue;
        }
        for (const scopedEntry of scoped) {
          if (!isPackageDirectory(scopedEntry)) continue;
          readVersion(path.join(scopeDir, scopedEntry.name, 'package.json'), strict);
        }
        continue;
      }
      const candidateDir = path.join(containerDir, entry.name);
      if (!holdsPackageManifest(candidateDir)) continue;
      readVersion(path.join(candidateDir, 'package.json'), strict);
    }
  };

  readContainer(nodeModules, true);

  // The pnpm virtual store records every resolved copy; walk it to detect a
  // package name that resolves to more than one version. It is a best-effort
  // secondary source: absence is normal (npm and yarn have no equivalent), so a
  // failure here must not turn a readable inventory into a scan error.
  const virtualStore = path.join(profilePath, layout.virtualStoreDir);
  let storeEntries: fs.Dirent[] = [];
  try {
    storeEntries = fs.readdirSync(virtualStore, { withFileTypes: true });
  } catch {
    storeEntries = [];
  }

  for (const storeEntry of storeEntries) {
    if (!storeEntry.isDirectory()) continue;
    // Real pnpm nests the package under `<entry>/node_modules/<name>`; the
    // synthetic test layout places it directly under `<entry>/<name>`.
    readContainer(path.join(virtualStore, storeEntry.name, 'node_modules'), false);
    readContainer(path.join(virtualStore, storeEntry.name), false);
  }

  const actual = new Map<string, ActualPackage>();
  for (const [name, copies] of byName) {
    actual.set(name, { versions: [...copies.values()], paths: [...copies.keys()] });
  }

  return { actual, errors };
}
