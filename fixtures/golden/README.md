# Golden 报告 fixture（M0）

本目录包含六份最小 golden 报告，逐一举证 report schema v1 的六种兼容状态。全部为**静态合成文件**：`run.id` 与 `startedAt` 为固定字面量，digest 与 integrity 为格式占位（真实工件溯源记录在 [`fixtures/sources.lock.json`](../sources.lock.json)，仅事故 fixture 使用真实值），连续运行可 diff、结果确定。

全部文件已脱敏：绝对路径一律别名为 `<dsh-home>`、`<profile>`、`<tmp>`，不含 token、凭据、环境变量值或 ANSI 控制序列。`scripts/verify-m0.mjs` 对每份 golden 执行 schema 校验、证据引用完整性、状态聚合自洽、计数一致性与脱敏扫描。

## 状态 → 文件与唯一预期结论

| 状态 | 文件 | 输入摘要 | 唯一预期结论 | 为何不是其他状态 |
| --- | --- | --- | --- | --- |
| validated_compatible | validated-compatible.json | 引擎声明匹配 + 隔离启动验证在 startup/loader-apply/http-probe/stability-window 范围通过 | 可放行（限 smoke 覆盖范围） | 声明检查与 smoke 证据齐备才允许该状态；notCovered 明示业务功能未验证，故不声称功能兼容 |
| declared_compatible | declared-compatible.json | 引擎声明匹配，未执行 smoke | 仅 advisory 放行 | 仅有 semver 范围匹配时最高为 declared；无 smoke 证据不得升为 validated |
| degraded | degraded.json | 宿主核心包 @deepseek-ai/dsh-web 实际 0.1.0-rc.9 与 CLI 0.1.1-rc.2 偏移 | 不放行，需人工复核 | 版本身份不一致确认了降级信号，但未确认代际冲突或 API 缺失，故不是 incompatible；存在明确问题故不是 unknown，更不是绿色 |
| incompatible | incompatible.json | K01 事故形态：@nanmicoder/dsh-agent-teams 0.1.15 调用宿主不存在的 subagents.registerContinuableSetup | 阻断 | 明确缺失的宿主 API 是已确认冲突（host_api 证据）；任何宽泛声明都不能覆盖为绿色；附带 engine-declaration-missing（unknown 级）但不改变主导结论 |
| unknown | unknown.json | example-dynamic-tool 无引擎声明、无 peer、无矩阵记录、未执行 smoke | 不放行，需人工确认 | 缺少 manifest 兼容声明且未执行 smoke 时必须为 unknown；没有错误不等于兼容，不得给绿色 |
| scan_error | scan-error.json | <profile>/pnpm-lock.yaml 损坏，扫描中止 | 基础设施失败，退出码 4 | 检查器无法完成扫描时既不能给兼容结论也不能给冲突结论；scan_error 表达基础设施失败，不是对组合的判定 |

## 聚合自洽

每份 golden 的 `summary.status` 均可由其 findings 按 [`docs/07-m0-contract.md`](../../docs/07-m0-contract.md) 第 7 节聚合顺序（`scan_error > incompatible > degraded > unknown > validated_compatible > declared_compatible`）推导；`summary.blocking` / `summary.review` 与 finding 的 `blocking` / `severity` 一致。此不变量由验证门与 `tests/contract/` 强制。

## 禁止事项

- 不得在 golden 中加入真实路径、真实凭据或真实用户数据；
- 不得修改 golden 使其与唯一预期结论冲突（例如给 unknown 场景加绿色结论）；
- 新状态或新 finding code 必须先扩充 [`docs/07-m0-contract.md`](../../docs/07-m0-contract.md) 注册表与 schema，再新增 golden。
