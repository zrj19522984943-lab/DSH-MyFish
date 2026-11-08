owner: qq.subsend
anchors: dsh-fish-qq/qq/index.js#parseSubsendCommand; dsh-fish-qq/qq/index.js#shouldSubsend; dsh-fish-qq/qq/index.js#renderSubsendInstruction
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.subsend

本文档是 `qq.subsend` 的唯一事实来源：主人发 `subsend <QQ号> <内容>` 时，桥接层怎么解析、怎么唤醒她、怎么限流，以及她调 `qq_bridge_subsend` 时的出站路径。其他指令族见 `qq.receive` / `qq.list` / `qq.help` / `qq.whitelist` / `qq.admin`；安全闸门汇总见 `qq.safety`。

## 事实

### 指令正则

- 前缀：`SUBSEND_PREFIX = 'subsend'`（可被调用方用 `prefix` 覆盖）。
- 实现：`new RegExp('^' + escapeRegExp(prefix) + '\\s+(\\d{5,12})\\s+([\\s\\S]+)$', 'i')`，对 `trim()` 后的整条消息匹配。
- 必须满足：
  1. 前缀在**开头**（大小写不敏感，首尾空白忽略）；
  2. 前缀后是 **5–12 位数字**的 QQ 号；
  3. 至少一个非空正文字符；正文 `trim()` 后不能为空。
- `subsend` 出现在消息中间不算指令；`帮我 subsend …` 也不算。解析失败返回 `null`，调用方按普通聊天处理。

### 权限档

- **仅主人**（`isOwnerSender`）。
- `decide()` 要求三者同时满足：`s.subsendEnabled !== false` + 主人 + `parseSubsendCommand()` 能解析。
- 非主人写一模一样的 `subsend …`：不是指令，按普通聊天；即使模型想调 `qq_bridge_subsend`，工具层还会检查 `currentTurnFromOwner`，非主人轮次直接拒绝（`reason: 'not-owner'`，一个字不发）。
- 非 QQ 轮（DSH 界面发起）第一次调工具只回 `needsConfirm: true`，同一轮第二次才发。

### 是否唤醒模型

**是。** `decide()` 返回 `{ action: 'wake', reason: 'owner-subsend' }`；`renderSubsendInstruction()` 把目标 QQ 与原文附在该轮正文后，模型负责润色并调 `qq_bridge_subsend`。目标 QQ 由桥接层固定，模型**不许改**。

### 是否进缓冲

**否。** 只有 `action === 'record'` 的消息才 `state.buffer.push()`；`subsend` 是 `wake`，它本身不进入未唤醒缓冲。唤醒时会带上此前的 `bufferSnapshot` 作为「未唤醒期间聊天记录」摘要，发送成功后按快照清掉。

### outbox 的 via 值

- 成功发送：`via: 'subsend'`，`sessionId: 'tool:qq_bridge_subsend'`，带 `nonQQTurn`（是否非 QQ 轮）与目标。
- 被拒（限流 / not-owner / too-long / bad-target / send-failed）：进 **dropped** 台账，`via: 'subsend'`，不落 outbox。
- 工具本身不经过 `replyMode` / `outboundGate`，是独立出站通道。

### 每日上限 / 冷却

- `SUBSEND_DEFAULTS`：`enabled: true`、`dailyLimit: 20`、`cooldownSeconds: 20`。
- `shouldSubsend()` 顺序：
  1. `enabled !== true` → `disabled`；
  2. `dailyLimit <= 0` → `limit-zero`；
  3. 跨天计数归零；`used >= dailyLimit` → `daily-limit`；
  4. `cooldownSeconds > 0` 且距 `lastAt` 不足 → `cooldown`，带 `retryInMs`；
  5. 否则 `{ allow: true, reason: 'ok' }`。
- **只有真的发出去才计数**：`sendSubsendToTarget()` 成功后才写 `state.subsend = { dayKey, count: used+1, lastAt }`；被拒（含超长、限流）不占额度。
- 超长按去 Markdown 后的码点数判断，超过 `replyMaxChars` → `too-long`，**拒发**（不截断），由模型缩短后重试。
- 目标等于 `selfId` → `self-target`；目标不是 5–12 位数字 → `bad-target`。

### 已知偏差

- **`renderSubsendInstruction` 的正文截断**：桥接层把 `message` 截到 `MAX_INBOUND_CHARS = 4000` 再附给模型；`功能文档.md` / `对接文档.md` 只写「主人点名把一段话发给指定 QQ」，没有提 4000 字上限。这是入站正文的统一上限，不是 `subsend` 专属。
- **「每日 20 条」的口径**：文档写每日上限 20；代码 `shouldSubsend()` 的计数按 `dayKeyOf()` 本地日历跨天归零，且**只统计成功发送**。被 `cooldown` 拒的那次不占额度，也不更新 `lastAt`。
- **非 QQ 轮的二次确认**：`对接文档.md` §5.3 只写「主人专用」；代码在 DSH 界面发起的那一轮还会多一道 `nonQQSubsendConfirmPending` 二次确认（第一次只回确认、第二次才发），与 `qq_bridge_send` 同款但计数变量独立。
- **`subsendEnabled !== false` 的缺省**：`decide()` 用的是 `!== false`，不是 `=== true`；`readSettings()` 默认给 `true`，所以正常路径等价。手写设置文件时若缺这个键，仍按开启处理。
- **原文档的指令表位置**：T3 任务书说「对接文档 §6.9 指令表」「qq README §3.9 指令表」，但当前两份文件里都没有对应编号的指令表——`对接文档.md` 的 §6 是「事件与宿主钩子」，`qq/README.md` 没有 §3.9。实际存在的是 `功能文档.md` §6.9 的指令表，已替换为 L1 链接；`对接文档.md` / `qq/README.md` 各自新增了一个 `6.9` / `3.9` 的「指令一览」索引段，只放链接、不放事实。

## 不负责

- `decide()` 的完整分支顺序、白名单/主人/管理员判定 → 见 [qq.safety](safety.md) / [qq.wake](wake.md)。
- `sendSubsendToTarget()` 的 OneBot 发送、`too-long` 判定与计数写入 → 见 `qq.outbound`。
- `subsendEnabled` / `subsendDailyLimit` / `subsendCooldownSeconds` 的默认值与存储 → 见 `qq.settings`。
- `qq_bridge_subsend` 在工具清单里的位置 → 见 `qq.tools`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-subsend.mjs
```

重点断言：`subsend <5–12位QQ> <正文>` 才解析；非主人同样开头不解析；`enabled/limit-zero/daily-limit/cooldown` 四种拒绝；只有成功才计数；超长拒发；非 QQ 轮第一次只回确认、第二次才发；not-owner 拒绝。
