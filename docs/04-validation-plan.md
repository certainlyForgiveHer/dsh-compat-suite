# 验证与发布验收方案

## 1. 验证目标

本方案优先防止两类严重错误：

1. false green：实际不兼容的组合被报告为兼容并获准升级；
2. 测试污染：检查器修改或干扰了真实 dsh profile、进程管理器/服务监督器、端口、插件数据或凭据。

协作治理还必须防止第三类错误：Issue 或 label 被误当成锁，使多个 Agent 在重叠范围内并行写入，或让无确认、过期、越界的工作进入 PR。

第二优先级是减少无依据的 false red。证据不足时输出 `unknown` 是预期行为，不属于误报。

## 2. 验证原则

- 所有结论基于固定输入和可复核 oracle。
- 单元测试使用最小合成 fixture；真实第三方包只用于受控集成/发布验收。
- 真实包按精确版本和 integrity 固定，不能依赖 `latest`。
- 每个历史事故先建立能失败的回归用例，再修改规则。
- 测试默认运行在临时目录、临时 `DSH_HOME`、临时端口和 disposable 进程管理器/服务监督器状态（如 PM2 的 `PM2_HOME`）。
- 自动化测试不读取真实 credentials、sessions、storages 或工作区内容。
- smoke 成功只证明规定的启动覆盖范围，报告必须列出未验证功能。
- 所有失败路径都验证进程、端口和临时资源清理。
- 多 Agent 测试验证的是记录、检测、暂停、交接和恢复，不声称 GitHub 技术上阻止了并发写入。
- assignee、label 和 Project 字段只作为 Issue 事件的投影；验证 oracle 以 Issue scope revision、有效确认事件、branch/PR SHA 和实际 diff 为准。

## 3. 测试层级

```text
L0  Static quality       lint, typecheck, schema validation
L1  Unit                 parsers, semver, rule engine, redaction
L2  Contract             CLI, JSON, exit code, Host API
L3  Integration          temp profile, registry stub, safe tar, lockfile
L4  Process smoke        real dsh child process, ready, HTTP, shutdown
L5  Plugin E2E           real Host + browser UI
L6  System acceptance    CLI ↔ report ↔ plugin ↔ disposable process-supervisor flow
L7  Security/reliability fault injection across all layers
L8  Repository/release   Git topology, package identity, provenance, listing conformance
L9  Collaboration        issue ledger, claim events, scope conflict, handoff, PR traceability
```

L0-L3 每个 PR 必跑；L4-L5 在合并前或受控 CI lane 必跑；L6-L7 在 release candidate 上全量执行。L8 在 G0、每个 release candidate 和 R2 投稿前执行相应子集。L9 在 G1、协作协议变更和 release traceability 复核时执行相应子集。

## 4. 环境矩阵

### 4.1 Node.js

至少包含：

- 项目声明的最低支持版本；
- 一个稳定主版本；
- 附加验证目标。

若最低支持版本无法运行某个 dsh 测试工件，只能缩小 engine 范围，不能跳过后仍宣称支持。

### 4.2 操作系统

| 平台 | 必测范围 |
| --- | --- |
| macOS arm64 | 全部 CLI、真实 dsh smoke、插件 E2E、进程管理器/服务监督器集成；首发阻断平台 |
| Linux x64 | L0-L4；若声明插件支持，则增加 L5 |
| Windows | 仅在正式声明支持后进入阻断矩阵；此前运行 parser/contract 测试但不宣称 dsh runtime 兼容 |

### 4.3 dsh 版本

初始版本矩阵：

- `0.1.0-rc.8`：历史 AgentTeams 基线；
- `0.1.1-rc.2`：主要回归基线；
- `0.1.2-alpha.1`：识别 prerelease 边界；
- `0.1.2-alpha.2`：新 AgentTeams 基线。

每个工件记录来源、版本、package integrity 和核心包摘要。无法取得可验证工件的 lane 标记 unavailable，不能用模拟通过替代真实 runtime 验收。

