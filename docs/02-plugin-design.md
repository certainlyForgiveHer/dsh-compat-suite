# 任务二：dsh Compatibility 插件详细设计

## 1. 定位与边界

dsh Compatibility 插件是兼容性报告的 Web 可视化入口。它可以在 dsh 健康运行时扫描当前环境、展示证据并辅助升级决策，但不能成为唯一的安全闸门。

原因是启动顺序存在不可消除的悖论：如果另一个插件令 loader 在宿主启动阶段失败，本插件可能根本没有机会执行。因此：

- CLI 对升级前阻断和崩溃后诊断负责；
- 插件对运行中可见性和人工审查体验负责；
- 插件不可把“页面显示正常”表述成“以后升级一定安全”；
- 插件不可要求 CLI 依赖一个正在运行的 dsh。

## 2. MVP 目标与非目标

### 2.1 MVP 目标

- 在 dsh Web 中展示宿主版本、核心包一致性和当前 profile。
- 展示每个已声明/已锁定/已安装插件的实际版本与启用状态。
- 展示共享规则引擎产生的兼容状态、证据等级和建议动作。
- 支持手动刷新当前环境扫描。
- 支持读取 CLI 写出的版本化报告，并明确显示报告时间和来源。
- 支持导出脱敏后的 JSON 报告。
- 在允许 registry 查询时，对一个精确候选版本做静态预检。
- 即使扫描失败，也不应使 dsh 宿主退出或进入重启循环。

### 2.2 MVP 非目标

- 不自动安装、升级、降级或移除插件。
- 不修改 profile、lockfile、loader patch 或 PM2 配置。
- 不在页面加载时自动访问 registry。
- 不从插件进程内部重启正式 dsh。
- 不把 dsh 内部的扫描结果当成启动前保证。
- 不展示 credentials、环境变量值、会话内容或插件业务数据。
- 不在 MVP 中从 Web UI 发起完整 smoke 子进程；UI 只展示已有 smoke 报告或给出可复制的 CLI 命令。

## 3. 组件结构

```text
dsh host process
   │
   ├── Compatibility host plugin
   │     ├── shared core: current inventory scan
   │     ├── report reader and validator
   │     ├── bounded in-memory cache
   │     └── authenticated same-origin HTTP API
   │
   └── Compatibility web client
         ├── summary
         ├── plugin inventory
         ├── finding details
         ├── candidate preview
         └── report export

external process
   └── dsh-compat-doctor CLI
         ├── preflight
         ├── candidate analysis
         └── isolated smoke
```

插件与 CLI 复用 `packages/core`，但插件构建不能把 CLI 的参数解析器、终端渲染器和进程控制代码打进浏览器 bundle。

## 4. 包与 Loader 设计

建议包名：

```text
@dsh-compat/core
@dsh-compat/doctor
@dsh-compat/plugin
```

建议 loader ID：

```text
dsh-compat
```

插件 package manifest 必须：

- 使用精确且经过实际测试的 `dsh.engines.dsh` 范围；
- 不声明未经验证的宽范围；
- 声明 `dsh.bundle.patch: "./cordis.patch.yml"`，保证可由 `dsh plugin add` 安装；
- 只有实际包含 Web 客户端时才声明 `dsh.client`；
- 把实际 import 的官方 `@deepseek-ai/*` 包声明为 `peerDependencies`，不得作为私有副本打入 `dependencies`；
- 对预发布版 dsh 使用显式 prerelease comparator，并以 semver 测试证明目标版本确实命中；
- 把 Host 与 Web 客户端入口分开；
- 明确客户端 inject 依赖；
- 不带 install lifecycle script；
- 使用 `files` 白名单限制 npm tarball 内容；
- 使用 `repository.url` 指回产品 Git 仓库，并以 `repository.directory` 指向 `packages/dsh-plugin`；
- 发布时包含对应 report schema 版本；
- 在发布说明中列出真实验证过的 dsh 版本矩阵。

示意结构如下；所有占位符必须在实现和发布前替换：

