owner: qq.list
anchors: dsh-fish-qq/qq/index.js#parseListCommand; dsh-fish-qq/qq/index.js#listWorkspaceFiles; dsh-fish-qq/qq/index.js#buildListReport
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.list

本文档是 `qq.list` 的唯一事实来源：主人或管理员发 `list` / `list dist` / `list managehub` 时，桥接层怎么解析、读哪两个目录、怎么排版回执。其他指令族见 `qq.receive` / `qq.subsend` / `qq.help` / `qq.whitelist` / `qq.admin`；安全闸门汇总见 `qq.safety`。

## 事实

### 指令正则

- `LIST_COMMAND = 'list'`。
- `parseListCommand(text)` 对 `trim()` 后的整条消息匹配：`/^list(?:\s+([^\s]+))?$/i`。
- 合法形态：
  - `list` → `{ command:'list', target:null }`（两个目录都列）；
  - `list dist` → `{ command:'list', target:'dist' }`；
  - `list managehub` → `{ command:'list', target:'managehub' }`。
- 目录名只认 `LIST_DIR_NAMES = ['dist', 'managehub']`；`list 别的目录`、`list receive`、`list dist managehub`、`list 一下`、`帮我 list` 都返回 `null`，按普通聊天处理。
- 大小写不敏感（`LIST DIST` 也认）；参数与指令之间空白任意。

### 权限档

- **主人或管理员**：`canUseFileCommand(senderId, settings)`。
- `decide()` 要求 `canUseFileCommand` 为真 + `parseListCommand` 能解析；普通人发 `list` 不是指令，不解析、不回话。
- 与 `fileget` / `filesend` / `receive` 共用同一道身份闸门。

### 是否唤醒模型

**否。** `decide()` 返回 `{ action:'list' }`；`handleInbound()` 在缓冲快照之前直接 `buildListReport()` + `sendBridgeReply(msg, text, 'list')`，不调用模型、不写事件流。

### 是否进缓冲

**否。** `list` 在 `bufferSnapshot` 之前返回；它本身不 `state.buffer.push()`，也不清空已有缓冲。

### outbox 的 via 值

- 成功：`via: 'list'`，目的地是**本条消息**来的地方（群回群、私聊回私聊）。
- 发送失败只记日志（`list-failed`），不写 outbox。

### 每日上限 / 冷却

- **无每日上限、无冷却、无概率**；这是主人/管理员的显式查询。
- 回执的行数上限：`LIST_REPORT_LIMIT = 20`（`buildListReport` 里夹在 1–100）；每个目录最多列最新 20 个文件，超过时表头写「共 N 个文件，只列最近 20 个」。
- 只读普通文件，不递归子目录；不存在的目录 / 空目录 / 读不了都如实说，不编内容。

### 目录与路径

- `listWorkspaceFiles(root, dirName)`：
  - `root` 为空 → `{ ok:false, reason:'no-root' }`；
  - 目录名是空串 / `.` / `..` / 含 `/` 或 `\` → `{ ok:false, reason:'bad-dir' }`（防目录扫描）；
  - 先找 `<root>/<dirName>`；不存在再找 `<root 的上一层>/<dirName>`（新布局里 `dist` / `managehub` 留在外层工作区）；
  - 目录不存在 → `not-found`；存在但读不了 → `unreadable`；
  - 返回 `{ ok:true, dir（绝对路径）, name, files:[{name,size,at}] }`，`at` 是 mtimeMs。
- `buildListReport({ root, target, results })`：
  - `root` 为空 → 整句「list 用不了：还没配工作区根目录…」；
  - 每个目录一块：表头是目录全路径（正斜杠）+ 文件数，下面每行 `序号. 名字 · 大小 · YYYY-MM-DD HH:mm`，按 mtime 从新到旧；
  - `not-found` → 「…不存在。」；`unreadable` → 「…读不了（权限或被占用），列不出来。」；其他 reason 原样写；
  - 目录空 → 「…是空的。」。

### 已知偏差

- **`list` 的目录范围**：`对接文档.md` / `功能文档.md` 说「看 `dist/` 与 `managehub/`」；代码还支持「小鱼根下找不到时，回退到上一层工作区找同名目录」（`listWorkspaceFiles` 的 outer 逻辑）。这是新布局的兼容，不是开放任意目录。
- **回执行数上限**：文档写「超过 20 个只列最新 20 个」；代码 `LIST_REPORT_LIMIT = 20`，`buildListReport` 里固定用这个数（没有调用方可覆盖的 `limit` 参数），与文档一致。
- **`list` 不经过 `qq.tools`**：它不是模型工具，是桥接层直回指令；`工具一览` 里没有 `qq_bridge_list`。模型侧只能通过普通聊天间接建议主人发 `list`。

## 不负责

- `list` 的身份判定与白名单 → 见 [qq.safety](safety.md)。
- `receive` 收件箱与文件落盘 → 见 `qq.receive`。
- `fileget` / `filesend` 发文件 → 见 `qq.files`（T4）。
- `dist/` / `managehub/` 的内容怎么产生（打包、交换） → 见 `ops.release` / `ops.layout`。
- 设置项 `workspaceRoot` 的默认值与存储 → 见 `qq.settings`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-list.mjs
```

重点断言：`list` / `list dist` / `list managehub` 才解析；大小写不敏感；非法目录/多参数返回 `null`；权限只主人/管理员；排序新→旧；空目录 / 不存在 / 未配工作区如实说；最多 20 行且表头写总数。