## 5. 关键兼容矩阵

| 用例 | 宿主 | 插件 | 静态预期 | smoke 预期 |
| --- | --- | --- | --- | --- |
| K01 | `0.1.1-rc.2` | AgentTeams `0.1.15` | `incompatible`：缺失宿主 API 或 known deny | loader 失败，捕获 `registerContinuableSetup` |
| K02 | `0.1.1-rc.2` | AgentTeams `0.1.2` | 至少 `declared_compatible` 或经矩阵认可 | ready，通过稳定窗口，无 loader 错误 |
| K03 | `0.1.1-rc.2` | task-board `0.3.10` | `incompatible`：engine 要求 `>=0.1.2-alpha.1` | 不得成为通过；若启动，识别 `session/list` 持续错误为 degraded/incompatible |
| K04 | `0.1.1-rc.2` | task-board `0.2.9` | `declared_compatible` | ready，无 `session/list` 错误风暴 |
| K05 | `0.1.1-rc.2` | skill-explorer `0.3.10` | `incompatible`：engine 不匹配 | 不得成为通过 |
| K06 | `0.1.1-rc.2` | skill-explorer `0.2.9` | `declared_compatible` | ready，插件 Host/静态资源可用 |
| K07 | `0.1.2-alpha.2` | AgentTeams `0.1.15` | `declared_compatible` | ready，注册所需 API 成功 |
| K08 | `0.1.0-rc.8` | AgentTeams `0.1.14` | `declared_compatible` | 按历史声明执行真实 smoke |

K01、K03、K05 是零 false-green 硬门槛。K02、K04、K06 的通过只能标成 startup validated，除非增加各插件业务探针。

## 6. 合成 Fixture 设计

不把完整第三方包复制进普通单元测试。为每种行为构造最小 package：

- `engine-match` / `engine-mismatch`；
- mandatory peer match/mismatch；
- optional peer mismatch；
- 无 engine 和 peer；
- 调用存在/缺失/动态宿主 API；
- 一个 package 多个 loader ID；
- disabled loader；
- manifest、lock、actual 一致与不一致；
- package 目录缺失；
- 同名多版本解析；
- Git、link 和不可复现来源；
- 损坏 JSON/YAML/lockfile；
- 超大或深度嵌套配置；
- 含 ANSI、控制字符和疑似 token 的错误文本；
- malicious tar：`../`、绝对路径、symlink escape、设备文件、超大展开比。

每个 fixture 需包含 README，说明输入、预期 findings 和为何不应产生其他状态。

## 7. L0：静态质量验证

必跑项：

- TypeScript strict typecheck；
- lint；
- 格式检查；
- JSON Schema 自校验；
- package exports 检查；
- 禁止未声明 Node 内置依赖；
- 依赖许可证与漏洞扫描；
- 构建后检查 browser bundle 不包含 CLI 进程控制模块；
- 检查发布包中无测试 secrets、临时路径和本机绝对路径。

门槛：零 type/lint/schema 错误；critical/high 依赖漏洞必须修复或有明确不受影响证明并通过安全评审。

## 8. L1：单元与性质测试

### 8.1 Semver

至少覆盖：

- release、rc、alpha、beta 的排序；
- `0.1.1-rc.2` 对 `>=0.1.2-alpha.1` 为 false；
- caret、tilde、区间、OR 和非法范围；
- prerelease 包含规则；
- optional peer 与 mandatory peer 的不同决策；
- 非标准版本变成 `unknown`。

使用性质测试生成版本三元组，验证比较的反对称性和传递性；不得手工复制另一套 semver 实现作为 oracle。

### 8.2 Parser

覆盖：

- package.json 缺字段、未知字段和重复逻辑；
- pnpm lock v9 importer、snapshot、Git 和 link 依赖；
- YAML 空文档、数组、无效 loader entry；
- scoped package path；
- symlink、大小写和 realpath；
- UTF-8、CRLF 和异常控制字符。

### 8.3 规则引擎

每条规则必须有：

