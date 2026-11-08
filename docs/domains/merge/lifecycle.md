owner: merge.lifecycle
anchors: dsh-fish-qq/index.js
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0 / qq@0.1.18

# merge.lifecycle

本文档是 `merge.lifecycle` 的唯一事实来源：二合一包的宿主半入口、fish/qq 的启动顺序、错误隔离与 dispose 顺序。版本号归 `merge.version-matrix`。

## 事实

- `dsh-fish-qq/index.js` 导出 `name='dsh-fish-qq'`、`VERSION='1.4.0'`（**与 package.json 不一致，当前版本见 [merge.version-matrix](version-matrix.md)**）、`inject`（fish + qq 并集）、`apply(ctx, config)`。
- 浏览器半 `client.js` 由 `scripts/build-bundle.mjs` 生成；跨端纯函数（settings contract / model-pool / protocol）由构建注入到 `__qqFactory`，宿主专属纯函数在 `qq/shared/`，client 不 import（bundle 是 classic script）。
- `config` 分两槽：`config.fish` 原样给 fish，`config.qq` 原样给 qq；两边互不串味。
- 启动顺序：**先 fish、再 qq**。fish 先建屋子（工作区 + 会话）；qq 的 `targetSessionId` 留空时读 `~/.dsh-fish/home.json` 拿会话 id，顺序反了第一次会读不到（有兜底）。
- 工具共享：`const herToolDefs = []` 同时传给 fish 的 `toolSink` 与 qq 的 `toolSink`；两边的她的工具都收进同一数组，由 fish 的 `agent/created` 挂进她的 own 层；QQ 管理/调试工具仍 global。
- `workspaceRoot` 以 getter 传给 fish：`readQqWorkspaceRoot(config.qq)` 每次调用重读 `qq-bridge-settings.json`，设置改完下一次工具调用生效。
- 错误隔离：fish/qq 各自 try/catch，任何一边启动抛错只记日志，不带走另一边；两边的 `dispose` 都收集。
- `dispose()` 逆序调用收集到的 disposer；单个抛错被吞掉，不拦住另一边。

### 已知偏差

- `index.js` 的 `VERSION='1.4.0'` 与 `package.json` 不一致。当前版本以 [merge.version-matrix](version-matrix.md) 为准；`VERSION` 常量应在发版时同步（T4 未改代码，只记录）。

## 不负责

- 三个包的版本表 → 见 `merge.version-matrix`。
- 服务依赖并集/可选服务 → 见 `merge.inject`。
- 浏览器 bundle 生成/双设置页 → 见 `merge.client-bundle`。
- patch 槽位 → 见 `merge.patch`。

## 验收

```powershell
node --check dsh-fish-qq/index.js
node scripts/docs-lint.mjs
```
人工核对：先 fish 后 qq、两槽不串、错误隔离、dispose 逆序、工具共享数组。
