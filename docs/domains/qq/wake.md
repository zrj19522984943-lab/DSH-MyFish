owner: qq.wake
anchors: dsh-fish-qq/qq/index.js#decide
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.wake

本文档是 `qq.wake` 的唯一事实来源：一条 QQ 入站消息进来后，`decide()` 按什么顺序判断「丢弃 / 直回 / 唤醒 / 只记录」。不负责设置项本身、身份判定函数或出站。

## 事实

`decide(msg, s, random = Math.random)` 是纯函数，返回 `{ action, reason }`。`action` 有六种：`drop`、`wake`、`record`，以及不叫模型的直回动作 `whitelist`、`admin`、`help`、`receive`、`list`。

**分支顺序（从上到下，命中即返回）：**

1. **主人 + whitelist 指令**：`isOwnerSender(msg.userId, s.ownerQQ)` 且 `parseWhitelistCommand(msg.text)` 能解析 → `{ action: 'whitelist', reason: 'owner-whitelist' }`。刻意排在白名单判断之前：白名单为空时谁都被 drop，主人必须还能从 QQ 里加回第一个人。
2. **主人 + admin 指令**：主人且 `parseAdminCommand(msg.text)` 能解析 → `{ action: 'admin', reason: 'owner-admin' }`。与上一条同级，管理管理员名单本身只靠 `ownerQQ` 授权。
3. **不在白名单**：`!isAllowed(msg, s)` → `{ action: 'drop', reason: 'not-allowlisted' }`。私聊看 `whitelist`，群聊看 `groupWhitelist`；名单为空 = 全拒（fail-closed）。
4. **help**：`parseHelpCommand(msg.text) !== null` → `{ action: 'help', reason: '<role>-help' }`。只要求已通过白名单；不叫模型，由桥接层按发送者身份直回 `buildHelpText()` 的分档列表。排在会话跟随和 `atOnlyInGroup` 之前。
5. **receive**：`canUseFileCommand(msg.userId, s)` 且 `parseReceiveCommand(msg.text) !== null` → `{ action: 'receive', reason: 'owner-receive' | 'admin-receive' }`。只主人 / 管理员；不叫模型。
6. **list**：`canUseFileCommand(...)` 且 `parseListCommand(msg.text) !== null` → `{ action: 'list', reason: 'owner-list' | 'admin-list' }`。只主人 / 管理员；不叫模型。
7. **会话跟随窗口**：`listeningActive(msg)` → `{ action: 'wake', reason: 'listening' }`。窗口由 `qq_bridge_listen` 工具开启，按目的地 key 与到期时间判断；排在 `atOnlyInGroup` 之前，否则群里的线性对话会被 @ 闸门掐断。
8. **主人 + subsend**：`s.subsendEnabled !== false` 且主人且 `parseSubsendCommand(msg.text) !== null` → `{ action: 'wake', reason: 'owner-subsend' }`。排在 `atOnlyInGroup` 之前；非主人写同样的开头不会被解析成指令。
9. **主人 / 管理员 + 发文件**：`canUseFileCommand(...)` 且 `parseFileCommand(msg.text) !== null` → `{ action: 'wake', reason: 'owner-file' | 'admin-file' }`。同样排在 `atOnlyInGroup` 之前。
10. **群 @ 闸门**：`msg.groupId` 且 `s.atOnlyInGroup` 且 `msg.atSelf !== true` → `{ action: 'drop', reason: 'group-not-at' }`。
11. **戳一戳**：`msg.poke === true && msg.atSelf === true` → `{ action: 'wake', reason: 'poke' }`。戳别人只是记录，不唤醒。
12. **被 @**：`msg.atSelf === true` → `{ action: 'wake', reason: 'at-mention' }`。
13. **命中昵称**：`mentionsNickname(msg.text, s.nicknames)` → `{ action: 'wake', reason: 'nickname' }`。归一化规则：转小写、去掉所有空白、去掉常见中英文标点后做子串匹配；空昵称不参与。
14. **概率唤醒**：`chance = msg.groupId ? s.wakeProbability : (s.privateWakeProbability ?? 1)`。
    - `chance >= 1` → 群聊 `{ action: 'wake', reason: 'probability' }`；私聊 `{ action: 'wake', reason: 'private-always' }`。
    - `random() < chance` → `{ action: 'wake', reason: 'probability' }`。
    - 否则 → `{ action: 'record', reason: 'sampled-out' }`：只进未唤醒缓冲，零模型调用；下一次真正唤醒时作为摘要前缀附上。

`record` 与 `wake` 之后的投递（`delivery=auto|followup|steer`）不在本单元，见 `qq.session`；入站消息如何映射成 `msg` 见 `qq.onebot`。

### 已知偏差

- `dsh-fish-qq/对接文档.md` §9.5 第 2 步写「主人 + help」；代码从 2026-10-29 起是**任何已通过白名单的人**都能发 help，`buildHelpText()` 按 `owner` / `admin` / `other` 给三份不同列表，`reason` 为 `<role>-help`。不是只有主人。
- §9.5 只列了 `whitelist`，漏掉了与它同级的 **`admin`** 直回分支（`admin add/del/list`，仅主人）。代码里 `admin` 分支紧跟在 `whitelist` 之后。
- §9.5 第 5 步写「主人 + fileget/filesend」；代码是**主人或管理员**（`canUseFileCommand`），`reason` 分 `owner-file` / `admin-file`。
- §9.5 第 10 步只写「概率」，没写 `privateWakeProbability >= 1` 时的 `private-always` 分支。私聊默认 `1`，所以默认每条私聊都唤醒，`reason` 不是 `probability`。
- `dsh-fish-qq/qq/DESIGN.md` §2 的流程图（白名单 → 昵称/@ → 概率）是早期版本，漏掉了 help/receive/list/admin/subsend/file 这些「不叫模型或必唤醒」的直回分支；当前顺序以本节为准。

## 不负责

- `isAllowed` / `isOwnerSender` / `canUseFileCommand` / help/receive/list 的解析细节 → 见 `qq.safety`。
- 各设置项的默认值、存储与 clamp → 见 `qq.settings`。
- 会话跟随窗口的状态、固定会话加载与投递方式 → 见 `qq.session`。
- 主人 / 管理员的产品语义与来源标记 → 见 `qq.owner`。
- 唤醒后如何出站 → 见 `qq.outbound`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-smoke.mjs        # 策略分支、出站闸门、设置卡片字段
node test-whitelist.mjs    # 白名单 / 主人加白名单指令
node test-owner-proactive.mjs  # 认主 / 管理员 / 非主人标记
```

逐分支核对时，用 `qq_bridge_simulate`（`dryRun: true`）或 `test-smoke.mjs` 里的 `decide()` 断言；`decide` 的 `random` 参数可注入，便于固定概率分支。