- 一个命中正例；
- 一个不命中反例；
- 一个与更高优先级规则冲突的例子；
- 一个证据不足例子。

安全关键模块的分支覆盖率要求：

- rule engine：至少 95%；
- path/tar validation：至少 95%；
- redaction：至少 95%；
- 其他核心模块：至少 85%。

覆盖率不是唯一门槛，K01/K03/K05 的结果更高优先。

### 8.4 脱敏

在输入中植入：

- URL query token；
- Bearer token；
- API key 风格字符串；
- 用户名和绝对 home 路径；
- 环境变量值；
- ANSI 和双向控制字符。

断言文本输出、JSON、错误对象和插件 API 均不含原值，同时保留可关联的安全摘要或哈希。

## 9. L2：契约测试

### 9.1 CLI

对每个命令验证：

- 必填参数；
- 非法参数；
- help/version；
- stdout/stderr 分离；
- `--json` 始终输出一个合法 JSON 文档；
- 六种状态到退出码的映射；
- strict/advisory 差异；
- signal 中断返回和清理；
- 报告 schema 版本。

### 9.2 报告

- golden JSON 做归一化比较，排除 run ID 和时间；
- 新 reader 可以读取本 major 的旧 minor schema；
- 不支持的 major 被明确拒绝；
- report digest 改动可以使插件 cache/stale 状态变化；
- finding ID 在同一输入中稳定。

### 9.3 插件 Host API

覆盖：

- `/status`、`/report`、`/scan`、可选 `/candidate-check`；
- method、content type、body size 和 schema；
- 未认证、跨 origin、非法 request ID；
- 并发 scan 去重；
- TTL 和 ETag；
- stale report；
- 内核抛错后的结构化错误；
- dispose 后请求终止。

## 10. L3：集成测试

### 10.1 临时 Profile

每个测试使用新的临时根，构建：

```text
temp-root/
├── dsh-home/
│   └── profiles/web/
├── cache/
├── reports/
└── sentinels/
```

测试前后记录真实目标 profile 的 manifest、lock、cordis patch 和 node_modules 顶层摘要，断言不变化。

### 10.2 Lifecycle script 哨兵

候选 fixture 声明会写入 `sentinels/lifecycle-ran` 的 install script。执行 candidate 分析和 smoke profile 安装后断言该文件不存在，以证明 scripts 未执行。

### 10.3 Registry Stub

使用本机 HTTPS/HTTP 测试服务器模拟：

- 正常 metadata/tarball；
- integrity 错误；
- 重定向到未允许 origin；
- 慢响应和超时；
- 404/429/500；
- 相同版本内容变化；
- 超大 metadata 和 tarball。

offline 模式安装网络调用拦截器，任何非 loopback socket 尝试都令测试失败。

### 10.4 文件系统故障

注入：

- 无读权限；
- lockfile 在扫描中被原子替换；
- package 目录消失；
- symlink 循环；
- 磁盘写满模拟；
- report 原子 rename 失败。

期望结果是确定性的 `scan_error`/`unknown`，且不留下半写报告。

## 11. L4：真实进程 Smoke

### 11.1 成功 Oracle

必须同时满足：

1. 子进程使用临时 `DSH_HOME` 和独立端口；
2. 在总超时内进入 ready；
3. HTTP 返回版本适配器允许的 `2xx` 或认证型 `401`；
4. ready 后默认 15 秒内 PID 不变、端口不消失；
5. 没有 loader failure、未捕获异常或高频兼容错误；
6. 正常终止信号后 10 秒内退出；
7. 子进程树、端口和临时锁全部释放。

缺一项都不能产生 `validated_compatible`。

### 11.2 失败 Oracle

至少验证：

- 启动前配置解析失败；
- loader entry apply 失败；
- ready 前退出；
- ready 后崩溃；
- ready 后每 5 秒重复同一兼容错误；
- 端口碰撞；
- HTTP 永远不响应；
- 子进程忽略正常终止；
- smoke 本身被 Ctrl-C；
- dsh 启动器再派生子进程。

