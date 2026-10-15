/**
 * Known compatibility matrix (docs/01 section 8.4).
 *
 * The matrix is a versioned JSON data file. Entries record a host side (exact
 * version or range), a plugin side (name plus exact version or range), a
 * decision (`allow` or `deny` — `degraded` needs runtime evidence and is out
 * of scope for the v1 data format), how the combination was verified, an
 * artifact integrity digest when one exists, the verification date, an expiry
 * policy and an optional minimum doctor version.
 *
 * Semantics that keep the matrix from manufacturing green:
 * - local rules outrank remote ones; MVP ships only the bundled file and never
 *   downloads or trusts a remote matrix;
 * - an expired `allow` degrades to unknown ("不保留绿色", docs/07 section 7);
 *   a `deny` never expires into green;
 * - a matrix load failure is surfaced as an error; the caller then falls back
 *   to manifest-only judgement, which is conservative and never green.
 */

import fs from 'node:fs';

import { isPackageName, isExactVersion } from './version.js';
import { satisfiesRange, isValidRange, compareVersions } from './semver.js';
import type { ParseError } from './inventory-types.js';

export interface KnownMatrixHostSelector {
  readonly version?: string;
  readonly range?: string;
}

export interface KnownMatrixPluginSelector {
  readonly name: string;
  readonly version?: string;
  readonly range?: string;
}

export interface KnownMatrixEntry {
  readonly host: KnownMatrixHostSelector;
  readonly plugin: KnownMatrixPluginSelector;
  readonly decision: 'allow' | 'deny';
  readonly verification: string;
  readonly reason: string;
  readonly source: string;
  readonly artifactDigest?: string;
  readonly verifiedAt: string;
  readonly maxAgeDays?: number;
  readonly minDoctorVersion?: string;
}

export interface KnownMatrix {
  readonly version: 1;
  readonly entries: readonly KnownMatrixEntry[];
}

export interface KnownMatrixLoadResult {
  readonly matrix: KnownMatrix | null;
  readonly error: ParseError | null;
}

export interface MatrixMatch {
  readonly entry: KnownMatrixEntry;
  readonly decision: 'allow' | 'deny';
  readonly expired: boolean;
}

const BUNDLED_MATRIX_URL = new URL('../data/known-matrix-v1.json', import.meta.url);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selectorError(label: string, selector: unknown): string | null {
  if (!isPlainObject(selector)) return `${label} must be an object`;
  const version = selector.version;
  const range = selector.range;
  if (version === undefined && range === undefined) return `${label} needs a version or a range`;
  if (version !== undefined && (typeof version !== 'string' || !isExactVersion(version))) {
    return `${label}.version must be a fully qualified semver version`;
  }
  if (range !== undefined && (typeof range !== 'string' || !isValidRange(range))) {
    return `${label}.range must be a valid semver range`;
  }
  return null;
}

function validateEntry(entry: unknown, index: number): string | null {
  if (!isPlainObject(entry)) return `entries[${index}] must be an object`;

  const hostError = selectorError(`entries[${index}].host`, entry.host);
  if (hostError !== null) return hostError;

  const plugin = entry.plugin;
  if (!isPlainObject(plugin)) return `entries[${index}].plugin must be an object`;
  if (typeof plugin.name !== 'string' || !isPackageName(plugin.name)) {
    return `entries[${index}].plugin.name must be a package name`;
  }
  const pluginSelectorError = selectorError(`entries[${index}].plugin`, plugin);
  if (pluginSelectorError !== null) return pluginSelectorError;

  if (entry.decision !== 'allow' && entry.decision !== 'deny') {
    return `entries[${index}].decision must be "allow" or "deny" ("degraded" needs runtime evidence and is not supported in v1 data)`;
  }
  for (const field of ['verification', 'reason', 'source', 'verifiedAt'] as const) {
    if (typeof entry[field] !== 'string' || (entry[field] as string).length === 0) {
      return `entries[${index}].${field} must be a non-empty string`;
    }
  }
  if (Number.isNaN(Date.parse(entry.verifiedAt as string))) {
    return `entries[${index}].verifiedAt must be a parseable RFC3339 date`;
  }
  if (entry.artifactDigest !== undefined && (typeof entry.artifactDigest !== 'string' || entry.artifactDigest === '')) {
    return `entries[${index}].artifactDigest must be a non-empty string when present`;
  }
  if (entry.maxAgeDays !== undefined && (typeof entry.maxAgeDays !== 'number' || !Number.isInteger(entry.maxAgeDays) || entry.maxAgeDays <= 0)) {
    return `entries[${index}].maxAgeDays must be a positive integer when present`;
  }
  if (entry.minDoctorVersion !== undefined && (typeof entry.minDoctorVersion !== 'string' || !isExactVersion(entry.minDoctorVersion))) {
    return `entries[${index}].minDoctorVersion must be a fully qualified semver version when present`;
  }
  return null;
}

