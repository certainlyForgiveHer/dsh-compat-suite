/**
 * Report assembly for C1: digesting the profile, deriving identity findings and
 * aggregating statuses per the frozen contract (docs/07 sections 3, 5, 7, 8).
 *
 * C1 never emits a green state. Discovery alone cannot show that a combination
 * works, so a plugin with no defect still reports `unknown` — absence of errors
 * is not compatibility (docs/07 section 1).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createRedactor } from './redact.js';
import { reconcilePlugins } from './reconcile.js';
import { parseProfileManifest, parsePnpmLock } from './parsers.js';
import { C1_FINDING_CODES, AGGREGATION_ORDER, defaultProfileLayout } from './inventory-types.js';
import type {
  CompatibilityState,
  PluginInventory,
  ProfileIdentity,
  ProfileScan,
  Report,
  ReportEvidence,
  ReportFinding,
  ProfileLayout,
  ReportPlugin,
  RunMetadata,
} from './inventory-types.js';
import type { HostIdentity } from './inventory-types.js';

const ADVISORY_EXIT: Readonly<Record<CompatibilityState, number>> = Object.freeze({
  validated_compatible: 0,
  declared_compatible: 0,
  degraded: 0,
  unknown: 0,
  incompatible: 1,
  scan_error: 4,
});

const STRICT_EXIT: Readonly<Record<CompatibilityState, number>> = Object.freeze({
  validated_compatible: 0,
  declared_compatible: 0,
  degraded: 2,
  unknown: 2,
  incompatible: 1,
  scan_error: 4,
});

export type Policy = 'advisory' | 'strict';

/** Frozen exit-code table (docs/07 section 3). */
export function exitCodeFor(state: CompatibilityState, policy: Policy = 'advisory'): number {
  const table = policy === 'strict' ? STRICT_EXIT : ADVISORY_EXIT;
  const code = table[state];
  if (code === undefined) throw new Error(`unknown compatibility state: ${String(state)}`);
  return code;
}

/** Most severe state wins; unknown outranks green; validated outranks declared. */
export function aggregateStatus(states: readonly CompatibilityState[]): CompatibilityState {
  if (states.length === 0) return 'unknown';
  let best = AGGREGATION_ORDER.length;
  for (const state of states) {
    const rank = AGGREGATION_ORDER.indexOf(state);
    if (rank === -1) throw new Error(`unknown compatibility state: ${String(state)}`);
    if (rank < best) best = rank;
  }
  return AGGREGATION_ORDER[best];
}

function sha256Digest(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  } catch {
    return `sha256:${crypto.createHash('sha256').update('').digest('hex')}`;
  }
}

export interface DerivedFinding {
  readonly code: string;
  readonly subject: string;
  readonly status: CompatibilityState;
  readonly severity: 'block' | 'review' | 'info';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly observed: string;
  readonly expected: string;
  readonly source: string;
  readonly detail: string;
  readonly nextStep: string;
  readonly blocking: boolean;
}

function severityFor(state: CompatibilityState): 'block' | 'review' | 'info' {
  if (state === 'scan_error' || state === 'incompatible') return 'block';
  if (state === 'degraded') return 'review';
  return 'info';
}

function specFor(code: string): { status: CompatibilityState; evidenceType: ReportEvidence['type'] } {
  const spec = C1_FINDING_CODES[code];
  if (spec === undefined) throw new Error(`finding code "${code}" is not registered for C1`);
  return { status: spec.minStatus, evidenceType: spec.evidenceLevel };
}

/**
 * Map a reconciliation outcome to a finding. `enabled` distinguishes a plugin
 * that is still declared (a genuine scan error) from one that was removed from
 * the manifest but lingers in the lockfile.
 */