### 11.3 资源泄漏门槛

- 连续 50 次成功 smoke 后无遗留进程和监听端口；
- 连续 20 次超时/取消 smoke 后无遗留进程；
- 临时目录默认全部清理；
- 选择保留失败现场时，报告列出唯一目录且权限仅当前用户可读写；
- 不使用宽泛进程名终止，只结束记录的进程组。

### 11.4 网络说明

若 CI 平台不能强制禁止非 loopback 网络：

- lane 名称必须标记 `network-not-enforced`；
- 不能作为“无副作用 smoke”的唯一证据；
- release 阻断 lane 应运行在可以审计网络调用的环境；
- 任何模型 API 请求都令测试失败。

## 12. L5：插件与浏览器 E2E

使用受控 dsh Host 和浏览器自动化验证：

- 页面首次打开时 loader 不被扫描阻塞；
- summary 显示 host/profile/report source/freshness；
- 六种状态的文字、图标和排序；
- finding 详情的 observed/expected/evidence/next step；
- static-only 报告显示未 smoke 提示；
- CLI report digest match 后显示 runtime evidence；
- digest mismatch 后显示 stale 且不提升状态；
- scan 失败保留上一份报告；
- registry 关闭、失败、限流和超时状态；
- 导出 JSON 通过 schema 且已脱敏；
- 窄侧栏、宽屏、键盘和屏幕阅读器流程；
- 恶意 README/error 字符串按纯文本显示，无 HTML/script 执行。

视觉验收保存关键状态截图，但截图不替代 DOM、API 和可访问性断言。

## 13. L6：系统与进程管理器/服务监督器集成

### 13.1 隔离要求

- 创建临时进程管理器/服务监督器状态（如 PM2 的 `PM2_HOME`）；
- 使用测试 app 名和独立端口；
- 不读取或写入用户真实进程管理器/服务监督器状态（如 `~/.pm2`）；
- 不通过任何进程管理器/服务监督器对正式 `dsh-service` 执行 start/stop/restart，也不持久化或修改其管理器状态；
- 测试结束后只清理隔离的测试进程管理器/服务监督器实例和已记录 PID。

### 13.2 场景

1. compatible：preflight 退出 `0`，外层流程启动测试 app；
2. incompatible：preflight 退出 `1`，外层流程不启动 app；
3. unknown + strict：退出 `2`，不启动 app；
4. scan infrastructure error：退出 `4`，不启动 app；
5. smoke unavailable：退出 `5`，不改变已有 app；
6. CLI report 写出后，插件读取且 digest 匹配；
7. profile 随后变化，插件把旧 report 标成 stale；
8. 回退到上一 lockfile 后，preflight 和 smoke 恢复通过。

### 13.3 不变性审计

系统测试前后比较：

- 正式 profile 文件摘要；
- 正式进程管理器/服务监督器 process list；
- 正式 dsh PID 和端口；
- 插件 storage 目录摘要；
- credentials 文件 metadata。

任何非预期变化都令测试失败。

## 14. L7：安全与可靠性

### 14.1 输入攻击

测试 package/profile/version 参数中的：

- shell 元字符；
- 换行和 NUL；
- 路径分隔符和 `..`；
- 超长值；
- Unicode 混淆字符；
- URL 和 Git spec；
- dist-tag 和范围。

所有外部进程断言使用 argv 数组，没有 shell 解释层。

### 14.2 供应链

- integrity mismatch；
- registry metadata 与 tarball package.json 版本不一致；
- 同版本 tarball 内容变化；
- 依赖混淆名称；
- tar 路径逃逸；
- lifecycle script 哨兵；
- 超大包资源耗尽；
- 不可信 README 指令注入。

### 14.3 服务稳定性

- 核心 scan 抛出同步/异步异常；
- 文件 watcher 连续触发；
- 并发 100 个 `/scan` 请求；
- registry 慢请求；
- client 中途断开；
- Host dispose；
- 相同错误持续发生。

