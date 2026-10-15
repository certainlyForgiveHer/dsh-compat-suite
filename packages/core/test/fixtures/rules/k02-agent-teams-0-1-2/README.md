# k02-agent-teams-0-1-2

## 输入
宿主 0.1.1-rc.2 + @nanmicoder/dsh-agent-teams 0.1.2（无 engines/peers 声明）；内置矩阵含该组合的静态 allow 记录。

## 预期 findings
known-matrix-allow（known_matrix 证据）；engine-declaration-missing 被矩阵证据抑制。

## 唯一预期结论
declared_compatible（非阻断；advisory/strict 退出码 0）。

## 为何不应产生其他状态
矩阵证据只支持声明级兼容：smoke 未执行，因此不得为 validated_compatible；无任何冲突 finding，不得为红色。
