/**
 * Host identity resolution.
 *
 * This is strictly out-of-process: it reads the filesystem and, at most, runs
 * `dsh --version`. It never loads the dsh host API, so a stopped or crashing
 * dsh cannot affect a scan (docs/01-cli-design.md section 7.1).
 *
 * The npm package version is authoritative for `cliVersion`; `dsh --version` is
 * cross-checked and a disagreement is surfaced rather than hidden.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { isExactVersion, isPackageName } from './version.js';
import type { CorePackageVersion, HostIdentity, ParseError } from './inventory-types.js';

const CORE_PACKAGE_PREFIX = '@deepseek-ai/dsh';

export interface ResolveHostOptions {
  readonly binary?: string;
  /** Package directories to inspect for core package versions. */
  readonly packageRoots?: readonly string[];
  /** Injectable for determinism in tests. */
  readonly runCommand?: (binary: string, args: readonly string[]) => string | null;
  readonly nodeVersion?: string;
}

function defaultRunCommand(binary: string, args: readonly string[]): string | null {
  try {
    const output = execFileSync(binary, [...args], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim();
  } catch {
    return null;
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Walk up from a file until a package.json with a name and version is found. */
export function findPackageRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current);
  for (;;) {
    const manifest = readJson(path.join(current, 'package.json'));
    if (manifest !== null && typeof manifest.name === 'string' && typeof manifest.version === 'string') {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function collectCorePackages(packageRoot: string | null): CorePackageVersion[] {
  if (packageRoot === null) return [];
  const nodeModules = path.join(packageRoot, 'node_modules');
  const found: CorePackageVersion[] = [];

  const consider = (manifestPath: string): void => {
    const manifest = readJson(manifestPath);
    if (manifest === null) return;
    const { name, version } = manifest;
    if (typeof name !== 'string' || !isPackageName(name)) return;
    if (!name.startsWith(CORE_PACKAGE_PREFIX)) return;
    if (!isExactVersion(version)) return;
    found.push({ name, version });
  };

  for (const scope of ['@deepseek-ai']) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(nodeModules, scope), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      consider(path.join(nodeModules, scope, entry.name, 'package.json'));
    }
  }

  const seen = new Set<string>();
  return found
    .sort((left, right) => left.name.localeCompare(right.name))
    .filter((entry) => {
      if (seen.has(entry.name)) return false;
      seen.add(entry.name);
      return true;
    });
}

/**
 * Resolve a binary that may be a bare command name. `fs.realpathSync('dsh')`
 * does not search PATH, so a bare name must be located first or every default
 * invocation would look like an unresolved host.
 */
function locateBinary(binary: string): string | null {
  const candidates: string[] = [];
  if (binary.includes('/') || binary.includes('\\')) {
    candidates.push(path.resolve(binary));
  } else {
    const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry !== '');
    const extensions =
      process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
    for (const entry of pathEntries) {
      for (const extension of extensions) candidates.push(path.join(entry, `${binary}${extension}`));
    }
  }

  for (const candidate of candidates) {
    try {
      const stats = fs.statSync(candidate);
      if (!stats.isFile()) continue;
      if (process.platform !== 'win32' && (stats.mode & 0o111) === 0) continue;
      return fs.realpathSync(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Resolve the host identity. A missing or unreadable binary is reported as
 * `host-identity-unresolved` (scan_error) instead of throwing, so the CLI keeps
 * working when dsh is absent, stopped or crashed.
 */
export function resolveHost(options: ResolveHostOptions = {}): HostIdentity {
  const binary = options.binary ?? 'dsh';
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const runCommand = options.runCommand ?? defaultRunCommand;

  const base: Omit<HostIdentity, 'error'> = {
    resolved: false,
    binaryInput: binary,
    binaryRealpath: null,
    cliVersion: null,
    packageName: null,
    packageRoot: null,
    nodeVersion,
    corePackages: [],
  };

  const realpath = locateBinary(binary);

  if (realpath === null) {
    const error: ParseError = {
      code: 'host-identity-unresolved',
      message: `cannot resolve dsh binary "${binary}"`,
      source: binary,
    };
    return { ...base, binaryRealpath: null, error };
  }

  const packageRoot = findPackageRoot(realpath);
  const manifest = packageRoot === null ? null : readJson(path.join(packageRoot, 'package.json'));
  const manifestVersion = typeof manifest?.version === 'string' && isExactVersion(manifest.version)
    ? manifest.version
    : null;
  const packageName = typeof manifest?.name === 'string' ? manifest.name : null;

  const reported = runCommand(binary, ['--version']);
  const reportedVersion = reported !== null && isExactVersion(reported.replace(/^v/, ''))
    ? reported.replace(/^v/, '')
    : null;

  const cliVersion = manifestVersion ?? reportedVersion;

  if (cliVersion === null) {
    const error: ParseError = {
      code: 'host-identity-unresolved',
      message: 'neither the package manifest nor `dsh --version` yielded a resolvable version',
      source: packageRoot ?? realpath,
    };
    return { ...base, binaryRealpath: realpath, packageRoot, packageName, error };
  }

  const rootCandidates = [packageRoot, ...(options.packageRoots ?? [])].filter(
    (value): value is string => typeof value === 'string' && value !== null,
  );
  const corePackages: CorePackageVersion[] = [];
  const seen = new Set<string>();
  for (const root of rootCandidates) {
    for (const entry of collectCorePackages(root)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      corePackages.push(
        entry.version === cliVersion ? entry : { ...entry, expectedVersion: cliVersion },
      );
    }
  }
  corePackages.sort((left, right) => left.name.localeCompare(right.name));

  // `dsh --version` disagreeing with the package manifest is itself a skew
  // signal; surface it on the core package list rather than silently picking one.
  const skewError: ParseError | null =
    reportedVersion !== null && manifestVersion !== null && reportedVersion !== manifestVersion
      ? {
          code: 'host-version-skew',
          message: `\`dsh --version\` reported ${reportedVersion} but the installed package is ${manifestVersion}`,
          source: packageRoot ?? realpath,
        }
      : null;

  return {
    resolved: true,
    binaryInput: binary,
    binaryRealpath: realpath,
    cliVersion,
    packageName,
    packageRoot,
    nodeVersion,
    corePackages,
    error: skewError,
  };
}
