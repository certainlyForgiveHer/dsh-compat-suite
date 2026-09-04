# Git 仓库、版本与生态发布治理

状态：设计基线 v2
外部收录规则核对日期：2026-09-04

## 1. 目的与适用范围

本文定义 `dsh-compat-suite` 的 Git 仓库边界、workspace 组织、跨包依赖、版本发布、分支与评审、多 Agent 协作入口、测试工件治理，以及向 `awesome-dsh-plugin` 投稿时的外部仓库边界。

本文解决的是源码和发布治理问题，不改变以下产品边界：

- `dsh-compat-doctor` CLI 仍是宿主进程之外的权威兼容性闸门；
- dsh Compatibility 插件仍是只读可视化入口；
- MVP 不自动安装、升级、降级、删除插件或重启正式 PM2 服务；
- `awesome-dsh-plugin` 收录不等同于安全审计，也不改变本项目自己的发布门槛。

## 2. 决策摘要

首个稳定设计采用以下不可含糊的仓库决策：

1. `dsh-compat-suite/` 是唯一产品 Git 根目录。
2. `core`、CLI 和 dsh 插件是同一 monorepo 中的三个发布包，不是三个 Git 仓库。
3. 产品仓库内禁止嵌套 `.git`、Git submodule 和 Git subtree。
4. 根目录只有一个 `pnpm-lock.yaml`，package 不拥有独立 lockfile。
5. `0.x` 阶段三个 npm 包 lockstep 发布，使用同一个产品版本和 Git tag。
6. report schema 自带独立 `schemaVersion`，不能用 npm 版本代替协议版本。
7. 兼容规则、schema 和跨包测试必须与消费它们的代码在同一个提交中原子更新。
8. `awesome-dsh-plugin` 使用产品仓库之外的独立 fork/checkout；它不是构建依赖，也不进入 lockfile。
9. 真实 DSH profile、PM2 数据、credentials、运行日志和 smoke 临时目录不得进入 Git。
10. 发布证据默认保存在 CI artifact/GitHub Release；源码仓库只保存可复现定义、固定摘要和小型脱敏 golden fixture。
11. GitHub Issue 只作为任务范围、认领事件、进度和交接的协调账本，不作为文件、分支或任务锁。
12. 一个 Issue 同时只记录一个活跃实现 Agent；该约束通过 `AGENTS.md`、协调者确认、独立 worktree 和 PR 验收执行，不声称 GitHub 提供原子互斥。

若未来要改变任一决策，必须先提交 ADR，说明迁移、回退、发布兼容性和安全影响，再修改仓库结构。

## 3. 物理仓库拓扑

### 3.1 本地拓扑

```text
<workspace>/                         # 本地工作容器，不是产品 Git 根
├── dsh-compat-suite/                 # 产品 monorepo，唯一产品 .git
│   ├── .git/
│   └── ...
├── dsh-compat-suite-wt-<purpose>/    # 可选 git worktree，位于产品根之外
└── awesome-dsh-plugin-fork/          # 可选独立 fork/checkout
```

规则：

- 不在 `<workspace>` 初始化一个包住所有项目的父级 Git 仓库。
- 不把 `awesome-dsh-plugin-fork/`、真实 DSH home 或 PM2 home 放进产品仓库。
- 临时 worktree 使用主仓库的 Git 元数据，但 checkout 位于产品根之外；测试脚本不能假定只有一个 checkout。
- 第三方插件源码不得通过 submodule/subtree 永久嵌入。需要真实工件时按精确版本和 integrity 获取。
- CI checkout、发布 checkout 和开发 checkout 都必须能从单一仓库独立恢复。

### 3.2 产品仓库目标结构

```text
dsh-compat-suite/
├── .git/
├── AGENTS.md
├── .github/
│   ├── CODEOWNERS
│   ├── ISSUE_TEMPLATE/
│   │   └── implementation.yml
│   ├── pull_request_template.md
│   └── workflows/
│       ├── pr.yml
│       ├── controlled-smoke.yml
│       ├── nightly.yml
│       └── release.yml
├── .changeset/
├── .gitignore
├── .gitattributes
├── LICENSE
├── SECURITY.md
├── CONTRIBUTING.md
├── CHANGELOG.md
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   └── src/
│   ├── cli/
│   │   ├── package.json             # name: @dsh-compat/doctor
│   │   └── src/
│   └── dsh-plugin/
│       ├── package.json             # name: @dsh-compat/plugin
│       ├── cordis.patch.yml
│       ├── screenshots.json         # 可选
│       ├── assets/                  # 可选、经脱敏和压缩的公开展示截图
│       └── src/
├── schemas/
├── rules/
├── fixtures/
│   ├── synthetic/
│   ├── golden/
│   └── sources.lock.json
├── tests/
├── docs/
│   ├── 01-cli-design.md
│   ├── 02-plugin-design.md
│   ├── 03-milestones.md
│   ├── 04-validation-plan.md
│   ├── 05-repository-governance.md
│   ├── 06-multi-agent-collaboration.md
│   └── adr/
│       └── 0001-issue-ledger-not-lock.md
└── scripts/
```

