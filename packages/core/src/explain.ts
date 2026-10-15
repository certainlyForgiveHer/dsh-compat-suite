/**
 * `explain` data layer (docs/01 section 5.4).
 *
 * The CLI command belongs to C5; C2 owns the data projection: expand one
 * finding into its rule identity (registry row, precedence rank) and the
 * related findings for the same subject. Pure data, no I/O, so the CLI, the
 * plugin and tests all render the exact same explanation.
 */

import { FINDING_CODE_REGISTRY, precedenceRank } from './finding-registry.js';
import type { FindingCodeSpec } from './finding-registry.js';
import type { ReportFinding } from './inventory-types.js';

export interface FindingExplanation {
  readonly finding: ReportFinding;
  readonly registry: FindingCodeSpec;
  readonly precedenceRank: number;
  /** Other findings for the same subject, in report order. */
  readonly related: readonly ReportFinding[];
}

/**
 * Explain one finding by its stable ID (`<subject>:<code>`).
 *
 * Returns null when the ID is not in the given findings — the caller renders
 * that as a usage error rather than inventing an explanation.
 */
export function explainFinding(
  findings: readonly ReportFinding[],
  findingId: string,
): FindingExplanation | null {
  const target = findings.find((finding) => finding.id === findingId);
  if (target === undefined) return null;

  const registry = FINDING_CODE_REGISTRY[target.code];
  if (registry === undefined) {
    // A materialized finding always carries a registered code; an unregistered
    // one means the report was produced by a different schema version, and the
    // CLI must not guess semantics for it.
    return null;
  }

  return {
    finding: target,
    registry,
    precedenceRank: precedenceRank(target.code),
    related: findings.filter((finding) => finding.subject === target.subject && finding.id !== target.id),
  };
}

/** The registry row set the explain surface may display. */
export function listFindingCodes(): readonly (FindingCodeSpec & { readonly code: string })[] {
  return Object.entries(FINDING_CODE_REGISTRY).map(([code, spec]) => ({ code, ...spec }));
}
