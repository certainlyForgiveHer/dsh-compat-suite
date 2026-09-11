export const PACKAGE_NAME = '@miguel_tu/core' as const;
export const PACKAGE_VERSION = '0.0.0' as const;

export { createRedactor } from './redact.js';
export type { Redactor, RedactorInput } from './redact.js';

export { isExactVersion, isPackageName, pinnedVersionFromSpecifier } from './version.js';

export { parseYaml, YamlParseError } from './yaml.js';
export type { YamlValue } from './yaml.js';

export { parseLockPackageKey, parseNodeModules, parseProfileManifest, parsePnpmLock } from './parsers.js';

export { reconcilePlugins } from './reconcile.js';

export { findPackageRoot, resolveHost } from './host.js';
export type { ResolveHostOptions } from './host.js';

export { aggregateStatus, buildReport, exitCodeFor, findingForReconcile, scanProfile, toReportPlugin } from './report.js';
export type { BuildReportInput, BuiltReport, DerivedFinding, Policy, ScanProfileOptions } from './report.js';

export { DOCTOR_VERSION, FIXED_RUN, runScan } from './scan.js';
export type { RunScanOptions, RunScanResult } from './scan.js';

export { AGGREGATION_ORDER, C1_FINDING_CODES, SIX_STATES } from './inventory-types.js';
export type {
  ActualPackage,
  CompatibilityState,
  CorePackageVersion,
  EvidenceLevel,
  FindingCodeSpec,
  HostIdentity,
  LockPackage,
  ParseError,
  PluginInventory,
  PluginReconcile,
  PnpmLock,
  ProfileIdentity,
  ProfileManifest,
  ProfileScan,
  ReconcileResult,
  Report,
  ReportEvidence,
  ReportFinding,
  ReportPlugin,
  RunMetadata,
  SmokeCoverage,
} from './inventory-types.js';