export function findingForReconcile(input: {
  readonly code: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly manifestSpecifier: string | null;
  readonly lockVersion: string | null;
  readonly actualVersion: string | null;
  readonly versions: readonly string[];
  readonly lockPath: string;
}): DerivedFinding {
  const { code, name, enabled } = input;
  const base = { code, subject: name, confidence: 'high' as const, blocking: false };

  switch (code) {
    case 'version-skew-manifest-lock': {
      const spec = specFor(code);
      return {
        ...base,
        status: spec.status,
        severity: severityFor(spec.status),
        observed: `manifest 声明 ${String(input.manifestSpecifier)}，lockfile 解析为 ${String(input.lockVersion)}`,
        expected: 'manifest 与 lockfile 解析出同一版本',
        source: input.lockPath,
        detail: 'manifest/lock 不一致，需要重新生成 lockfile',
        nextStep: '重新生成 lockfile；确认声明与实际意图一致后再复扫',
      };
    }
    case 'version-skew-lock-actual': {
      const spec = specFor(code);
      return {
        ...base,
        status: spec.status,
        severity: severityFor(spec.status),
        observed: `lockfile 解析为 ${String(input.lockVersion)}，node_modules 实际为 ${String(input.actualVersion)}`,
        expected: 'lockfile 与实际安装版本一致',
        source: input.lockPath,
        detail: 'lock/actual 不一致；候选 smoke 不得复用该 node_modules',
        nextStep: '以冻结 lockfile 重新安装依赖后再复扫',
      };
    }
    case 'package-missing': {
      // docs/01 section 7.3: a still-enabled plugin is a genuine scan error;
      // one that is no longer declared is degraded (the lockfile should have
      // been pruned).
      const status: CompatibilityState = enabled ? 'scan_error' : 'degraded';
      return {
        ...base,
        status,
        severity: severityFor(status),
        blocking: status === 'scan_error',
        observed: `lockfile 解析为 ${String(input.lockVersion)}，但 node_modules 中不存在该包目录`,
        expected: enabled ? '声明启用的插件应实际安装' : '已移除的插件不应残留在 lockfile 中',
        source: input.lockPath,
        detail: enabled ? '插件仍启用但包目录缺失' : '插件未启用但仍在 lockfile 中',
        nextStep: enabled ? '重新安装该插件或将其从 profile 中移除' : '清理 lockfile 中不再需要的条目',
      };
    }
    case 'ambiguous-resolution': {
      const spec = specFor(code);
      return {
        ...base,
        status: spec.status,
        severity: severityFor(spec.status),
        observed: `同名插件解析出多个实际版本：${input.versions.join(', ')}`,
        expected: '同名插件在 node_modules 中只有一个实际版本',
        source: input.lockPath,
        detail: '存在重复解析，版本身份不可信',
        nextStep: '清理重复安装并重新安装依赖后再复扫',
      };
    }
    default:
      throw new Error(`unhandled reconcile code "${code}"`);
  }
}

function findingId(subject: string, code: string): string {
  return `${subject}:${code}`;
}

function materializeFinding(derived: DerivedFinding, redact: (value: string) => string): ReportFinding {
  const id = findingId(derived.subject, derived.code);
  const evidenceId = `${id}#1`;
  return {
    id,
    code: derived.code,
    subject: derived.subject,
    status: derived.status,
    severity: derived.severity,
    confidence: derived.confidence,
    observed: redact(derived.observed),
    expected: redact(derived.expected),
    evidence: [
      {
        id: evidenceId,
        type: specFor(derived.code).evidenceType,
        source: redact(derived.source),
        detail: redact(derived.detail),
      },
    ],
    location: redact(derived.source),
    nextStep: redact(derived.nextStep),
    blocking: derived.blocking,
  };
}

export interface ScanProfileOptions {
  readonly dshHome?: string;
  readonly tmpPaths?: readonly string[];
  readonly exposePaths?: boolean;
  /** Override where profile artifacts are looked for (tests use synthetic fixtures). */
  readonly layout?: ProfileLayout;
}

/**
 * Scan one profile directory and return the inventory: profile identity, the
 * per-plugin three-way identity, identity findings and the aggregated summary.
 */
