owner: qq.outbound
anchors: dsh-fish-qq/qq/index.js#normalizeReplyMode; dsh-fish-qq/qq/index.js#outboundGate; dsh-fish-qq/qq/index.js#sendToQQ; dsh-fish-qq/qq/index.js#sendBridgeReply; dsh-fish-qq/qq/index.js#sendSubsendToTarget; dsh-fish-qq/qq/index.js#sendProactiveToOwner; dsh-fish-qq/qq/index.js#extractQQReply
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.outbound

本文档是 `qq.outbound` 的唯一事实来源：QQ 侧的回复怎么从「一轮会话的输出」变成真正发出去的消息，三条 `replyMode` 分支、来源闸门，以及 subsend / 主动私聊等独立出站通道的校验顺序。不负责消息段拼装、入站唤醒判断或台账存储细节。

## 事实

### 三种 `replyMode`

`normalizeReplyMode(raw)` 只认三个值，其他一律回 `'marker'`：

| 值 | turn/end 时发什么 |
| --- | --- |
| `marker`（默认） | 只发 `[QQ]…[/QQ]` 块里的内容；开标记必须位于行首（允许行首空白） |
| `tool` | 标记块整条路关掉，不自动发；要发就调 `qq_bridge_send` / `qq_bridge_send_multi` |
| `always` | 整轮原始回复原样发（技术说明也会进群，慎用） |

`extractQQReply(text)` 用 `/^[ \t]*\[QQ\]([\s\S]*?)\[\/QQ\]/gim` 抽取所有标记块，按出现顺序用空行拼接；没有块返回空串。开标记要求行首，是为了防止正文里「提到 `[QQ]` 这个写法」时把中间整段正文误捕获。

### turn/end 的标记块闸门

一轮结束时按以下顺序判断（任一不满足就静默不发）：

1. **来源**：只发 `fromQQ === true` 的那一轮。DSH 界面里聊出来的标记块一个字都不发。
2. **模式**：`replyMode === 'tool'` 时直接返回，标记块不参与出站。
3. **防重复**：这一轮 `qq_bridge_send_multi` 真的发出去过（`multiSent === true`）时，整个标记块丢弃，避免同一段话发两遍。
4. **取正文**：`always` 用整轮原文，`marker` 用 `extractQQReply()`；空串直接返回。
5. **发送**：`sendToQQ(text, turnDestination ?? undefined)`；成功落 outbox（`via` = `marker` / `always`），被拒落 dropped 台账，并把 `too-long` 等原因回注会话，避免模型以为已经回复。

### `sendToQQ(text, destination, { quote, atQQ })`

普通回复的唯一发送函数：

1. **目的地**：显式传入的 `destination` > `currentTurnDestination`（这一轮被 QQ 唤醒时的目的地）> `state.lastDestination`。没有 `dest.kind` → `{ dropped: true, reason: 'no-destination' }`。
2. **连接**：OneBot 传输未打开 → `not-connected`。
3. **正文**：`stripMarkdown` 为真时先抹掉 Markdown；空串 → `empty`。
4. **长度**：按 Unicode 码点计数（emoji 算 1 个），`> replyMaxChars` → `{ dropped: true, reason: 'too-long', limit, length }`，**整条一条都不发**，由模型缩短后重发。
5. **消息段**：`replyWithQuote && quote && state.lastMessageId` 时先加 `{ type: 'reply', data: { id } }`；再接 `buildMessageSegments(body, { atQQ })`（正文里的 `@QQ号` 转真正的 at 段）。
6. **投递**：群聊 `send_group_msg`（带 `group_id`），私聊 `send_private_msg`（带 `user_id`）；成功后更新 `state.proactive.lastActivityAt` 并保存状态。
7. 返回 `{ sent: 1, dropped: false, destination }`。

### 来源闸门 `outboundGate(action)`

用于 `qq_bridge_send`、`qq_bridge_send_multi`、`qq_bridge_sticker` 这类「模型主动发」的工具：

- `currentTurnFromQQ === true` → 放行（返回 `null`）。
- 否则第一次调用：置 `nonQQConfirmPending = true`，返回 `{ sent: 0, needsConfirm: true, reason: ... }`，**一个字都不发**。
- 同一轮里第二次调用：放行并记日志。`nonQQConfirmPending` 在每轮开始时清零，不跨轮泄漏。
- 不是「检查发起人是谁」；它要的是一次有意识的二次确认。