验收要求：宿主不退出；active scan 数不超过 1；错误日志被限流；内存和 handle 数回落到基线容差内。

## 15. L8：仓库、发布与生态收录一致性

### 15.1 Git 拓扑

在 G0 和 release candidate 上执行：

- `git rev-parse --show-toplevel` 必须精确解析到 `dsh-compat-suite/`；
- 从产品根向下扫描，除根 `.git` 外不得出现嵌套 Git repo、submodule 或 subtree；
- 父级 workspace、真实 DSH home、进程管理器/服务监督器状态目录和外部 awesome-list fork 不得成为 tracked path；
- 根 `package.json` 必须为 `private: true`，并固定 package manager 版本；
- 只允许根目录存在 `pnpm-lock.yaml`，package 目录不得出现第二个 lockfile；
- canonical remote、默认分支、package repository 和 CI badge/link 必须指向同一仓库；
- npm scope 发布权限已经验证，根 LICENSE 与三个 package 的 license metadata 一致；
- 干净 checkout 的冻结安装、构建和测试结束后，`git status --porcelain` 必须为空；
- Git symlink 扫描不得指向产品根之外或真实运行数据。

### 15.2 Package 与 release identity

对三个 package 分别执行 pack 检查：

- package name、version、exports、bin、files 和 repository/directory 正确；
- `doctor` 和 `plugin` 只依赖公开的 `core` exports；
- tarball manifest 不含 `workspace:`、`link:`、`file:` 本机路径或占位符；
- 三个 package 版本、精确内部依赖、CHANGELOG 和 `vX.Y.Z` tag 一致；
- 插件 tarball 包含有效 `dsh.bundle.patch`、`cordis.patch.yml`、Host/Web 入口和所需 schema；
- 实际 import 的官方 `@deepseek-ai/*` package 位于 peers，且 prerelease 范围命中声明支持的每个 DSH 工件；
- 从 CI 生成的原始 tarball 执行 clean-room 安装，不在发布 job 中重新构建；
- 发布后从 registry 取回工件，digest、repository 和 provenance 与验收记录一致。

### 15.3 Tracked file 与 fixture 治理

- tracked files secret scan 不得发现 token、私钥、credential、真实 session 或环境变量值；
- 路径扫描不得出现未经允许的用户名、本机绝对路径、真实 profile 或进程管理器/服务监督器日志；
- `fixtures/sources.lock.json` 中每个真实工件都有精确 identity、integrity/SHA、许可证、来源、用例和复核日期；
- 默认不提交第三方完整 tarball、core dump 或大于 1 MiB 的二进制；
- golden fixture 必须确定、脱敏，并有 README 解释唯一预期结论；
- 完整 evidence、coverage、SBOM 和自动化原始截图只进入受控 CI artifact/GitHub Release；经脱敏、压缩和人工批准的少量公开展示截图可以版本化。

### 15.4 awesome-dsh-plugin 投稿一致性

R2 在独立外部 checkout 中验证：

1. 记录上游 `main` commit 和规则核对日期；
2. 产品公开 URL 在干净环境可由 `dsh plugin add` 安装；
3. 仓库 topic、年龄、真实代码和维护状态满足上游当前要求；
4. 投稿只新增 `data/plugins/<owner>__dsh-compat-suite--packages-dsh-plugin.yml`；
5. URL 指向 `packages/dsh-plugin`，分类为当前最贴切的 `dev`；
6. 中英文描述中的每个功能声明都映射到发布代码、测试或截图；
7. 不手工修改生成 README，不触碰其他条目；
8. 上游 generator、lint、site build 和远端 CI 通过；
9. 可选 `screenshots.json` 只含 1-8 个受允许且不逃逸的路径，图片已通过隐私与大小检查；
10. 外部 fork、node_modules、token 和 PR 凭据不进入产品仓库或产品 CI。

上游 CI 绿色只证明投稿形式符合要求；维护者源码评审和最终合并单独记录。收录不能作为安全性或完整功能兼容的证据。

## 16. L9：多 Agent 协作治理

