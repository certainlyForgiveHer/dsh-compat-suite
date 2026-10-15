/**
 * Prerelease-aware semver evaluation for the C2 rule engine.
 *
 * The evaluator is the battle-tested `semver` package (docs/01 section 8.3:
 * a handwritten string comparison is forbidden). This module wraps it with the
 * discipline the compatibility rules need:
 *
 * - strict parsing only: a non-standard version is `null`, never coerced;
 * - range satisfaction returns `null` when either side is undecidable, so a
 *   rule that cannot judge falls back to `unknown` instead of guessing;
 * - npm-standard prerelease gating: a prerelease version satisfies a range
 *   only when the range carries a comparator with a prerelease on the same
 *   [major, minor, patch] tuple. This is the conservative reading — a broad
 *   range cannot silently admit prerelease hosts (docs/04 section 8.1).
 */

import {
  compare as semverCompareRaw,
  parse as semverParse,
  satisfies as semverSatisfies,
  validRange as semverValidRange,
} from 'semver';

/**
 * Ordered comparison with the defensive branch removed at the type level: the
 * `semver.compare` signature allows null for unparseable input, but every
 * internal caller has parsed both operands first, so the null arm cannot run.
 */
function compareSpec(a: string, b: string): number {
  return semverCompareRaw(a, b) as number;
}

export interface ParsedVersion {
  readonly version: string;
  readonly raw: string;
}

/** Strict semver parse. Returns null for anything the spec does not accept. */
export function parseVersion(value: string): ParsedVersion | null {
  if (typeof value !== 'string') return null;
  const parsed = semverParse(value);
  return parsed === null ? null : { version: parsed.version, raw: value };
}

/** Whether a string is a standard, fully qualified semver version. */
export function isStandardVersion(value: string): boolean {
  return parseVersion(value) !== null;
}

/** Whether a string parses as a semver range at all.
 *
 * The empty string compiles to "any range" in npm, but a rule input must name
 * a constraint to be judged, so an empty declaration is reported as unusable
 * (`rule-input-unparseable`) rather than treated as a wildcard.
 */
export function isValidRange(range: string): boolean {
  if (typeof range !== 'string' || range.trim() === '') return false;
  return semverValidRange(range) !== null;
}

/**
 * Whether `version` satisfies `range`, or null when the judgement cannot be
 * made (unparseable version, invalid range). npm-standard prerelease gating
 * applies, deliberately without `includePrerelease`.
 */
export function satisfiesRange(version: string | null, range: string): boolean | null {
  if (version === null || parseVersion(version) === null) return null;
  if (!isValidRange(range)) return null;
  return semverSatisfies(version, range);
}

/**
 * Full ordering of two standard versions; null when either side does not
 * parse. The result follows `semver.compare` (prerelease-aware, spec order).
 */
export function compareVersions(left: string, right: string): number | null {
  if (parseVersion(left) === null || parseVersion(right) === null) return null;
  const diff = semverCompareRaw(left, right);
  return diff === 0 ? 0 : diff; // normalize semver's -0 to 0 for stable equality
}

/**
 * The highest parseable version of a list; null when none parses. Unparseable
 * entries are ignored rather than coerced.
 */
export function maxVersion(versions: readonly string[]): string | null {
  const parseable = versions.filter((version) => parseVersion(version) !== null);
  if (parseable.length === 0) return null;
  return parseable.reduce((best, current) => (compareSpec(current, best) > 0 ? current : best));
}

/**
 * Stable ordering: parseable versions ascending by semver order; unparseable
 * entries keep their original relative order after all parseable ones. The
 * sort is deterministic for a given input.
 */
export function sortVersions(versions: readonly string[]): readonly string[] {
  const parseable = versions.filter((version) => parseVersion(version) !== null);
  parseable.sort(compareSpec);
  const unparseable = versions.filter((version) => parseVersion(version) === null);
  return [...parseable, ...unparseable];
}
