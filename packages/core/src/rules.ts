/**
 * The C2 compatibility rule engine.
 *
 * For every plugin discovered by C1 it evaluates, in frozen precedence order
 * (docs/01 section 8.2, docs/07 section 7):
 *
 *   3. known matrix deny;
 *   4. dsh.engines mismatch;
 *   5. mandatory peer mismatch;
 *   6. missing host API;
 *   8. known matrix allow;
 *   9. manifest range match;
 *  10. heuristic risk and information gaps.
 *
 * Conflict resolution is the M0 state aggregation: a higher-priority finding
 * can never be overridden by a lower-priority allow, `unknown` outranks every
 * green state, and a plugin with no findings is `unknown` — never green.
 *
 * Everything here is offline, static and deterministic: no plugin code runs,
 * no network is touched, and the same input always yields the same finding
 * order and IDs.
 */

import fs from 'node:fs';
import path from 'node:path';

import { satisfiesRange, isValidRange, isStandardVersion } from './semver.js';
import {
  loadBundledKnownMatrix,
  lookupKnownMatrix,
  entryAllowedForDoctor,
} from './known-matrix.js';
import type { KnownMatrix } from './known-matrix.js';
import {
  buildHostApiIndex,
  extractPluginApiUsage,
  evaluateApiSurface,
  DEFAULT_API_LIMITS,
} from './api-surface.js';
import type { ApiScanLimits, HostApiIndex, PluginApiUsage } from './api-surface.js';
import { isPackageName } from './version.js';
import { FINDING_CODE_REGISTRY, precedenceRank } from './finding-registry.js';
import { aggregateStatus } from './inventory-types.js';
import type {
  CompatibilityState,
  HostIdentity,
  ParseError,
  ProfileScan,
  ReportFinding,
  SmokeCoverage,
} from './inventory-types.js';

export type { KnownMatrix, KnownMatrixEntry, MatrixMatch } from './known-matrix.js';
export type { HostApiIndex, PluginApiUsage, ApiReference, ApiSurfaceEvaluation, ApiScanLimits } from './api-surface.js';

/** One peer dependency declaration read from an installed plugin manifest. */
export interface PeerDeclaration {
  readonly name: string;
  readonly range: string;
  readonly optional: boolean;
}

/** Rule-relevant declarations of one installed plugin package. */
export interface PluginManifestRules {
  readonly enginesDsh: string | null;
  /** True when `dsh.engines.dsh` exists but could not be used. */
  readonly enginesDshPresent: boolean;
  readonly peers: readonly PeerDeclaration[];
  readonly manifestError: ParseError | null;
  /** Declaration shapes that exist but cannot be evaluated. */
  readonly unparseableInputs: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read `dsh.engines` and `peerDependencies`(+Meta) from an installed plugin
 * package. The first parseable manifest wins — the directories are copies of
 * the same package identity. A manifest that cannot be read at all is
 * returned as `manifestError`; the caller then leaves judgement to the C1
 * identity findings instead of inventing declarations.
 */
export function readPluginManifestRules(packageDirs: readonly string[]): PluginManifestRules {
  const empty: PluginManifestRules = {
    enginesDsh: null,
    enginesDshPresent: false,
    peers: [],
    manifestError: null,
    unparseableInputs: [],
  };
  if (packageDirs.length === 0) return empty;

  let raw: string | null = null;
  let manifestError: ParseError | null = null;
  for (const packageDir of packageDirs) {
    try {
      raw = fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8');
      break;
    } catch (error) {
      manifestError = {
        code: 'scan-infrastructure-error',
        message: `cannot read installed package manifest: ${error instanceof Error ? error.message : String(error)}`,
        source: path.join(packageDir, 'package.json'),
      };
    }
  }
  if (raw === null) return { ...empty, manifestError };

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return {
      ...empty,
      manifestError: {
        code: 'scan-infrastructure-error',
        message: 'installed package manifest is not valid JSON',
        source: packageDirs[0] as string,
      },
    };
  }
  if (!isPlainObject(manifest)) {
    return {
      ...empty,
      manifestError: {
        code: 'scan-infrastructure-error',
        message: 'installed package manifest is not an object',
        source: packageDirs[0] as string,
      },
    };
  }

  const unparseableInputs: string[] = [];
  const dsh = isPlainObject(manifest.dsh) ? manifest.dsh : undefined;
  const engines = dsh !== undefined && isPlainObject(dsh.engines) ? dsh.engines : undefined;