### 16.1 静态契约

对 `AGENTS.md`、协作文档、ADR、Issue Form 和 PR 模板执行：

- Markdown 本地链接、标题和代码块可解析；
- Issue Form YAML 有效，必填字段 ID 唯一；
- `objective`、`non_goals`、依赖、`scope_revision`、`write_scope`、`forbidden_scope`、`shared_interfaces`、验收、验证、安全/回退、文档影响和更新时间全部必填；
- implementation Issue 默认带 `status:draft` 和 `type:implementation`，且 label 名称存在于协议目录；
- status/event 名称在所有文档和模板中一致；
- PR 模板要求 Issue、`claim_id`、范围、共享接口、验证、review 和 rollback；
- 不出现把 assignee、label、Project、评论、branch、worktree 或 claim 文件描述为原子锁的文字；
- 产品树中不存在 `.agents/claims/*.lock`、claim daemon 配置或中央锁服务依赖。

静态测试应规范化 Markdown 空白后再检查关键句，避免换行导致伪失败；但不能因此弱化关键词或删掉 no-write 条件。

### 16.2 状态和事件模型

建立最小 event fixture，覆盖：

- `draft -> ready -> claimed -> in-progress -> review -> done`；
- `claimed -> ready` 的无工作释放；
- `in-progress -> blocked -> in-progress`；
- `claimed/in-progress -> handoff -> claimed`；
- `draft/ready/blocked -> abandoned`；
- 未知 event、缺字段、重复 `claim_id`、scope revision 回退和非法状态跳转；
- label 与事件不一致；
- 评论更正通过 `AMENDMENT` 追加，而非修改历史 fixture。

Oracle：非法或不完整事件不得产生有效写入授权；投影不一致必须返回 `unknown/conflict` 并要求协调者处理。

### 16.3 并发认领场景

在测试 repository 或固定 Issue 时间线 fixture 中模拟两个不同 `agent_id`：

| 场景 | 输入 | 预期 |
| --- | --- | --- |
| T01 同一 Issue 竞态 | 两个 `CLAIM_REQUESTED` 基于同一 revision | 只有一个协调者确认；另一请求 rejected/仍只读 |
| T02 路径重叠 | 两个任务写同一文件或目录前缀 | 标记 conflict，不允许第二确认 |
| T03 生成物重叠 | 源文件不同但生成同一 schema/lockfile | 标记 shared-interface conflict |
| T04 语义重叠 | schema producer 与 consumer 同时改变字段含义 | 要求排序、共同父 Issue 或 integration owner |
| T05 无重叠并行 | 路径和共享接口均独立 | 两个 claim 可分别确认并在独立 worktree 推进 |
| T06 双确认故障 | 错误地产生两个确认 | 双方停止，记录 branch/SHA，由协调者保留一个 |
| T07 越界写入 | diff 包含未确认路径 | PR gate 失败，即使 CI 通过也不能验收 |

T01/T02/T06 的通过标准不是“第二 Agent 无法写文件”，而是记录能确定其未获授权、Agent 按协议停止、越界 diff 不能进入验收。

### 16.4 Scope revision 与基线漂移

- Issue 从 `scope_revision: 1` 改为 `2` 并新增路径时，旧 claim 对新增路径无效；
- `base_sha` 后的 main 变化触碰同一共享接口时，Agent 必须停止并复核；
- main 变化与任务完全无关时，可记录 `BASELINE_RECHECKED` 或等价进度证据后继续；
- Issue 正文、确认事件和 PR 最终范围必须可追溯，不能只依赖当前 label。

验证使用固定 commit 图和 diff，不依赖口头判断。

### 16.5 陈旧、中止和交接

至少演练：

1. 超过 `expected_update_at`，但协调者尚未审计：不得自动转移；
2. owner 失联且 remote branch clean：记录 `CLAIM_EXPIRED` 后从固定 SHA 交接；
3. owner 有未推送或 dirty 状态：标记不可完全恢复，不得声称现场已保存；
4. 正常 `HANDOFF_READY`：新 Agent 获得新 `claim_id`，复跑基线后继续；
5. 同一 branch 交接：旧 worktree 停止写入并完成核对后才能由新 worktree 使用；
6. blocked 状态：明确解除条件和保留/释放 owner 决策。