根 `package.json` 必须标记 `private: true`，固定 `packageManager` 版本，只承担 workspace、脚本和开发依赖管理，不能被发布到 npm。

### 3.3 Canonical remote、名称与许可证

- G0 必须选定唯一 canonical GitHub URL；正式 checkout 的 `origin` 指向该仓库，个人 fork 使用 `origin`，并以 `upstream` 指向 canonical 仓库。
- 默认分支统一为 `main`。CI、README、package repository 和 awesome-list URL 不得分别指向不同镜像。
- `@dsh-compat/*` 是当前逻辑包名。G0 必须验证维护者确实拥有对应 npm scope 的发布权限；若没有，先选择可拥有的新 scope 并原子更新六份设计文档，不能抢注或发布到他人命名空间。
- G0 必须由维护者明确选择开源许可证，并确保根 LICENSE、各 package metadata 和第三方 fixture 使用方式一致。未选择许可证不会被默认解释为 MIT、Apache-2.0 或其他许可证。
- 产品仓库在 R2 前必须公开；如开发阶段保持私有，release/投稿文档必须记录公开时点和敏感历史审计。

## 4. Package 职责与依赖方向

### 4.1 发布单元

| 目录 | npm 包 | 责任 | 允许依赖 |
| --- | --- | --- | --- |
| `packages/core` | `@dsh-compat/core` | inventory、规则、schema、脱敏、candidate 与隔离控制内核 | 受审计的通用库 |
| `packages/cli` | `@dsh-compat/doctor` | 命令解析、终端输出、退出码、外部进程编排 | `core` |
| `packages/dsh-plugin` | `@dsh-compat/plugin` | Host API、Web UI、报告读取和候选预览 | `core` 的显式入口 |

依赖必须是有向无环图：

```text
doctor ───────► core
dsh-plugin ───► core
core ─────────X doctor
core ─────────X dsh-plugin
doctor ───────X dsh-plugin
```

### 4.2 Node 与浏览器边界

`core` 必须通过 package exports 暴露不同运行时入口，例如：

- `@dsh-compat/core/node`：文件发现、tar、子进程和 smoke；
- `@dsh-compat/core/browser`：状态类型、纯函数和安全展示模型；
- `@dsh-compat/core/schema`：报告 schema、版本和 validator。

浏览器 bundle 不得通过深层 import 绕过 exports，也不得包含 `child_process`、文件系统扫描、registry credentials 或 smoke 代码。CI 必须对构建后的 import graph 做检查。

### 4.3 Workspace 依赖

- 开发态内部依赖使用 `workspace:*`，禁止本地绝对路径和 `file:` 逃逸。
- 发布打包后，依赖必须转换为与当前 release 相同的精确版本；tarball 中残留 `workspace:`、`link:` 或本机路径即阻断发布。
- `core` 的公开 API 只能经 exports 使用；禁止跨 package 读取 `src/`。
- 根 lockfile 是依赖身份的唯一来源。package 目录出现第二个 lockfile 时 CI 失败。

## 5. 版本与协议策略

### 5.1 `0.x` lockstep

在 `0.x` 阶段：

- `core`、`doctor`、`plugin` 使用相同版本，例如全部为 `0.1.0`；
- 每个 release 只有一个版本 PR、一个 release commit 和一个 `vX.Y.Z` tag；
- 任何已发布 package 发生代码变化，三个 package 一起提升版本；
- 发布包之间使用精确内部版本，避免 CLI、插件和 schema 解析器漂移；
- Changesets 记录变更意图，但 release 聚合器必须强制 lockstep。

项目达到稳定 API 后，如需独立版本，必须新增 ADR，并先实现跨版本兼容矩阵、schema 迁移和至少一个版本周期的双版本验证。

### 5.2 Schema 版本

