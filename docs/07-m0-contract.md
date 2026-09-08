# M0 契约与安全基线（冻结 v1）

状态：M0 冻结基线。本文与 [`schemas/report-v1.schema.json`](../schemas/report-v1.schema.json) 共同构成 report v1 契约；语义以本文为准，结构以 schema 为准。验证入口为 `pnpm run verify:m0` 与 `pnpm run test:contract`。

本文的六状态词汇、finding code 命名空间和退出码映射必须与 [`01-cli-design.md`](01-cli-design.md) 第 4、6、8、12、13 节保持一致；发现不一致时上报偏差，不得在本文单方面重新定义。

## 1. 兼容状态

六种状态语义互不重叠；每种状态回答同一个问题——"当前策略能否放行这个组合"，且答案来源互不相同：

| 状态 | 含义 | 默认放行 |
| --- | --- | --- |
| validated_compatible | 声明检查通过，并且对应组合完成了规定范围的隔离启动验证 | 是 |
| declared_compatible | 存在明确的版本声明或可信兼容矩阵支持，但本机尚未执行 smoke | 仅 advisory 模式 |
| degraded | 宿主可启动，但插件持续报错、功能缺失、健康探针失败，或身份三方不一致 | 否 |
| incompatible | 已确认的版本范围冲突、缺失宿主 API、加载失败或进程崩溃 | 否 |
| unknown | 信息不足、元数据缺失或静态分析无法得出可靠结论 | 否 |
| scan_error | 文件损坏、权限不足、版本解析失败或检查器自身无法完成扫描 | 否 |

零误报为绿原则（不可协商）：

- 没有找到错误不等于兼容。
- 仅 semver 范围匹配时，最高为 `declared_compatible`。
- 缺少 manifest 兼容声明且未执行 smoke 时必须是 `unknown`。
- API 静态检查发现明确缺失方法可判定 `incompatible`；未发现缺失方法不能反向证明兼容。
- smoke 只覆盖启动与所配置的健康探针，报告必须标明未覆盖的功能。
- 不存在错误本身不能产生 `validated_compatible`：该状态必须由"声明检查通过"与"完成的隔离启动验证"共同产生；该约束由 schema 的结构性检查强制（见第 8 节阴性检查）。

## 2. 证据等级

| 等级 | 例子 | 可证明什么 |
| --- | --- | --- |
| runtime | loader 报错、ready 探针、稳定观察窗口 | 可以确认启动成功、崩溃或持续降级 |
| host_api | 插件调用的方法在当前宿主实际导出表中不存在 | 可以确认该调用路径不兼容 |
| manifest | dsh.engines、mandatory peer range | 可以确认显式版本冲突；范围匹配本身不能证明全部功能兼容 |
| known_matrix | 经固定工件和测试验证的宿主/插件组合 | 可以在矩阵版本和工件哈希匹配时提供强证据 |
| lock | manifest、lockfile、node_modules 三方一致性 | 可以确认实际运行版本身份 |
| heuristic | 源码字符串、动态 API 使用推断 | 只能提升风险，不能单独判定兼容 |

每个阻断结论至少需要一种可追溯证据；heuristic 证据只能将结论向更保守方向推动，不能单独产生绿色结论。

## 3. 退出码契约

| 状态 | advisory 退出码 | strict 退出码 |
| --- | --- | --- |
| validated_compatible | 0 | 0 |
| declared_compatible | 0 | 0 |
| degraded | 0 | 2 |
| unknown | 0 | 2 |
| incompatible | 1 | 1 |
| scan_error | 4 | 4 |

退出码同样覆盖不由扫描状态直接产生的情况：

| 条件 | advisory 退出码 | strict 退出码 |
| --- | --- | --- |
| 输入、profile 或报告契约错误 | 3 | 3 |
| smoke 未达到可判定结果 | 5 | 5 |
| CLI 内部错误 | 70 | 70 |

各退出码的完整含义见 [`01-cli-design.md`](01-cli-design.md) 第 6 节。同一运行同时出现多类问题时，退出码优先级为 `70 > 4 > 5 > 1 > 2 > 0`。JSON 报告保留全部 finding，退出码只表达自动化决策，不截断证据。

## 4. Finding code 命名与稳定 ID

命名规范：

