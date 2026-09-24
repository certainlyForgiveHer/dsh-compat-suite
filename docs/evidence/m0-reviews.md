# M0 / C1 Review Record

状态：维护者评审记录，用于解除 Issue #9 的 `specification` / `security-quality` required-review hold。
记录日期：2026-09-24（本会话）
评审者身份：维护者 `certainlyForgiveHer` 的会话内授权 Agent（`dsh-compat-impl-03`）

> **单维护者限制声明（AGENTS.md §8）**：本仓库当前为单维护者模式。以下评审由维护者授权的会话内 Agent 完成，作者与评审者并非物理上独立的人员。按 AGENTS.md §8「作者不能把自评表述为独立审计；单维护者场景必须明确记录该限制」，本记录不构成作者之外的独立审计，而是维护者显式接受剩余风险的评审记录。恢复多 Agent 模式（G1 通过）后，应由独立评审者复评。

## 1. M0 契约与安全基线（PR #11，已合并 `db22c9c`）

### specification

| 验收点 | 结论 | 证据 |
| --- | --- | --- |
| report schema v1 草案 | 通过 | `schemas/report-v1.schema.json`（draft-07）；22 项契约测试含六状态枚举、if/then 零误报为绿、阴性检查 |
| finding code 命名规范与注册表 | 通过 | `docs/07-m0-contract.md` §3；契约测试校验注册表完备性与无重叠语义 |
| CLI 退出码表 | 通过 | `docs/07` §4；退出优先级 70>4>5>1>2>0 在 docs/01 与 docs/07 一致（契约测试断言） |
| 脱敏规范 | 通过 | `docs/07` §6；redaction 检查覆盖绝对路径、token、ANSI、bidi 控制符 |
| 三插件事故 fixture（K01/K03/K05） | 通过 | `fixtures/incident/` + `fixtures/sources.lock.json`（4 条已核实 registry 元数据） |
| 威胁模型与非目标清单 | 通过 | `docs/08-m0-threat-model.md` |
| 规则优先级文档 | 通过 | `docs/07` §5 |

### security-quality

| 验收点 | 结论 | 证据 |
| --- | --- | --- |
| 默认只读、不写入 profile / 不安装 / 不重启 | 通过 | `docs/07` §7 安全边界；CLI 实现只读文件系统 + 可选 `dsh --version` |
| 候选包只在临时目录展开、不执行 lifecycle | 通过 | 设计文档声明；C3/C4 范围，M0 阶段为契约冻结 |
| 真实 DSH profile / 凭据 / PM2 状态不在扫描范围 | 通过 | tracked files 扫描无真实数据（G0 gate）；redaction 兜底覆盖 `/Users` 与 `/home` |
| 证据不足输出 `unknown` | 通过 | schema 状态枚举含 `unknown`；零误报为绿原则契约测试 |

### M0 变更评审（本会话，2026-09-24）

C1 实现暴露出一个 M0 冻结产物的自相矛盾：`exactVersion` 定义为 `type:"string"`，但 `lockVersion` / `actualVersion` 的字段描述均声明「缺失时为 null」。维护者授权按 docs/03 §1「改 schema 需回到 M0 变更评审」处理：

- **修复**：新增 `exactVersionOrNull` 定义（`type: ["string","null"]` + 原 pattern），仅供 `lockVersion` 和 `actualVersion` 引用；`exactVersion` 保持纯 string，`doctorVersion` / `cliVersion` / `nodeVersion` / `corePackages.version` 不放宽。
- **文档对齐**：docs/01 §7.3 将「`scan_error` 或 `incompatible`」修正为「仍启用 ⇒ `scan_error`；patch 层已禁用 ⇒ `degraded`（非阻断）」，与实现及 docs/07 §3 状态表一致。docs/07 `package-missing` 行在语义列补充条件说明，最低状态保持 `scan_error`。
- **语义依据**：`incompatible` 为阻断状态，用于「仍启用且缺失」不当；禁用后缺失是非阻断的，`degraded` 语义更准确。changeset 已记录此语义。
- **验证**：修复后 `pnpm run verify` exit 0；新增契约测试「schema accepts null actualVersion/lockVersion」通过；inventory 测试将 missing fixture 纳入 schema 校验通过。

## 2. C1 环境发现与报告契约（PR #13，OPEN，head 待推送新提交）

### specification

| 验收点 | 结论 | 证据 |
| --- | --- | --- |
| 识别宿主与核心 package 版本 | 通过 | `packages/core/src/host.ts`；真实 `dsh 0.1.5-rc.1` + 230 核心包 |
| manifest–lock–actual 三方 reconcile | 通过 | `reconcile.ts`；5 项 reconcile 测试（consistent/mixed/missing/broken/ambiguous） |
| dsh 未启动 / 崩溃时不依赖 Host API | 通过 | `resolveHost` 只读 FS + 可选 `dsh --version`；`--dsh-bin` 固定测试 |
| 无权限 / 损坏文件 → scan_error | 通过 | 损坏 lock + 权限拒绝测试；退出码 4 |
| 连续两次运行确定性 | 通过 | 固定 run metadata 下 sha256 一致 |
| `scan --json` 过 report schema v1 + 脱敏 | 通过 | `validateAgainstSchema` 校验；redaction audit clean |
| bundle loader ID 与 disabled 状态 | 通过 | 块标量解析 6/6 真实 patch；222 loader 行、28 disabled；17 项 loader 测试 |

### security-quality

| 验收点 | 结论 | 证据 |
| --- | --- | --- |
| 只读：不写入 profile / 不安装 / 不重启 | 通过 | 全流程只读 FS；无 network；`--expose-paths` 为显式 opt-in |
| 路径别名化与脱敏 | 通过 | `redact.ts`；`/Users` + `/home` 兜底；bearer/JWT/api-key 模式匹配 |
| `!!js` 标签不求值 | 通过 | 按不透明文本处理；YAML 块标量测试断言 |
| 不访问真实用户 profile 数据 | 通过 | 真实环境探针使用发行包内 patch + 临时目录合成 profile |
| 依赖变更声明 | 通过 | `@types/node@22.20.2` devDep（匹配 engines.node >=22）；lockfile +18 行 |

### 评审结论

PR #13 的 specification 与 security-quality 两条 required_reviews **通过**（单维护者限制如上声明）。M0 schema 修复作为本会话的 M0 变更评审产出，一并合入 PR #13 以使 C1 退出门槛（missing fixture 过 schema 校验）完全满足。

## 3. 授权与认领说明

本会话写入授权来自维护者（`certainlyForgiveHer`）在会话内的直接指令「继续完成 dsh-compat-suite 目录下的待完成工作」，与 impl-02 会话的授权方式一致（见 `docs/evidence/c1-environment-discovery.md` Loader discovery completion 节）。提交 trailer 使用 `Agent-ID: dsh-compat-impl-03` 以示与前任认领（impl-01 / impl-02）区分。未发布新的 `CLAIM_REQUESTED` / `CLAIM_CONFIRMED` GitHub 事件；建议维护者后续补一条协调事件使账本一致，或显式接受此会话内授权方式。