`schemaVersion` 与 npm version 分离：

- 向后兼容增加字段：保留 major，增加 schema minor；
- 删除字段、改变状态含义或收紧必填字段：提升 schema major；
- CLI 与插件必须在同一 PR 中增加新 schema 的生产、读取和拒绝/迁移测试；
- 旧插件读取新报告失败时必须显示 `unsupported-schema`，不能回退成绿色；
- 发布说明同时列出产品版本、schema 版本和已验证 DSH 范围。

### 5.3 规则版本

- 内置规则随 npm/GitHub release 发布，不从未签名远程地址静默热更新。
- 每条 known allow/deny 包含规则 ID、适用版本、证据摘要、验证日期和来源工件摘要。
- 规则变化至少触发 patch release；撤销 false green allow 时优先发布紧急 patch。
- 若未来支持独立规则 feed，必须先设计签名、回滚、防降级和离线快照；MVP 不启用。

## 6. 分支、提交与评审治理

### 6.1 分支模型

- `main` 是唯一长期分支，必须始终可构建。
- 所有实现分支包含 Issue 编号：`feat/<issue>-<slug>`、`fix/<issue>-<slug>`、`docs/<issue>-<slug>`、`rules/<issue>-<slug>`；发布分支使用 `release/<issue>-<version>`。
- 正常变更经 PR 合并，禁止直接推送 `main`。
- 默认 squash merge，使一个 PR 对应一个可回退变更单元。
- 已发布 tag 和 GitHub Release 不覆盖、不移动；修复通过新版本发布。
- 每个活跃实现 Agent 使用产品根之外的独立 worktree；branch/worktree 是代码隔离手段，不是任务锁。

### 6.2 Required checks

普通 PR 至少通过：

1. workspace/lockfile 一致性；
2. 格式、lint、typecheck；
3. schema、契约和单元测试；
4. package exports 与浏览器边界；
5. fixture 来源和敏感信息检查；
6. 受影响 package 构建与 pack 内容检查；
7. 文档链接、Mermaid 和示例命令静态校验；
8. 变更分类与 Changeset 检查。
9. Issue、`claim_id`、确认范围、共享接口和 PR diff 的 traceability 检查。

`core`、`schemas/` 或 `rules/` 变化时，路径过滤不能跳过 CLI 与插件测试。smoke、安全或进程管理变化时必须运行受控 L4/L7 lane。

### 6.3 评审责任

建议 CODEOWNERS 边界：

- `/schemas/`、`packages/core/src/report/`：协议 owner；
- `/rules/`、`packages/core/src/rules/`：兼容规则 owner；
- `safe-tar`、进程、网络、脱敏代码：安全 owner；
- `/packages/dsh-plugin/`：Host/Web owner；
- `/.github/workflows/release.yml`：release owner。

有多名维护者时，安全边界、schema major、release workflow 和 known allow 需要作者之外至少一名 owner 批准。单维护者阶段必须保存自评 checklist 和完整 CI 证据，不能把缺少第二人复核表述成已独立审计。

### 6.4 多 Agent 任务协调

- 根 [`AGENTS.md`](../AGENTS.md) 是所有 Agent 的强制入口；详细状态机和事件格式由 [`06-multi-agent-collaboration.md`](06-multi-agent-collaboration.md) 定义。
- implementation Issue 必须声明 objective、non-goals、依赖、`write_scope`、`forbidden_scope`、`shared_interfaces`、验收、验证、安全/回退和文档影响。
- 只有 `status:ready` Issue 可以请求认领；协调者发布有效 `CLAIM_CONFIRMED` 前，Agent 保持只读。
- Issue 评论、assignee、label 和 Project 字段只记录协调事实，不提供锁、原子更新或平台级排他保证。
- 一个 Issue 同时只记录一个活跃实现 Agent；范围不重叠的 Issue 可在独立 worktree 并行。
- 路径、生成物或共享接口重叠时，由协调者排序、缩小范围、设定 integration owner 或拆分 Issue；不创建 claim lockfile。
- `expected_update_at` 只用于识别陈旧状态，到期不会自动转移任务。范围变化和 handoff 需要新的确认事件。
- PR 是验收面，必须关联 Issue、`claim_id`、范围和验证证据；关键变更按 6.3 进行独立评审。
- GitHub Project 可以作为看板，但不能成为第二套任务定义或覆盖 Issue 记录。
- G0 前仅允许维护者明确授权的 bootstrap 工作；G1 通过后 bootstrap 例外关闭。

