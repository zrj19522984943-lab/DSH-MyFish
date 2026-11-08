owner: qq.state-file
anchors: dsh-fish-qq/qq/index.js
版本核对: dsh-fish-qq@2.0.0 / qq@0.1.18

# qq.state-file

本文档是 `qq.state-file` 的唯一事实来源：`$DSH_HOME/qq-bridge-state.json` 的形状、加载/保存、环形上限与启动基线。设置文件归 `qq.settings`。

## 事实

- 路径：`config.statePath` 或 `$DSH_HOME/qq-bridge-state.json`（`statePath` 空时）。
- 顶层字段：
  - `buffer`（未唤醒聊天，上限 200，单条最多 500 字）
  - `log`（唤醒/丢弃日志，上限 200）
  - `outbox`（真发出去的台账，上限 50）
  - `dropped`（被拒出站，上限 20）
  - `lastDestination` / `lastMessageId`（最近目的地/消息）
  - `listening`（会话跟随窗口 `{key,until,setAt}`）
  - `proactive`（dayKey/count/lastActivityAt/lastAt）
  - `subsend`（dayKey/count/lastAt）
  - `fileSend`（dayKey/count/lastAt/base64）
  - `checklogNotify`（dayKey/count/lastAt）
  - `idleTrigger`（dayKey/count/quiet/lastActivityAt/lastAt/recent）
  - `interaction`（file/offset）
- `loadState()` 容错：文件缺失/坏 JSON 只跳过逐段加载，但**启动基线**（proactive/idleTrigger 的 `lastActivityAt`）仍会打，避免 fresh 安装永远 `no-activity-yet`；数组按各自上限 `slice(-MAX)`。
- `saveState()`：`mkdir` 后写 `.tmp` 再 `rename`（原子），失败只记日志，不影响对话。
- 状态文件与设置文件同目录；`statePath` 变了，`qq-bridge-settings.json` 也跟着变（见 `qq.settings`）。
- 重启后「今天发了几条 / 上次何时发」仍有效；这是主动私聊、subsend、私人时间、checklog 通知的计数依据。

## 不负责

- `qq-bridge-settings.json` 的 55 项设置 → 见 `qq.settings`。
- 缓冲/日志/台账的语义与出站闸门 → 见 `qq.outbound` / `qq.wake`。
- 主动私聊/私人时间的判定 → 见 `qq.proactive` / `qq.idle`。
- 文件发送的路径沙箱 → 见 `qq.fileget`。

## 验收

```powershell
cd dsh-fish-qq/qq
node test-smoke.mjs
```
重点断言：默认字段、数组上限、坏 JSON 容错、原子保存、启动基线、`lastDestination`/`listening` 持久化。