- 规则 code 为小写 kebab-case（`^[a-z][a-z0-9]+(-[a-z0-9]+)*$`），由领域前缀开头，禁止裸动词。
- finding 稳定 ID 为 `<subject>:<code>`，subject 为受影响插件的 package name 或保留字 `host`；同一输入下 ID 确定、可复现，禁止时间戳、随机数或序号漂移。
- 证据稳定 ID 为 `<findingId>#<序号>`，序号按 finding 内证据顺序从 1 编号。
- schema 中的 code 受模式约束；语义注册表如下，v1 之外的 code 必须先扩充本表再使用：

| code | 语义 | 最低状态 | 证据等级 |
| --- | --- | --- | --- |
| host-version-skew | 宿主 CLI 版本与核心包实际版本偏移 | degraded | lock |
| host-identity-unresolved | 无法解析宿主二进制或版本身份 | scan_error | lock |
| plugin-engine-mismatch | dsh.engines 声明与宿主版本冲突 | incompatible | manifest |
| engine-declaration-missing | 缺少引擎声明且无其他可判证据 | unknown | manifest |
| engine-range-match | 引擎声明范围覆盖当前宿主版本 | declared_compatible | manifest |
| peer-mismatch-mandatory | mandatory peer 依赖范围不匹配 | incompatible | manifest |
| peer-mismatch-optional | optional peer 不匹配，仅记录不阻断 | unknown | manifest |
| version-skew-manifest-lock | manifest 与 lockfile 解析版本不一致 | degraded | lock |
| version-skew-lock-actual | lockfile 与实际安装版本不一致 | degraded | lock |
| package-missing | 声明启用的插件在 node_modules 中缺失 | scan_error | lock |
| ambiguous-resolution | 同名插件解析出多个实际版本 | degraded | lock |
| missing-host-api | 插件引用的宿主 API 明确不存在 | incompatible | host_api |
| analysis-incomplete | 静态分析无法覆盖的 API 使用方式 | unknown | heuristic |
| known-matrix-allow | 已验证兼容矩阵记录允许 | declared_compatible | known_matrix |
| known-matrix-deny | 已验证兼容矩阵记录拒绝 | incompatible | known_matrix |
| loader-failure | smoke 或运行时 loader 加载失败 | incompatible | runtime |
| smoke-passed | 隔离启动验证在声明范围内通过 | validated_compatible | runtime |
| smoke-unavailable | 无法建立隔离环境执行 smoke | unknown | runtime |
| smoke-blocked | 需要凭据或外部服务才能启动 | unknown | runtime |
| degraded-runtime-errors | 启动后持续错误或健康探针失败 | degraded | runtime |
| scan-infrastructure-error | 扫描基础设施失败 | scan_error | lock |

示例：

```text
id:      @nanmicoder/dsh-agent-teams:missing-host-api
code:    missing-host-api
subject: @nanmicoder/dsh-agent-teams
evidence id: @nanmicoder/dsh-agent-teams:missing-host-api#1
```

## 5. 报告 schema v1

结构契约冻结于 [`schemas/report-v1.schema.json`](../schemas/report-v1.schema.json)（draft-07）。顶层结构：

```json
{
  "schemaVersion": 1,
  "run": { "id": "uuid", "startedAt": "RFC3339", "mode": "scan|check-update|smoke", "doctorVersion": "0.1.0" },
  "host": { "binaryInput": "<dsh-home>/bin/dsh", "binaryRealpath": "<dsh-home>/bin/dsh", "cliVersion": "0.1.1-rc.2", "nodeVersion": "26.5.0", "corePackages": [] },
  "profile": { "name": "web", "manifestDigest": "sha256:...", "lockDigest": "sha256:..." },
  "plugins": [],
  "findings": [],
  "summary": { "status": "unknown", "blocking": 0, "review": 0 }
}
```

要点：

- `host.corePackages[]` 每项含 `name`、实际 `version` 和可选 `expectedVersion`；`expectedVersion` 与 `version` 不一致即结构化表达宿主版本偏移。
- `plugins[]` 每项含 `manifestSpecifier`、`lockVersion`、`actualVersion`（可为 null），三方字段共同表达 manifest/lock/actual 版本身份；`smokeCoverage` 表达隔离启动验证的范围（`scope`）、未覆盖项（`notCovered`）与结果。
- `findings[]` 每项必须绑定至少一条 `evidence`（`type` 为第 2 节等级之一），并给出 `observed`、`expected`、`nextStep` 与 `blocking`。
- `summary.blocking` 等于 `blocking: true` 的 finding 数；`summary.review` 等于 `severity: review` 且不阻断的 finding 数。
- schema 版本策略沿用 [`01-cli-design.md`](01-cli-design.md) 第 12.3 节：新增可选字段不提升 major；删除字段、改变语义或改变退出码映射必须提升 major。