## 7. CI 与不可信 PR 边界

### 7.1 PR CI

- fork PR 视为不可信输入，不向其暴露 npm token、GitHub release token 或其他 secrets。
- PR lane 只使用合成 fixture 和公开的固定工件。
- 会执行第三方代码、真实 dsh smoke 或需要凭据的 lane 必须在受控环境中显式触发。
- workflow 不使用来自 PR 的字符串拼接 shell 命令；参数按数组或严格枚举传递。

### 7.2 Main、Nightly 与 Release

| 触发 | 范围 | 权限 |
| --- | --- | --- |
| PR | L0-L3、package pack、边界检查 | 无发布 secrets |
| 合并到 `main` | 重跑 PR 门槛、构建候选工件 | 只写 CI artifact |
| Nightly | 受控 L4-L5、漂移检测 | 最小读取权限 |
| Release candidate | L0-L7、矩阵、PM2 隔离、clean-room | 受保护环境 |
| Release | 对已验证摘要对应的工件发布 | npm provenance、GitHub Release |

发布 job 只能消费同一 commit 已通过验证且按 digest 固定的工件，不得在发布阶段重新构建一套无法与 CI 工件对应的 tarball。

## 8. Fixture、第三方工件与生成物

### 8.1 可提交内容

允许提交：

- 最小合成 package/profile/lockfile；
- 脱敏后的稳定 golden JSON；
- 兼容矩阵规则和工件身份清单；
- 为 parser、安全解压和错误分类专门构造的小型恶意 fixture；
- 经人工脱敏、压缩且用于公开商店展示的少量截图；
- 每个 fixture 的 README、预期 finding 与许可说明。

### 8.2 默认禁止提交

- `node_modules/`、`dist/`、coverage、临时 cache；
- 真实 `DSH_HOME`、profile、PM2 home 或 PM2 日志；
- `.env`、token、credentials、session、storage 和用户工作区内容；
- 未脱敏崩溃日志、core dump、浏览器 profile；
- 从 npm/GitHub 下载的第三方完整源码或 tarball；
- 本机绝对路径、临时 smoke 根和动态端口记录；
- release evidence 全量目录。

### 8.3 固定真实工件

真实第三方插件只在 `fixtures/sources.lock.json` 中登记：

- package/repository identity；
- 精确版本或 commit；
- registry tarball integrity/commit SHA；
- 许可证和来源 URL；
- 用于哪个 K 用例；
- 首次核验日期与最后复核日期。

CI 从允许来源获取并先验证摘要。缓存只是加速层，不是信任来源。确需把第三方二进制提交 Git 时，必须有许可证依据、安全评审和 ADR；MVP 默认不允许 Git LFS，也不提交大于 1 MiB 的新增二进制。

### 8.4 生成证据

- 小型、确定性的 golden 报告可提交 Git。
- 完整日志、自动化原始截图、SBOM、SARIF、coverage 和性能数据保存为有保留期的 CI artifact。
- 只有明确用于 README/商店展示、已通过隐私检查的截图可以进入 `packages/dsh-plugin/assets/`。
- release checksum、provenance、SBOM 和验收摘要附加到不可变 GitHub Release。
- 测试完成后工作树必须 clean；生成器未声明的文件变化视为失败。

## 9. `.gitignore` 与路径防护基线

G0 至少覆盖以下类别：

```gitignore
node_modules/
dist/
coverage/
.cache/
.tmp/
tmp/
evidence/
*.log
*.pid
.env
.env.*
!.env.example
*.tgz
playwright-report/
test-results/
```

此外，测试和脚本必须拒绝把以下路径解析为产品仓库子目录：

- 用户真实 DSH home/profile；
- `~/.pm2` 或其他真实 PM2 home；
- credentials/session/storage 目录；
- 产品仓库外部的 symlink 目标。

CI 应运行 secret scanner，并扫描 tracked files 中的本机用户名、绝对路径、token 模式和私钥头。`.gitignore` 只是最后一道防误提交措施，不替代运行时路径隔离。

## 10. 插件可安装性与仓库元数据

插件 package 必须满足：