export function scanProfile(profilePath: string, options: ScanProfileOptions = {}): ProfileScan {
  const resolvedProfile = path.resolve(profilePath);
  const dshHome = options.dshHome ?? path.resolve(resolvedProfile, '..', '..');
  const redact = createRedactor({
    dshHome,
    profilePath: resolvedProfile,
    tmpPaths: options.tmpPaths ?? [],
    exposePaths: options.exposePaths ?? false,
  });

  const layout = options.layout ?? defaultProfileLayout();
  const manifest = parseProfileManifest(resolvedProfile, layout);
  const lock = parsePnpmLock(resolvedProfile, layout);
  const reconcile = reconcilePlugins(resolvedProfile, layout);

  const profile: ProfileIdentity = {
    name: manifest.name ?? 'unknown',
    manifestDigest: sha256Digest(path.join(resolvedProfile, layout.manifest)),
    lockDigest: sha256Digest(path.join(resolvedProfile, layout.lockfile)),
  };

  const findings: ReportFinding[] = [];
  const plugins: PluginInventory[] = [];

  if (reconcile.error !== null) {
    const derived: DerivedFinding = {
      code: 'scan-infrastructure-error',
      subject: 'host',
      status: 'scan_error',
      severity: 'block',
      confidence: 'high',
      observed: reconcile.error.message,
      expected: '可完整读取 profile manifest 与 lockfile',
      source: reconcile.error.source,
      detail: '扫描基础设施失败，检查器无法给出兼容结论',
      nextStep: '修复文件权限或损坏文件后重新扫描',
      blocking: true,
    };
    findings.push(materializeFinding(derived, redact));
  }

  for (const name of reconcile.pluginOrder) {
    const plugin = reconcile.byName.get(name);
    if (plugin === undefined) continue;

    const pluginFindings: ReportFinding[] = [];
    if (plugin.reconcileCode !== null) {
      const actualVersions = reconcile.actualVersions.get(name) ?? [];
      const derived = findingForReconcile({
        code: plugin.reconcileCode,
        name,
        enabled: plugin.enabled,
        manifestSpecifier: plugin.manifestSpecifier,
        lockVersion: plugin.lockVersion,
        actualVersion: plugin.actualVersion,
        versions: actualVersions,
        lockPath: lock.path,
      });
      pluginFindings.push(materializeFinding(derived, redact));
    }

    findings.push(...pluginFindings);
    plugins.push({
      ...plugin,
      status: aggregateStatus(pluginFindings.map((f) => f.status)),
      evidenceIds: pluginFindings.flatMap((f) => f.evidence.map((e) => e.id)),
      smokeCoverage: {
        result: 'not-run',
        scope: [],
        notCovered: ['隔离启动验证（C1 scan 未执行）', '插件功能行为与宿主 API 兼容性'],
        evidenceIds: [],
      },
      uncheckedFeatures: ['插件功能行为', '运行时宿主 API 可用性'],
    });
  }

  const hostLevelStates = findings
    .filter((f) => f.subject === 'host')
    .map((f) => f.status);
  const summaryStatus = aggregateStatus([...hostLevelStates, ...plugins.map((p) => p.status)]);

  return {
    profile,
    plugins,
    findings,
    summary: {
      status: summaryStatus,
      blocking: findings.filter((f) => f.blocking).length,
      review: findings.filter((f) => f.severity === 'review' && !f.blocking).length,
    },
    redact,
  };
}

export interface BuildReportInput {
  readonly scan: ProfileScan;
  readonly host: HostIdentity;
  readonly run: RunMetadata;
}

export interface BuiltReport {
  readonly report: Report;
  readonly json: string;
}

/**
 * Project an internal plugin inventory onto the exact report v1 plugin shape.
 *
 * The schema sets `additionalProperties: false`, so internal diagnostics
 * (`ambiguous`, `reconcileCode`) must not leak into the wire format. Listing
 * the fields explicitly here makes that boundary a single reviewable place
 * rather than an implicit spread.
 */
