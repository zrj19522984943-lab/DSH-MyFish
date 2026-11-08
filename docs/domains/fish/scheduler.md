owner: fish.scheduler
anchors: dsh-fish-qq/fish/lib/scheduler.js
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.scheduler

本文档是 `fish.scheduler` 的唯一事实来源：生物钟每分钟 tick、每天醒几次、事件/提问配额、叫醒时间窗、刷站窗口与风险检查。具体刷站内容归 `fish.bili`。

## 事实

- `startScheduler(ctx, deps)`：每分钟 tick（`TICK_MS = 60_000`），启动后延迟 `INITIAL_DELAY_MS = 20_000` 先跑一次；停用插件时随 ctx 回收。
- 每次 tick：读配置/事件 → `detectAbsence()` 冷落检测 → `ensureSchedule()` 为当天挑一个叫醒时刻（`pickWakeTime`，按本地时区，跨零点窗口按 `inWindow` 处理）→ 在窗口内才继续。
- 配额：
  - `wakesPerDay`（0–4，默认 1）每天最多主动醒几次；
  - `daily.events`（0–6，默认 2）每天推进几条成长事件；
  - `daily.questions`（0–6，默认 1）其中提问上限；
  - `browse.perDay`（0–4，默认 1）每天刷几次 B 站，与事件配额分开算。
- `plan(model, config, counts, events, ...)` 决定今天是否该醒、该不该生成事件；`gapSqueeze` 按冷落天数调整节奏。
- 叫醒超时 `WAKE_TIMEOUT_MS = 5 * 60_000`；刷站报告最长等 `REPORT_WAIT_MS = 90_000`；`WAKE_HINT` 只给一句「括号里的短句不是用户说的」，不塞任务清单。
- 刷站前会 `riskState()` 检查风控；`noteRisk()` 记录；`recordBrowse()` 落配额；失败只记日志，不影响下一次 tick。
- 时间判断全部走本地时区；`settings.inWindow` / `dateKey` / `pickWakeTime` 是唯一口径。

## 不负责

- 成长阶段、事件模板、`growth_commit` → 见 `fish.growth`。
- B 站接口、选题、评论、风控细节 → 见 `fish.bili`。
- 她醒来后说什么、身份段 → 见 `fish.identity` / `fish.say`（T4 后 say 并入 identity/persona 相关单元）。
- QQ 侧唤醒策略 → 见 `qq.wake`。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test --test-isolation=none
```
重点断言：tick 周期、叫醒窗口、每日配额、冷落挤压、刷站风险检查、失败不打断后续 tick。