恢复 Oracle 包含 branch、HEAD、clean/dirty、修改路径、测试、剩余工作和风险；任一字段未知必须显式标记 `unknown`。

### 16.6 GitHub 不可用和能力受限

- 无法读取 Issue 时，新 Agent 保持只读；
- 已有有效确认的 Agent 只能在原范围内工作到既定复核点，不得扩围、交接、合并或发布；
- 恢复后离线事实先追加回 Issue；
- G1 实测当前仓库的 Issue Form、labels、Projects、required checks、CODEOWNERS 和 branch protection 能力；
- 无法由平台强制的项目必须记录人工 coordinator gate，不得伪造为自动保护。

### 16.7 PR 与独立评审

建立正反 PR fixture：

- 缺 Issue、`claim_id`、确认 URL、写入范围或验证结果时失败；
- PR diff 超过 Issue scope 时失败；
- schema、规则、安全、process 或 release 变更缺必要 reviewer 时失败；
- 作者自评不能满足独立审查；
- Issue 关闭前核对 merged SHA、acceptance evidence 和 follow-up Issues；
- 一个 release 中的变更可映射到 Issue、claim、PR、review、CI artifact 和 merged SHA。

### 16.8 G1 验收方法

G1 使用两类证据：

1. 静态/fixture 验证：YAML、Markdown、event schema、状态机、路径比较和 PR gate；
2. 真实演练：至少两个 Agent 或两个受控模拟身份，在独立 worktree 完成一次竞态、一次冲突拒绝、一次无冲突并行和一次 handoff。

人工演练记录不得包含 credentials 或真实 DSH、进程管理器/服务监督器数据。只有两类证据同时通过，才能记录 `G1 accepted`。

## 17. 性能验证

基准 profile：20 个直接插件、200 个传递 package、普通 lockfile。

| 指标 | 目标 |
| --- | --- |
| offline scan p95 | `< 2s` |
| API surface index p95 | `< 3s` |
| candidate 分析（下载后）p95 | `< 5s` |
| plugin loader apply p95 | `< 100ms` |
| cached `/status` p95 | `< 50ms` |
| cached `/report` p95 | `< 100ms` |
| smoke 总超时 | `45s` 默认 |
| live scan 峰值内存 | `< 200MiB` 目标 |

性能超限必须显示阶段耗时并产生非绿色结果，不能跳过扫描后返回兼容。

## 18. 节点到验证的映射

| 节点 | 最低必须通过的验证层级 |
| --- | --- |
| G0 | L0、L8 Git 拓扑/workspace/secret/path 基线 |
| G1 | L0 文档/YAML、完整 L9、GitHub capability 实测 |
| M0 | schema review、threat model、golden examples |
| C1 | L0、L1 parser、L2 report、L3 temp profile |
| C2 | L1 semver/rules、K01-K06 static matrix |
| C3 | L1-L3 candidate、安全 tar、registry stub |
| C4 | L4、资源泄漏、网络边界 |
| C5 | L0-L4、CLI contract、clean install |
| P1 | L0-L3 Host API、故障隔离 |
| P2 | L2、L5 UI/accessibility |
| P3 | L3、L5 candidate/digest/security |
| I1 | K01-K08、L4-L7、进程管理器/服务监督器不变性审计 |
| R1 | 全部阻断 lane、L8 package/release、L9 traceability、clean-room、回退演练 |
| R2 | L8 awesome-list 投稿一致性、上游 CI |

## 19. 发布硬门槛

Release candidate 必须满足：

