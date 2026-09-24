# C1 Environment Discovery Evidence Record

状态：C1 交付物完成并通过本地全量验证；`specification` 与 `security-quality` 评审待 PR 提出、由维护者完成（单维护者场景：以下为作者自评 + 自动化证据，不构成独立审计）。

记录日期：2026-09-11

## Coordination record

- Implementation Issue：[#12](https://github.com/certainlyForgiveHer/dsh-compat-suite/issues/12)（milestone C1，单 Agent 模式）
- `claim_id`：`issue-12-20260911T102000Z-dsh-compat-impl-01`（CLAIM_CONFIRMED 2026-09-11T10:20:11Z）
- `agent_id`：`dsh-compat-impl-01`
- 分支：`feat/12-env-inventory-scan`（worktree `dsh-compat-suite-wt-12-dsh-compat-impl-01`，产品根之外）
- `base_sha`：`db22c9c0a7222bb18c5e3137fea8c39da2477598`
- 实现提交：失败基线 → `70f40a7`（inventory 实现 + `scan`）→ `6c36139`（CLI 对齐设计基线）

## Delivered surface

| 交付物 | 路径 |
| --- | --- |
| 宿主身份 resolver（binary/realpath/package root/核心包版本） | `packages/core/src/host.ts` |
| profile manifest、pnpm lock v9、node_modules 解析器 | `packages/core/src/parsers.ts` |
| manifest–lock–actual 三方 reconcile | `packages/core/src/reconcile.ts` |
| 受控 YAML 子集解析器（lock v9 / cordis patch，零依赖） | `packages/core/src/yaml.ts` |
| 路径别名化与脱敏 | `packages/core/src/redact.ts` |
| report v1 组装、聚合、退出码、wire-format 投影 | `packages/core/src/report.ts` |
| `scan` 入口（确定性 run metadata） | `packages/core/src/scan.ts` |
| `dsh-compat-doctor scan` CLI（`--json` / `--strict` / `--dsh-bin` / `--dsh-home` / `--expose-paths`） | `packages/cli/src/index.ts` |
| 单元 / reconcile / 脱敏 / 阴性测试与 fixture | `packages/core/test/inventory.test.mjs`、`test/helpers/`、`test/fixtures/profiles/` |

## Process: failing baseline first

按 AGENTS.md 第 3 节第 8 步，先提交失败基线（`f74421f`：`node --test test/inventory.test.mjs` 因实现与 `dist` 均不存在而 `ERR_MODULE_NOT_FOUND`），再实现工件使其转绿。最终 25 项测试全部通过。

## Local verification

基线（`base_sha`，写入前）：`verify:g0`、`verify:m0`、22 项契约测试全绿，工作树干净。

实现后（HEAD `6c36139`）：

| Check | Command | Result |
| --- | --- | --- |
| G0 gate（不回归） | `node scripts/verify-repository.mjs` | pass |
| M0 gate（不回归） | `node scripts/verify-m0.mjs` | pass |
| Contract tests | `node --test tests/contract/*.test.mjs` | pass；22/22 |
| Typecheck | `pnpm -r run typecheck` | pass；0 error |
| Package tests | `pnpm -r run test` | pass；core 26/26、cli 1/1、plugin 1/1 |
| Boundary | `git status --short` | 空（clean） |

### CI

PR #13 的 `PR quality` 工作流在 node 22.x / 24.x / 26.x 三个矩阵上全部通过（`pnpm install --frozen-lockfile` + `pnpm verify`）。

首轮 CI 曾失败，原因是端到端 CLI 测试未指定 `--dsh-bin`，依赖运行机器恰好装有 `dsh`：CI runner 无 `dsh`，宿主解析正确产生 `host-identity-unresolved` 与退出码 4，而测试把它当作失败。修复方式是把 `--dsh-bin` 固定为不存在的路径，并断言"宿主不可解析时仍输出完整 inventory、退出码 4"——这正是验收条件所要求的 dsh 缺失场景，且不再依赖环境。该轮失败同时暴露了脱敏兜底只覆盖 `/Users` 而不含 Linux 的 `/home`，已一并修复并加入回归断言。

### Acceptance criteria 逐项

| # | 验收条件 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 识别宿主与核心 package 版本 | 通过 | 本机 `dsh 0.1.5-rc.1`，`host.corePackages` 230 项 |
| 2 | 三方一致/两种 skew/包缺失/重复解析各有测试 | 通过 | 5 项 reconcile 测试，对应 `consistent`/`mixed`/`missing` fixture |
| 3 | dsh 未启动时 package 身份不缺失 | 通过 | 无 dsh 二进制场景仍解析 11 个插件（见下） |
| 4 | dsh 崩溃时 CLI 不依赖 Host API | 通过 | 全流程只读文件系统 + 可选 `dsh --version`；`resolveHost` 不使用 Host API |
| 5 | 无权限/损坏文件 → `scan_error`，不崩溃不输出绿色 | 通过 | 损坏 lock 与权限拒绝各 1 项测试；退出码 4 |
| 6 | 连续两次运行除 run metadata 外结果一致 | 通过 | 固定 run metadata 下两次输出字节相同（sha256 见下） |
| 7 | `scan --json` 过 report schema v1 且完成脱敏 | 通过 | 测试用仓库自带 `validateAgainstSchema` 校验；脱敏审计见下 |

## Real-environment exercise（read-only）

对真实 `dsh 0.1.5-rc.1` 与 `web` profile 执行 `scan`（只读，未写入 profile、未安装、未重启）：

```text
$ DSH_HOME=~/.dsh dsh-compat-doctor scan --profile web
dsh-compat-doctor scan — profile dsh-profile-web
status: degraded  blocking: 0  review: 1
```

结论：11 个插件完成三方 reconcile；仅 1 条真实 finding——宿主 CLI 为 `0.1.5-rc.1`，而 230 个核心包为 `0.1.5-rc.2`（真实环境版本偏移，**非**工具缺陷）。

脱敏后的 inventory 摘录（完整 11 个插件，此处示 4 个；`corePackages` 230 项省略）：

```json
{
  "schemaVersion": 1,
  "run": {
    "id": "00000000-0000-4000-8000-000000000000",
    "startedAt": "2026-01-01T00:00:00Z",
    "mode": "scan",
    "doctorVersion": "0.0.0"
  },
  "host": {
    "binaryInput": "dsh",
    "binaryRealpath": "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js",
    "cliVersion": "0.1.5-rc.1",
    "nodeVersion": "26.5.0",
    "corePackages": "[230 项，此处省略]"
  },
  "profile": {
    "name": "dsh-profile-web",
    "manifestDigest": "sha256:da10b8ab00ca4d2e5b653fd56d23bd1820fa77f9e737cef339f59d5472b46f14",
    "lockDigest": "sha256:156df8989ddfe65ec17c67cdaefe26eb4354e36b9c30d5a21c80f848df0da3b4"
  },
  "plugins": [
    { "name": "@cocofhu/skillhub", "manifestSpecifier": "^0.2.16", "lockVersion": "0.2.16", "actualVersion": "0.2.16", "status": "unknown" },
    { "name": "@dsh-external/workflow", "manifestSpecifier": "git+https://github.com/dsh-external/dsh_workflow.git", "lockVersion": "0.1.2", "actualVersion": "0.1.2", "status": "unknown" },
    { "name": "@gausszhou/dsh-opencode-session-id", "manifestSpecifier": "^0.1.0", "lockVersion": "0.1.0", "actualVersion": "0.1.0", "status": "unknown" },
    { "name": "@linxin666/dsh-client-ui-skill-explorer", "manifestSpecifier": "0.3.20", "lockVersion": "0.3.20", "actualVersion": "0.3.20", "status": "unknown" }
  ],
  "findings": [
    { "id": "host:host-version-skew", "code": "host-version-skew", "status": "degraded", "severity": "review", "blocking": false }
  ],
  "summary": { "status": "degraded", "blocking": 0, "review": 1 }
}
```

## Determinism

固定 run metadata（`DSH_COMPAT_FIXED_RUN=1`）下连续两次运行输出字节相同：

```text
$ diff run1.json run2.json   # 无差异
sha256: e609f9e1ed6251adcc8ccf23de08cd39959e62e91795e1dd12c955c49d67e300
```

## Negative checks（零误报为绿）

| 场景 | 结果 |
| --- | --- |
| 损坏的 `pnpm-lock.yaml` | `scan-infrastructure-error`，退出码 4，不崩溃、不给绿色 |
| 不可读文件（权限拒绝） | 同上；fixture 在运行时构造并自检拒绝确实生效，否则 skip（不伪造通过） |
| 包目录缺失 | `package-missing`；`actualVersion` 为 null，**不猜测版本** |
| 重复解析 | `ambiguous-resolution`；条目按 realpath 去重，符号链接与 store 同一副本不误判 |
| dsh 二进制不存在 | `host-identity-unresolved`（scan_error，退出码 4），`binaryInput`/`binaryRealpath` 为 `<unresolved>`；**11 个插件身份仍完整** |
| 宽泛 range（`^0.2.16` → lock `0.2.16`） | 不判 skew（range 不可反解为单版本） |
| git/tarball 引用依赖 | 不比版本；采用 entry body 中的真实版本，避免误报 |
| 仅发现、无缺陷 | 状态为 `unknown`，**不得**为 `validated_compatible`/`declared_compatible` |

## Redaction audit（对真实 profile 报告）

```text
clean  absolute /Users paths
clean  home dir name
clean  ANSI escapes
clean  bidi controls
clean  bearer/api-key shapes
clean  query token params
```

## Dependency change（按 Issue #12「依赖变更须在 Issue 声明」）

`@types/node@22.20.2` 作为 `packages/core` 与 `packages/cli` 的 devDependency（匹配 `engines.node >=22` 下限）。`pnpm-lock.yaml` 相应更新（+18 行）。无其他依赖变更；`schemas/report-v1.schema.json` 语义未改动。

## Known limitations and deferred items

- **冻结 schema 无法表达「包缺失」**：`lockVersion` / `actualVersion` 的 schema 描述声明可为 null，但强制类型为 `exactVersion`（`type: "string"`）。已用仓库自带校验器复现（`actualVersion: null` → `valid: false`），并按 AGENTS.md §2 上报为 #12 的 `BLOCKED` 事件，未自行放宽（该文件在 `forbidden_scope` 内）。当前实现用内部 `missing` 状态表达缺失，reconcile 检测与测试均已通过；**待维护者裁定修复方式后**再落最终报告字段。
- `loaderIds` 与 `enabled` 的 loader 取证已补齐（见下文「Loader discovery completion」）。仍未覆盖：行内 `config` 内容不解析；完整 patch 合成（`dsh.profile.bundles` 顺序、home 层 `$DSH_HOME/cordis.patch.yml`、`--patch` 覆盖）不在 C1 范围，只解析 profile 自身层与插件自身声明的 patch。
- `smokeCoverage.result` 恒为 `not-run`：C1 不执行隔离启动验证（属 C4）。
- 报告中的 `binaryRealpath` 可保留 `/opt/homebrew/...` 这类系统安装路径：它不是用户目录，`docs/07` §6 的别名表（dsh home / profile / tmp）未覆盖系统路径，且 `/Users/<user>` 形态已被兜底别名化。若维护者要求连系统路径也别名化，需扩充别名表。
- 插件状态恒为 `unknown`（有缺陷时为 `degraded`/`scan_error`）：C1 只做发现，不做兼容判定（C2 范围）。
- secret 模式匹配为尽力而为：覆盖 Bearer/Basic、常见 provider key 前缀、JWT 形态与敏感 query 参数；不声称穷尽所有凭据形态。

## Loader discovery completion（2026-09-24，agent `dsh-compat-impl-02`）

### 补齐的交付物

docs/03 §7 的 C1 交付物「bundle loader ID 与 disabled 状态解析」以及 docs/01 §7.2/§12.2 的对应契约此前未实现（`loaderIds` 恒为空数组，`enabled` 只由 manifest 声明推断）。本会话补齐：

| 交付物 | 路径 |
| --- | --- |
| 读取层支持块标量（`|`/`>` + chomping + 显式缩进）；`!!js` 标签保持不透明文本，绝不求值 | `packages/core/src/yaml.ts` |
| cordis patch 行解析：`insert:` 行与被 `id` 定位的行 | `packages/core/src/parsers.ts`（`parseCordisPatch`、`readCordisPatch`） |
| 插件自身 `dsh.bundle.patch` + profile 层按 `id` 覆盖（last write wins）的 loader 状态合成 | `packages/core/src/parsers.ts`（`loaderStateForPlugin`、`discoverLoaderState`） |
| 接入三方 reconcile：`loaderIds`/`enabled` 真实化；profile patch 不可读 ⇒ scan 错误 | `packages/core/src/reconcile.ts` |
| 合成 fixture：bundle patch、profile 覆盖、缺失但被禁用的 bundle、损坏 patch | `packages/core/test/fixtures/profiles/loaders/`、`loaders-broken/` |
| 17 项测试（YAML 块标量 6、patch 行 3、loader 语义与阴性检查 8） | `packages/core/test/loaders.test.mjs` |
| 设计基线补充块 7.2.1 | `docs/01-cli-design.md` |

### 先建立失败基线

基线提交 `cd14737`：新增测试当时因「块标量被读取层拒绝 + `parseCordisPatch` 不存在 + `loaderIds` 为空」而失败（AGENTS.md §3 第 8 步），实现后转绿。

### 真实发行物语料验证（read-only，非用户 profile 数据）

对 dsh 发行包内的 6 个 bundle patch（`dsh-base`、`dsh-web-app`、`dsh-sdk-app`、`dsh-sdk-minimal`、`dsh-headless`、`dsh-acp-app` 的 `cordis.patch.yml`）运行读取层：

| 结果 | 值 |
| --- | --- |
| 解析成功 | 6/6（实现前 0/6，全部 `unexpected indentation in mapping`） |
| 发现的 loader 行 | 222 |
| 其中 `disabled: true` | 28 |

`dsh-base` 单层 84 行、`dsh-web-app` 单层 94 行（含 24 行 disabled）。也就是说：实现前 C1 在任何真实 profile 上都拿不到 loader ID，而现在能拿到。

端到端（**默认生产布局**，非注入式 fixture；profile 与插件包在临时目录中合成，patch 文件为真实发行件，未读取任何真实用户 profile）：

| 步骤 | 结果 |
| --- | --- |
| 以 `dsh-base` 层中真实接线的包 `@deepseek-ai/dsh-tool-subagent` 建包并声明 `dsh.bundle.patch` | 发现 2 个 loader ID：`tool-subagent`、`tool-subagent-fork`，与真实行逐字一致 |
| profile 层对这两行写 `disabled: true` | `enabled = false` |
| profile 层不禁用（`disabled: false`） | `enabled = true`，`loaderIds` 仍为 2 |
| 包名与任何行都不匹配时 | `loaderIds = []`、回退到 manifest 判断——**不臆造** loader 行 |

### 本地验证

| Check | Command | Result |
| --- | --- | --- |
| 全链（不回归） | `pnpm run verify`（G0 + M0 + 契约 22 + build + typecheck + 全部包测试） | pass；exit 0 |
| 新增测试 | `node --test packages/core/test/loaders.test.mjs` | pass；17/17 |
| 既有包测试 | core / cli / plugin | pass；26 / 1 / 1 |
| CI（PR #13，head `dddc5f9`） | `quality / node-22.x`、`node-24.x`、`node-26.x` | 全部 pass（`pnpm install --frozen-lockfile` + `pnpm verify`）；无依赖与 lockfile 变更 |

### 语义变更（提请评审确认）

`package-missing` 的状态现在按 docs/01 §7.3 原文依赖 loader 启用状态：**仍启用却缺失 ⇒ `scan_error`；patch 层已禁用且缺失 ⇒ `degraded`**。此前两种情况均为 `scan_error`。同时 `enabled` 不再等同于「manifest 是否声明」。

### 仍未闭合（交维护者裁定）

1. 冻结 schema 的 `exactVersion` 不可为 null（见上文第一条限制），仍使「包缺失」场景的 `scan --json` 无法通过 schema 校验；修复需 M0 变更评审或 scope revision，本会话未越权修改 `schemas/report-v1.schema.json`。
2. loader 取证只覆盖 profile 自身层与插件自身 patch；完整合成顺序（`dsh.profile.bundles`、home 层、`--patch`）留待 C3/C4。
3. 本会话的写入授权来自维护者在会话内的直接指令；**未**发布新的 `CLAIM_REQUESTED`/`CLAIM_CONFIRMED` 事件，提交 trailer 使用新 `agent_id` `dsh-compat-impl-02` 以示与前任认领区分。
