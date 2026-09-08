# M0 威胁模型与非目标清单

状态：M0 冻结基线。本文定义 dsh-compat-suite MVP 的资产、信任边界、威胁目录和不可协商的安全边界；与 [`07-m0-contract.md`](07-m0-contract.md)、[`01-cli-design.md`](01-cli-design.md) 第 2.2、15 节和 [`04-validation-plan.md`](04-validation-plan.md) 第 14 节共同构成安全评审输入。

## 1. 范围与资产

- 资产：真实 dsh profile（manifest、lockfile、loader patch）、进程管理器/服务监督器状态、宿主进程与端口、插件业务数据、用户凭据与会话、报告内容本身、CI/发布工件。
- 检查器读取的最小集合：profile manifest、lockfile、直接依赖插件的 package.json 与发布 JS、bundle patch 元数据、registry 元数据（只读）。
- MVP 产物形态：静态契约（schema、文档）与合成 fixture；不含运行时实现。

## 2. 信任边界

不可信输入（只能作为数据证据，不得驱动命令或控制流）：

- 插件 package.json、lockfile、分发 JS、bundle patch、README 与错误消息文本；
- registry metadata 响应与候选 tarball 内容；
- 既有报告文件（可能 stale、损坏或来自旧 major schema）；
- 浏览器侧请求参数（插件 Host API）。

可信实现：doctor/core 源码、冻结 schema 与规则注册表、本仓库 fixture 与验证门。

## 3. 威胁目录

| ID | 威胁 | 影响 | 对策 | 验证 |
| --- | --- | --- | --- | --- |
| T01 | 恶意 tarball 路径逃逸（`../`、绝对路径、设备文件、异常 symlink） | 任意文件写入 | 先校验 integrity，再安全列表检查，拒绝异常条目后才展开 | C3 恶意 tar 夹具 |
| T02 | 压缩炸弹或超大包 | 资源耗尽、拒绝服务 | 展开总大小、文件数、单文件大小限额 | C3 超限夹具 |
| T03 | 候选包 lifecycle script 执行 | 任意代码执行 | 安装一律 `--ignore-scripts`；sentinel 文件断言未执行 | L3 lifecycle 哨兵 |
| T04 | registry integrity 不匹配或同版本内容变化 | 供应链注入 | cache key 含 package/version/integrity；不匹配立即阻断 | C3 registry stub |
| T05 | 依赖混淆与名称伪装 | 取错工件 | 只接受精确 package name + 精确 semver；registry allowlist | C3 输入验证 |
| T06 | 凭据、token、会话内容泄漏进报告或日志 | 机密泄露 | 脱敏规范、路径别名、token/ANSI 扫描 | 脱敏单元测试与 golden 检查 |
| T07 | 不可信 README/错误文本注入指令 | 指令注入、钓鱼 | 仅作数据证据；纯文本渲染；不驱动命令 | P2 恶意文本渲染测试 |
| T08 | stale 报告重放或 digest 不匹配合并 | 基于过期事实决策 | 宿主/profile/候选 digest 全匹配才合并；stale 明确隔离 | P3 digest E2E |
| T09 | 旧 major schema 报告伪装为当前状态 | 语义漂移 | 不支持的 major 显式拒绝；无法迁移只允许下载 | L2 报告契约测试 |
| T10 | smoke 网络副作用与第三方遥测 | 隐私外泄 | 默认网络隔离；平台无法强制时显式标记，不声称无副作用 | C4 网络边界测试 |
| T11 | smoke 子进程、端口、临时文件泄漏 | 资源占用、端口冲突 | 进程组回收、超时终止、清理审计 | C4 泄漏门槛（50/20 次） |
| T12 | 真实 profile 或进程管理器/服务监督器状态被写入 | 环境破坏 | 只读扫描；临时 DSH_HOME；前后摘要不变性审计 | L3/L6 不变性审计 |
| T13 | 插件 Host 服务故障拖垮宿主 | 宿主崩溃 | 惰性扫描、错误限流、故障隔离、dispose 清理 | P1 故障注入 |
| T14 | 浏览器任意指定路径或 report 文件读取 | 本地文件泄漏 | Host API 路径白名单与受控 report 根 | P1/P3 安全测试 |

## 4. MVP 非目标边界（安全承诺）

以下边界为 MVP 硬承诺，任何"方便性"不得突破；变更需回到 M0 设计变更评审：

- 不写入任何真实 DSH profile 的 manifest、lockfile、loader patch 或进程管理器/服务监督器状态；
- 不安装、升级、降级或删除插件；
- 不重启正式 dsh，不执行任何进程管理器/服务监督器管理命令或系统服务操作；
- 不执行任意 shell 命令，也不执行候选包的 install/preinstall/postinstall lifecycle scripts；
- 不读取模型凭据、会话内容、插件业务数据或用户工作区文件；
- smoke 不创建模型会话、不发送提示词、不调用模型 API；
- 不把任意 Git 仓库、文件路径或未固定版本当作可安全执行的候选包；
- 不自动下载并信任远程兼容矩阵；未来增加时必须先做签名验证与缓存审计设计。

## 5. 残余风险与假设

- registry 元数据（含镜像）本身可信度有限：M0 溯源只记录只读元数据可复核的身份（版本、integrity、license），不下载 tarball；
- 网络隔离能力依赖平台：无法强制阻断非 loopback 网络的环境必须显式标记 `network-not-enforced`；
- 静态 API 检查无法覆盖动态属性访问、反射与 minified 代码，对应结论只能是 `unknown` 或风险提升，不能给绿色；
- 单维护者仓库的评审限制：作者自评不能替代独立审查，必须在 PR 与证据中如实标注；
- K01/K03/K05 之外的历史组合不在 M0 举证范围内，进入 I1 前不得宣称已验证。

## 6. 验证映射

- 结构性阴性检查（绿色不可伪造）：`tests/contract/` 与 `scripts/verify-m0.mjs`（见 [`07-m0-contract.md`](07-m0-contract.md) 第 8 节）；
- 脱敏与 golden 确定性：`fixtures/golden/` 全量过门；
- 供应链与进程边界的运行时验证分别映射到 C3/C4 与 L3-L7（见 [`04-validation-plan.md`](04-validation-plan.md) 第 10-14 节）。