- K01、K03、K05 零 false green；
- K01-K08 所有可用真实工件 lane 符合预期；
- rule/path/tar/redaction 覆盖率达到门槛；
- 所有 CLI/Host API 契约测试通过；
- 50 次成功 smoke 和 20 次取消/失败 smoke 无泄漏；
- 无 critical/high 未处置安全问题；
- offline 模式网络审计通过；
- candidate 分析未执行 lifecycle script；
- CLI 与 UI 对同一报告给出相同总体状态；
- 报告和 UI 无测试 secret 泄漏；
- 正式 profile、进程管理器/服务监督器和插件数据不变性审计通过；
- clean-room 安装和回退演练通过；
- 产品树只有一个 Git 根和一个 lockfile，测试后工作树 clean；
- tag、三个 package、精确内部依赖和 CHANGELOG 版本一致；
- packed manifest 无 `workspace:`、`link:`、本机路径或未替换占位符；
- 插件 tarball 的 `dsh.bundle`、patch、repository directory 和 prerelease peers 验证通过；
- fixture 来源、integrity、许可证和用途清单完整；
- 发布说明准确区分 declared、startup validated 和 functional validated。
- release commit 中每个变更都可追溯到 Issue、有效 claim、PR、必要 review 和 CI evidence，且无未处置范围冲突。

任一硬门槛失败，release 不得通过人工豁免直接发布；如确需调整门槛，必须先更新设计、解释风险并重新评审。

## 20. 验证证据包

每个 release 生成一个不可变证据包：

```text
evidence/
├── environment.json
├── artifact-checksums.json
├── unit-and-coverage/
├── contract/
├── compatibility-matrix/
├── smoke/
├── plugin-e2e/
├── security/
├── coordination-governance/
├── repository-conformance/
├── package-inspection/
├── performance/
├── process-supervisor-isolation-audit/
├── clean-room-install/
└── rollback/
```

证据包内的日志先脱敏；原始敏感日志不进入 CI artifact。每个报告包含测试工件摘要、doctor/core/plugin 版本、schema 版本和执行环境。

R2 在对应 release 证据之外追加独立的生态投稿证据，不回写或重签 R1 工件：

```text
ecosystem-submission/
├── upstream.json              # repository、commit、核对日期
├── entry.yml
├── claim-evidence-map.md
├── install-verification.txt
├── generator-and-lint.txt
└── external-pr.json           # URL、CI、external status
```

## 21. 生产前人工验收

自动化全部通过后，在与生产相同架构的 macOS 主机上执行：

1. 对当前 profile 运行 offline scan；
2. 对目标候选运行 check-update；
3. 确认真实 profile 和进程管理器/服务监督器状态 before snapshot；
4. 运行隔离 smoke，确认使用临时 DSH_HOME 和非生产端口；
5. 检查报告无凭据、token 和会话内容；
6. 在测试 dsh 实例打开插件 UI，核对 CLI/UI 状态一致；
7. 检查进程、端口和临时目录清理；
8. 确认生产 profile、进程管理器/服务监督器管理的进程和插件数据未变化；
9. 按升级流程演练一次阻断和一次通过；
10. 演练回退并保存证据。

人工验收不能覆盖自动化失败，也不能把 `unknown` 手工改写成 `validated_compatible`；人工确认只能作为单独的审计记录和显式放行决策。

## 22. 回归维护

- 每个新 dsh 版本加入版本矩阵前，先固定工件 identity。
- 每个插件兼容事故新增永久 K 用例或合成 fixture。
- known matrix allow 必须带验证日期和工件摘要；过期后降级为 `unknown`。
- 删除测试前必须说明已不再支持的版本或由更强测试覆盖。
- 每季度审查 registry、安全解压、脱敏和进程清理假设。
- 每个 release 复核 Git 拓扑、lockstep、package repository 和 fixture 来源清单。
- 每次 R2 投稿或更新条目前重新读取上游贡献指南，记录 commit 和规则差异。
- 兼容规则发生误判时，发布规则数据修订和 doctor patch，并在发布说明中标明影响范围。
- 修改 Issue Form、状态、event、冲突、交接或 PR traceability 时重跑完整 L9；不能只做 Markdown 语法检查。
