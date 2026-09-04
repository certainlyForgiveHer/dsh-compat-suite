# 任务一：dsh-compat-doctor CLI 详细设计

## 1. 定位

`dsh-compat-doctor` 是运行在 dsh 进程之外的只读兼容性检查器。它必须在以下三种状态下均可工作：

1. dsh 正常运行；
2. dsh 已停止；
3. dsh 因某个插件加载失败而无法启动。

CLI 是升级前安全闸门和故障后的诊断入口。dsh 插件只消费 CLI/共享内核的结果，不能反过来成为 CLI 的运行依赖。

## 2. 目标与非目标

### 2.1 MVP 目标

- 发现实际执行的 dsh 二进制、CLI 版本和核心包版本。
- 发现指定 profile 中声明、锁定和实际安装的插件版本。
- 检查 `dsh.engines`、`peerDependencies`、lockfile 一致性和已知兼容矩阵。
- 对插件分发代码做有限、可解释的 API 表面检查。
- 在不修改真实 profile 的前提下分析候选升级版本。
- 在临时 `DSH_HOME` 和隔离端口中启动 dsh，验证插件组合能否加载。
- 以人类可读文本和稳定 JSON 两种格式输出结果。
- 提供稳定退出码，供 CI、升级脚本或 PM2 外层流程使用。
- 所有结论包含证据、来源和置信等级。

### 2.2 MVP 非目标

- 不自动修改真实 `package.json`、lockfile、`cordis.patch.yml` 或 PM2 配置。
- 不自动安装、升级、降级或删除插件。
- 不自动执行 `pm2 restart`、`pm2 save` 或系统服务操作。
- 不读取模型凭据、会话内容、插件业务数据或用户工作区文件。
- 不保证插件所有业务功能正确；启动烟雾测试只证明定义范围内的启动兼容性。
- 不把任意 Git 仓库、文件路径或未固定版本当作可安全执行的候选包。
- 不执行候选 npm 包的 install/preinstall/postinstall 等 lifecycle scripts。

## 3. 总体架构

```text
CLI command
   │
   ├── Environment resolver
   │     ├── dsh binary identity
   │     ├── host/core versions
   │     └── profile location
   │
   ├── Inventory scanner
   │     ├── package.json
   │     ├── pnpm-lock.yaml
   │     ├── node_modules payloads
   │     └── bundle/patch metadata
   │
   ├── Compatibility rule engine
   │     ├── manifest rules
   │     ├── semver rules
   │     ├── known compatibility matrix
   │     └── API surface rules
   │
   ├── Candidate analyzer (optional registry access)
   │
   ├── Isolated smoke runner (explicit command only)
   │
   └── Reporter
         ├── terminal
         ├── JSON
         └── evidence bundle
```

共享内核必须是无 UI、无 PM2 写操作、无 shell 拼接的 TypeScript 库。CLI 只负责参数解析、进程生命周期和输出格式。

## 4. 术语与结果语义

### 4.1 兼容状态

| 状态 | 含义 | 是否可默认放行升级 |
| --- | --- | --- |
| `validated_compatible` | 声明检查通过，并且对应组合完成规定的隔离启动验证 | 是 |
| `declared_compatible` | 明确的版本声明或可信兼容矩阵支持，但本机尚未做烟雾测试 | 仅 advisory 模式可放行 |
| `degraded` | 宿主可启动，但插件持续报错、功能缺失或健康探针失败 | 否 |
| `incompatible` | 已确认版本范围冲突、缺失 API、加载失败或进程崩溃 | 否 |
| `unknown` | 信息不足、元数据缺失或静态分析无法得出可靠结论 | 否，需人工确认或 smoke |
| `scan_error` | 文件损坏、权限不足、版本解析失败或检查器自身无法完成扫描 | 否 |

### 4.2 证据等级

