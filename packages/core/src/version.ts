/**
 * Exact-version handling for the frozen report v1 contract.
 *
 * `definitions.exactVersion` in schemas/report-v1.schema.json is
 * `^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`, so a report may only carry a
 * fully qualified version. Anything else must be surfaced as unresolvable
 * rather than coerced, because a coerced version would fabricate identity.
 *
 * Range matching (dsh.engines, peer ranges) belongs to the C2 rule engine.
 */

const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export function isExactVersion(value: unknown): value is string {
  return typeof value === 'string' && EXACT_VERSION.test(value);
}

export function isPackageName(value: unknown): value is string {
  return typeof value === 'string' && /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
}

/**
 * Extract the version implied by a manifest specifier when the specifier is an
 * exact version or a simple range pinned to one version (`1.0.0`, `=1.0.0`,
 * `v1.0.0`). Returns null for genuine ranges (`^`, `~`, `>=`, `*`, `workspace:*`,
 * `npm:` aliases, git or file specifiers) — those cannot be inverted into one
 * version, and guessing would create false identity.
 */
export function pinnedVersionFromSpecifier(specifier: string | null | undefined): string | null {
  if (typeof specifier !== 'string') return null;
  const trimmed = specifier.trim().replace(/^v/, '');
  if (isExactVersion(trimmed)) return trimmed;
  const operator = /^=\s*(\S+)$/.exec(trimmed);
  if (operator && isExactVersion(operator[1])) return operator[1];
  return null;
}
