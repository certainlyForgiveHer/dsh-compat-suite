# k03-task-board-0-3-10

## 输入
宿主 0.1.1-rc.2 + @linxin666/dsh-client-ui-task-board 0.3.10，dsh.engines.dsh = '>=0.1.2-alpha.1'。

## 预期 findings
plugin-engine-mismatch（manifest 证据）。

## 唯一预期结论
incompatible（阻断；退出码 1）。

## 为何不应产生其他状态
prerelease-aware 语义：0.1.1-rc.2 不满足 >=0.1.2-alpha.1（docs/04 §8.1 硬门槛）；无 allow 证据可覆盖。
