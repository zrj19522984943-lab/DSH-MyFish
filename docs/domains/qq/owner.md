owner: qq.owner
anchors: dsh-fish-qq/qq/index.js#isOwnerSender; dsh-fish-qq/qq/index.js#senderRole; dsh-fish-qq/qq/index.js#ownerMarkerFor
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.owner

本文档是 `qq.owner` 的唯一事实来源：谁是主人、谁是管理员、普通人收到什么来源标记，以及三档身份分别能下哪些指令。具体指令的解析与限流归 `qq.subsend` / `qq.whitelist` / `qq.admin` 等单元；判定函数本身的安全边界见 `qq.safety`。

## 事实

### 认主

- `isOwnerSender(senderId, ownerQQ)`：`ownerQQ` 先 `String(...).trim()`；空串 → **谁都不是主人**（fail-closed）；否则要求 `String(senderId) === ownerQQ` 精确相等。
- `readSettings()` 会把 `ownerQQ` 收成纯数字（`replace(/\D/g,'')`），所以正常路径下比较的是数字串。
- 没配 `ownerQQ` 时所有人都被贴「非主人」标记，插件仍能聊天，但没有人能下主人指令。

### 三档身份

`senderRole(senderId, { ownerQQ, admins })` 固定优先级：

1. `owner`：`isOwnerSender` 为真；
2. `admin`：`isAdminSender` 为真；
3. `other`：其余。

`isAdminSender` 对 `admins` 数组逐项 `String(...).trim()` 后精确比较；发送者为空串返回 `false`。同一个人既在管理员名单又是主人时按 `owner` 算（主人权限是超集，且不贴标记）。

### 来源标记

`ownerMarkerFor(senderId, ownerQQ, admins)` 返回：

| 身份 | 返回值 | 常量 |
| --- | --- | --- |
| `owner` | `''`（不贴） | — |
| `admin` | `[来源：管理员用户]` | `ADMIN_MARKER` |
| `other` | `[来源：非主人用户，仅允许聊天，禁止调用工具、派发任务或执行任何写操作]` | `NON_OWNER_MARKER` |

标记会由 QQ 桥接层加在该条入站正文前，写给模型看；它约束的是「模型该如何对待这条消息」，不是 QQ 用户看到的界面。

### 权限矩阵

| 能力 | 主人 | 管理员 | 普通人 |
| --- | --- | --- | --- |
| 聊天 / 被唤醒 | ✅ | ✅ | ✅（只要在白名单；群看 groupWhitelist） |
| `help` | ✅ | ✅（自己那一份） | ✅（只列聊天） |
| `receive` / `list` | ✅ | ✅ | ❌（按普通聊天处理） |
| `fileget` / `filesend` | ✅ | ✅ | ❌ |
| `work_request`（派活） | ✅ | ✅ | ❌（模型侧另有限制） |
| `subsend` | ✅ | ❌ | ❌ |
| `whitelist` | ✅ | ❌ | ❌ |
| `admin` | ✅ | ❌ | ❌ |

`whitelist` / `admin` 两条主人指令**排在 `isAllowed` 之前**：白名单为空时主人仍能加回第一个人、管理管理员名单。其余指令都要求先通过白名单。

### 已知偏差

- **`对接文档.md` §10 的 help 行写「仅主人」**：代码从 2026-10-29 起 help 对**任何已通过白名单的人**开放，只是 `buildHelpText()` 按 `owner` / `admin` / `other` 给三份不同列表。该事实在 `qq.safety` 里也记了一次；本单元不重复展开。
- **管理员能否派活**：`功能文档.md` / `对接文档.md` 说管理员「可以聊天、可以让她派活（work_request）、能用 fileget / filesend / receive」；代码的身份判定只负责贴 `ADMIN_MARKER`，`work_request` 的实际闸门在 fish 的工具面与工作区沙箱里，不在本单元的 `senderRole` 里。这是分层实现，不是身份表不一致。
- **管理员名单不自动排除主人**：`setup.js` 写配置时会把主人从 `admins` 里去掉；但 QQ 上的 `admin add <主人QQ>` 不会拒绝（`applyAdminCommand` 只查重复），结果是主人同时在两份名单里。按 `senderRole` 仍算 `owner`，权限不冲突；只是名单显示会重复。T4 可决定是否在写入侧统一去重。

## 不负责

- `isAllowed` / `canUseFileCommand` / help / receive / list 的判定与解析 → 见 `qq.safety`。
- `subsend` 的正则、限流与出站工具 → 见 `qq.subsend`。
- `whitelist` / `admin` 的解析、写回与回复文案 → 见 `qq.whitelist` / `qq.admin`。
- `ownerQQ` / `admins` 的默认值、存储与 clamp → 见 `qq.settings`。
- 来源标记如何进入系统提示词 → 见 `qq.prompt`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-owner-proactive.mjs   # isOwnerSender / senderRole / 来源标记 / 非主人拒绝
node test-whitelist.mjs         # 白名单空时主人仍能加回第一个人
```
