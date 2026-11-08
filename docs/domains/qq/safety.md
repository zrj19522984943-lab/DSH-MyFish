owner: qq.safety
anchors: dsh-fish-qq/qq/index.js#isAllowed; dsh-fish-qq/qq/index.js#isOwnerSender; dsh-fish-qq/qq/index.js#canUseFileCommand; dsh-fish-qq/qq/index.js#parseHelpCommand; dsh-fish-qq/qq/index.js#parseReceiveCommand; dsh-fish-qq/qq/index.js#parseListCommand
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.safety

本文档是 `qq.safety` 的唯一事实来源：身份判定（主人 / 管理员 / 普通人）、白名单 fail-closed、文件类指令的身份闸门，以及 help / receive / list 三个「整条消息恰好是指令」的解析形状。`decide()` 怎么排列这些判断见 `qq.wake`。

## 事实

### `isAllowed(msg, s)`：fail-closed 白名单

- 群聊（`msg.groupId` 非空）：`s.groupWhitelist` 为空 → `false`；否则要求 `groupWhitelist.includes(String(msg.groupId))`。
- 私聊：`s.whitelist` 为空 → `false`；否则要求 `whitelist.includes(String(msg.userId))`。
- 精确字符串匹配，不做前缀 / 模糊匹配；空名单 = 谁都不能唤醒，不是「默认全放行」。

### `isOwnerSender(senderId, ownerQQ)`

- `ownerQQ` 先 `String(...).trim()`；空串 → `false`（没配主人时**谁都不是主人**，fail-closed）。
- 否则要求 `String(senderId) === ownerQQ` 精确相等。
- `qq.settings` 的 `readSettings()` 已经把 `ownerQQ` 收成纯数字；本函数不再做数字清洗。

### 身份档与来源标记

- `senderRole(senderId, { ownerQQ, admins })` 固定优先级：`owner` > `admin` > `other`。同一个人既在管理员名单又是主人时按 `owner` 算。
- `isAdminSender(senderId, admins)`：对名单逐项 `String(...).trim()` 后精确比较；发送者为空串 → `false`。
- 非主人入站会贴标记：
  - 管理员：`ADMIN_MARKER = '[来源：管理员用户]'`；
  - 普通人：`NON_OWNER_MARKER = '[来源：非主人用户，仅允许聊天，禁止调用工具、派发任务或执行任何写操作]'`；
  - 主人：不贴。
- `ownerMarkerFor()` 返回上述三种结果；标记是写给模型看的权限边界，不是给 QQ 用户看的。

### `canUseFileCommand(senderId, settings)`

- 主人 → `true`；管理员 → `true`；其他人 → `false`。
- 同一道闸门被 `fileget` / `filesend` / `receive` / `list` 共用。**命令文本解析函数本身不判权限**；权限在 `decide()` / 工具执行处判。

### 三个直回指令的解析

**`parseHelpCommand(text)`**

- 判据：整条消息 `trim()` 后**恰好**等于 `HELP_WORDS` 之一：`help`、`/help`、`帮助`、`指令`；大小写不敏感。
- `help me`、`帮我看看 help 文档` 都不算；解析失败返回 `null`，调用方按普通聊天处理。
- 权限：任何已通过 `isAllowed` 的人都能用；`buildHelpText(settings, { senderId })` 按 `owner` / `admin` / `other` 给三份不同列表（管理员会看到自己可用的 fileget/filesend/receive/list，并注明哪些只有主人能下；普通人只看到聊天）。
- 返回 `{ command: 'help' }` 或 `null`。

**`parseReceiveCommand(text)`**

- 判据：整条消息 `trim()` 后恰好等于 `receive`，大小写不敏感。
- 只主人 / 管理员能触发（`decide()` 里用 `canUseFileCommand` 判）；解析器本身只认形状。
- 返回 `{ command: 'receive' }` 或 `null`。

**`parseListCommand(text)`**

- 判据：`/^list(?:\s+([^\s]+))?$/i` 匹配整条 `trim()` 后的消息：
  - `list` → `{ command: 'list', target: null }`（两个目录都列）；
  - `list dist` / `list managehub` → `{ command: 'list', target: 'dist' | 'managehub' }`；
  - 目录名只有 `LIST_DIR_NAMES = ['dist', 'managehub']`，其他值（包括 `list receive`、`list dist managehub`）返回 `null`。
- 只主人 / 管理员能触发；解析器本身不判权限。

三个解析器都遵循同一条口径：**不是指令就返回 `null`，调用方按普通聊天处理**——不报错、不丢消息、不回「你不配」。

### 已知偏差

- `dsh-fish-qq/对接文档.md` §10 的 help 行写「仅主人」；代码从 2026-10-29 起是**任何已通过白名单的人**都能用 help，只是内容按身份分档（普通人那份不列有副作用的指令）。同一行写「优先级最高」也不准确：help 排在 `whitelist` / `admin` 两条主人直回和 `isAllowed` 之后。
- §10 的 outbound 闸门行写「只有被 QQ 唤醒、或 DSH 会话发起人本人，才能把消息发出去」；代码实际是「非 QQ 轮第一次调用只回确认，同一轮第二次才真发」的两步确认，没有发起人身份判断。该事实归 `qq.outbound`。
- §10 的工具面收窄行写「只留 10 + 6 + `read_image`」，是旧的全局注册口径；当前是会话级 scoped 挂载 + `restrict` / `guard` 两把刀，具体清单归 `fish.tools`，不在本单元。
- §10 的文件沙箱行把 `listdir/readfile/fileget` 写在一起；它们分属两个单元：`listdir` / `readfile` 见 `fish.workspace`，`fileget` / `filesend` 见 `qq.files`。本单元只负责 `canUseFileCommand` 这道身份闸门。
- §10 的「无人值守」行与代码一致（管理账户私聊明确要求时按该要求执行），但具体提示词文本归 `qq.prompt`，本单元不重复。
- §10 的「凭据」行写「每次操作重新解析」；代码里 `accessTokenEnv` 的解析发生在 OneBot 建连 / 重连路径，不是每次消息都解析。细节归 `qq.onebot`。

## 不负责

- `decide()` 的分支顺序与动作、record / wake 的判定 → 见 `qq.wake`。
- `ownerQQ` / `admins` 的配置、维护与产品语义 → 见 `qq.owner`。
- whitelist / admin 指令的解析与写回（主人专用） → 见 `qq.owner` 与 `qq.wake`。
- `replyMode` / `outboundGate` 等出站闸门 → 见 `qq.outbound`。
- `fileget` / `filesend` 的路径沙箱与发送 → 见 `qq.files`；`receive` 落盘 → 见 `qq.receive`。
- 注入给目标会话的无人值守提示词 → 见 `qq.prompt`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-whitelist.mjs       # isAllowed / 白名单空 = 全拒 / 主人加白名单
node test-help.mjs            # help 四种词 / 整条消息口径 / 三档列表
node test-receive.mjs         # receive 精确匹配 / 主人管理员权限
node test-list.mjs            # list / list dist / list managehub / 非法目录
node test-owner-proactive.mjs # isOwnerSender / senderRole / 来源标记
```