| 等级 | 例子 | 可证明什么 |
| --- | --- | --- |
| `runtime` | loader 报错、ready 探针、稳定观察窗口 | 可以确认启动成功、崩溃或持续降级 |
| `host_api` | 插件调用的方法在当前宿主实际导出表中不存在 | 可以确认该调用路径不兼容 |
| `manifest` | `dsh.engines`、mandatory peer range | 可以确认显式版本冲突；范围匹配本身不能证明全部功能兼容 |
| `known_matrix` | 经固定工件和测试验证的宿主/插件组合 | 可以在矩阵版本和工件哈希匹配时提供强证据 |
| `lock` | manifest、lockfile、node_modules 三方一致性 | 可以确认实际运行版本身份 |
| `heuristic` | 源码字符串、动态 API 使用推断 | 只能提升风险，不能单独判定兼容 |

### 4.3 零误报为绿原则

- 没有找到错误不等于兼容。
- 仅有 semver 范围匹配时，最高为 `declared_compatible`。
- 缺少 manifest 兼容声明且未执行 smoke 时必须是 `unknown`。
- API 静态检查发现明确缺失方法可判定 `incompatible`；未发现缺失方法不能反向证明兼容。
- smoke 只覆盖启动和所配置的健康探针，报告必须标明未覆盖的功能。

## 5. 命令接口

### 5.1 当前环境扫描

```text
dsh-compat-doctor scan --profile web
dsh-compat-doctor scan --profile web --json
dsh-compat-doctor scan --profile web --strict
```

职责：发现当前宿主和 profile 的真实状态，执行离线静态规则，不访问 registry，不启动第二个 dsh。

### 5.2 候选版本预检

```text
dsh-compat-doctor check-update \
  --profile web \
  --plugin @scope/name@1.2.3
```

职责：下载并检查一个固定版本候选包，比较当前版本与候选版本，生成不修改真实 profile 的升级风险报告。

MVP 只接受 npm 包名加精确版本。拒绝 `latest`、`^1.2.3`、Git URL、本地路径和任意 shell 文本。未来支持其他来源时必须有独立的来源适配器和完整性策略。

### 5.3 隔离启动验证

```text
dsh-compat-doctor smoke --profile web
dsh-compat-doctor smoke \
  --profile web \
  --plugin @scope/name@1.2.3 \
  --timeout 45s
```

职责：构建临时 profile，启动独立 dsh 子进程，等待 ready、进行 HTTP 和日志检查、观察最小稳定窗口，然后清理子进程和临时资源。

### 5.4 解释单条结论

```text
dsh-compat-doctor explain <finding-id> --report <report.json>
```

职责：把规则、实际值、期望值、来源文件和建议动作完整展开，便于人工审查。

### 5.5 通用参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--dsh-bin` | 从当前 `PATH` 解析 | 指定待检查二进制；报告同时记录输入路径和 realpath |
| `--dsh-home` | 解析 dsh 默认值 | 只用于发现 profile，不允许扫描凭据和会话内容 |
| `--profile` | 必填 | profile 名，MVP 限制为安全字符集合 |
| `--json` | `false` | stdout 只输出机器可读 JSON，诊断写 stderr |
| `--strict` | `false` | `unknown`、`degraded` 也产生阻断退出码 |
| `--offline` | `scan` 默认开启 | 禁止 registry 和其他网络访问 |
| `--timeout` | `45s` | smoke 总超时，允许在安全范围内调整 |
| `--stability-window` | `15s` | ready 后继续观察的时间 |
| `--report-file` | 无 | 原子写入 JSON 报告；不覆盖现有文件，除非显式允许 |
| `--no-color` | 非 TTY 自动开启 | 禁止 ANSI 颜色，便于日志解析 |

## 6. 稳定退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 当前策略允许继续；无阻断 finding |
| `1` | 存在 `incompatible` |
| `2` | strict 模式下存在 `unknown` 或 `degraded` |
| `3` | 输入、profile 或报告契约错误 |
| `4` | 扫描基础设施错误，例如权限、损坏文件、无法解析宿主身份 |
| `5` | smoke 未达到可判定结果，例如超时、端口配置失败或无法建立隔离环境 |
| `70` | CLI 内部错误；必须附带可报告的错误标识，不输出敏感堆栈到普通终端 |

