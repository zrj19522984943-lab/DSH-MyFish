owner: qq.help
anchors: dsh-fish-qq/qq/index.js#parseHelpCommand; dsh-fish-qq/qq/index.js#buildHelpText
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.help

本文档是 `qq.help` 的唯一事实来源：`help` / `/help` / `帮助` / `指令` 怎么解析、谁能用、回哪一份列表、走哪条出站通道。其他指令族见 `qq.subsend` / `qq.receive` / `qq.list` / `qq.whitelist` / `qq.admin`；安全闸门汇总见 `qq.safety`。

## 事实

### 指令正则

- `HELP_COMMAND = 'help'`；`HELP_WORDS = ['help', '/help', '帮助', '指令']`。
- `parseHelpCommand(text)`：对 `trim()` 后的整条消息做 `HELP_WORDS.includes(raw.toLowerCase())`。
- 必须**整条消息恰好**是四个词之一；`help me`、`帮我看看 help 文档`、`/help 一下` 都不算；解析失败返回 `null`，按普通聊天处理。
- 排在会话跟随与 `atOnlyInGroup` 之前：要看帮助不需要先 @。

### 权限档

- **任何已通过白名单的人**：`decide()` 只在 `isAllowed` 之后判 help；主人、管理员、普通人都能发。
- 内容按身份分档（`buildHelpText(settings, { senderId })`）：
  - **主人**：全部指令（含 subsend / whitelist / admin）；
  - **管理员**：fileget / filesend / receive / list / help，并注明「可以派活」与「subsend / whitelist / admin 只有主人能用」；
  - **普通人**：只告诉「能聊天 + help」，不列任何有副作用的指令。
- `senderId` 为空时 `buildHelpText` 按主人那份返回（旧调用处/纯函数测试的形状）；实际入站一定带 `senderId`。

### 是否唤醒模型

**否。** `decide()` 返回 `{ action:'help', reason:'<role>-help' }`；`handleInbound()` 调 `sendHelpReply(msg)` → `buildHelpText()` + `sendBridgeReply(..., 'help')`，不调用模型、不写事件流。

### 是否进缓冲

**否。** help 分支在 `bufferSnapshot` 之前返回；不 `state.buffer.push()`，也不清空已有缓冲。

### outbox 的 via 值

- 成功：`via: 'help'`，目的地是**本条消息**来的地方。
- 发送失败只记日志（`help-failed`），不写 outbox。

### 每日上限 / 冷却

**无**：help 没有每日上限、没有冷却、没有概率；它不花 token。

### 列表内容

- `buildHelpText` 只列**真的能用**的：
  - `subsendEnabled !== false` 时才列 `subsend`；
  - 工作区根没配时，`fileget` / `filesend` 后面注明「工作区还没配，现在用不了」；
  - 管理员那份固定列 `fileget` / `filesend` / `receive` / `list` / `help`，并写「可以派活」；
  - 普通人那份只列 `help` 和「只能聊天」。
- 文案是纯文本短句，不使用 Markdown 表格；每行一个用法 + 一行说明。
- 主人那份末尾会写「指令要写在消息开头，整条消息就是它，大小写都行」；配了 `ownerQQ` 时再写主人的 QQ。

### 已知偏差

- **「help 仅主人」的说法过时**：`dsh-fish-qq/qq/README.md` 的章节标题写 `help：指令词列表（主人专用）`；`功能文档.md` §6.9 的规则写「只有主人」，同节又写 `help` 放宽；代码从 2026-10-29 起是**任何已通过白名单的人**都能用，只是内容按身份分档。`对接文档.md` §9.5 第 2 步也还写「主人 + help」，同一处已在 `qq.wake` / `qq.safety` 记录。
- **`help` 的 `reason`**：`decide()` 返回 `${role}-help`（`owner-help` / `admin-help` / `other-help`），不是固定的 `help`；入站台账里会看到这个 reason，动作仍是 `help`。
- **普通人那份不列副作用指令**：这是安全属性（普通人看不到 `subsend` / `fileget` / `whitelist` / `admin` 的用法），不是「普通人不能用 help」。普通人仍然能拿到「只能聊天」那份。

## 不负责

- help 的身份判定、白名单、`isAllowed` → 见 [qq.safety](safety.md)。
- 管理员能力的实际闸门（fileget / filesend / receive / list / work_request） → 见 `qq.owner` / `qq.files` / `qq.receive` / `qq.list`。
- 注入给模型的系统提示（与 help 无关） → 见 `qq.prompt`。
- 设置项 `subsendEnabled` / `workspaceRoot` 的默认值 → 见 `qq.settings`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-help.mjs
```

重点断言：四种词、整条消息口径、大小写不敏感；主人/管理员/普通人三档列表；`subsendEnabled=false` 时不列 subsend；工作区没配时标「用不了」；普通人那份不列副作用指令；不唤醒模型、不进缓冲。