### 独立出站通道（绕开 `replyMode` 与 `outboundGate`）

这些发送是插件自己发起的，不属于「被 QQ 唤醒那一轮的回复」：

- **`sendBridgeReply(msg, text, via)`**：help / receive / list / whitelist 确认等桥接层直回。发回**本条消息**来的地方（群回群、私聊回私聊），不走 `replyMode`、不判字数、不要求模型写 `[QQ]` 块；成功落 outbox。
- **`sendSubsendToTarget({ targetQQ, message, atQQ })`**：
  1. `subsendEnabled !== true` → `disabled`；传输未开 → `not-connected`。
  2. 目标号不合法 → `bad-target`；目标等于 `selfId` → `self-target`。
  3. 去 Markdown、去空白；空 → `empty`；码点数超 `replyMaxChars` → `too-long`（**拒发**，不截断）。
  4. 过 `shouldSubsend()` 的每日上限与冷却；被拒返回 `daily-limit` / `cooldown`（后者带 `retryInMs`），不占额度。
  5. `send_private_msg` 成功后计数 `state.subsend`、更新 `lastActivityAt`、记日志；失败返回 `send-failed`，不抛错。
- **`sendProactiveToOwner(text)`**：主动私聊。没配 `ownerQQ` → `no-owner`；传输未开 → `not-connected`；正文空 → `empty`；去 Markdown 后空 → `empty`。超长时**截断**到 `replyMaxChars - 1` 个码点再加 `…`（与 subsend 的「拒发」不同：主动私聊没有让模型改短的机会）。成功后 `state.proactive` 计数 +1、落 outbox（`via: 'proactive'`）。
- 发文件（`fileget` / `filesend`）也是独立通道，详见 `qq.files`。

### 已知偏差

- `dsh-fish-qq/对接文档.md` §9.4 说 `tool` 模式「她必须调 `qq_bridge_send`」；代码同时支持 `qq_bridge_send_multi`（1–3 条分条发送）和 `qq_bridge_sticker`，只写 `qq_bridge_send` 不完整。
- §9.4 说超长「一条都不发」；这对 `sendToQQ` / subsend / 标记块成立，但**主动私聊与私人时间出站是截断**（加 `…`），不是拒发。
- §10 把 `outboundGate()` 描述成「只有被 QQ 唤醒、或 DSH 会话发起人本人，才能把消息发出去」；代码不是按发起人身份放行，而是「非 QQ 轮第一次调用只回确认，同一轮第二次才真发」的两步确认。
- §9.4 列了 help/receive/list/whitelist 绕开 `replyMode`，但没列 proactive / 私人时间 / subsend / fileget / filesend 这些同样绕开的通道；它们都以独立函数直调 OneBot。
- `DESIGN.md` §7 写「出站目的地 = 最后一次入站消息的来源」；当前 `sendToQQ` 是三级优先（显式 > 本轮目的地 > 最后一次入站），主动私聊则固定发主人，不适用这条。

## 不负责

- 一条消息该不该唤醒、该走哪个分支 → 见 `qq.wake`。
- 消息段（占位符、图片、表情包、引用、@）的拼装 → 见 `qq.segments`。
- `subsend` 指令的解析与产品语义（谁能在什么时候发） → 见 `qq.subsend`。
- 发文件通道的沙箱与 `upload_private_file` 细节 → 见 `qq.files`。
- outbox / dropped 台账的存储与查询 → 见 `qq.ledger`。
- `replyMode` 等设置的默认值、存储与 clamp → 见 `qq.settings`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-smoke.mjs          # 标记块 / outboundGate / 超长 / 目的地
node test-send-multi.mjs     # 分条发送与防重复
node test-subsend.mjs        # subsend 限流 / 冷却 / 两步确认
node test-owner-proactive.mjs # 主动私聊与主人目标
```

> 本机 Node 24 + 当前 `@deepseek-ai/dsh-tools` 下，`test-send-multi.mjs` 可能在 `sim.execute({ groupId: undefined })` 处报 `ToolArgsError: "arguments" must be a lossless JSON object`；这是测试夹具与工具版本的问题，不是出站逻辑回归（同批 `test-smoke` / `test-subsend` 均通过）。
