# dsh Compatibility Suite

状态：设计基线 v0.3
日期：2026-09-04
目标宿主基线：DeepSeek Harness `0.1.1-rc.2`

本目录定义一套用于发现、解释和预防 dsh 插件兼容性故障的方案。方案由两个面向用户的任务组成：

1. `dsh-compat-doctor` CLI：运行在 dsh 进程之外，负责升级前检查、当前环境体检、候选版本分析和隔离启动验证，是兼容性判断的权威安全闸门。
2. dsh Compatibility 插件：运行在健康的 dsh Web 宿主内，负责展示扫描结果、解释风险和导出报告，是可视化入口，不承担启动前拦截职责。

两者复用同一套扫描内核和版本化报告契约。即使 dsh 因其他插件无法启动，CLI 仍必须能够工作。

## 文档索引

- [CLI 详细设计](docs/01-cli-design.md)
- [dsh 插件详细设计](docs/02-plugin-design.md)
- [节点、依赖与里程碑](docs/03-milestones.md)
- [验证与发布验收方案](docs/04-validation-plan.md)
- [Git 仓库、版本与生态发布治理](docs/05-repository-governance.md)
- [多 Agent 任务认领与协作协议](docs/06-multi-agent-collaboration.md)

以上六份文档共同构成本项目的权威设计基线。根目录
[`AGENTS.md`](AGENTS.md) 是 Agent 的强制入口；
[`ADR-0001`](docs/adr/0001-issue-ledger-not-lock.md) 记录“Issue 只作协调账本、不作锁”的已接受决策。实现期间若修改关键边界、状态语义、退出码、仓库边界、版本策略、协作协议或验收条件，必须先更新对应文档并记录原因。

## 核心决策

- 兼容性安全闸门必须位于 dsh 进程之外，避免“检查插件也随宿主一起崩溃”的启动悖论。
- 默认只读；MVP 不自动安装、升级、降级、删除插件，也不自动重启 PM2。
- 不把“没有发现问题”误报为“确认兼容”。证据不足时必须输出 `unknown`。
- 静态元数据、API 表面检查和隔离启动验证分别保留证据，不用单一分数掩盖不确定性。
- 每一条结论都必须能追溯到宿主版本、插件版本、规则、文件或运行日志。
- 候选包只在临时目录中展开，不执行其 lifecycle scripts，不修改真实 profile。
- 插件数据、凭据、会话日志和用户工作区不属于扫描对象，除非未来由用户显式授权且设计另行评审。
- 产品代码采用一个 Git monorepo；`core`、CLI 和插件是独立发布包，不是独立 Git 仓库。
- `0.x` 阶段三个包使用 lockstep 版本，schema、规则与跨包测试在同一变更集中原子更新。
- `awesome-dsh-plugin` 只通过独立 fork/checkout 投稿，不作为子模块、subtree 或产品构建依赖。
- GitHub Issue 是任务范围、认领事件、进度和交接的协调账本，不是原子锁或技术互斥机制。
- 一个 Issue 同时只记录一个活跃实现 Agent；未经协调者确认不得写入，但该约束由参与者遵守，不声称平台会自动阻止违规写入。

## 本次故障形成的基准用例

设计必须至少覆盖下列真实组合：

| dsh | 插件 | 预期结果 | 关键证据 |
| --- | --- | --- | --- |
| `0.1.1-rc.2` | AgentTeams `0.1.15` | `incompatible` | 调用宿主不存在的 `registerContinuableSetup` |
| `0.1.1-rc.2` | AgentTeams `0.1.2` | 启动兼容 | 不调用上述缺失 API，隔离启动通过 |
| `0.1.1-rc.2` | task-board `0.3.10` | `incompatible` | 声明要求 `dsh >=0.1.2-alpha.1`，运行时反复请求不可用的 `session/list` |
| `0.1.1-rc.2` | task-board `0.2.9` | 启动兼容 | 声明支持 `dsh >=0.1.1-rc.1`，peer 对齐 `0.1.1-rc.2` |
| `0.1.1-rc.2` | skill-explorer `0.3.10` | `incompatible` | 声明要求 `dsh >=0.1.2-alpha.1` |
| `0.1.1-rc.2` | skill-explorer `0.2.9` | 启动兼容 | 声明支持 `dsh >=0.1.1-rc.1` |

“启动兼容”仅表示插件能够加载、宿主能够达到 ready 状态且观察窗口内没有兼容性错误；它不等同于插件全部业务功能已经通过验证。

## 仓库结构决策

`<workspace>` 只是本地工作容器，不作为产品 Git 仓库。唯一产品 Git 根是 `dsh-compat-suite/`；其下禁止嵌套 `.git`。

```text
<workspace>/
├── dsh-compat-suite/              # 唯一产品 Git monorepo
│   ├── .git/
│   ├── AGENTS.md                # Agent 强制入口与写入前置条件
│   ├── .github/                 # Issue/PR 模板、CI、CODEOWNERS、release 治理
│   ├── .changeset/              # 版本变更意图
│   ├── package.json             # private workspace root
│   ├── pnpm-workspace.yaml
│   ├── pnpm-lock.yaml           # 唯一 lockfile
│   ├── LICENSE
│   ├── SECURITY.md
│   ├── CONTRIBUTING.md
│   ├── CHANGELOG.md
│   ├── packages/
│   │   ├── core/                 # 共享扫描、规则、报告与脱敏内核
│   │   ├── cli/                  # npm package: @dsh-compat/doctor
│   │   └── dsh-plugin/           # Host 服务与 Web 客户端
│   ├── schemas/                  # 版本化 JSON Schema
│   ├── rules/                    # 内置兼容矩阵与 API 规则
│   ├── fixtures/                 # 合成夹具与经审核的固定工件索引
│   ├── tests/                    # 单元、集成、smoke、E2E 与安全测试
│   └── docs/                     # 本设计基线
│
└── awesome-dsh-plugin-fork/     # 可选、独立 Git checkout，不进入产品树
```

当前目录只包含设计基线与治理模板草案，不包含实现代码；Git 已初始化，但尚未完成 `G0`。目标仓库只能在 `G0` 节点的退出门槛全部通过后视为建立完成；多 Agent 写入模式只能在 `G1` 节点通过后视为可用。详见 [Git 仓库、版本与生态发布治理](docs/05-repository-governance.md)和[多 Agent 任务认领与协作协议](docs/06-multi-agent-collaboration.md)。
