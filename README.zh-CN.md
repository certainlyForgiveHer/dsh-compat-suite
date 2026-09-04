# dsh 兼容性套件

[English](README.md) · [中文](README.zh-CN.md)

dsh 兼容性套件是一套用于发现、解释和预防 DeepSeek Harness（`dsh`）宿主与插件之间兼容性故障的设计与验证基线。

## 项目定义

项目计划提供两个面向用户的入口：

- **`dsh-compat-doctor` CLI** —— 运行在宿主进程之外的安全闸门，用于升级前检查、环境清单、候选版本分析和隔离启动验证。
- **dsh Compatibility 插件** —— 运行在健康 dsh 宿主内的只读界面，用于查看、解释和导出扫描结果。

两个入口复用同一套扫描内核和版本化报告契约。即使其他插件阻止 dsh 宿主启动，CLI 仍必须能够工作。

## 安全边界

- 默认只读。
- MVP 不自动安装、升级、降级、删除插件，也不自动重启 PM2。
- 候选包只在临时目录中展开，不执行 lifecycle scripts。
- 真实 DSH profile、凭据、会话、PM2 数据和未脱敏日志不属于仓库或扫描范围。
- 证据不足时输出 `unknown`；启动验证不代表插件全部业务功能均已通过。

## 项目状态

当前仓库包含公开设计基线和治理模板，尚未包含实现包或运行时夹具。Git 已初始化，但 `G0` bootstrap 和 `G1` 多 Agent 就绪门槛仍待完成。

## 文档

- [CLI 详细设计](docs/01-cli-design.md)
- [dsh 插件详细设计](docs/02-plugin-design.md)
- [节点、依赖与里程碑](docs/03-milestones.md)
- [验证与发布验收方案](docs/04-validation-plan.md)
- [Git、版本与生态发布治理](docs/05-repository-governance.md)
- [多 Agent 任务认领与协作协议](docs/06-multi-agent-collaboration.md)
- [ADR-0001：GitHub Issue 是协调账本，不是锁](docs/adr/0001-issue-ledger-not-lock.md)
- [Agent 协作入口](AGENTS.md)

详细文档是本项目的权威设计基线。若修改兼容性边界、状态语义、退出码、仓库边界、版本策略、协作规则或验收条件，必须同步更新对应文档并记录原因。
