owner: qq.whitelist
anchors: dsh-fish-qq/qq/index.js#parseWhitelistCommand; dsh-fish-qq/qq/index.js#whitelistReplyText; dsh-fish-qq/qq/index.js#writeSettingsFile
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.whitelist

本文档是 `qq.whitelist` 的唯一事实来源：主人发 `whitelist <QQ号>` 时怎么解析、怎么在**不唤醒模型**的情况下把号写进私聊白名单、怎么回确认。管理员名单归 `qq.admin`；白名单的 fail-closed 语义与判定函数见 `qq.safety`。

## 事实

### 指令正则

- `WHITELIST_PREFIX = 'whitelist'`（可被调用方用 `prefix` 覆盖）。
- 实现：`new RegExp('^' + escapeRegExp(prefix) + '\\s+(\\d{5,12})$', 'i')`，对 `trim()` 后的整条消息匹配。
- 必须满足：前缀在开头（大小写不敏感）；后面是 **5–12 位数字**；**整条消息到号码为止**。
- `whitelist 10001 你好`、`whitelist 12`、`帮我 whitelist 10001` 都不算；解析失败返回 `null`，按普通聊天处理。
- 只加**私聊白名单**（`values.whitelist`）；群白名单是另一个设置项 `groupWhitelist`，没有对应 QQ 指令。

### 权限档

- **仅主人**（`isOwnerSender`）。
- `decide()` 把 `whitelist` 分支排在 `isAllowed` **之前**：白名单为空（谁都被丢弃）时主人仍能加回第一个人；判据是「主人 + 能解析」，不要求发送者已经在白名单里。
- 非主人发一模一样的开头：不解析、不回话，按普通聊天处理。

### 是否唤醒模型

**否。** `decide()` 返回 `{ action:'whitelist' }`；`handleInbound()` 调 `addPrivateWhitelist()` 改设置，再用 `whitelistReplyText()` + `sendBridgeReply(..., 'whitelist')` 回确认。全程不调用模型、不写事件流。

### 是否进缓冲

**否。** whitelist 分支在任何 `await` / 缓冲快照之前返回；不 `state.buffer.push()`，也不清空已有缓冲。

### outbox 的 via 值

- 成功：`via: 'whitelist'`，目的地是**本条消息**来的地方。
- 写失败 / 发送失败：`whitelist-failed` 日志，不写 outbox（`sendBridgeReply` 只在真的发出时记）。

### 每日上限 / 冷却

**无**：whitelist 没有每日上限、没有冷却、没有概率；它是主人临场加人的管理动作。

### 写回与回复

- `addPrivateWhitelist(targetQQ)`：
  1. 号码为空或不匹配 `QQ_ID_RE`（5–12 位数字）→ `{ ok:false, reason:'bad-qq' }`；
  2. 0.1.5 老宿主（`legacySettings`）→ `{ ok:false, reason:'legacy-settings' }`，如实说「这个宿主不支持从桥接层写白名单，请在设置界面里手动加」；
  3. 已在 `whitelist` 里 → `{ ok:true, already:true }`，不重复写；
  4. 否则 `writeSettingsFile({ ...readSettingsFile(), whitelist: next })`，写 `$DSH_HOME/qq-bridge-settings.json` 的 `values.whitelist`；写失败返回 `write-failed` 和原因。
- `writeSettingsFile()` 原子写（`.tmp` → rename）、结构 `{ version:1, values }`、清 mtime 缓存；写成功后**下一条消息**就按新名单唤醒，不用重启。
- `whitelistReplyText({ targetQQ, already, failed })` 三档：
  - 成功：`已把 QQ <号> 加进私聊白名单，现在就能叫醒我了（不用重启）。`
  - 重复：`QQ <号> 已经在私聊白名单里了，不用重复加。`
  - 失败：`白名单没写成：<原因>`；绝不说「加好了」。

### 已知偏差

- **「白名单空 = 谁都不能唤醒」与「主人能加人」不矛盾**：`qq.safety` 的 `isAllowed` 对空名单返回 `false`；但 `decide()` 在 `isAllowed` 之前先处理「主人 + whitelist 指令」，所以空名单时主人仍能加回第一个人。文档如果只读 `isAllowed` 会以为主人也被挡，实际不会。
- **0.1.5 不能从 QQ 写白名单**：`对接文档.md` §4.4 / README 说 0.1.5 的值在 settings 命名空间；代码的 `addPrivateWhitelist()` 对 `legacySettings` 直接返回 `legacy-settings`，不偷写 `readSettings` 不读的文件。0.2.x 才写 `qq-bridge-settings.json`。
- **只加私聊**：README 的章节标题写「私聊白名单」；命令也只改 `whitelist`，不会动 `groupWhitelist`。群白名单没有 QQ 指令，只能去设置页改。
- **回复文案的「不用重启」**：只对 0.2.x 的 `writeSettingsFile` 成立；0.1.5 走设置界面改，改完是否生效取决于宿主的 settings 服务。

## 不负责

- `isAllowed` 的 fail-closed 判定、白名单/群白名单的语义 → 见 [qq.safety](safety.md)。
- 管理员名单的 `admin add/del/list` → 见 `qq.admin`。
- `whitelist` 设置项的默认值、存储与 `groupWhitelist` → 见 `qq.settings`。
- 0.1.5 设置命名空间的读取 → 见 `qq.settings` / `merge.config`。
- 白名单如何影响 `decide()` 的后续分支 → 见 `qq.wake`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-whitelist.mjs
```

重点断言：`whitelist <5–12位QQ>` 才解析；非主人不解析；空名单时主人仍能加；重复加返回 `already`；非法号/老宿主写不了如实报错；写成功后下一条消息生效；不唤醒模型、不进缓冲。