  let enginesDsh: string | null = null;
  let enginesDshPresent = false;
  if (engines !== undefined && Object.hasOwn(engines, 'dsh')) {
    enginesDshPresent = true;
    const value = engines.dsh;
    if (typeof value === 'string' && value !== '') enginesDsh = value;
    else unparseableInputs.push('dsh.engines.dsh 必须是字符串范围');
  }

  const peers: PeerDeclaration[] = [];
  const peerDependencies = isPlainObject(manifest.peerDependencies) ? manifest.peerDependencies : undefined;
  const peerMeta = isPlainObject(manifest.peerDependenciesMeta) ? manifest.peerDependenciesMeta : undefined;
  if (peerDependencies !== undefined) {
    for (const [name, range] of Object.entries(peerDependencies).sort(([a], [b]) => a.localeCompare(b))) {
      const optional = peerMeta !== undefined && isPlainObject(peerMeta[name]) ? peerMeta[name].optional === true : false;
      if (typeof range !== 'string' || range === '' || !isPackageName(name)) {
        unparseableInputs.push(`peer ${name}: 声明不可用`);
        continue;
      }
      peers.push({ name, range, optional });
    }
  }

  return { enginesDsh, enginesDshPresent, peers, manifestError: null, unparseableInputs };
}

/** Evidence entry for a finding under construction. */
export interface RuleEvidenceInput {
  readonly type: import('./inventory-types.js').EvidenceLevel;
  readonly source: string;
  readonly detail: string;
}

/** A pre-redacted finding under construction. */
export interface RuleFindingInput {
  readonly code: string;
  readonly subject: string;
  readonly observed: string;
  readonly expected: string;
  readonly evidence: readonly RuleEvidenceInput[];
  readonly nextStep: string;
  readonly blocking: boolean;
}

export interface RuleEvaluationInput {
  readonly scan: ProfileScan;
  readonly host: HostIdentity;
}

export interface EvaluateRulesOptions {
  /** When false, the rule engine contributes nothing (C1-only report). */
  readonly enabled?: boolean;
  readonly matrix?: KnownMatrix;
  /** Redactor applied at materialization; buildReport passes the report's. */
  readonly redact?: (value: string) => string;
  /** Injected clock for expiry policy; tests pin it, production uses now. */
  readonly now?: Date;
  readonly doctorVersion?: string;
  /** Directories indexed as the host API corpus; empty means "no corpus". */
  readonly hostApiDirs?: readonly string[];
  /** Prebuilt index override; when absent the corpus is built from hostApiDirs. */
  readonly hostApiIndex?: HostApiIndex | null;
  /** Prebuilt usage overrides keyed by plugin name (tests, C4). */
  readonly apiUsageOverrides?: ReadonlyMap<string, PluginApiUsage>;
  /** Smoke coverage overrides keyed by plugin name (the C4 seam). */
  readonly smokeCoverageByName?: ReadonlyMap<string, SmokeCoverage>;
  readonly apiLimits?: Partial<ApiScanLimits>;
}

export interface RuleEvaluationResult {
  readonly findings: readonly ReportFinding[];
  readonly statusByPlugin: ReadonlyMap<string, CompatibilityState>;
}

function hostFirstSubject(left: string, right: string): number {
  const leftRank = left === 'host' ? 0 : 1;
  const rightRank = right === 'host' ? 0 : 1;
  return leftRank !== rightRank ? leftRank - rightRank : left.localeCompare(right);
}

/** Deterministic total order over materialized findings (docs/07 section 7). */
export function compareFindingsStable(left: ReportFinding, right: ReportFinding): number {
  const rank = precedenceRank(left.code) - precedenceRank(right.code);
  if (rank !== 0) return rank;
  const subject = hostFirstSubject(left.subject, right.subject);
  if (subject !== 0) return subject;
  if (left.code !== right.code) return left.code.localeCompare(right.code);
  return left.observed.localeCompare(right.observed, 'zh-Hans-CN');
}

/**
 * The installed version of a peer package: host core packages first, then the
 * profile's actual installs. Returns every known copy so the caller can be
 * conservative (a mismatch only when NO copy satisfies).
 */
function resolvePeerVersions(
  name: string,
  host: HostIdentity,
  actualVersionsByName: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const versions = new Set<string>();
  for (const corePackage of host.corePackages) {
    if (corePackage.name === name) versions.add(corePackage.version);
  }
  for (const version of actualVersionsByName.get(name) ?? []) versions.add(version);
  return [...versions];
}