同一运行同时出现多类问题时，优先级为 `70 > 4 > 5 > 1 > 2 > 0`。JSON 报告仍保留全部 finding，退出码只表达自动化决策。

## 7. 环境与插件发现

### 7.1 宿主身份

依次收集：

1. 输入的 dsh 路径；
2. `realpath` 后的真实可执行文件；
3. `dsh --version` 输出；
4. CLI 所属 npm package 的名称、版本和 package root；
5. 宿主内所有 `@deepseek-ai/dsh-*` 核心包的实际版本；
6. Node.js 版本、平台和架构；
7. CLI 版本与核心包版本是否一致。

如果 `dsh --version` 为 `0.1.1-rc.2`，但实际核心包出现其他版本，应生成 `host-version-skew`，最低状态为 `degraded`；若关键包跨代，状态为 `incompatible` 或 `scan_error`，不得继续给出绿色结论。

### 7.2 Profile 身份

只读取以下范围：

- `<dsh-home>/profiles/<profile>/package.json`
- 对应 lockfile；MVP 首先支持 `pnpm-lock.yaml` v9
- 直接依赖插件的 `node_modules/<name>/package.json`
- 插件 package 中声明的 bundle patch 文件
- profile 的 `cordis.patch.yml`，仅解析 loader 条目和 disabled 状态

不得递归读取插件数据目录、会话日志、credentials、工作区源代码或任意未声明路径。

### 7.3 三方版本一致性

每个插件必须比较：

```text
manifest specifier ↔ lockfile resolved version ↔ node_modules actual version
```

规则：

- 三方一致：版本身份可信。
- manifest 与 lockfile 不一致：`degraded`，提示重新生成 lockfile。
- lockfile 与实际安装不一致：`degraded`；候选 smoke 不得复用该 node_modules。
- 包目录缺失：`scan_error` 或 `incompatible`，取决于插件是否仍在 bundles 中启用。
- 同名插件出现多个实际版本：报告全部路径，标记 `ambiguous-resolution`。

## 8. 兼容性规则引擎

### 8.1 规则输入

- 宿主 CLI 和核心包身份；
- 插件 manifest、lock 和实际版本；
- `dsh.engines.dsh`；
- mandatory/optional `peerDependencies`；
- bundle loader ID 和启用状态；
- 已知兼容矩阵；
- 插件分发代码引用的宿主 API；
- 可选 smoke 结果。

### 8.2 规则优先级

从高到低：

1. 工件身份或扫描完整性失败；
2. smoke 进程崩溃、loader 失败、ready 超时；
3. 已验证的明确 deny 规则；
4. `dsh.engines` 不匹配；
5. mandatory peer dependency 不匹配；
6. 插件引用的宿主 API 明确不存在；
7. 启动后持续错误或健康探针失败；
8. 已验证 allow 规则；
9. manifest 范围匹配；
10. 启发式风险与信息缺失。

高优先级结论不能被低优先级 allow 覆盖。例如 manifest 声明范围宽泛，但 smoke 已复现缺失 API，则结果必须是 `incompatible`。

### 8.3 预发布 semver

必须使用经过测试的 semver 实现，不允许手写字符串比较。重点覆盖：

- `0.1.1-rc.2` 小于 `0.1.2-alpha.1`；
- prerelease 只有在范围语义允许时才匹配；
- optional peer 不直接产生阻断结论，但必须记录；
- 非法或自定义版本字符串产生 `unknown`，不能静默强转。

### 8.4 已知兼容矩阵

内置规则采用版本化 JSON/YAML 数据文件，至少包含：

- 宿主精确版本或范围；
- 插件名称和精确版本或范围；
- `allow`、`deny` 或 `degraded`；
- 验证类型；
- 工件完整性摘要；
- 来源和验证日期；
- 规则过期策略；
- 可选的最低 doctor 版本。

