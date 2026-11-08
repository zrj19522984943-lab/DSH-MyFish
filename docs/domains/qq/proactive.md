owner: qq.proactive
anchors: dsh-fish-qq/qq/index.js#shouldProactivelyMessage; dsh-fish-qq/qq/index.js#proactivePromptText
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.proactive

本文档是 `qq.proactive` 的唯一事实来源：不定时主动私聊的开关、空闲判据、概率、每日上限、扫描间隔与出站方式。私人时间（自主待机）归 `qq.idle`。

## 事实

- `PROACTIVE_DEFAULTS`：`enabled:false`、`idleHours:4`、`probability:0.15`、`dailyLimit:3`、`scanIntervalMinutes:30`。
- `shouldProactivelyMessage()` 顺序：
  1. `enabled !== true` → `disabled`；
  2. `ownerQQ` 为空 → `no-owner`；
  3. 传输未开 → `not-connected`；
  4. `dailyLimit <= 0` → `limit-zero`；跨天计数归零；`used >= limit` → `daily-limit`；
  5. `lastActivityAt` 为 0 → `no-activity-yet`；空闲不足 `idleHours` → `not-idle`；
  6. 距上次主动私聊不足 `scanIntervalMinutes` → `cooldown`；
  7. `random() >= probability` → `sampled-out`；否则 `hit`。
- 命中后 `proactivePromptText(idleHours)` 投一段「处境」提示，不写任务清单；她那一轮说的话由 `sendProactiveToOwner()` 直接私聊主人。
- **独立出站**：绕开 `replyMode` / `outboundGate`；`sendProactiveToOwner()` 检查 owner、传输、空正文；超长**截断**到 `replyMaxChars`（加 `…`）而不是拒发；成功写 `state.proactive` 计数与 outbox `via:'proactive'`。
- 与私人时间的区别：主动私聊 = 她想找主人说一句，直接发；私人时间 = 没人找她，给她自己的时间，默认不发（见 `qq.idle`）。
- 同一时刻只允许一轮在跑；`PROACTIVE_TURN_STALE_MS = 15 分钟`，超时按丢失处理。

## 不负责

- 私人时间抽签/Ghost Mode → 见 `qq.idle`。
- `proactive*` 设置默认值与存储 → 见 `qq.settings`。
- `sendProactiveToOwner` 的通用出站细节 → 见 `qq.outbound`。
- 入站唤醒策略 → 见 `qq.wake`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-owner-proactive.mjs
```
重点断言：五种拒绝原因、跨天归零、空闲/冷却、概率注入、超长截断、outbox `via=proactive`、同一时刻单轮。
