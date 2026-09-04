# Agent 协作入口

状态：设计基线 v1
适用范围：本文件所在目录及全部子目录

任何人类或自动化 Agent 在读取、规划、修改、验证或评审本仓库前，都必须先阅读本文件。本文只定义协作入口；完整协议见
[`docs/06-multi-agent-collaboration.md`](docs/06-multi-agent-collaboration.md)。

## 1. 不可绕过的原则

- GitHub Issue 是协调记录，不是锁。assignee、label、Project 字段、评论、分支和本地文件都不提供原子互斥保证。
- “一个 Issue 一个活跃实现 Agent”是参与者必须遵守的流程约束，不是平台自动阻止写入的技术承诺。
- 正常模式下，未收到协调者发布的 `CLAIM_CONFIRMED` 事件，不得修改文件、创建实现提交或扩大任务范围。
- 开始写入前必须检查 Issue 状态、依赖、活跃认领、路径范围和共享接口；发现歧义或冲突时保持只读并上报。
- 每个实现任务使用独立短期分支和独立 worktree；不得让多个 Agent 共用同一工作目录。
- Issue 可以进一步收窄任务，但不能降低产品安全边界、测试门槛或本文要求。
- 真实 DSH profile、进程管理器/服务监督器状态（例如 PM2 的 `~/.pm2`）、凭据、会话、插件存储和未脱敏日志不属于默认写入或 fixture 范围。

## 2. 阅读顺序与权威顺序

开始任务时按顺序阅读：

1. 本文件；
2. [`README.md`](README.md)；
3. [`docs/06-multi-agent-collaboration.md`](docs/06-multi-agent-collaboration.md)；
4. 与任务相关的设计文档、ADR 和安全说明；
5. GitHub Issue 正文、依赖和全部协调事件；
6. 关联 PR、分支和验证结果。

仓库内信息冲突时按以下顺序处理：

1. 已确认的维护者指令；
2. `AGENTS.md` 和已接受 ADR；
3. 权威设计与安全文档；
4. Issue 的目标、非目标和验收条件；
5. 最新有效的协调者确认事件；
6. label、assignee 和 Project 字段等派生视图。

高层规则与低层记录不一致时采用更严格边界，并请求协调者修正记录；不得自行选择更宽松解释。

## 3. 新 Agent 的第一组动作

1. 只读确认当前目录、Git 根、分支、HEAD、工作树状态和 remote。
2. 判断仓库处于“G0 前 bootstrap”还是“G1 后正常协作”状态。
3. 读取任务 Issue，确认其处于 `status:ready`，并检查 `blocked_by` 依赖已解除。
4. 将 Issue 的 `write_scope` 与所有活跃任务比较，同时检查 `shared_interfaces`。
5. 发布符合协议的 `CLAIM_REQUESTED` 新评论；不要编辑旧事件。
6. 等待协调者发布带唯一 `claim_id` 的 `CLAIM_CONFIRMED`。
7. 再次检查 HEAD、冲突和工作树，然后创建独立分支/worktree 并发布 `WORK_STARTED`。
8. 先建立失败测试或可复核基线，再实现、验证、评审和交接。

第 6 步未完成时只能继续只读分析、提出拆分建议或补充问题，不能写入。

## 4. Bootstrap 例外

当前目录尚未完成 G0、没有 canonical GitHub Issue tracker 时，正常认领流程无法运行。此阶段只允许：

- 维护者在当前会话中明确指定目标和范围的 bootstrap 工作；
- 建立 Git 仓库、remote、Issue 模板、协作文档和 G0/G1 所需基础设施；
- 在结果中准确列出修改路径、验证和未完成事项。

不得从“仓库还没有 Issue”推导出一般写入权限。G0 完成后，应为尚未完成的 bootstrap 工作建立 Issue 并记录当前状态；G1 完成后，本例外自动失效。

## 5. Issue、范围与并发