本地规则优先于远程规则。MVP 不自动下载并信任远程矩阵；若未来增加更新，必须做签名验证、版本回滚保护和缓存审计。

## 9. API 表面检查

### 9.1 目的

识别“包能安装、semver 看似匹配，但插件调用宿主不存在的方法”的问题。例如：

```text
ctx.subagents.registerContinuableSetup(...)
```

### 9.2 方法

1. 只扫描 npm 包 `files` 范围内的发布 JS 和类型声明；
2. 提取静态可识别的 `ctx.<service>.<method>`、命名导入和深层 package import；
3. 从当前宿主实际安装包的运行时代码和 `.d.ts` 构建 API 索引；
4. 对明确缺失的方法生成 `missing-host-api`；
5. 对动态属性访问、反射、字符串拼接和 minified 代码标记 `analysis-incomplete`。

### 9.3 边界

- 静态检查不执行插件代码。
- 发现明确缺失 API 可以阻断。
- 未发现缺失 API 不能判定兼容。
- 不对任意源码运行 AST transformer 或第三方插件。
- 单包展开大小、文件数和单文件大小必须设上限，防止压缩炸弹和资源耗尽。

## 10. 候选版本分析

### 10.1 获取流程

1. 验证 package name 和精确 semver；
2. 从配置允许的 npm registry 获取 metadata；
3. 记录 tarball URL、integrity、shasum 和 publish time；
4. 直接下载 tarball 到临时 cache；
5. 先检查内容列表、路径和大小，再安全展开；
6. 不执行 lifecycle scripts；
7. 读取候选 `package.json`、bundle patch 和发布 JS；
8. 与当前宿主、当前插件和当前 profile 进行差异分析。

### 10.2 输出

候选报告必须展示：

- 当前版本与目标版本；
- 宿主要求的变化；
- 新增、移除或变化的 peer dependencies；
- bundle loader ID 变化；
- 新出现的宿主 API 引用；
- 静态决策和剩余未知项；
- 是否建议进入 smoke；
- 不修改现场的手工升级/回退建议，但不自动执行。

### 10.3 安全限制

- MVP 不接受版本范围和 dist-tag，避免 registry 状态变化造成不可复现结果。
- 拒绝 tar 中的绝对路径、`..`、设备文件、异常链接和超限内容。
- registry 重定向必须受允许列表约束。
- cache key 包含 package、version 和 integrity；相同版本但 integrity 变化必须阻断。

## 11. 隔离启动验证

### 11.1 隔离原则

- 使用系统临时目录创建唯一测试根；
- 使用独立 `DSH_HOME`；
- 生成独立测试 profile；
- 使用独立 loopback 端口；
- 不连接真实 PM2 app；
- 不读取或写入真实插件业务数据；
- 默认不复制 credentials；
- 所有子进程在超时、异常和 Ctrl-C 时均被回收；
- 临时目录默认保留到报告完成后再删除；失败时可通过显式参数保留用于审计。

### 11.2 Profile 构建

当前组合 smoke：

1. 复制经过白名单筛选的 profile manifest、lock 和 loader patch；
2. 解析并固定所有直接插件版本；
3. 在临时 profile 中安装/链接已验证工件；
4. 安装阶段使用冻结 lockfile 和 `--ignore-scripts`；
5. 对 Git/link 依赖若无法离线重建，结果为 `smoke-unavailable`，不得伪装成通过。

候选组合 smoke：在临时 manifest 中只替换指定插件版本，其他依赖必须保持原 lock 身份。报告必须记录完整差异。

### 11.3 分阶段运行