- `dsh.bundle.patch` 明确指向同目录 `cordis.patch.yml`；
- 只有存在浏览器 UI 时声明 `dsh.client`；
- 实际 import 的官方 `@deepseek-ai/*` package 放在 `peerDependencies`，不复制进 `dependencies`；
- prerelease DSH 范围使用显式 prerelease comparator，并由 semver 测试证明覆盖目标版本；
- `repository.url` 指向产品仓库，`repository.directory` 指向 `packages/dsh-plugin`；
- `files` 白名单包含运行所需 dist、patch、schema 和静态资源，不包含源码外敏感文件；
- `npm pack` 后从 tarball 执行 clean-room `dsh plugin add` 验证；
- GitHub 仓库设置 `dsh-plugin` topic。

示意 manifest；版本范围必须在实现时替换为真实测试结果：

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

占位符 manifest 不得进入 release；CI 必须拒绝 `<owner>`、`<tested-...>` 等未替换占位符。

## 11. Release 流程

### 11.1 Release candidate

1. Changesets 生成 lockstep version PR。
2. 确认三个 package、内部依赖、CHANGELOG 和文档版本一致。
3. 在 release commit 上执行完整 L0-L7 与生产前人工验收。
4. 生成三个 npm tarball、checksum、SBOM 和 provenance。
5. 检查 tarball 无 `workspace:`、本机路径、测试 secrets 或未声明文件。
6. 从 tarball clean-room 安装 CLI 和插件，运行关键 K 矩阵。
7. 记录 release commit SHA 和所有工件 digest。

### 11.2 发布

1. 创建不可移动的 annotated `vX.Y.Z` tag；启用签名时必须验证签名。
2. 发布 CI 已验证的原始 tarball，不重新构建。
3. 使用 npm provenance 发布三个 package。
4. 创建 GitHub Release，附 checksum、SBOM、已验证矩阵、已知限制和回退方法。
5. 从 registry 重新下载并比对 digest、repository 和 package metadata。
6. 在无本地 workspace 的环境执行最终安装检查。

### 11.3 失败和撤回

- npm 已发布版本不覆盖；发布修复版本。
- 严重误判时可 deprecate 受影响版本，并发布说明和规则 patch。
- GitHub Release 不删除原证据；增加醒目标记和后继版本链接。
- tag/工件摘要不一致时立即停止发布，不能只修 tag 或网页说明。

## 12. `awesome-dsh-plugin` 收录流程

### 12.1 外部边界

`awesome-dsh-plugin` 是外部策展仓库，不是 npm registry，也不托管本项目源码。产品先在自己的 GitHub/npm 发布，再通过独立 fork 提交收录元数据。

外部规则可能变化。R2 开始前必须重新读取：

- <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
- <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

本文记录的是 2026-09-04 核对结果；若上游规则与本文冲突，先更新本文并评审，不得直接照旧模板投稿。

### 12.2 投稿前置条件

R2 前必须满足：

- R1 已完成，公开仓库中有真实可工作的代码；
- 仓库已存在至少 1 天并处于维护状态；
- 插件从公开 URL 可通过 `dsh plugin add` 安装；
- 插件 package 声明有效 `dsh.bundle`，而不是只有 `dsh.client`；
- GitHub 仓库有 `dsh-plugin` topic；
- 条目描述中的每个功能、数量和 API 名称都有代码/测试证据；
- 已完成与现有 doctor、clinic、stability-audit、depguard、forge 等条目的差异说明；
- 源码不存在明显混淆、凭据外传或意外 install-time 行为；
- 收录不能被表述成安全背书。

### 12.3 分类与差异化

首选分类为 `dev`（Development & Runtime），不使用：

- `security`：除非未来交付独立、可验证的恶意行为或权限审计能力；
- `market`：本插件不负责插件发现、商城或安装管理；
- `tools`：兼容诊断属于 DSH 开发和运行时治理，而非通用 agent tool。

对外差异化只声明已经实现并验证的能力：

1. 宿主无法启动时仍可工作的外部 CLI；
2. 当前版本到精确候选版本的 API/engine/peer 差异检查；
3. 独立 DSH_HOME、端口和进程树中的隔离启动报告；
4. fail-closed 的证据等级与 `unknown` 状态；
5. 插件只读展示 CLI 证据，不自动升级或修复。

### 12.4 投稿文件

本项目是 monorepo，因此条目 URL 指向插件子目录。建议文件名：

```text
data/plugins/<owner>__dsh-compat-suite--packages-dsh-plugin.yml
```

建议内容；提交时必须替换 owner，并按实现核对描述：

