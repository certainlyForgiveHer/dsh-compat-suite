# 事故 Fixture（M0）：dsh 0.1.1-rc.2 三插件事故

本目录固定记录引发本项目的三插件事故，作为 K 矩阵零误报为绿硬门槛（K01/K03/K05）的永久回归输入。每个 fixture 是**静态输入定义 + 预期结论**，不是报告；C2 规则引擎与 C4 smoke 将以本目录为回归基线。

宿主基线：`dsh 0.1.1-rc.2`（docs/04 环境矩阵的主要回归基线）。

## 文件与预期

| 用例 | 文件 | 输入摘要 | 预期结论 | 为何不是其他状态 |
| --- | --- | --- | --- | --- |
| K01 | k01-agent-teams-0.1.15.json | @nanmicoder/dsh-agent-teams 0.1.15：无 dsh.engines、全 optional peer、静态引用 subagents.registerContinuableSetup | incompatible（missing-host-api 主导） | 明确缺失的宿主 API 是已确认冲突；unknown 级 finding（无引擎声明、optional peer 不匹配）被 incompatible 主导，不得抵消为绿色 |
| K03 | k03-task-board-0.3.10.json | @linxin666/dsh-client-ui-task-board 0.3.10：dsh.engines.dsh >=0.1.2-alpha.1 | incompatible（plugin-engine-mismatch） | 0.1.1-rc.2 < 0.1.2-alpha.1，manifest 级冲突成立即阻断；若强行启动，session/list 持续错误必须被识别为 degraded/incompatible |
| K05 | k05-skill-explorer-0.3.10.json | @linxin666/dsh-client-ui-skill-explorer 0.3.10：dsh.engines.dsh >=0.1.2-alpha.1 | incompatible（plugin-engine-mismatch） | 引擎声明不匹配成立即阻断，smoke 不得成为通过 |

## 溯源与核实方法（只读，未下载任何 tarball）

2026-09-07 通过只读 registry 元数据查询（registry.npmjs.org，未安装、未下载 tarball、未执行任何脚本）核实：

- 四个工件的精确身份（name@version、dist.integrity、license、repository）全部存在且已记录到 [`fixtures/sources.lock.json`](../sources.lock.json)；
- K03 的 `dsh.engines.dsh >=0.1.2-alpha.1` 与 docs/04 K03 权威预期**逐字一致**，确认 @linxin666/dsh-client-ui-task-board 即事故中的 task-board；
- K05 的 engine 范围 docs 未固定，以 registry 核实值 `>=0.1.2-alpha.1` 记录，并在 fixture 的 manifestNotes 与 rationale 中标注待 C1 复核；
- K01 的 @nanmicoder/dsh-agent-teams 全名由 docs/01 第 13 节固定，registry 核实其无 dsh.engines、全部 peer 为 optional。

## 已知限制（不猜测原则）

- 三方版本（manifest specifier / lock / actual）的逐项值未在权威文档记录；fixture 以文档固定的安装版本填充三方，标注为假设，待 C1 从真实 profile 复核；
- loader ID 需读取包内 `cordis.patch.yml`，M0 不下载 tarball，故不记录，待 C3/C4 取证；
- task-board 的 react peer 是否 optional 未记录，不影响本案判定；
- 以上限制均以显式 note/manifestNotes 记录在 fixture 内，不得以猜测值冒充已核实事实。

## 变更规则

- 每次真实兼容事故必须先新增失败 fixture 再修规则（docs/03 第 1 节）；
- 修改预期结论或引擎范围必须同步更新本 README、[`docs/07-m0-contract.md`](../../docs/07-m0-contract.md) 注册表与 [`fixtures/sources.lock.json`](../sources.lock.json)；
- 本目录不得引入真实 profile 数据、凭据或未脱敏日志。