| 阶段 | 动作 | 成功条件 |
| --- | --- | --- |
| S0 环境 | 验证二进制、临时目录、端口和 profile | 无路径冲突，工件身份完整 |
| S1 组合 | 执行受支持的 config dump/compose 检查 | 配置可解析，无 loader composition failure |
| S2 启动 | 启动 `dsh web --no-open` 等价命令 | 在超时内输出 ready 或监听 loopback |
| S3 健康 | HTTP 探针、进程状态和日志分类 | 接受预定义的 `2xx` 或认证型 `401`；无 fatal finding |
| S4 稳定 | 继续观察默认 15 秒 | PID 未变化，无重复异常、无高频兼容错误 |
| S5 退出 | 发送正常终止信号并等待 | 在 10 秒内退出；无遗留子进程和端口 |

具体启动参数由版本适配器生成，不能假设所有 dsh 版本支持同一端口参数。若无法安全指定独立端口，应中止 smoke，而不是占用正式服务端口。

### 11.4 日志判定

至少识别：

- `plugin tree failed to load`；
- `failed to apply loader entry`；
- `is not a function`、`missing service`、`cannot get required service`；
- 未捕获异常和 promise rejection；
- PM2 式快速退出/重启模式；
- 同一错误在观察窗口内高频重复；
- ready 后端口消失。

日志匹配只是 finding 生成器；最终状态由规则引擎结合退出状态、ready 和重复频率决定。

### 11.5 网络边界

启动本身可能触发第三方插件遥测。默认 smoke 报告必须显示网络隔离是否真正生效：

- 若平台可强制阻断非 loopback 网络，则默认启用；
- 若无法可靠阻断，必须要求显式确认或运行 `--offline-static`，不能声称“无网络副作用”；
- smoke 不创建模型会话、不发送提示词、不调用模型 API；
- 任何需要凭据或外部服务才能启动的插件标记为 `smoke_blocked`。

## 12. 报告契约

### 12.1 顶层结构

```json
{
  "schemaVersion": 1,
  "run": {
    "id": "uuid",
    "startedAt": "RFC3339",
    "mode": "scan|check-update|smoke",
    "doctorVersion": "0.1.0"
  },
  "host": {
    "binaryInput": "/path/to/dsh",
    "binaryRealpath": "/real/path/to/dsh",
    "cliVersion": "0.1.1-rc.2",
    "nodeVersion": "26.5.0",
    "corePackages": {}
  },
  "profile": {
    "name": "web",
    "manifestDigest": "sha256:...",
    "lockDigest": "sha256:..."
  },
  "plugins": [],
  "findings": [],
  "summary": {
    "status": "incompatible",
    "blocking": 1,
    "review": 0
  }
}
```

### 12.2 Plugin 记录

每条至少包含：

- package name；
- loader IDs；
- enabled/disabled；
- manifest specifier；
- lock version；
- actual version；
- package integrity；
- compatibility status；
- evidence IDs；
- smoke coverage；
- 未检查的功能列表。

### 12.3 Finding 记录

每条至少包含：

- 稳定 `id` 和规则 `code`；
- `status`、`severity`、`confidence`；
- 插件和宿主身份；
- observed、expected；
- evidence type 和来源；
- 脱敏后的位置或日志摘要；
- 建议的下一步；
- 是否阻断当前策略。

报告 schema 必须单独版本化并提供 JSON Schema。新增可选字段不提升 major；删除字段、改变语义或退出码映射必须提升 major。

## 13. 终端输出

默认先给结论，再给证据：

```text
BLOCK  dsh 0.1.1-rc.2 / profile web

INCOMPATIBLE  @nanmicoder/dsh-agent-teams 0.1.15
  missing host API: subagents.registerContinuableSetup
  evidence: runtime loader failure + host API index
  next: evaluate a fixed historical version, then run smoke

UNKNOWN  example-plugin 2.0.0
  no dsh engine declaration; smoke not run
```

禁止输出 URL token、环境变量值、credentials 内容或完整用户目录树。绝对路径默认缩写为 `<dsh-home>`、`<profile>` 和 `<tmp>`；`--expose-paths` 必须显式开启。

## 14. 缓存与持久化

