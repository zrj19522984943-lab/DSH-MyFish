owner: qq.admin
anchors: dsh-fish-qq/qq/index.js#isAdminSender; dsh-fish-qq/qq/index.js#parseAdminCommand; dsh-fish-qq/qq/index.js#adminReplyText; dsh-fish-qq/qq/index.js#applyAdminCommand
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.admin

本文档是 `qq.admin` 的唯一事实来源：主人用 `admin add/del/list` 管理管理员名单时怎么解析、写哪里、怎么回执，以及管理员身份在 `isAdminSender` 里的判定。白名单指令归 `qq.whitelist`；三档权限矩阵见 `qq.owner`；安全闸门汇总见 `qq.safety`。

## 事实

### 指令正则

- `ADMIN_PREFIX = 'admin'`（可被调用方用 `prefix` 覆盖）。
- 两种形态，均对 `trim()` 后的整条消息、大小写不敏感：
  1. `new RegExp('^' + escapeRegExp(prefix) + '\\s+(add|del)\\s+(\\d{5,12})$', 'i')` → `{ op:'add'|'del', targetQQ }`；
  2. `new RegExp('^' + escapeRegExp(prefix) + '\\s+(list|列表)$', 'i')` → `{ op:'list' }`。
- 必须整条消息匹配：`admin add 10001 你好`、`admin add 12`、`帮我 admin list` 都不算；解析失败返回 `null`，按普通聊天处理。
- 操作词只认 `add` / `del` / `list`（`列表` 等价 `list`）。

### 权限档

- **仅主人**（`isOwnerSender`）。
- `decide()` 把 `admin` 分支排在 `isAllowed` **之前**，与 `whitelist` 同级：白名单为空时主人仍能管理管理员名单。
- 非主人发一模一样的开头：不解析、不回话，按普通聊天处理。
- `isAdminSender(senderId, admins)` 对名单逐项 `String(...).trim()` 后精确比较；空发送者返回 `false`。`senderRole` 里主人优先于管理员。

### 是否唤醒模型

**否。** `decide()` 返回 `{ action:'admin' }`；`handleInbound()` 调 `applyAdminCommand()` 改名单，再用 `adminReplyText()` + `sendBridgeReply(..., 'admin')` 回执。全程不调用模型、不写事件流。

### 是否进缓冲

**否。** admin 分支在任何 `await` / 缓冲快照之前返回；不 `state.buffer.push()`，也不清空已有缓冲。

### outbox 的 via 值

- 成功：`via: 'admin'`，目的地是**本条消息**来的地方。
- 写失败 / 发送失败：`admin-failed` 日志，不写 outbox。

### 每日上限 / 冷却

**无**：admin 没有每日上限、没有冷却、没有概率。

### 写回与回复

`applyAdminCommand(cmd)`：

| op | 行为 |
| --- | --- |
| `list` | 返回当前 `readSettings().admins`（字符串数组），不改盘 |
| `add` | 已在名单 → `already:true`；否则 `[...list, qq]` 写入设置 |
| `del` | 不在名单 → `missing:true`；否则过滤掉该号写入设置 |
| 其他 | `bad-op` |

写入细节：

- 号码为空或不匹配 `QQ_ID_RE`（5–12 位）→ `{ ok:false, reason:'bad-qq' }`。
- 0.1.5 老宿主（`legacySettings`）→ `{ ok:false, reason:'legacy-settings' }`，提示去设置界面手动改。
- 0.2.x → `writeSettingsFile({ ...readSettingsFile(), admins: next })`，写 `$DSH_HOME/qq-bridge-settings.json` 的 `values.admins`；原子写、清 mtime 缓存，下一条消息立即生效。
- **管理员名单不自动排除主人**：`admin add <主人QQ>` 只查重复，不拒绝；主人同时在 `admins` 里时 `senderRole` 仍按 `owner` 算，权限不冲突。

`adminReplyText({ op, targetQQ, already, missing, failed, list })` 的分支：

- 失败：`管理员名单没写成：<原因>`；
- add 成功 / 已存在；
- del 成功 / 不在名单；
- list：空名单 → 「管理员名单现在是空的…」；非空 → `管理员名单（N 人）：…`。

### 已知偏差

- **`对接文档.md` §4.4 说管理员「能用 receive / fileget / filesend」**；代码的身份判定（`isAdminSender` / `senderRole`）只负责打标记，具体能不能用由 `decide()` 的 `canUseFileCommand` 与工具闸门决定。`receive` / `list` 在 `decide()` 里对管理员放行；`fileget` / `filesend` 的工具闸门在 `qq.files`（T4）。这是分层，不是身份表不一致。
- **管理员名单与主人重复**：`setup.js` 写配置时会把主人从 `admins` 去掉，但 QQ 上的 `admin add` 不做这个排除；代码只按 `senderRole` 的主人优先级消解，名单本身可能重复。
- **「立刻生效」**：只对 0.2.x 的 `writeSettingsFile` 成立；0.1.5 的值在宿主 settings 命名空间，桥接层没有写入接口，会明确回 `legacy-settings`，不会假装成功。
- **`admin list` 的中文别名**：正则接受 `列表`，但 `adminReplyText` 只按 `op:'list'` 分支；两者一致。

## 不负责

- `isAdminSender` 之外的身份判定、白名单、help/receive/list 的安全闸门 → 见 [qq.safety](safety.md)。
- 主人 / 管理员 / 普通人的权限矩阵与来源标记 → 见 `qq.owner`。
- `whitelist` 指令 → 见 `qq.whitelist`。
- `admins` 设置项的默认值、存储与 `writeSettingsFile` 的结构 → 见 `qq.settings` / `qq.whitelist`。
- 管理员能用 fileget / filesend / receive / list 的具体实现 → 见 `qq.files`（T4）/ `qq.receive` / `qq.list`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-admin.mjs
```

重点断言：`admin add/del <5–12位QQ>`、`admin list` / `admin 列表` 才解析；大小写不敏感；非主人不解析；重复 add / 不在名单 del 的 `already` / `missing`；写失败/老宿主如实报错；名单立刻生效；不唤醒模型、不进缓冲。