## 6. 脱敏规范

路径别名：

| 原始内容 | 报告中的表示 |
| --- | --- |
| dsh home 及其子路径 | `<dsh-home>` |
| 当前 profile 及其子路径 | `<profile>` |
| 系统临时目录与 smoke 运行目录 | `<tmp>` |

- 绝对用户路径必须按上表别名化；`--expose-paths` 必须显式开启才允许例外。
- 禁止出现在任何报告或日志输出中：URL query token、Bearer/API key 形态字符串、私钥材料、环境变量值、凭据与会话内容、完整用户目录树。
- 报告渲染前清除 ANSI 转义序列与双向控制字符；不可信文本（README、错误消息、包注释）只作为数据证据呈现，不驱动命令。
- golden 报告为静态文件：`run.id`、`startedAt` 为固定字面量，输出确定、可 diff、连续运行一致。

## 7. 规则优先级、冲突消解与证据聚合

规则优先级从高到低（沿用 [`01-cli-design.md`](01-cli-design.md) 第 8.2 节）：

1. 工件身份或扫描完整性失败；
2. smoke 进程崩溃、loader 失败、ready 超时；
3. 已验证的明确 deny 规则；
4. dsh.engines 不匹配；
5. mandatory peer dependency 不匹配；
6. 插件引用的宿主 API 明确不存在；
7. 启动后持续错误或健康探针失败；
8. 已验证 allow 规则；
9. manifest 范围匹配；
10. 启发式风险与信息缺失。

冲突消解：

- 高优先级结论不能被低优先级 allow 覆盖。manifest 声明范围宽泛但 smoke 已复现缺失 API 时，结论必须是 `incompatible`。
- runtime deny 或明确缺失 API 不能被宽泛 manifest allow 覆盖。
- known matrix allow 过期后降级为 `unknown`，不保留绿色。

状态聚合顺序（保守优先，同时表达证据强度）：

`scan_error > incompatible > degraded > unknown > validated_compatible > declared_compatible`

推导规则：

- subject（插件）状态 = 该插件全部 finding 状态按聚合顺序取最高位；没有任何 finding 的插件为 `unknown`，不得给绿色。
- `unknown` 高于任何绿色状态：只要存在未决问题，组合不得呈现为绿色（零误报为绿）。
- `validated_compatible` 高于 `declared_compatible`：二者都为绿时取证据更完整者。
- summary 状态 = host 级 finding 状态与全部插件状态按聚合顺序取最高位；无任何 finding 且无插件时为 `unknown`。
- 每个阻断结论至少绑定一种可追溯证据；heuristic 只能升风险，不能降级为绿色。

## 8. 阴性检查（零误报为绿的结构性证明）

以下阴性检查由 `tests/contract/` 与 `scripts/verify-m0.mjs` 强制执行，证明"不存在错误"不能产生绿色：

1. 插件状态为 `validated_compatible` 但 `smokeCoverage.result` 不是 `passed`：schema if/then 拒绝。
2. `smokeCoverage.result` 为 `passed` 但未列出 `notCovered` 或未绑定证据：schema 拒绝。
3. 状态枚举之外的状态值（如 `mostly_compatible`）：schema 拒绝。
4. 没有证据的 finding：schema 拒绝。
5. K01 事故 fixture 期望绿色结论：incident 检查拒绝。
6. 未经 registry 记录的 finding code：incident/golden 检查拒绝。
7. 声称 verified 但 lock 中不存在的溯源：incident 检查拒绝。
8. 含绝对用户路径、token 或 ANSI 序列的报告：脱敏检查拒绝。
9. 退出码表缺少状态或把 `validated_compatible` 映射为阻断码：契约检查拒绝。

## 9. 与权威文档的一致性

- 六状态语义、证据等级、退出码与优先级：与 [`01-cli-design.md`](01-cli-design.md) 第 4、6 节一致，本文为其冻结投影。
- 规则优先级：与 [`01-cli-design.md`](01-cli-design.md) 第 8.2 节一致。
- 脱敏边界：与 [`01-cli-design.md`](01-cli-design.md) 第 13、15 节一致。
- 报告结构：覆盖 [`01-cli-design.md`](01-cli-design.md) 第 12 节要求的全部字段；`host.corePackages` 采用数组形式以结构化表达版本偏移。
- 变更退出码、状态语义、schema 结构或安全边界时，回到 M0 做设计变更评审（见 [`03-milestones.md`](03-milestones.md) 第 18 节）。