/** Materialize a rule finding with stable IDs and per-evidence ordinal IDs. */
function materializeRuleFinding(
  input: RuleFindingInput,
  redact: (value: string) => string,
): ReportFinding {
  const spec = FINDING_CODE_REGISTRY[input.code];
  if (spec === undefined) throw new Error(`finding code "${input.code}" is not registered`);
  const id = `${input.subject}:${input.code}`;
  return {
    id,
    code: input.code,
    subject: input.subject,
    status: spec.minStatus,
    severity:
      spec.minStatus === 'scan_error' || spec.minStatus === 'incompatible'
        ? 'block'
        : spec.minStatus === 'degraded'
          ? 'review'
          : 'info',
    confidence: 'high',
    observed: redact(input.observed),
    expected: redact(input.expected),
    evidence: input.evidence.map((entry, index) => ({
      id: `${id}#${index + 1}`,
      type: entry.type,
      source: redact(entry.source),
      detail: redact(entry.detail),
    })),
    location: redact(input.evidence[0]?.source ?? ''),
    nextStep: redact(input.nextStep),
    blocking: input.blocking,
  };
}

/**
 * Evaluate all C2 rules for one profile.
 *
 * Findings come back materialized (stable IDs, per-evidence IDs) with an
 * identity "redactor" — buildReport supplies the real one, so paths are
 * aliased before anything reaches a report. Per-plugin status follows the
 * frozen aggregation; a plugin without findings stays `unknown`.
 */