```json
{
  "name": "@dsh-compat/plugin",
  "version": "0.1.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/<owner>/dsh-compat-suite.git",
    "directory": "packages/dsh-plugin"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web"
    },
    "engines": {
      "dsh": "<tested-prerelease-aware-range>"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/<actually-imported-package>": "<tested-prerelease-aware-range>"
  }
}
```

第一个版本优先支持当前基线 `dsh 0.1.1-rc.2`。后续支持新宿主时，应先增加测试 lane，再扩展 engine 范围；不能先放宽再补测试。

GitHub 仓库在公开发布时应添加 `dsh-plugin` topic。向 `awesome-dsh-plugin` 投稿、截图、npm repository 关联和外部 fork 的具体流程见 [Git 仓库、版本与生态发布治理](05-repository-governance.md)；生态收录不属于插件启动时职责。

## 5. 启动与生命周期

### 5.1 启动顺序

1. 插件注册最小 Host 服务和 API；
2. 校验配置，不读取插件目录之外的业务数据；
3. 不在 loader apply 阶段执行 registry 请求或完整扫描；
4. 首次打开页面或 API 请求时执行惰性扫描；
5. 扫描异常转成结构化 `scan_error`，不向 loader 抛出未处理异常。

### 5.2 故障隔离

- 所有扫描 promise 必须有超时和 catch 边界；
- 同一时间只允许一个扫描，其他请求复用进行中的 promise；
- 连续失败采用有上限的退避，不使用高频轮询；
- 日志按错误指纹限流，避免每几秒刷屏；
- 内核初始化失败时，API 返回可解释错误页面，宿主仍保持可用；
- dispose 时取消扫描、关闭文件 watcher 和 SSE 连接；
- 插件不得拦截或修改其他 loader entry。

### 5.3 自身不兼容时

若本插件自身无法加载，外部 CLI 仍应报告：

- 本插件 package 版本；
- engine/peer 冲突；
- loader 错误；
- 推荐禁用本插件后恢复宿主的命令建议。

因此本插件不能是 dsh profile 的硬依赖，也不能改变 CLI 的可用性。

## 6. 扫描来源与模式

插件支持三种报告来源，并在 UI 中明确标识：

| 来源 | 用途 | 权威范围 |
| --- | --- | --- |
| `live-static` | 插件在当前宿主内调用共享内核做只读扫描 | 当前运行实例和静态规则 |
| `cli-report` | 读取 CLI 生成并通过 schema 校验的 JSON | 取决于 CLI 运行模式，可包含 smoke |
| `candidate-static` | 用户显式请求后查询固定候选版本 | 候选包静态风险，不包含运行验证 |

合并规则：

- 版本身份以最新 `live-static` 为准；
- smoke 证据只能来自 CLI report；
- 宿主/profile digest 不匹配时，CLI report 显示为 stale，不与当前结论合并；
- 旧 schema 无法迁移时只允许下载原报告，不在 UI 中呈现为当前状态；
- runtime failure 永远优先于 manifest allow。

## 7. Host API

所有 API 均使用版本前缀：

```text
/api/dsh-compat/v1
```

### 7.1 `GET /status`

返回轻量状态：

- 插件版本；
- report schema 版本；
- 最近扫描时间；
- 当前 summary status；
- 数据是否 stale；
- 是否正在扫描；
- registry lookup 是否启用。

不得返回绝对路径、原始日志或环境变量。

### 7.2 `GET /report`

返回最新的脱敏完整报告。响应必须通过共享 JSON Schema 校验。支持 ETag；输入 digest 未变化时避免重复传输。

### 7.3 `POST /scan`

触发当前配置 profile 的只读静态扫描。

请求体只能包含：

```json
{
  "requestId": "uuid"
}
```

profile 和路径由受信任的插件配置确定，不能由浏览器传任意文件路径。

### 7.4 `POST /candidate-check`

默认关闭。开启后仅接受：

```json
{
  "requestId": "uuid",
  "package": "@scope/name",
  "version": "1.2.3"
}
```

服务端再次验证包名和精确 semver，不接受 URL、范围、dist-tag、命令参数或文件路径。该接口只执行共享内核的安全下载和静态分析，不安装包。

### 7.5 `GET /events`

