# k01-agent-teams-0-1-15

## 输入
宿主 0.1.1-rc.2 + @nanmicoder/dsh-agent-teams 0.1.15（无 engines/peers 声明）；bundle dist/index.js 调用 ctx.subagents.registerContinuableSetup；宿主语料（host-corpus）无该方法；内置矩阵含 deny 记录。

## 预期 findings
known-matrix-deny（known_matrix 证据）+ missing-host-api（host_api 证据）；无引擎声明被矩阵 deny 抑制。

## 唯一预期结论
incompatible（阻断；advisory/strict 退出码 1）。

## 为何不应产生其他状态
该组合即 K01 事故：loader 因缺失 API 失败。任何绿色状态都属零误报为绿违规；smoke 未执行不得为 validated_compatible。
