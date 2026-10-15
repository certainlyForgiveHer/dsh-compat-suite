export const PACKAGE_NAME = '@miguel_tu/core' as const;
export const PACKAGE_VERSION = '0.0.0' as const;

export { createRedactor } from './redact.js';
export type { Redactor, RedactorInput } from './redact.js';

export { isExactVersion, isPackageName, pinnedVersionFromSpecifier } from './version.js';

export {
  compareVersions,
  isStandardVersion,
  isValidRange,
  maxVersion,
  parseVersion,
  satisfiesRange,
  sortVersions,
} from './semver.js';

export {
  DEFAULT_API_LIMITS,
  buildHostApiIndex,
  evaluateApiSurface,
  extractPluginApiUsage,
} from './api-surface.js';
export type {
  ApiReference,
  ApiScanLimits,
  ApiSurfaceEvaluation,
  HostApiIndex,
  PluginApiUsage,
} from './api-surface.js';

export {
  entryAllowedForDoctor,
  loadBundledKnownMatrix,
  lookupKnownMatrix,
  parseKnownMatrix,
} from './known-matrix.js';
export type {
  KnownMatrix,
  KnownMatrixEntry,
  MatrixMatch,
} from './known-matrix.js';

export {
  compareFindingsStable,
  evaluateRules,
  readPluginManifestRules,
} from './rules.js';
export type {
  EvaluateRulesOptions,
  PeerDeclaration,
  PluginManifestRules,
  RuleEvaluationInput,
  RuleEvaluationResult,
  RuleFindingInput,
} from './rules.js';

export { explainFinding, listFindingCodes } from './explain.js';
export type { FindingExplanation } from './explain.js';

export { parseYaml, YamlParseError } from './yaml.js';
export type { YamlValue } from './yaml.js';

export {
  discoverLoaderState,
  loaderStateForPlugin,
  parseCordisPatch,
  parseLockPackageKey,
  parseNodeModules,
  parseProfileManifest,
  parsePnpmLock,
  readCordisPatch,
} from './parsers.js';

export { reconcilePlugins } from './reconcile.js';

export { findPackageRoot, resolveHost } from './host.js';
export type { ResolveHostOptions } from './host.js';

export { buildReport, exitCodeFor, findingForReconcile, scanProfile, toReportPlugin } from './report.js';
export type { BuildReportInput, BuiltReport, DerivedFinding, Policy, ScanProfileOptions } from './report.js';


export { DOCTOR_VERSION, FIXED_RUN, runScan } from './scan.js';
export type { RunScanOptions, RunScanResult } from './scan.js';

export {
  AGGREGATION_ORDER,
  C1_FINDING_CODES,
  DEFAULT_PROFILE_PATCH_FILE,
  FINDING_CODE_REGISTRY,
  RULE_PRECEDENCE,
  SIX_STATES,
  aggregateStatus,
  isRegisteredFindingCode,
  precedenceRank,
} from './inventory-types.js';
export type {
  ActualPackage,
  CompatibilityState,
  CordisPatch,
  CordisPatchRow,
  CorePackageVersion,
  EvidenceLevel,
  FindingCodeSpec,
  HostIdentity,
  LockPackage,
  ParseError,
  PluginInventory,
  PluginLoaderState,
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