可选 SSE，用于发送 `scan-started`、`scan-completed` 和 `report-invalidated`。事件中只包含 request ID、时间和摘要，不包含原始错误堆栈。

## 8. Web UI 信息架构

### 8.1 页面头部

固定展示：

- 总体状态；
- dsh CLI 版本；
- 核心包是否一致；
- profile 名；
- 报告来源和时间；
- `fresh/stale` 标记；
- “重新扫描”和“导出报告”按钮。

如果报告只做了静态扫描，必须展示：

> 尚未执行隔离启动验证；当前结果不构成完整升级放行。

### 8.2 插件清单

列字段：

| 字段 | 说明 |
| --- | --- |
| 插件 | package name 和 loader ID |
| 状态 | enabled/disabled |
| 声明 | manifest specifier |
| 锁定 | lockfile version |
| 实际 | node_modules version |
| 宿主要求 | `dsh.engines` 或 unknown |
| 兼容结果 | 六种状态 badge |
| 证据 | 最强证据类型和 finding 数 |

默认按阻断程度排序：`incompatible`、`scan_error`、`degraded`、`unknown`、`declared_compatible`、`validated_compatible`。

### 8.3 Finding 详情

详情抽屉必须回答五个问题：

1. 发生了什么；
2. 实际值是什么；
3. 期望值是什么；
4. 证据来自哪里；
5. 下一步如何验证或回退。

原始路径默认以逻辑别名显示。日志仅展示脱敏、限长片段，同时显示原始片段哈希以支持离线比对。

### 8.4 候选版本预览

用户必须手动输入或选择一个精确版本。结果按差异展示：

- 当前 → 候选；
- engine 变化；
- peer 变化；
- API 引用变化；
- bundle/loader 变化；
- 新增阻断 finding；
- 建议执行的 CLI smoke 命令。

页面不能提供“一键升级”按钮。第一版只允许复制命令或下载报告。

### 8.5 状态与可访问性

- 不只依赖颜色表达状态；badge 同时包含文本和图标。
- 表格、抽屉和按钮完整支持键盘操作。
- 扫描进行中使用非阻塞状态，不清空上一份报告。
- API 不可用时保留最近有效报告并明确标记 stale。
- 空 profile、无插件、报告损坏和权限不足均有独立空状态。

## 9. 插件配置

建议配置形态：

```yaml
- id: dsh-compat
  name: '@dsh-compat/plugin'
  config:
    profile: web
    scanOnFirstOpen: true
    cacheTtlSeconds: 60
    allowRegistryLookup: false
    exposeAbsolutePaths: false
    reportFile: auto
```

约束：

- `profile` 只允许已知 profile 名，不能包含路径分隔符；
- `reportFile: auto` 解析到受控的 doctor 报告目录；
- 自定义 report 路径若未来支持，必须限制在配置白名单根中；
- `allowRegistryLookup` 默认 `false`；
- 配置变化使 cache 失效，但不得自动重启宿主。

## 10. 报告缓存与一致性

### 10.1 Cache key

至少包含：

- dsh binary realpath 和版本；
- 核心包版本摘要；
- profile manifest digest；
- lockfile digest；
- 直接插件 package manifest digest；
- 规则集版本；
- doctor/core 版本。

任一输入变化立即使报告 stale。

### 10.2 并发

- Host 内部只允许一个 active scan；
- 相同输入的并发请求共享结果；
- request ID 用于幂等和日志关联；
- 新输入到达时，不强行终止即将完成的旧扫描；旧结果只进入历史，不覆盖新 input key。

### 10.3 持久化

MVP 默认只缓存内存中的 live scan。若配置读取 CLI report：

- 只读打开；
- 先校验文件 owner/权限、大小、schema 和 digest；
- 不跟随超出允许目录的 symlink；
- 不修改 CLI report；
- 不把无效报告作为空白成功结果。

## 11. 安全模型

### 11.1 Web 边界

- 复用 dsh 的 loopback 和认证边界；
- 写型触发接口要求 same-origin 和 JSON content type；
- 不发送 permissive CORS header；
- 对 request ID、package、version 和 body 大小做严格验证；
- candidate 请求限流，避免 registry 滥用。

