owner: qq.receive
anchors: dsh-fish-qq/qq/index.js#parseReceiveCommand; dsh-fish-qq/qq/index.js#sanitizeForFileName; dsh-fish-qq/qq/index.js#uniqueReceiveName; dsh-fish-qq/qq/index.js#inlineFileNotes; dsh-fish-qq/qq/index.js#buildReceiveReport
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.receive

本文档是 `qq.receive` 的唯一事实来源：别人发来的文件怎么落到 `<工作区>/receive/`、正文里的 `[文件]` 占位符怎么填、主人发 `receive` 时怎么回收件箱近况。`fileget` / `filesend` 发文件的出站通道归 `qq.files`；安全闸门汇总见 `qq.safety`。

## 事实

### 指令正则

- `RECEIVE_PREFIX = 'receive'`。
- `parseReceiveCommand(text)`：对 `trim()` 后的整条消息做 `toLowerCase() === 'receive'`；大小写不敏感，**整条消息必须恰好是它**。
- `receive 一下`、`帮我 receive`、`receive now` 都不算；解析失败返回 `null`，调用方按普通聊天处理（不报错、不丢消息、不回话）。

### 权限档

- **主人或管理员**：`canUseFileCommand(senderId, settings)`（`isOwnerSender || isAdminSender`）。
- `decide()` 里同时要求 `canUseFileCommand` 为真 + `parseReceiveCommand` 能解析；普通人发 `receive` 不是指令，按普通聊天处理。
- 与 `fileget` / `filesend` / `list` 共用同一道身份闸门。

### 是否唤醒模型

**否。** `decide()` 返回 `{ action: 'receive' }`，`handleInbound()` 在 `bufferSnapshot` 之前直接 `buildReceiveReport()` + `sendBridgeReply(msg, text, 'receive')`，不调用模型、不写事件流。

### 是否进缓冲

**否。** 直接回执分支在任何 `await` / 缓冲快照之前返回；`receive` 本身不 `state.buffer.push()`，也不清空已有缓冲（那些留给下一次唤醒）。

### outbox 的 via 值

- `sendBridgeReply(msg, text, 'receive')` → 成功时 outbox `via: 'receive'`，目的地是**本条消息**来的地方（群回群、私聊回私聊）。
- 发送失败只记日志（`receive-failed`），不写 outbox。

### 每日上限 / 冷却

- **无**：`receive` 没有每日上限、没有冷却、没有概率；它是主人/管理员的显式查询。
- 收件箱本身的容量限制：
  - 目录 = `fishWorkspaceRoot(readSettings().workspaceRoot) + '/receive/'`；
  - 单文件上限 `FILE_MAX_BYTES = 50 * 1024 * 1024`（50MB），超过不落地、正文里写原因；
  - 每收到一个新文件后按 mtime 淘汰最旧的，最多保留 `MAX_RECEIVE_FILES = 200` 个；
  - 一条消息最多收 `MAX_RECEIVE_PER_MESSAGE = 8` 个文件，多出来的写 `reason` 不下载。
- 回执本身：`buildReceiveReport()` 默认 `RECEIVE_REPORT_LIMIT = 5` 个，`limit` 夹在 1–50；按接收时间从新到旧。
- 文件命名：`sanitizeForFileName(nickname, 40)` + `_` + `sanitizeForFileName(fileName, 120)`；重名加 `_1` / `_2`…，极端情况退回时间戳。全清理空了用「未知」/「未命名文件」。
- 正文占位：`inlineFileNotes(text, slots)` 按出现顺序把第 n 个 `[文件]` 换成第 n 个槽位的结果：
  - 成功：`[文件 path=<绝对路径，正斜杠> 大小=<带单位> 来自=<昵称>]`；
  - 失败/超限/没地址：`[文件:<名字>]：<原因>`，不静默丢弃。
- 回执格式：`收件箱（<目录>）共 N 个文件，最近 M 个：` + 每行 `序号. 名字 · 大小 · YYYY-MM-DD HH:mm`；目录没配/空目录都如实说。

### 已知偏差

- **`receive` 的权限**：`对接文档.md` §9.5 与 §10 写「主人 / 管理员」；代码一致（`canUseFileCommand`）。`功能文档.md` 旧 §6.9 的指令表把 `receive` 列在主人指令区，但正文写了管理员可用；两处口径不完全一致，代码按「主人或管理员」。
- **收件箱上限**：`功能文档.md` / `对接文档.md` 没有系统写「200 个文件 / 50MB / 每条消息最多 8 个」这三个数；代码的 `MAX_RECEIVE_FILES` / `FILE_MAX_BYTES` / `MAX_RECEIVE_PER_MESSAGE` 是实际边界，本 L1 补齐。
- **`receiveDirPath` 的工作区探测**：代码用 `fishWorkspaceRoot()`（会向下探测 `DSH-MyFish/`）再拼 `receive/`；文档只说「工作区 receive/ 目录」。如果工作区根填的是外层 `DSH_WorkArea`，实际目录可能是 `<外层>/DSH-MyFish/receive/`，不是 `<外层>/receive/`。
- **失败回执**：`buildReceiveReport()` 在目录没配时返回「收件箱用不了…」，在空目录时返回「现在是空的」；两者都不抛，也不编内容。

## 不负责

- `receive` 的身份判定、白名单、命令解析的安全边界 → 见 [qq.safety](safety.md)。
- `fileget` / `filesend` 把工作区文件发给谁、路径沙箱 → 见 `qq.files`。
- `list` 看 dist/ 与 managehub/ → 见 `qq.list`。
- 收文件的 OneBot `file` 段映射、下载 URL/`file_id` 兜底 → 见 `qq.onebot` / `qq.segments`。
- 设置项默认值与存储 → 见 `qq.settings`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-receive.mjs
```

重点断言：`receive` 精确匹配、大小写不敏感、权限只主人/管理员；`sanitizeForFileName` 去掉非法字符与结尾点/空格；重名加序号；`inlineFileNotes` 逐位对齐、失败写原因；回执按时间新→旧、最多 5 条、空目录/未配工作区如实说；不唤醒模型、不进缓冲。
