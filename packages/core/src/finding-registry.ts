/**
 * The frozen finding-code registry (docs/07-m0-contract.md section 4).
 *
 * One row per code: its minimum status, its evidence level, the milestone that
 * owns it, and its semantic. `materializeFinding` refuses to emit a code that
 * is absent here, so every finding stays traceable to the frozen contract.
 *
 * C2 additive rows (issue #14, scope_revision 2, confirmed 2026-10-14):
 * `rule-input-unparseable` and `peer-resolution-missing`. Both are additive —
 * no existing code, state, exit code or schema structure changed.
 */

import type { CompatibilityState, EvidenceLevel } from './inventory-types.js';

export interface FindingCodeSpec {
  readonly minStatus: CompatibilityState;
  readonly evidenceLevel: EvidenceLevel;
  readonly semantic: string;
  readonly owner: 'C1' | 'C2';
}

const REGISTRY_ROWS: readonly (FindingCodeSpec & { readonly code: string })[] = Object.freeze([
  { code: 'host-version-skew', minStatus: 'degraded', evidenceLevel: 'lock', semantic: '宿主 CLI 版本与核心包实际版本偏移', owner: 'C1' },
  { code: 'host-identity-unresolved', minStatus: 'scan_error', evidenceLevel: 'lock', semantic: '无法解析宿主二进制或版本身份', owner: 'C1' },
  { code: 'plugin-engine-mismatch', minStatus: 'incompatible', evidenceLevel: 'manifest', semantic: 'dsh.engines 声明与宿主版本冲突', owner: 'C2' },
  { code: 'engine-declaration-missing', minStatus: 'unknown', evidenceLevel: 'manifest', semantic: '缺少引擎声明且无其他可判证据', owner: 'C2' },
  { code: 'engine-range-match', minStatus: 'declared_compatible', evidenceLevel: 'manifest', semantic: '引擎声明范围覆盖当前宿主版本', owner: 'C2' },
  { code: 'peer-mismatch-mandatory', minStatus: 'incompatible', evidenceLevel: 'manifest', semantic: 'mandatory peer 依赖范围不匹配', owner: 'C2' },
  { code: 'peer-mismatch-optional', minStatus: 'unknown', evidenceLevel: 'manifest', semantic: 'optional peer 不匹配，仅记录不阻断', owner: 'C2' },
  { code: 'version-skew-manifest-lock', minStatus: 'degraded', evidenceLevel: 'lock', semantic: 'manifest 与 lockfile 解析版本不一致', owner: 'C1' },
  { code: 'version-skew-lock-actual', minStatus: 'degraded', evidenceLevel: 'lock', semantic: 'lockfile 与实际安装版本不一致', owner: 'C1' },
  { code: 'package-missing', minStatus: 'scan_error', evidenceLevel: 'lock', semantic: '声明启用的插件在 node_modules 中缺失', owner: 'C1' },
  { code: 'ambiguous-resolution', minStatus: 'degraded', evidenceLevel: 'lock', semantic: '同名插件解析出多个实际版本', owner: 'C1' },
  { code: 'missing-host-api', minStatus: 'incompatible', evidenceLevel: 'host_api', semantic: '插件引用的宿主 API 明确不存在', owner: 'C2' },
  { code: 'analysis-incomplete', minStatus: 'unknown', evidenceLevel: 'heuristic', semantic: '静态分析无法覆盖的 API 使用方式', owner: 'C2' },
  { code: 'known-matrix-allow', minStatus: 'declared_compatible', evidenceLevel: 'known_matrix', semantic: '已验证兼容矩阵记录允许', owner: 'C2' },
  { code: 'known-matrix-deny', minStatus: 'incompatible', evidenceLevel: 'known_matrix', semantic: '已验证兼容矩阵记录拒绝', owner: 'C2' },
  { code: 'loader-failure', minStatus: 'incompatible', evidenceLevel: 'runtime', semantic: 'smoke 或运行时 loader 加载失败', owner: 'C2' },
  { code: 'smoke-passed', minStatus: 'validated_compatible', evidenceLevel: 'runtime', semantic: '隔离启动验证在声明范围内通过', owner: 'C2' },
  { code: 'smoke-unavailable', minStatus: 'unknown', evidenceLevel: 'runtime', semantic: '无法建立隔离环境执行 smoke', owner: 'C2' },
  { code: 'smoke-blocked', minStatus: 'unknown', evidenceLevel: 'runtime', semantic: '需要凭据或外部服务才能启动', owner: 'C2' },
  { code: 'degraded-runtime-errors', minStatus: 'degraded', evidenceLevel: 'runtime', semantic: '启动后持续错误或健康探针失败', owner: 'C2' },
  { code: 'scan-infrastructure-error', minStatus: 'scan_error', evidenceLevel: 'lock', semantic: '扫描基础设施失败', owner: 'C1' },
  // C2 additive rows (issue #14, scope_revision 2):
  { code: 'rule-input-unparseable', minStatus: 'unknown', evidenceLevel: 'manifest', semantic: '声明的规则输入（engines/peer 范围）无法解析为有效 semver，规则无法判定', owner: 'C2' },
  { code: 'peer-resolution-missing', minStatus: 'unknown', evidenceLevel: 'manifest', semantic: '声明的 mandatory peer 无法在宿主核心包或 profile 实际安装中解析出可核对版本', owner: 'C2' },
]);

export const FINDING_CODE_REGISTRY: Readonly<Record<string, FindingCodeSpec>> = Object.freeze(
  Object.fromEntries(
    REGISTRY_ROWS.map(({ code, minStatus, evidenceLevel, semantic, owner }) => [
      code,
      { code, minStatus, evidenceLevel, semantic, owner },
    ]),
  ),
);

export function isRegisteredFindingCode(code: string): boolean {
  return Object.hasOwn(FINDING_CODE_REGISTRY, code);
}

/**
 * Rule precedence (docs/01 section 8.2), lower number = higher priority.
 * Status aggregation in report.ts is the actual conflict resolution; the rank
 * drives deterministic finding order within a report.
 */
export const RULE_PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  'host-identity-unresolved': 1,
  'scan-infrastructure-error': 1,
  'package-missing': 1,
  'ambiguous-resolution': 1,
  'version-skew-manifest-lock': 1,
  'version-skew-lock-actual': 1,
  'host-version-skew': 1,
  'loader-failure': 2,
  'smoke-passed': 2,
  'known-matrix-deny': 3,
  'plugin-engine-mismatch': 4,
  'peer-mismatch-mandatory': 5,
  'missing-host-api': 6,
  'degraded-runtime-errors': 7,
  'known-matrix-allow': 8,
  'engine-range-match': 9,
  'engine-declaration-missing': 10,
  'peer-mismatch-optional': 10,
  'analysis-incomplete': 10,
  'smoke-unavailable': 10,
  'smoke-blocked': 10,
  'rule-input-unparseable': 10,
  'peer-resolution-missing': 10,
});

export function precedenceRank(code: string): number {
  return RULE_PRECEDENCE[code] ?? Number.MAX_SAFE_INTEGER;
}
