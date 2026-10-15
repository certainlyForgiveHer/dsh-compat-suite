# k05-skill-explorer-0-3-10

## 输入
宿主 0.1.1-rc.2 + @linxin666/dsh-client-ui-skill-explorer 0.3.10，mandatory peer @deepseek-ai/dsh '>=0.2.0-rc.2'。

## 预期 findings
peer-mismatch-mandatory（manifest 证据）+ engine-declaration-missing。

## 唯一预期结论
incompatible（阻断；退出码 1）。

## 为何不应产生其他状态
peer 核对宿主核心包 @deepseek-ai/dsh=0.1.1-rc.2 不满足范围；mandatory peer 不匹配为阻断结论。
