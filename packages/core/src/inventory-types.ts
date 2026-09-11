/**
 * Shared inventory types for C1 environment discovery.
 *
 * These mirror the frozen report v1 contract (schemas/report-v1.schema.json,
 * semantics in docs/07-m0-contract.md). C1 only *discovers* identity; it makes
 * no compatibility judgement, so every state it can emit is non-green.
 */

import path from 'node:path';

import type { Redactor } from './redact.js';

export const SIX_STATES = [
  'validated_compatible',
  'declared_compatible',
  'degraded',
  'incompatible',
  'unknown',
  'scan_error',
] as const;

export type CompatibilityState = (typeof SIX_STATES)[number];

/** Conservative aggregation order: scan_error > incompatible > degraded > unknown > validated > declared. */
export const AGGREGATION_ORDER: readonly CompatibilityState[] = [
  'scan_error',
  'incompatible',
  'degraded',
  'unknown',
  'validated_compatible',
  'declared_compatible',
];

export type EvidenceLevel = 'runtime' | 'host_api' | 'manifest' | 'known_matrix' | 'lock' | 'heuristic';

/** Finding codes C1 may emit, with the registry minimum status and evidence level. */
export interface FindingCodeSpec {
  readonly minStatus: CompatibilityState;
  readonly evidenceLevel: EvidenceLevel;
}

/**
 * Subset of the docs/07 section 4 registry owned by C1 (identity and
 * infrastructure findings). C2 owns the engine/peer/API judgement codes.
 */
export const C1_FINDING_CODES: Readonly<Record<string, FindingCodeSpec>> = Object.freeze({
  'host-version-skew': { minStatus: 'degraded', evidenceLevel: 'lock' },
  'host-identity-unresolved': { minStatus: 'scan_error', evidenceLevel: 'lock' },
  'version-skew-manifest-lock': { minStatus: 'degraded', evidenceLevel: 'lock' },
  'version-skew-lock-actual': { minStatus: 'degraded', evidenceLevel: 'lock' },
  'package-missing': { minStatus: 'scan_error', evidenceLevel: 'lock' },
  'ambiguous-resolution': { minStatus: 'degraded', evidenceLevel: 'lock' },
  'scan-infrastructure-error': { minStatus: 'scan_error', evidenceLevel: 'lock' },
});

export interface ProfileManifest {
  readonly path: string;
  readonly name: string | null;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly error: ParseError | null;
}

/**
 * Where the profile readers look for each artifact.
 *
 * Production always uses the real dsh layout (`package.json`, `pnpm-lock.yaml`,
 * `node_modules`). It is injectable so tests can drive the same readers over
 * synthetic fixtures without committing a tree that mimics runtime data: the
 * repository boundary check (scripts/verify-repository.mjs) deliberately
 * forbids a second lockfile or a tracked `node_modules` path.
 */
export interface ProfileLayout {
  readonly manifest: string;
  readonly lockfile: string;
  readonly storeDir: string;
  readonly virtualStoreDir: string;
}

export function defaultProfileLayout(): ProfileLayout {
  return {
    manifest: 'package.json',
    lockfile: 'pnpm-lock.yaml',
    storeDir: 'node_modules',
    virtualStoreDir: path.join('node_modules', '.pnpm'),
  };
}

export interface ParseError {
  readonly code: string;
  readonly message: string;
  readonly source: string;
}

export interface LockPackage {
  readonly version: string;
  readonly integrity: string | null;
}

export interface PnpmLock {
  readonly path: string;
  readonly lockfileVersion: string | null;
  readonly specifiers: ReadonlyMap<string, string>;
  readonly packages: ReadonlyMap<string, LockPackage>;
  readonly error: ParseError | null;
}

export interface ActualPackage {
  readonly versions: readonly string[];
  readonly paths: readonly string[];
}

