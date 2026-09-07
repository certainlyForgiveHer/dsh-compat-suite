# 单 Agent 进入 M0 / Single-agent entry to M0

日期 / Date: 2026-09-07

状态：维护者已明确批准；本次阶段入口切换完成后，M0 可开始。
Status: explicitly approved by the maintainer; M0 may start once this entry change is recorded.

## 决策 / Decision

因预算有限，跳过当前 G1 多 Agent 演练，采用单 Agent 模式推进 M0 契约与安全基线。G1 记录为延期、未验证，不标记为演练通过；M0 的交付物和退出门槛不变。

Defer the current G1 multi-agent rehearsal for budget reasons and permit M0 contract and safety work in single-agent mode. G1 remains deferred and unverified. M0 deliverables and exit criteria are unchanged.

## 执行边界 / Operating rules

- 每次只允许一个实现 Agent，不主动启动并行 Agent、演练或委派；维护者后续明确要求时再重新评估。
- 保留 Issue 范围及认领记录、独立分支/worktree、PR 和 CI。关键安全与发布评审要求不变；自评必须如实标注。
- 本例外只解除单 Agent 工作对 G1 演练的阶段依赖，不扩大真实运行环境或发布权限，也不恢复 bootstrap 写入例外。

- Use one implementation agent at a time; do not initiate parallel agents, rehearsals or delegation without a later explicit maintainer request.
- Keep scoped Issues and claim records, isolated branches/worktrees, PRs and CI. Existing critical safety and release review requirements remain; label self-review accurately.
- This exception only removes the G1 rehearsal prerequisite for single-agent work. It does not grant runtime/release permissions or restore bootstrap write exceptions.

## 已有工作 / Existing work

演练任务 [#5](https://github.com/certainlyForgiveHer/dsh-compat-suite/issues/5) 和 [#6](https://github.com/certainlyForgiveHer/dsh-compat-suite/issues/6) 未开始实现，按取消关闭。G1 父任务 [#2](https://github.com/certainlyForgiveHer/dsh-compat-suite/issues/2) 保留为延期记录。已有静态验证 [PR #4](https://github.com/certainlyForgiveHer/dsh-compat-suite/pull/4) 保留待审，不是 M0 入口前提，也不因本决策自动合并。决策实施由 [#7](https://github.com/certainlyForgiveHer/dsh-compat-suite/issues/7) 记录。

Unstarted rehearsal Issues #5 and #6 are cancelled. G1 parent #2 remains deferred. Existing static validation PR #4 stays pending review; it neither blocks M0 entry nor merges automatically under this decision. Issue #7 records this change.

## 恢复条件 / Revisit trigger

准备同时运行多个实现 Agent 时，先重新打开演练任务并完成 G1 规定的验证；届时再记录 G1 验收通过。

Before concurrent implementation agents are enabled, reopen the rehearsal work and satisfy the full G1 verification requirements. Record G1 acceptance only then.