- 一个实现 Issue 只记录一个活跃 `agent_id`；协调者、评审者和观察者不算实现 owner。
- `write_scope` 使用仓库相对路径或目录前缀，必须足够精确，不能只写“相关文件”。
- `forbidden_scope` 明确列出不得修改的路径、运行环境和外部系统。
- `shared_interfaces` 至少覆盖 schema、公共 exports、规则格式、根依赖、lockfile、CI/release workflow 和跨包契约。
- 路径不重叠但共享接口重叠时，也必须由协调者决定顺序、集成 owner 或共同父 Issue。
- 需要扩大范围时先发布 `SCOPE_CHANGE_REQUESTED`；收到 `SCOPE_CHANGE_CONFIRMED` 前不得写入新增范围。
- 若发现两个 Agent 已经写入重叠范围，双方立即停止相关写入并保存现状，由协调者决定保留、拆分、rebase 或交接方案。

任何范围确认都只是记录和授权，不锁定文件，也不保证其他参与者不会误操作。

## 6. 分支与 worktree

分支名必须包含 Issue 编号：

```text
feat/<issue>-<slug>
fix/<issue>-<slug>
docs/<issue>-<slug>
rules/<issue>-<slug>
release/<issue>-<version>
```

推荐 worktree 位于产品根之外：

```text
<workspace>/dsh-compat-suite-wt-<issue>-<agent-id>/
```

创建 worktree 前记录 `base_sha`。不得在其他 Agent 的 worktree 中写入，不得把外部 `awesome-dsh-plugin` checkout 放进产品树。

## 7. 进度、失效与交接

- `expected_update_at` 是活动记录的复核时间，不是自动解锁时间。
- 到期不代表其他 Agent 自动获得写权限；协调者必须检查 Issue、分支、PR 和工作树证据后发布 `CLAIM_EXPIRED` 或安排交接。
- 状态、阻塞、范围和验证发生实质变化时发布新事件，不通过编辑旧评论重写历史。
- 交接必须记录 `claim_id`、分支、HEAD、clean/dirty、修改路径、已完成项、待办项、验证、风险和建议下一步。
- 接手者必须获得新的 `CLAIM_CONFIRMED`，不能沿用前任 Agent 身份。

## 8. PR 与评审

- PR 使用 [`.github/pull_request_template.md`](.github/pull_request_template.md)，关联实现 Issue 和 `claim_id`。
- PR 只能包含已确认范围；无关变化必须拆出或撤回。
- schema、兼容规则、安全边界、进程控制和 release workflow 需要作者之外的相应 owner 评审。
- 作者不能把自评表述为独立审计；单维护者场景必须明确记录该限制。
- CI 绿色只是必要条件，不替代验收条件、人工边界复核或产品语义审查。
- 每个 commit message 必须包含机器可读的 `Agent-ID: <agent_id>` trailer；其值必须与当前有效认领或协调事件中的 `agent_id` 一致。G0 bootstrap 没有 Issue 时，使用维护者在 bootstrap 任务中明确指定的 `agent_id`。
- 合并后由协调者核对 PR、验证证据和剩余工作，再记录 `WORK_COMPLETED` 并关闭 Issue。

## 9. 必须停止并上报的情况

- 没有有效 `CLAIM_CONFIRMED`；
- Issue 不是 `status:ready`，或存在未解除依赖；
- 当前 HEAD 与 `base_sha` 偏移且可能改变任务假设；
- 与其他活跃任务路径或共享接口重叠；
- 工作树已有来源不明的修改；
- 需要访问真实 DSH 或进程管理器/服务监督器数据、凭据或未授权外部系统；
- 需要删除、覆盖、强制推送或改写他人历史；
- 验证无法达到 Issue 的退出门槛；
- GitHub 协调记录不可用，且不属于 G0 前明确授权的 bootstrap 工作。

停止不等于放弃任务。保留证据、说明精确阻塞点，并等待协调者决定。
