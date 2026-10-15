# C2 兼容规则引擎证据记录

状态：C2 交付物完成并通过本地全量验证；`specification` 与 `security-quality` 评审待 PR 提出、由维护者完成（单维护者场景：以下为作者自评 + 自动化证据，不构成独立审计）。

记录日期：2026-10-15

## Coordination record

- Implementation Issue：[#14](https://github.com/certainlyForgiveHer/dsh-compat-suite/issues/14)（milestone C2，单 Agent 模式）
- `claim_id`：`issue-14-20261014T183000Z-dsh-compat-impl-01`（(CLAIM_CONFIRMED 2026-10-14T18:30:00Z 会话内协调，维护者明确指示完成目录内待完成任务）
- `agent_id`：`dsh-compat-impl-01`
- 分支：`feat/14-rule-engine`（worktree `dsh-compat-suite-wt-14-dsh-compat-impl-01`，产品根之外）
- `base_sha`：`5058e02ca1b50ad0fba015b8340caab5aeecca9a`（= C1 合并后的 `main`）
- 范围修订：
  - `scope_revision 2`（confirmed）：docs/07 §4 注册表 additive 追加 `rule-input-unparseable`、`peer-resolution-missing`（不改动任何既有语义）
  - `scope_revision 3`（confirmed）：`scripts/verify-repository.mjs` 的 core 依赖守卫修正为实际 G0 不变量（禁止依赖 workspace 包；允许精确锁定第三方依赖，本任务新增 `semver@7.8.5`）
- 实现提交：失败基线 `3157c18` → `7bfdbfa`（规则引擎全套）→ `118e54b`(真实扫描反馈的聚合/信任边界修复 + 文档)

## Delivered surface

| 交付物 | 路径 |
| --- | --- |
| prerelease-aware semver 评估层（成熟 `semver` 库封装，严格解析、排序、范围判定） | `packages/core/src/semver.ts` |
| 冻结 finding code 注册表单源（docs/07 §4 全表 + 两条 additive）与规则优先级 | `packages/core/src/finding-registry.ts` |
| known compatibility matrix：数据 schema/校验/过期策略/内置数据 | `packages/core/src/known-matrix.ts`、`packages/core/data/known-matrix-v1.json` |
| engines / mandatory–optional peer 规则、规则优先级、冲突消解、状态聚合、smoke seam | `packages/core/src/rules.ts` |
| API surface：宿主语料索引 + 插件用法提取 + 缺失判定（限额、minified 处理） | `packages/core/src/api-surface.ts` |
| `explain` 数据层（CLI 命令属 C5） | `packages/core/src/explain.ts` |
| scan 管线接入（报告合并、确定性排序、脱敏、状态重算） | `packages/core/src/report.ts`、`reconcile.ts`、`inventory-types.ts`、`scan.ts`、`index.ts` |
| K01–K06 静态矩阵（合成最小 fixture + README） | `packages/core/test/fixtures/rules/` |
| 测试套件 | `test/semver.test.mjs`、`test/rules.test.mjs`、`test/api-surface.test.mjs`、`test/known-matrix.test.mjs`、`test/matrix.test.mjs` |

## Process: failing baseline first

按 AGENTS.md §3 第 8 步先提交失败基线 `3157c18`：六个新测试文件在实现缺席时以 `ERR_MODULE_NOT_FOUND` 全部失败（输出存档 `/tmp/c2-failing-baseline.log`，9 个失败文件）。实现提交后转绿。

## Local verification（HEAD `7bfdbfa` 后 + 修复提交 `118e54b`）

写入前基线（base_sha）：`verify:g0`、`verify:m0`、22+1 项契约测试全绿，工作树干净。

实现后（`pnpm run verify`，exit 0）：

| Check | Command | Result |
| --- | --- | --- |
| G0 gate（依赖守卫按 scope_revision 3 修订） | `node scripts/verify-repository.mjs` | pass |
| M0 gate（含 docs/07 注册表 additive 行校验） | `node scripts/verify-m0.mjs` | pass |
| Contract tests | `node --test tests/contract/*.test.mjs` | pass；23/23 |
| Build + Typecheck | `pnpm -r run build && pnpm -r run typecheck` | pass；0 error（strict） |
| Package tests | `pnpm -r run test` | pass；core 144、cli 1、plugin 1 |
| 全链路 | `pnpm run verify` | exit 0 |
| 边界 | `git status --short` | 空（clean） |

### 分支覆盖率（docs/04 §8.3：rule engine ≥ 95%）

`node --test --experimental-test-coverage packages/core/test/*.test.mjs`（完整测试套件）：

| 模块（dist 编译产物） | line % | branch % | funcs % |
| --- | --- | --- | --- |
| rules.js | 100.00 | 96.58 | 100.00 |
| api-surface.js | 99.15 | 96.20 | 100.00 |
| known-matrix.js | 100.00 | 98.08 | 100.00 |
| finding-registry.js | 100.00 | 100.00 | 100.00 |
| semver.js | 100.00 | 96.88 | 100.00 |
| explain.js | 100.00 | 100.00 | 100.00 |

仅存的未覆盖分支均为防御性守卫：`api-surface.js` 85-86（readdir 与 statSync 之间文件消失的 TOCTOU；确定性单进程测试无法注入）。原始输出：`/tmp/c2-coverage-final.log`（会话临时目录，未入库）。

### 真实 profile 只读演示（脱敏前不收证据）

本机只读执行 `scan --json --dsh-bin dsh`（宿主 `0.2.0-rc.2`，13 个插件，37 findings，0 重复 ID；advisory 退出码 1）：
`@cocofhu/skillhub` / `@openviking/dsh-memory-plugin` / `dsh-lsp-actions` 因 mandatory peer 范围不匹配给出 `incompatible`；其余为 `unknown`（声明缺失/peer 不可核对/API 语料不可信其一）。演示仅作运行示例，不进入仓库证据。

### CI

PR 建立后由 `PR quality` 工作流验证（node 22.x/24.x/26.x 矩阵）。

## Acceptance criteria 逐项（Issue #14）

| # | 验收条件 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | semver：`0.1.1-rc.2` 对 `>=0.1.2-alpha.1` 为 false 等 + 性质测试（反对称/传递/全序，固定种子 0xC2/0xC3，非第二套手写 oracle） | 通过 | `test/semver.test.mjs`：解析/排序/范围/prerelease 门槛 19 项 + 2 项性质测试 |
| 2 | AgentTeams `0.1.15` × `0.1.1-rc.2` 非绿（deny + missing host API，双证据链） | 通过 | `test/matrix.test.mjs` K01（两种语料状态均 incompatible） |
| 3 | task-board `0.3.10`、skill-explorer `0.3.10` → `incompatible`（engine `>=0.1.2-alpha.1` / mandatory peer `>=0.2.0-rc.2`） | 通过 | K03（engine）、K05（peer） |
| 4 | 缺 engine/peer 且无矩阵 → `unknown`，不得绿色 | 通过 | `test/rules.test.mjs`（engine-declaration-missing 默认位）+ K02/K04/K06 反例对比 |
| 5 | runtime deny / 明确缺失 API 不被宽泛 manifest allow 覆盖；矩阵 allow 过期降级 unknown | 通过 | deny 覆盖 engine match 测试、missing-api + engine match 测试、expired allow 测试 |
| 6 | mandatory peer → `incompatible`；optional peer → 记录 `unknown` 不单独阻断；peer 正例/反例/冲突/证据不足 4 类测试 | 通过 | `test/rules.test.mjs` peer 组 6 项 + 矩阵聚合回归 |
| 7 | 同一输入 finding 顺序与 ID 稳定 | 通过 | K fixtures 重复扫描 byte-identical、规则重复 evaluation byte-identical、真实 profile 0 重复 ID |
| 8 | K01–K06 静态矩阵按 docs/04 §5 全通过（合成 fixture + README 唯一预期） | 通过 | `test/fixtures/rules/{k01..k06}/README.md` + `test/matrix.test.mjs`（每个 K 用例均校验 schema） |
| 9 | rule engine 分支覆盖率 ≥95% | 通过 | 上表全部模块 ≥96%；唯一未覆盖臂为 TOCTOU 防御守卫 |
| 10 | `scan` 全链路 schema v1 + 脱敏 + 契约不回退 | 通过 | contract 23/23；matrix 测试逐例 schema 校验；live scan 0 重复 ID |

## 每条规则的正反例（docs/04 §8.3 要求）

| 规则 | 命中正例 | 不命中反例 | 与更高优先级冲突 | 证据不足 |
| --- | --- | --- | --- | --- |
| engine match | K04/K06（domain 覆盖） | K03（不覆盖） | deny > engine match（`plugin-doomed`） | 宿主版本不可解析 → 无判定 |
| engine mismatch | `>=0.1.2-alpha.1`（K03） | 覆盖时不产出 | — | 非标准宿主版本（`garbage+++1`） |
| mandatory peer | 满足时不产出（`plugin-peer-ok`） | K05 mismatch | deny/missing-api 均高于 | 无可核对版本 → peer-resolution-missing |
| optional peer | 缺失或匹配不产出 | 已装不匹配 → 记录 | unknown 压过绿色（聚合） | — |
| known matrix | K01 deny / K02 allow | 无匹配条目 | deny 压过 engine match | allow 过期 → unknown |
| missing-host-api | K01 `registerContinuableSetup` | `registerSetup` 存在时不产出 | engine match 不覆盖 | 语料不可信 → analysis-incomplete |
| rule-input-unparseable | engine/peer 范围垃圾 | 合法范围不产出 | deny/allow 均高于 | —（该 finding 即"证据不足"本体） |

## AgentTeams 缺失 API golden finding（K01）

`report.verify` 后的固定 golden（K01 fixture + 内置矩阵，宿主语料注入）：

```json
{
  "id": "@nanmicoder/dsh-agent-teams:missing-host-api",
  "code": "missing-host-api",
  "subject": "@nanmicoder/dsh-agent-teams",
  "status": "incompatible",
  "severity": "block",
  "confidence": "high",
  "observed": "插件引用的宿主 API 在当前宿主导出表中不存在：ctx.subagents.registerContinuableSetup",
  "expected": "引用的 ctx.<service>.<method> 在宿主语料中声明",
  "evidence": [
    { "id": "@nanmicoder/dsh-agent-teams:missing-host-api#1", "type": "host_api", "source": "index.js", "detail": "ctx.subagents.registerContinuableSetup" }
  ],
  "nextStep": "更换插件版本或升级宿主；缺失 API 不能被 manifest 声明覆盖",
  "blocking": true
}
```

同组合同时产出 `known-matrix-deny`（evidence `fixtures/sources.lock.json#agent-teams-0.1.15`，含 `sha512` 工件摘要），二者按确定性排序落地（rank 3 → rank 6）。

## 规则优先级 property/时序验证

- 排位表与冲突消解由 `AGGREGATION_ORDER` + `RULE_PRECEDENCE` 实施：deny(3) > engine-mismatch(4) > mandatory peer(5) > missing-api(6) > allow(8) > engine-match(9) > 信息缺失(10)。
- 同输入重放：6 个 K fixture 分别双次扫描 JSON byte-identical；`evaluateRules` 对合成 profile 双次 byte-identical；真实 profile 13 插件 0 重复 ID。
- 状态聚合顺序满足 docs/07 §7（unknown 压绿等）由既有 `test:contract` + 六状态 golden 保持不回退。

## M0 additive 注册表扩充（供维护者复核）

| code | 语义 | 最低状态 | 证据等级 | 需要的原因 |
| --- | --- | --- | --- | --- |
| `rule-input-unparseable` | 声明的规则输入（engines/peer 范围）无法解析为有效 semver | unknown | manifest | docs/01 §8.3"非法或自定义版本字符串产生 unknown，不能静默强转" |
| `peer-resolution-missing` | mandatory peer 无可核对安装版本 | unknown | manifest | 不判定会漏掉未决问题（绿灯泄漏），误判 mismatch 会产生 false red |

均为 additive 行；六状态、退出码、schema 结构、既有 code 语义零变更；`verify-m0.mjs` 对 docs/07 表的解析（kebab-case、语义长度、状态/证据合法性）通过。

## 已知限制（含 C4/后续建议）

1. **宿主内置第三方库不计入 peer 解析源**：仅 `@deepseek-ai/*` 宿主核心包与 profile 实际安装可控；插件声明 `react` 等宿主内置库为 mandatory peer 且本机未安装时 → `peer-resolution-missing`（unknown）。已在本机扫描中观察到该形态。C4/后续可扩展核心包前缀或以宿主声明清单为解析源。
2. **方法存在性 ≠ 位置兼容**：API 语料按方法名必要条件判定；`ctx.<service>.<method>` 的服务与方法位置匹配交给 runtime 证据（C4）。
3. **内置矩阵 verifyAt 固定为静态记录**：K02 的 allow 为"incident-baseline-static"，只支持 declared_compatible；非 smoke 验证。
4. **`degraded` 矩阵决策不在 v1 数据**：需要 runtime 证据；loader 校验显式拒绝并记录（docs/01 §8.5 标注）。

## Rollback / Security

- 回滚：三个实现提交独立，可整体 revert；不触碰 schemas 与既有 code 语义。
- 安全边界：全程无网络、无进程、无真实 profile 写入；API 语料扫描有 maxFiles/maxFileBytes/maxTotalBytes 限额并跳过 minified 内容；不执行任何插件代码；fixture 全部为合成内容，未新增第三方 fixture 来源（sources.lock 无变化）。