export function evaluateRules(
  input: RuleEvaluationInput,
  options: EvaluateRulesOptions = {},
): RuleEvaluationResult {
  const { scan, host } = input;
  const redact = options.redact ?? ((value: string): string => value);
  const matrix = options.matrix ?? loadBundledKnownMatrix();
  const now = options.now ?? new Date();
  const doctorVersion = options.doctorVersion ?? '0.0.0';

  const hostVersion = host.resolved && isStandardVersion(host.cliVersion ?? '') ? host.cliVersion : null;
  const findings: ReportFinding[] = [];
  const statusByPlugin = new Map<string, CompatibilityState>();

  const hostApiIndex: HostApiIndex | null =
    options.hostApiIndex !== undefined
      ? options.hostApiIndex
      : options.hostApiDirs !== undefined && options.hostApiDirs.length > 0
        ? buildHostApiIndex(options.hostApiDirs, options.apiLimits)
        : null;

  for (const plugin of scan.plugins) {
    if (!isPackageName(plugin.name)) continue;
    const manifest = readPluginManifestRules(plugin.packageDirs);
    if (manifest.manifestError !== null) {
      // Identity evidence failed for this package; C1 findings already speak.
      statusByPlugin.set(plugin.name, aggregateStatus([]));
      continue;
    }
    const pluginFindings: ReportFinding[] = [];
    const emit = (rule: RuleFindingInput): void => {
      pluginFindings.push(materializeRuleFinding(rule, redact));
    };
    const source = plugin.packageDirs[0] ?? plugin.name;

    const versions = plugin.actualVersion !== null ? [plugin.actualVersion] : [];
    const matrixMatches =
      hostVersion !== null
        ? lookupKnownMatrix(matrix, { hostVersion, pluginName: plugin.name, pluginVersions: versions }, { now })
        : [];
    const usableMatches = matrixMatches.filter(
      (match) => entryAllowedForDoctor(match.entry, doctorVersion) && !match.expired,
    );

    const denies = usableMatches.filter((match) => match.decision === 'deny');
    if (denies.length > 0) {
      emit({
        code: 'known-matrix-deny',
        subject: plugin.name,
        observed: `known compatibility matrix 拒绝 ${plugin.name} ${versions.join(', ') || '(版本未知)'} 在宿主 ${hostVersion ?? ''} 上`,
        expected: '组合不在已验证的 deny 记录中',
        evidence: denies.map((match) => ({
          type: 'known_matrix' as const,
          source: match.entry.source,
          detail: `${match.entry.verification}（验证于 ${match.entry.verifiedAt}）：${match.entry.reason}`,
        })),
        nextStep: '更换插件版本或升级宿主；deny 记录可追溯，不能被 manifest 声明覆盖',
        blocking: true,
      });
    }

    const allows = usableMatches.filter((match) => match.decision === 'allow');
    if (allows.length > 0) {
      emit({
        code: 'known-matrix-allow',
        subject: plugin.name,
        observed: `known compatibility matrix 记录允许 ${plugin.name} ${versions.join(', ') || '(版本未知)'} 在宿主 ${hostVersion ?? ''} 上`,
        expected: '矩阵证据支持声明级兼容（smoke 未执行，最高为 declared_compatible）',
        evidence: allows.map((match) => ({
          type: 'known_matrix' as const,
          source: match.entry.source,
          detail: `${match.entry.verification}（验证于 ${match.entry.verifiedAt}）：${match.entry.reason}`,
        })),
        nextStep: '需要更强证据时执行隔离启动验证（smoke）',
        blocking: false,
      });
    }

    if (hostVersion !== null) {
      if (manifest.enginesDsh !== null) {
        if (!isValidRange(manifest.enginesDsh)) {
          emit({
            code: 'rule-input-unparseable',
            subject: plugin.name,
            observed: `dsh.engines.dsh = '${manifest.enginesDsh}' 无法解析为有效 semver 范围`,
            expected: 'dsh.engines.dsh 是可解析的 semver 范围',
            evidence: [{ type: 'manifest', source, detail: '不可解析的声明不产生任何方向性结论' }],
            nextStep: '修正插件 manifest 的 dsh.engines.dsh 声明后重新扫描',
            blocking: false,
          });
        } else {
          const match = satisfiesRange(hostVersion, manifest.enginesDsh);
          if (match === true) {
            emit({
              code: 'engine-range-match',
              subject: plugin.name,
              observed: `dsh.engines.dsh '${manifest.enginesDsh}' 覆盖宿主版本 ${hostVersion}`,
              expected: '引擎声明覆盖当前宿主版本（smoke 未执行，最高为 declared_compatible）',
              evidence: [{ type: 'manifest', source, detail: `dsh.engines.dsh = '${manifest.enginesDsh}'` }],
              nextStep: '需要更强证据时执行隔离启动验证（smoke）',
              blocking: false,
            });
          } else {
            emit({
              code: 'plugin-engine-mismatch',
              subject: plugin.name,
              observed: `dsh.engines.dsh '${manifest.enginesDsh}' 不覆盖宿主版本 ${hostVersion}`,
              expected: '引擎声明覆盖当前宿主版本',
              evidence: [{ type: 'manifest', source, detail: `prerelease-aware 比较：宿主 ${hostVersion} ∉ ${manifest.enginesDsh}` }],
              nextStep: '更换插件版本或升级宿主后重新扫描',
              blocking: true,
            });
          }
        }
      }

      for (const peer of manifest.peers) {
        const installed = resolvePeerVersions(peer.name, host, scan.actualVersionsByName);
        if (!isValidRange(peer.range)) {
          emit({
            code: 'rule-input-unparseable',
            subject: plugin.name,
            observed: `peer ${peer.name} 的范围 '${peer.range}' 无法解析`,
            expected: 'peerDependencies 中的范围是可解析的 semver 范围',
            evidence: [{ type: 'manifest', source, detail: `peer ${peer.name}（${peer.optional ? 'optional' : 'mandatory'}）` }],
            nextStep: '修正插件 manifest 的 peerDependencies 声明后重新扫描',
            blocking: false,
          });
          continue;
        }
        if (installed.length === 0) {
          if (!peer.optional) {
            emit({
              code: 'peer-resolution-missing',
              subject: plugin.name,
              observed: `mandatory peer ${peer.name} 未能在宿主核心包或 profile 实际安装中解析出版本`,
              expected: '声明的 mandatory peer 存在可核对的安装版本',
              evidence: [{ type: 'manifest', source, detail: `peer ${peer.name} '${peer.range}'；无可核对版本` }],
              nextStep: '重新安装依赖（含 peer）后重新扫描',
              blocking: false,
            });
          }
          continue;
        }
        if (installed.some((version) => satisfiesRange(version, peer.range) === true)) continue;
        if (peer.optional) {
          emit({
            code: 'peer-mismatch-optional',
            subject: plugin.name,
            observed: `optional peer ${peer.name} '${peer.range}' 不匹配实际安装 ${installed.join(', ')}`,
            expected: 'optional peer 范围匹配（不匹配仅记录，不单独阻断）',
            evidence: [{ type: 'manifest', source, detail: `peer ${peer.name}（optional）'${peer.range}'` }],
            nextStep: '复核 optional peer 范围与实际安装版本',
            blocking: false,
          });
        } else {
          emit({
            code: 'peer-mismatch-mandatory',
            subject: plugin.name,
            observed: `mandatory peer ${peer.name} '${peer.range}' 不匹配实际安装 ${installed.join(', ')}`,
            expected: 'mandatory peer 范围覆盖实际安装版本',
            evidence: [{ type: 'manifest', source, detail: `peer ${peer.name}（mandatory）'${peer.range}'` }],
            nextStep: '更换插件版本或安装满足范围的 peer 依赖后重新扫描',
            blocking: true,
          });
        }
      }
    }

    // API surface check. Only an installed plugin carries distributed code.
    if (plugin.packageDirs.length > 0) {
      const usage =
        options.apiUsageOverrides?.get(plugin.name) ??
        extractPluginApiUsage(plugin.packageDirs, options.apiLimits);
      const surface = evaluateApiSurface(hostApiIndex, usage);
      if (surface.missing.length > 0) {
        emit({
          code: 'missing-host-api',
          subject: plugin.name,
          observed: `插件引用的宿主 API 在当前宿主导出表中不存在：${surface.missing.map((m) => `ctx.${m.service}.${m.method}`).join(', ')}`,
          expected: '引用的 ctx.<service>.<method> 在宿主语料中声明',
          evidence: surface.missing.map((reference) => ({
            type: 'host_api' as const,
            source: reference.file,
            detail: `ctx.${reference.service}.${reference.method}`,
          })),
          nextStep: '更换插件版本或升级宿主；缺失 API 不能被 manifest 声明覆盖',
          blocking: true,
        });
      } else if (surface.incomplete) {
        emit({
          code: 'analysis-incomplete',
          subject: plugin.name,
          observed: '静态分析无法完整覆盖宿主 API 使用方式（语料缺失、受限或存在动态访问）',
          expected: '可完整建立宿主 API 语料与静态引用清单',
          evidence: [{ type: 'heuristic', source, detail: '仅提升不确定性，不产生任何方向的结论' }],
          nextStep: '必要时用隔离启动验证获得运行时证据',
          blocking: false,
        });
      }
    }

    // Manifest-level information gap. Suppressed when the matrix already
    // produced a decidable conclusion (its semantics: "且无其他可判证据").
    if (!manifest.enginesDshPresent && manifest.unparseableInputs.length === 0 && usableMatches.length === 0 && hostVersion !== null) {
      const peerNames = manifest.peers.map((peer) => peer.name);
      emit({
        code: 'engine-declaration-missing',
        subject: plugin.name,
        observed:
          peerNames.length > 0
            ? `缺少 dsh.engines.dsh 声明（peer 声明：${peerNames.join(', ')}），且无匹配的 known matrix 记录`
            : '缺少 dsh.engines.dsh 与 peer 声明，且无匹配的 known matrix 记录',
        expected: '存在引擎声明、peer 证据或经验证的矩阵记录之一',
        evidence: [{ type: 'manifest', source, detail: '信息不足按 unknown 处理，不给绿色' }],
        nextStep: '由插件作者补充 dsh.engines.dsh 声明，或将组合加入已验证兼容矩阵',
        blocking: false,
      });
    }

    // Smoke seam (docs/07 section 1): validated_compatible requires a positive
    // manifest-level declaration AND a completed isolated startup verification.
    const smokeCoverage = options.smokeCoverageByName?.get(plugin.name) ?? plugin.smokeCoverage;
    const positiveManifest = pluginFindings.some(
      (f) => f.code === 'engine-range-match' || f.code === 'known-matrix-allow',
    );
    const hasBlockingRule = pluginFindings.some((f) => f.status === 'incompatible' || f.status === 'scan_error');
    const hasUnresolved = pluginFindings.some((f) => f.status === 'unknown');
    if (smokeCoverage.result === 'passed' && positiveManifest && !hasBlockingRule && !hasUnresolved) {
      emit({
        code: 'smoke-passed',
        subject: plugin.name,
        observed: `隔离启动验证通过（范围：${smokeCoverage.scope.join(', ') || '未声明'}；未覆盖：${smokeCoverage.notCovered.join(', ') || '无'}）`,
        expected: '声明检查与隔离启动验证共同支持 validated_compatible',
        evidence: [{ type: 'runtime', source: 'smoke', detail: `scope=[${smokeCoverage.scope.join(', ')}]` }],
        nextStep: '无；报告标明 smoke 未覆盖的功能',
        blocking: false,
      });
    }

    pluginFindings.sort(compareFindingsStable);
    findings.push(...pluginFindings);
    statusByPlugin.set(plugin.name, aggregateStatus(pluginFindings.map((f) => f.status)));
  }

  return { findings, statusByPlugin };
}
