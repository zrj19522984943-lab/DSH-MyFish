owner: qq.checklog-notify
anchors: dsh-fish-qq/qq/checklog-notify.js
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.checklog-notify

本文档是 `qq.checklog-notify` 的唯一事实来源：fish 写成任务日志后，QQ 侧按 `checklogNotifyMode` 怎么发、发给谁、怎么限流。日志本身归 `fish.checklog`。

## 事实

- 触发：fish 的 `checklog/finished` 事件（只有日志**写成功**才 emit）；载荷 = `buildTaskResult()` 的字段。
- 模式：`checklogNotifyMode` = `off`（默认，不说）/ `system`（插件发模板）/ `agent`（投「处境」让她自己说，没说退回模板）。
- `shouldNotifyChecklog({mode,onSuccess,status,dailyLimit,dayKey,todayKey,usedCount})`：
  1. mode 不是 system/agent → `mode-off`；
  2. 失败/超时/异常必发；成功要看 `checklogNotifyOnSuccess`；
  3. `dailyLimit <= 0` → `limit-zero`；跨天归零；`used >= dailyLimit` → `daily-limit`。
- `resolveNotifyTarget({target,ownerQQ,lastDestination})`：`owner` → 主人私聊；`last` → 最近有往来的目的地（群/私聊），没有则回落主人。
- 文案：`buildChecklogNotifyText(result)` 生成 `[任务通知] … 完成了 / 失败了 / 超时了`；`buildChecklogSituationText(result)` 生成给她的「活儿有结果了」处境。
- `createChecklogNotifier(deps)` 是发出口：system 档直发；agent 档把处境投给她，她没说就退回模板；超长按 `replyMaxChars` 截断；不发就记 reason。
- 两档共用同一道门禁与计数；`checklogNotifyDailyLimit` 默认 5、`checklogNotifyTarget` 默认 `owner`。

## 不负责

- 任务日志文件/`buildTaskResult`/2 小时超时 → 见 `fish.checklog`。
- `checklogNotify*` 设置默认值与存储 → 见 `qq.settings`。
- 出站通道/`replyMode` → 见 `qq.outbound`。
- 私聊目标解析 → 见 `qq.state-file` / `qq.outbound`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-checklog-notify.mjs
```
重点断言：off/system/agent 三档、成功开关、失败必发、每日上限、owner/last 目标、agent 不说话退回模板、超长截断。