```yaml
url: https://github.com/<owner>/dsh-compat-suite/tree/main/packages/dsh-plugin
name: <owner>/dsh-compat-suite#dsh-compat
category: dev
description:
  en: Read-only compatibility dashboard for installed DSH plugins, with exact-version preflight and isolated startup reports from the companion CLI.
  zh: 已安装 DSH 插件的只读兼容性面板，支持精确候选版本预检，并展示配套 CLI 生成的隔离启动报告。
```

描述不能把 startup validated 写成全部功能兼容，也不能使用“最安全”“唯一”“完全防止崩溃”等不可证实措辞。

### 12.5 截图与 npm 关联

- 可在 `packages/dsh-plugin/screenshots.json` 声明 1-8 张仓库内截图；路径不得以 `/` 开头或包含 `..`。
- 没有截图不阻断收录，但发布前至少保存一张真实兼容报告页面作为产品验收证据。
- npm package 的 `repository` 必须指回被收录仓库；awesome 条目不手写 `npm:` 字段。
- 若不发布 npm 而提供 GitHub Release tarball，URL 必须是 GitHub 托管的 HTTPS `.tgz`，并避免会随版本失效的 `latest` 文件名组合。

### 12.6 独立 fork 工作流

1. 在产品根之外 fork/clone `awesome-dsh-plugin`。
2. 配置 `upstream` 指向官方仓库，投稿分支从最新 `upstream/main` 创建。
3. 只新增本项目的一个 YAML；不修改其他条目。
4. 不手工修改 README。需要预览时运行上游文档规定的生成器，检查结果后不把无关生成差异放入 PR。
5. 本地运行上游 lint/site build；任何依赖安装只发生在外部 checkout。
6. PR 最多包含本项目一个条目，并链接公开 release、安装验证和功能证据。
7. 上游 CI 绿色后，R2 内部工程工作可完成；维护者合并状态单独记录为 `external_pending`、`listed` 或 `changes_requested`。

产品 release workflow 不得自动向外部仓库推送或创建 PR。创建外部 PR 是明确的维护者操作，所用 token 不进入产品测试 workflow。

## 13. R2 不阻塞 R1 的规则

- R1 的定义是产品工件已发布、可验证、可回退。
- R2 的定义是收录投稿符合上游规则、PR 已创建且自动检查通过。
- 上游维护者尚未合并不能否定 R1，也不能导致重新发布 npm 版本。
- 若上游指出产品真实缺陷，回到对应工程节点修复并发布新版本；不能只修改条目描述掩盖缺陷。
- 若仅要求调整分类或措辞，在外部 PR 中修正，并保存评审链接。

## 14. ADR 要求

以下变更必须新增 `docs/adr/NNNN-<slug>.md`：

- 拆分或合并 Git 仓库；
- 从 lockstep 改为独立 package 版本；
- 引入 submodule、Git LFS 或 vendored 第三方工件；
- 独立发布兼容规则 feed；
- 修改长期分支或 merge 策略；
- 把 GitHub Issue 从协调记录改为技术锁，或引入中央 claim/lease 服务；
- 改变多 Agent 写入授权、范围冲突、handoff 或审查权威模型；
- 改变 tag、provenance 或 release 工件生成方式；
- 允许自动向外部仓库提交 PR。

ADR 至少包含上下文、决策、替代方案、迁移步骤、安全影响、回退和验收证据。

## 15. 完成定义

仓库治理只有在以下条件全部满足时才算落地：

- `dsh-compat-suite/` 是唯一产品 Git 根，产品树中无嵌套 `.git`；
- 根 workspace、唯一 lockfile 和三个 package 可在干净 checkout 安装；
- 依赖方向和浏览器/Node 边界由自动化测试强制；
- required checks、CODEOWNERS 和 release 环境已配置；branch protection 在当前能力允许时启用，否则人工 merge gate 已记录并演练；
- `AGENTS.md`、Issue/PR 模板、ADR-0001 和协作协议已通过 G1，且明确 Issue 不作锁；
- 认领、冲突、scope revision、陈旧状态和 handoff 已在独立 worktree 中演练并保存证据；
- fixture 来源清单、许可证和摘要完整；
- secret/path 扫描证明仓库不含真实 DSH/PM2/credential 数据；
- lockstep 版本、schemaVersion 和 tag 规则被 release test 验证；
- 三个 tarball 可从同一 release commit 重现并与发布摘要一致；
- canonical remote、npm scope 发布权限和许可证已经明确验证；
- 外部 awesome-list fork 与产品仓库完全隔离；
- G0、G1 和 R2 的证据包满足里程碑文档要求。