/** Parse and validate a matrix JSON document. Any invalid entry rejects the file. */
export function parseKnownMatrix(raw: string, source = '<matrix>'): KnownMatrixLoadResult {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return { matrix: null, error: { code: 'scan-infrastructure-error', message: 'known matrix is not valid JSON', source } };
  }
  if (!isPlainObject(document)) {
    return { matrix: null, error: { code: 'scan-infrastructure-error', message: 'known matrix root must be an object', source } };
  }
  if (document.version !== 1) {
    return { matrix: null, error: { code: 'scan-infrastructure-error', message: `unsupported known matrix version ${String(document.version)}`, source } };
  }
  if (!Array.isArray(document.entries)) {
    return { matrix: null, error: { code: 'scan-infrastructure-error', message: 'known matrix entries must be an array', source } };
  }

  const entries: KnownMatrixEntry[] = [];
  for (const [index, candidate] of document.entries.entries()) {
    const problem = validateEntry(candidate, index);
    if (problem !== null) {
      return { matrix: null, error: { code: 'scan-infrastructure-error', message: problem, source } };
    }
    const record = candidate as Record<string, unknown>;
    entries.push({
      host: record.host as KnownMatrixHostSelector,
      plugin: record.plugin as KnownMatrixPluginSelector,
      decision: record.decision as 'allow' | 'deny',
      verification: record.verification as string,
      reason: record.reason as string,
      source: record.source as string,
      ...(typeof record.artifactDigest === 'string' ? { artifactDigest: record.artifactDigest } : {}),
      verifiedAt: record.verifiedAt as string,
      ...(typeof record.maxAgeDays === 'number' ? { maxAgeDays: record.maxAgeDays } : {}),
      ...(typeof record.minDoctorVersion === 'string' ? { minDoctorVersion: record.minDoctorVersion } : {}),
    });
  }

  return { matrix: Object.freeze({ version: 1 as const, entries: Object.freeze(entries) }), error: null };
}

/** The bundled, versioned matrix data shipped with the package. */
export function loadBundledKnownMatrix(): KnownMatrix {
  const raw = fs.readFileSync(BUNDLED_MATRIX_URL, 'utf8');
  const result = parseKnownMatrix(raw, 'builtin:known-matrix-v1.json');
  if (result.matrix === null) throw new Error(`bundled known matrix is invalid: ${result.error?.message}`);
  return result.matrix;
}

function isUsable(entry: KnownMatrixEntry, now: Date): boolean {
  if (entry.maxAgeDays === undefined) return true;
  const verified = Date.parse(entry.verifiedAt);
  if (Number.isNaN(verified)) return false;
  return now.getTime() - verified <= entry.maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Every matrix entry matching the host/plugin combination, in data order.
 *
 * `deny` entries are returned even when stale (a deny never becomes green);
 * `allow` entries past their expiry come back with `expired: true` so callers
 * can decide to drop them (docs/07 section 7: expired allow degrades to
 * unknown). Unparseable plugin versions simply match nothing — no coercion.
 */
export function lookupKnownMatrix(
  matrix: KnownMatrix,
  input: {
    readonly hostVersion: string | null;
    readonly pluginName: string;
    readonly pluginVersions: readonly string[];
  },
  options: { readonly now?: Date } = {},
): readonly MatrixMatch[] {
  const now = options.now ?? new Date();
  if (input.hostVersion === null) return [];

  const matches: MatrixMatch[] = [];
  for (const entry of matrix.entries) {
    if (entry.plugin.name !== input.pluginName) continue;

    const hostOk =
      entry.host.version !== undefined
        ? entry.host.version === input.hostVersion ||
          (entry.host.range !== undefined && satisfiesRange(input.hostVersion, entry.host.range) === true)
        : satisfiesRange(input.hostVersion, entry.host.range ?? '') === true;
    if (!hostOk) continue;

    const pluginOk =
      (entry.plugin.version !== undefined && input.pluginVersions.includes(entry.plugin.version)) ||
      (entry.plugin.range !== undefined &&
        input.pluginVersions.some((version) => satisfiesRange(version, entry.plugin.range ?? '') === true));
    if (!pluginOk) continue;

    matches.push({
      entry,
      decision: entry.decision,
      expired: entry.decision === 'allow' && !isUsable(entry, now),
    });
  }
  return matches;
}

/** Whether the running doctor may consume an entry with a minimum doctor version. */
export function entryAllowedForDoctor(entry: KnownMatrixEntry, doctorVersion: string): boolean {
  if (entry.minDoctorVersion === undefined) return true;
  return (compareVersions(doctorVersion, entry.minDoctorVersion) ?? -1) >= 0;
}
