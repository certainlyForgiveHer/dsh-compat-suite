# k06-skill-explorer-0-2-9

## 输入
宿主 0.1.1-rc.2 + @linxin666/dsh-client-ui-skill-explorer 0.2.9，dsh.engines.dsh = '>=0.1.1-rc.2'。

## 预期 findings
engine-range-match（manifest 证据）。

## 唯一预期结论
declared_compatible（非阻断；退出码 0）。

## 为何不应产生其他状态
同 tuple prerelease 比较允许 rc.2 满足 >=0.1.1-rc.2；声明匹配之上无更高证据，不得为 validated_compatible。