export interface PluginReconcile {
  readonly name: string;
  readonly manifestSpecifier: string | null;
  readonly lockVersion: string | null;
  readonly actualVersion: string | null;
  readonly integrity: string | null;
  readonly enabled: boolean;
  readonly loaderIds: readonly string[];
  readonly ambiguous: boolean;
  readonly reconcileCode: string | null;
}

export interface ReconcileResult {
  readonly error: ParseError | null;
  readonly byName: ReadonlyMap<string, PluginReconcile>;
  readonly pluginOrder: readonly string[];
  /** Every version each name resolves to, keyed by package name. */
  readonly actualVersions: ReadonlyMap<string, readonly string[]>;
}

export interface SmokeCoverage {
  readonly result: 'passed' | 'failed' | 'not-run' | 'unavailable' | 'indeterminate';
  readonly scope: readonly string[];
  readonly notCovered: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface PluginInventory extends PluginReconcile {
  readonly status: CompatibilityState;
  readonly evidenceIds: readonly string[];
  readonly smokeCoverage: SmokeCoverage;
  readonly uncheckedFeatures: readonly string[];
}

/**
 * The exact `plugins[]` item shape of report v1.
 *
 * The schema sets `additionalProperties: false`, so this deliberately omits the
 * internal reconciliation diagnostics (`ambiguous`, `reconcileCode`) that
 * `PluginInventory` carries. `toReportPlugin` is the only place that converts
 * between the two.
 */
export interface ReportPlugin {
  readonly name: string;
  readonly loaderIds: readonly string[];
  readonly enabled: boolean;
  readonly manifestSpecifier: string | null;
  readonly lockVersion: string | null;
  readonly actualVersion: string | null;
  readonly integrity: string | null;
  readonly status: CompatibilityState;
  readonly evidenceIds: readonly string[];
  readonly smokeCoverage: SmokeCoverage;
  readonly uncheckedFeatures: readonly string[];
}

export interface ReportFinding {
  readonly id: string;
  readonly code: string;
  readonly subject: string;
  readonly status: CompatibilityState;
  readonly severity: 'block' | 'review' | 'info';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly observed: string;
  readonly expected: string;
  readonly evidence: readonly ReportEvidence[];
  readonly location?: string;
  readonly nextStep: string;
  readonly blocking: boolean;
}

export interface ReportEvidence {
  readonly id: string;
  readonly type: EvidenceLevel;
  readonly source: string;
  readonly detail?: string;
}

export interface ProfileIdentity {
  readonly name: string;
  readonly manifestDigest: string;
  readonly lockDigest: string;
}

export interface HostIdentity {
  readonly resolved: boolean;
  readonly binaryInput: string;
  readonly binaryRealpath: string | null;
  readonly cliVersion: string | null;
  readonly packageName: string | null;
  readonly packageRoot: string | null;
  readonly nodeVersion: string;
  readonly corePackages: readonly CorePackageVersion[];
  readonly error: ParseError | null;
}

export interface CorePackageVersion {
  readonly name: string;
  readonly version: string;
  readonly expectedVersion?: string;
}

export interface ProfileScan {
  readonly profile: ProfileIdentity;
  readonly plugins: readonly PluginInventory[];
  readonly findings: readonly ReportFinding[];
  readonly summary: { readonly status: CompatibilityState; readonly blocking: number; readonly review: number };
  readonly redact: Redactor;
}

export interface RunMetadata {
  readonly id: string;
  readonly startedAt: string;
  readonly mode: 'scan' | 'check-update' | 'smoke';
  readonly doctorVersion: string;
}

export interface Report {
  readonly schemaVersion: 1;
  readonly run: RunMetadata;
  readonly host: {
    readonly binaryInput: string;
    readonly binaryRealpath: string;
    readonly cliVersion: string;
    readonly nodeVersion: string;
    readonly corePackages: readonly CorePackageVersion[];
  };
  readonly profile: ProfileIdentity;
  readonly plugins: readonly ReportPlugin[];
  readonly findings: readonly ReportFinding[];
  readonly summary: { readonly status: CompatibilityState; readonly blocking: number; readonly review: number };
}