export function toReportPlugin(plugin: PluginInventory): ReportPlugin {
  return {
    name: plugin.name,
    loaderIds: [...plugin.loaderIds],
    enabled: plugin.enabled,
    manifestSpecifier: plugin.manifestSpecifier,
    lockVersion: plugin.lockVersion,
    actualVersion: plugin.actualVersion,
    integrity: plugin.integrity,
    status: plugin.status,
    evidenceIds: [...plugin.evidenceIds],
    smokeCoverage: {
      result: plugin.smokeCoverage.result,
      scope: [...plugin.smokeCoverage.scope],
      notCovered: [...plugin.smokeCoverage.notCovered],
      evidenceIds: [...plugin.smokeCoverage.evidenceIds],
    },
    uncheckedFeatures: [...plugin.uncheckedFeatures],
  };
}

/**
 * Compose a schema v1 report from a scan and a host identity. Host level
 * findings (version skew, unresolved identity) are added here so the summary
 * reflects both host and plugin state.
 */
export function buildReport(input: BuildReportInput): BuiltReport {
  const { scan, host, run } = input;
  const redact = scan.redact;
  const findings: ReportFinding[] = [...scan.findings];

  if (!host.resolved && host.error !== null) {
    const derived: DerivedFinding = {
      code: 'host-identity-unresolved',
      subject: 'host',
      status: 'scan_error',
      severity: 'block',
      confidence: 'high',
      observed: host.error.message,
      expected: '可解析 dsh 可执行文件与其包版本',
      source: host.error.source,
      detail: '宿主身份无法解析，扫描结果不得给出绿色结论',
      nextStep: '确认 dsh 路径正确且可读后重新扫描',
      blocking: true,
    };
    findings.unshift(materializeFinding(derived, redact));
  }

  const skewed = host.corePackages.filter(
    (pkg) => pkg.expectedVersion !== undefined && pkg.expectedVersion !== pkg.version,
  );
  if (host.cliVersion !== null && skewed.length > 0) {
    // Summarize by version: a real host can carry hundreds of core packages, and
    // enumerating every one buries the signal. Per-package detail stays available
    // in host.corePackages for consumers that need it.
    const byVersion = new Map<string, number>();
    for (const pkg of skewed) byVersion.set(pkg.version, (byVersion.get(pkg.version) ?? 0) + 1);
    const groups = [...byVersion.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([version, count]) => `${count} 个核心包为 ${version}`);
    const samples = skewed.slice(0, 3).map((pkg) => pkg.name).join(', ');
    const derived: DerivedFinding = {
      code: 'host-version-skew',
      subject: 'host',
      status: 'degraded',
      severity: 'review',
      confidence: 'high',
      observed: `宿主 CLI 为 ${String(host.cliVersion)}，但 ${groups.join('；')}（如 ${samples}）`,
      expected: '宿主 CLI 版本与核心包实际版本一致',
      source: host.packageRoot ?? host.binaryRealpath ?? '<unresolved>',
      detail: `${skewed.length} 个核心包版本与 CLI 身份偏移，需人工复核；完整清单见 host.corePackages`,
      nextStep: '对齐 dsh 安装版本后重新扫描',
      blocking: false,
    };
    findings.unshift(materializeFinding(derived, redact));
  }

  const plugins = scan.plugins.map((plugin) =>
    toReportPlugin({
      ...plugin,
      evidenceIds: findings.filter((f) => f.subject === plugin.name).flatMap((f) => f.evidence.map((e) => e.id)),
    }),
  );

  const hostAndPluginStates = [
    ...findings.filter((f) => f.subject === 'host').map((f) => f.status),
    ...plugins.map((p) => p.status),
  ];
  const summaryStatus = aggregateStatus(hostAndPluginStates);

  const report: Report = {
    schemaVersion: 1,
    run,
    host: {
      binaryInput: host.resolved ? redact(host.binaryInput) : '<unresolved>',
      binaryRealpath: host.binaryRealpath === null ? '<unresolved>' : redact(host.binaryRealpath),
      cliVersion: host.cliVersion ?? '0.0.0',
      nodeVersion: host.nodeVersion,
      corePackages: host.corePackages,
    },
    profile: scan.profile,
    plugins,
    findings,
    summary: {
      status: summaryStatus,
      blocking: findings.filter((f) => f.blocking).length,
      review: findings.filter((f) => f.severity === 'review' && !f.blocking).length,
    },
  };

  return { report, json: JSON.stringify(report, null, 2) };
}
