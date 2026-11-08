owner: qq.idle
anchors: dsh-fish-qq/qq/idle-trigger.js
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.idle

本文档是 `qq.idle` 的唯一事实来源：「私人时间 / 自主待机」的判定、抽签、注入文案、Ghost Mode 出站与每日额度。主动私聊归 `qq.proactive`。

## 事实

- `IDLE_TRIGGER_DEFAULTS`：`enabled:false`（默认关）、`scanIntervalMinutes:30`、`minIdleHours:2`、`dailyMax:3`、`weights:{silent:80,message:10,browse:5,diary:5}`。
- `shouldFireIdleTime()` 顺序：开关 → 空闲是否够 `minIdleHours` → 跨天归零后 `dailyMax`（**silent 不计入**）→ 扫描间隔冷却。命中后才抽签。
- `pickIdleAction(weights)`：按权重抽 `silent` / `message` / `browse` / `diary`；权重全 0 退回 `silent`。`silent` 必须占绝对优势：默认 80/100，什么都不做、零 token。
- `IDLE_PICKS = ['silent','message','browse','diary']`；`IDLE_FORCE_PICKS = ['message','browse','diary']`（`qq_bridge_idle` 调试用，`silent` 没有强制主张）。
- 命中非 silent 时 `buildIdleTriggerText()` 投一段 `[系统：私人时间]` **处境**提示：真实本机时间/时段、多久没人来找她、几件可以做的事（抽到的排最前）。不是任务清单。
- **Ghost Mode**：这一轮默认一个字都不发 QQ；她回 `[IDLE]`、写日记、刷 B 站都静默；只有明确写 `[QQ]…[/QQ]` 或调 `qq_bridge_send` 才发。她做了什么照常进自己的 `events.jsonl` / `diary/`。
- 与主动私聊各扫各的、各算各的额度；唯一交集是同一时刻只能有一轮在跑。`IDLE_TURN_STALE_MS = 15 分钟`。
- 调试工具 `qq_bridge_idle`：`status` / `scan` / `force`（`force` 可指定 `message`/`browse`/`diary`，跳过冷却、不破每日上限）。

## 不负责

- 主动私聊的空闲/概率/每日上限 → 见 `qq.proactive`。
- `idleTrigger*` 设置默认值与 clamp → 见 `qq.settings`。
- 她刷 B 站/写日记的具体执行 → 见 `fish.bili` / `fish.identity`。
- 入站唤醒 → 见 `qq.wake`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-idle-trigger.mjs
```
重点断言：默认关、silent 不占额度、权重抽签、每日上限、扫描冷却、Ghost Mode 默认不出站、`[QQ]` 块才发、`qq_bridge_idle` 三动作。
