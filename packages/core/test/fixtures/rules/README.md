# C2 静态兼容矩阵 fixtures（K01–K06）

docs/04-validation-plan.md §5 的关键兼容矩阵在 C2（静态判定层）的合成最小 fixture。
所有 fixture 使用合成布局（`manifest.json` / `pnpm.lock` / `store/`），不复制任何第三方完整包；
真实工件的 identity/integrity 登记在仓库根 `fixtures/sources.lock.json`。

宿主统一为 `0.1.1-rc.2`（测试内注入 HostIdentity），known matrix 使用内置
`packages/core/data/known-matrix-v1.json`。每个子目录的 README 说明唯一预期结论，
以及为何不应产生其他状态（docs/04 §6）。

- `host-corpus/`：K01 使用的合成宿主 API 语料（声明 `registerSetup`，不含 `registerContinuableSetup`）。
- `k01-agent-teams-0-1-15/`：deny（missing-host-api + known-matrix-deny）→ `incompatible`。
- `k02-agent-teams-0-1-2/`：known-matrix-allow → `declared_compatible`。
- `k03-task-board-0-3-10/`：engine `>=0.1.2-alpha.1` 不匹配 → `incompatible`。
- `k04-task-board-0-2-9/`：engine `>=0.1.1-rc.1` 匹配 → `declared_compatible`。
- `k05-skill-explorer-0-3-10/`：mandatory peer `@deepseek-ai/dsh >=0.2.0-rc.2` 不匹配 → `incompatible`。
- `k06-skill-explorer-0-2-9/`：engine `>=0.1.1-rc.2` 匹配 → `declared_compatible`。
