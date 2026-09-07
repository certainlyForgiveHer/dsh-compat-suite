# M0 Contract Baseline Acceptance Record

状态：M0 交付物完成并通过本地全量验证；`specification` 与 `security-quality` 评审经由 PR 提出、待维护者完成（单维护者场景：以下验证为作者自评 + 自动化证据，不构成独立审计）。

记录日期：2026-09-07

## Coordination record

- Implementation Issue：[#10](https://github.com/certainlyForgiveHer/dsh-compat-suite/issues/10)（parent #9，milestone M0，单 Agent 模式）
- `claim_id`：`issue-10-20260907T023612Z-dsh-glm-01`（CLAIM_CONFIRMED 2026-09-07T02:36:12Z；本记录为交接说明指定的后续会话，WORK_STARTED 已发布）
- `agent_id`：`dsh-glm-01`
- 分支：`feat/10-m0-contract`（worktree `dsh-compat-suite-wt-10-dsh-glm-01`，产品根之外）
- `base_sha`：`739d876d8e73ccc8eb796cf1a36b0c51d8ea84f6`
- 实现提交：`7206914`（失败测试基线）→ `82068cd`（schema + fixtures）→ `5499282`（契约与威胁模型文档）→ `1031a0b`（验证门）

## Delivered surface

| 交付物 | 路径 |
| --- | --- |
| report schema v1 草案 | `schemas/report-v1.schema.json`（draft-07） |
| 契约文档（六状态、证据等级、退出码、finding code 注册表、schema 说明、脱敏、规则优先级与聚合、阴性检查） | `docs/07-m0-contract.md` |
| 威胁模型与非目标清单 | `docs/08-m0-threat-model.md` |
| 三插件事故固定 fixture（K01/K03/K05，dsh 0.1.1-rc.2） | `fixtures/incident/` |
| 六状态最小 golden 报告 | `fixtures/golden/` |
| fixture 溯源 lock（4 条已核实条目） | `fixtures/sources.lock.json` |
| 零依赖验证门 + 契约测试 | `scripts/verify-m0.mjs`、`tests/contract/` |
| 验证链接入（additive） | `package.json`（`verify:m0`、`test:contract`，无依赖与 lockfile 变更） |

## Process: failing baseline first

按 AGENTS.md 第 3 节第 8 步，先提交失败测试基线（`7206914`：`node --test tests/contract/` 因 schema、文档、fixtures、门禁不存在而失败），再实现工件使其转绿。最终 22 项契约测试全部通过，其中 8 项为阴性检查（零误报为绿的结构性证明）。

## Local verification

基线（base_sha `739d876`，写入前）：`pnpm run verify` 全链绿色、工作树干净。

实现后（HEAD `1031a0b`）：

| Check | Command | Result |
| --- | --- | --- |
| M0 gate | `pnpm run verify:m0` | pass（schema 结构、golden 一致性、fixture lock 一致性） |
| Contract tests | `node --test tests/contract/*.test.mjs` | pass；22/22，含阴性检查 |
| G0 gate（不回归） | `pnpm run verify:g0` | pass |
| Full chain | `pnpm run verify`（G0 + M0 + contract + build + typecheck + test） | pass；exit 0 |
| Package build/typecheck/test | `pnpm -r run build/typecheck/test` | pass；core/doctor/plugin 各 1 项 smoke 测试通过 |
| Boundary | `git status --short`（验证后） | 空（clean） |
| Whitespace | `git diff --check` | pass |
| Scope | `git diff base_sha --stat` | 仅含确认 `write_scope` 路径；`packages/`、`pnpm-lock.yaml`、`docs/01-06`、`schemas/fixture-source-lock.schema.json`、`AGENTS.md`、`.github/` 未触碰 |

## Negative checks (zero false green)

- `validated_compatible` 无 `smokeCoverage.result=passed`：schema if/then 拒绝 ✔
- `passed` smoke 未列 `notCovered`/未绑证据：schema 拒绝 ✔
- 虚构状态（`mostly_compatible`）、未知顶层字段、无证据 finding：schema 拒绝 ✔
- K01 fixture 期望绿色、未注册 code、猜测 provenance：incident 检查拒绝 ✔
- 绝对用户路径、token、ANSI 序列植入：脱敏检查拒绝 ✔
- 退出码表缺状态或 `validated_compatible`→阻断码：契约检查拒绝 ✔

## Provenance verification (read-only registry metadata, 2026-09-07)

方法：对 registry.npmjs.org 的**只读元数据 GET**（不安装、不下载 tarball、不执行任何脚本），记录于 `fixtures/sources.lock.json`：

| 工件 | 核实结果 |
| --- | --- |
| `@deepseek-ai/dsh@0.1.1-rc.2` | 存在；MIT；integrity `sha512-UP1U…N3wg==`；repository deepseek-harness |
| `@nanmicoder/dsh-agent-teams@0.1.15` | 存在（全名由 docs/01 §13 固定）；MIT；integrity `sha512-Tfyz…q2Cg==`；无 `dsh.engines`、全部 peer optional |
| `@linxin666/dsh-client-ui-task-board@0.3.10` | 存在；Apache-2.0；integrity `sha512-Bw+C…h7jA==`；`dsh.engines.dsh: >=0.1.2-alpha.1` 与 docs/04 K03 权威预期逐字一致（scope 识别据此确认） |
| `@linxin666/dsh-client-ui-skill-explorer@0.3.10` | 存在；BSD-3-Clause；integrity `sha512-e8cy…l0wQ==`；`dsh.engines.dsh: >=0.1.2-alpha.1`（K05 具体范围 docs 未固定，以 registry 核实值记录并标注待 C1 复核） |

## Limitations and deferred evidence

- 三方版本（manifest specifier/lock/actual）逐项值未在权威文档记录，fixture 以文档固定的安装版本填充三方并显式标注为假设，待 C1 真实 profile 复核；
- loader ID 需读取包内 `cordis.patch.yml`，M0 不下载 tarball，故不记录（不猜测），待 C3/C4 取证；
- task-board 的 react peer optional 性未记录，不影响本案判定；
- 六状态 golden 为静态合成示例（digest/integrity 为格式占位），真实工件溯源仅在事故 fixture 中使用真实值；
- `specification` 与 `security-quality` 评审待 PR 完成；本文验证记录为作者自评 + 自动化证据。

## Remaining for M0 acceptance

- 维护者完成 `specification` 与 `security-quality` 评审（CLAIM_CONFIRMED 的 required_reviews）；
- PR 合并后由协调者记录 `WORK_COMPLETED` 并对照 #9 关闭 M0 验收；
- C1 及后续节点以 `schemas/report-v1.schema.json` 与 `docs/07-m0-contract.md` 为冻结契约消费方。