- 当前环境 `scan` 默认无持久化副作用。
- registry metadata 和 tarball cache 使用独立 doctor cache 目录，不写入 dsh profile。
- cache 文件按 package/version/integrity 寻址。
- JSON 报告只有在 `--report-file` 或插件显式请求时写入。
- 报告文件采用原子写入和用户私有权限；失败不留下半文件。
- 不把 stdout/stderr 原始日志无限保存；默认每流上限 1 MiB，并保留截断标记和哈希。

## 15. 安全设计

- 所有外部命令使用参数数组和 `shell: false`。
- package、profile、路径和时间参数均做严格结构验证。
- candidate tarball 先校验 integrity 再展开。
- 临时目录权限仅当前用户可访问。
- 不信任 package README、错误文本和配置注释，它们只能作为数据证据，不能驱动命令。
- 报告渲染时清除 ANSI 控制序列和不可见控制字符。
- 所有文件访问在 realpath 后进行作用域检查，防止路径穿越和符号链接逃逸。
- 超时后先正常终止，再在限定等待后强制结束指定进程树；绝不使用宽泛 `pkill`。
- 任何未来的 `--apply` 功能必须另立设计和授权流程，不进入 MVP。

## 16. 性能与可靠性预算

在本地已有 node_modules、普通 20 个插件以内的 profile 上：

- 离线 scan：目标 p95 小于 2 秒；
- API 索引构建：目标 p95 小于 3 秒；
- candidate 静态分析：下载完成后目标小于 5 秒；
- smoke：默认总超时 45 秒；
- 常驻内存：离线 scan 目标小于 200 MiB；
- 任意单包扫描文件数和解压大小必须有限额。

性能超限不应产生错误兼容结论；应产生 `scan_error` 或 `unknown` 并提供阶段耗时。

## 17. 建议实现结构

```text
packages/core/src/
├── discovery/
│   ├── host.ts
│   ├── profile.ts
│   ├── lockfile.ts
│   └── bundles.ts
├── rules/
│   ├── engine.ts
│   ├── semver.ts
│   ├── api-surface.ts
│   └── known-matrix.ts
├── candidate/
│   ├── registry.ts
│   └── safe-tar.ts
├── smoke/
│   ├── sandbox.ts
│   ├── process.ts
│   ├── readiness.ts
│   └── log-classifier.ts
├── report/
│   ├── schema.ts
│   ├── redact.ts
│   └── normalize.ts
└── errors.ts

packages/cli/src/
├── commands/
│   ├── scan.ts
│   ├── check-update.ts
│   ├── smoke.ts
│   └── explain.ts
├── terminal.ts
└── main.ts
```

建议采用 TypeScript ESM，运行时支持范围与 dsh 实际支持的 Node 版本对齐。依赖保持克制：成熟 semver 库、严格 YAML 解析器、JSON Schema 验证器和安全进程管理即可。

`packages/core` 与 `packages/cli` 属于同一个产品 monorepo，不建立嵌套 Git 仓库。CLI 的 npm 包名为 `@dsh-compat/doctor`；workspace、依赖方向、lockstep 版本、fixture 来源和 release 工件规则见 [Git 仓库、版本与生态发布治理](05-repository-governance.md)。

## 18. CLI 完成定义

任务一只有在以下条件全部满足时才算完成：

- 四个命令的契约、JSON schema 和退出码冻结；
- 当前环境扫描在 dsh 无法启动时仍可运行；
- 本次真实故障矩阵全部得到预期结论；
- candidate 分析不执行包脚本、不修改真实 profile；
- smoke 能证明进程、端口、临时目录均已清理；
- 已知不兼容组合不存在 false green；
- 所有阻断结论都有可复核证据；
- 安全、故障注入和跨平台必测项通过；
- 发布包可从干净环境安装并复现同一归一化报告；
- packed manifest 不含 `workspace:`、`link:`、本机路径或未替换占位符；
- CLI tarball、core tarball、Git tag 与 release commit identity 一致。