### 11.2 文件边界

- 只读扫描白名单 profile 元数据；
- realpath 后验证文件仍在允许根内；
- 不读取 credentials、sessions、storages 和 workspace 内容；
- 导出报告默认去除用户名、绝对路径、URL token 和环境变量值；
- 单次报告和日志片段有大小上限。

### 11.3 进程与网络边界

- MVP Host 插件不执行 shell；
- MVP 不从 Web UI 启动 dsh smoke 子进程；
- registry 请求只能由共享 candidate adapter 发出；
- registry 默认关闭且只允许配置中的 HTTPS origin；
- README、包描述和错误消息均视为不可信文本，使用 text rendering，不执行 HTML。

## 12. 可观测性

结构化事件至少包括：

- `compat.scan.started`；
- `compat.scan.completed`；
- `compat.scan.failed`；
- `compat.report.loaded`；
- `compat.report.rejected`；
- `compat.candidate.started`；
- `compat.candidate.completed`。

每条包含 request ID、耗时、状态和 finding 数，不包含用户路径或包内容。重复错误按指纹和时间窗限流。

插件健康状态分为：

- `ready`：API 和扫描可用；
- `degraded`：页面/API 可用，但扫描失败或报告 stale；
- `unavailable`：插件未加载，此状态只能由外部 CLI 或宿主 inventory 发现。

## 13. 性能预算

- 插件 loader apply：目标 p95 小于 100 ms，不执行扫描和网络；
- cached `/status`：目标 p95 小于 50 ms；
- cached `/report`：目标 p95 小于 100 ms；
- live static scan：目标 p95 小于 2 秒；
- 页面首次可交互：不等待 scan 完成；
- 内存 cache：默认仅保留当前和上一份归一化报告；
- 连续失败时不得形成每秒级重试或日志风暴。

## 14. UI 到 CLI 的交接

当用户需要 smoke 时，页面生成结构化建议：

```text
dsh-compat-doctor smoke --profile web \
  --plugin @scope/name@1.2.3 \
  --report-file <controlled-report-path>
```

UI 需要同时说明：

- 该命令将在独立临时环境运行；
- 它不会修改真实 profile；
- 若平台无法强制网络隔离，会在 CLI 中再次提示；
- 完成后刷新页面即可读取与当前 digest 匹配的报告。

命令由结构化参数渲染，只允许复制；浏览器不直接执行。

## 15. 建议实现结构

```text
packages/dsh-plugin/src/
├── host/
│   ├── index.ts
│   ├── service.ts
│   ├── routes.ts
│   ├── report-reader.ts
│   ├── cache.ts
│   └── config.ts
├── client/
│   ├── index.tsx
│   ├── pages/compatibility.tsx
│   ├── components/
│   │   ├── summary.tsx
│   │   ├── plugin-table.tsx
│   │   ├── finding-drawer.tsx
│   │   └── candidate-preview.tsx
│   ├── api.ts
│   └── locale/
├── assets/                  # 可选、经脱敏的公开展示截图
├── screenshots.json        # 可选，awesome-list/storefront 元数据
├── cordis.patch.yml
└── package.json
```

## 16. 插件完成定义

任务二只有在以下条件全部满足时才算完成：

- 插件自身 engine 范围与真实验证矩阵一致；
- loader apply 不做扫描或网络访问；
- 扫描失败不会使 dsh 退出或重复重启；
- UI 能准确显示六种兼容状态和证据来源；
- CLI report digest 不匹配时明确显示 stale；
- 所有 API 有 schema、认证边界、大小限制和错误契约；
- candidate check 只接受固定 npm 版本，不执行安装脚本；
- 页面没有自动升级、自动重启或任意命令执行入口；
- 浏览器 E2E、Host API、脱敏和故障注入测试通过；
- 在插件被禁用或故意破坏时，CLI 仍能独立报告问题；
- npm tarball 包含有效 `dsh.bundle`、相邻的 `cordis.patch.yml` 和所需入口；
- packed manifest 不含 `workspace:`、`link:`、本机路径或未替换占位符；
- 从发布 tarball 执行 clean-room `dsh plugin add` 验证成功。
