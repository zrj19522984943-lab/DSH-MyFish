owner: fish.checklog
anchors: dsh-fish-qq/fish/lib/checklog.js#TASK_LOG_TIMEOUT_MS; dsh-fish-qq/fish/lib/checklog.js#defaultCheckLogsDir; dsh-fish-qq/fish/lib/checklog.js#renderTaskLog; dsh-fish-qq/fish/lib/checklog.js#writeTaskLog; dsh-fish-qq/fish/lib/checklog.js#buildTaskResult; dsh-fish-qq/fish/lib/checklog.js#writeTaskLogAndAnnounce; dsh-fish-qq/fish/lib/checklog.js#createTaskWatcher
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.checklog

本文档是 `fish.checklog` 的唯一事实来源：`work_request` 派出去的任务结束后，`CheckLogs/` 里的 `.md` 什么时候写、写什么、文件名叫什么、怎么写成功后发 `checklog/finished`，以及 2 小时超时。QQ 侧收到事件后怎么通知归 `qq.checklog`。

## 事实

### 目录与文件名

- `defaultCheckLogsDir()`：`DSH_FISH_CHECKLOGS_DIR` 环境变量优先；否则 `<包根>/CheckLogs`。
  - 路径由 `LIB_DIR`（`fish/lib/`）往上两级得到：合并包是 `dsh-fish-qq/CheckLogs/`，单独安装 `dsh-fish` 时是 `dsh-fish/CheckLogs/`。
  - 日志跟着**插件目录**走，不跟派活的工作区走；这样派到别的目录也能在包旁边找到。
- 文件名：`YYYYMMDD-HHmmss-<task sha1 前 8 位>.md`（本地时间）；同一秒、同一任务碰撞时再加 `-<4 位随机>`，不覆盖。
- 一个任务一个文件；失败 / 中止 / 出错 / 超时也写——日志的意义是事后能看出哪次没做成。

### 写什么

`renderTaskLog({ task, title, sessionId, startedAt, endedAt, status, note })` 输出：

```markdown
# 任务完成日志

- 结果：成功（或 失败（…）/ 中止（…）/ 超时（…））
- 任务：<task，空白折成一行>
- 会话：<title>            （有才写）
- 会话编号：<sessionId>     （有才写）
- 派发时间：YYYY-MM-DD HH:mm:ss
- 结束时间：YYYY-MM-DD HH:mm:ss
- 耗时：X 秒 / X 分 Y 秒 / X 小时 Y 分

<!-- 由 dsh-fish 自动写入：一个任务一个文件。不抄她的回复正文。 -->
```

**不抄她的回复正文**；只记结果、任务、会话、时间、耗时。

### `writeTaskLog()`

- `dir` 缺省用 `defaultCheckLogsDir()`；空则返回空串。
- `mkdir(dir, { recursive:true })` 后写文件；**永不抛**，失败返回空串（日志写不出来不能带崩派活）。
- 返回写成功的绝对路径，或 `''`。

### `buildTaskResult()` 与事件载荷

`buildTaskResult({ kind, ok, task, title, sessionId, startedAt, endedAt, status, file })` 返回：

```js
{
  ok: boolean,          // 只有传入严格 true 才为 true；缺省按失败（fail-safe）
  reason: string,       // 宿主 turn/end 的 reason.kind
  task, sessionTitle, sessionId, status,
  startedAt: number, endedAt: number,
  elapsedMs: number,    // max(0, endedAt - startedAt)
  file: string          // 日志路径
}
```

这是 fish 与 QQ 之间**唯一约定**的载荷形状；fish 不 import qq，两边只共享 `'checklog/finished'` 这个事件名。

### `writeTaskLogAndAnnounce()`

1. 先 `writeTaskLog()`；
2. 文件为空（写失败）→ `{ file:'', announced:false, result:null }`，**不 emit**；
3. 写成功 → `buildTaskResult()`，若 `ctx.emit` 存在则 `ctx.emit('checklog/finished', result)`，`announced:true`；emit 抛错只记日志，`announced:false`；
4. 没人监听也算「发出去」（`announced:true`），与「有没有人收」无关。

「先写后喊、只有写成功才喊」的理由：日志是事实，通知是衍生物；写失败还喊，等于让 QQ 去通知一件没留下痕迹的事。

### 等待一轮结束：`createTaskWatcher()`

- 参数：`{ sessionId, onDone, timeoutMs = TASK_LOG_TIMEOUT_MS, log }`。
- 没有 `sessionId` 或 `ctx.on` 不可用 → 返回 `null`，调用方按「没有日志」处理，不报错。
- 监听 `session/event`：`session.header.id ?? session.id` 必须等于目标 `sessionId`；`turn/end` 时 `finish(event.data.reason.kind ?? 'unknown')`。
- `finish()` 只跑一次（`done` 守卫）：清理定时器与监听，然后 `Promise.resolve(onDone({ kind, ...describeTurnEnd(kind) }))`；`onDone` 抛错/异步失败只记日志，不让 watcher 崩。
- **超时兜底**：`TASK_LOG_TIMEOUT_MS = 2 * 60 * 60 * 1000`（2 小时）；到点 `finish('timeout')`，即使会话卡住也会留下一条「超时」日志。定时器 `unref()`，不阻止进程退出。
- 返回 `{ cleanup, get done }`；`cleanup()` 可提前注销。

### `describeTurnEnd()` 的状态映射

| 宿主 `reason.kind` | 日志 status | ok |
| --- | --- | --- |
| `completed` | 成功 | true |
| `max-tokens` | 失败（输出太长被截断） | false |
| `aborted` | 中止（被取消） | false |
| `interrupted` | 中断（被取消） | false |
| `blocked` | 失败（被拦下） | false |
| `error` | 失败（出错） | false |
| `forked` | 结束（分叉） | false |
| `timeout` | 超时（没等到这一轮结束） | false |
| 其他 | `结束（<kind>）` | false |

### 边界

- 监听的是**本进程**的 `session/event`。DSH 在任务跑完前重启、或插件被停用，这一次就没有日志——不事后补写、不扫描旧 `CheckLogs/` 补发。
- `work_request` 派出任务时创建 watcher；任务结束的 `turn/end` 触发 `onDone`，`onDone` 里再调 `writeTaskLogAndAnnounce()`。派活本身的参数与工具闸门归 `fish.workspace` / `merge.tools`。

### 已知偏差

- **目录名**：`功能文档.md` §5.5 写「在 `dsh-fish-qq/CheckLogs/` 里写」；代码是 `<包根>/CheckLogs`。合并包里包根就是 `dsh-fish-qq/`，所以一致；**单独安装 `dsh-fish`** 时是 `dsh-fish/CheckLogs/`，不是 `dsh-fish-qq/`。用 `DSH_FISH_CHECKLOGS_DIR` 可覆盖。
- **文件名碰撞**：`对接文档.md` §7.3 只写 `YYYYMMDD-HHmmss-<sha1 8>.md`；代码在同一秒同一任务碰撞时还会加 `-<4 位随机>`。这是补充，不改变命名主格式。
- **`ok` 的缺省**：`对接文档.md` §7.3 说「载荷字段 buildTaskResult」；代码 `buildTaskResult()` 的 `ok` 只有严格 `true` 才为 true，缺省/信息不全按失败。这是有意的 fail-safe，文档没展开。
- **超时时间**：`功能文档.md` §5.5 写「两小时等不到结束会记超时」；代码 `TASK_LOG_TIMEOUT_MS = 2 * 60 * 60 * 1000`，一致。调用方可通过 `timeoutMs` 覆盖，但默认 2 小时。
- **`describeTurnEnd` 的 `forked`**：`对接文档.md` §6 说 `forked` 只出现在种子变体里；`checklog` 把它记成「结束（分叉）/ ok:false」，不当作失败原因去重试。这是日志口径，不是行为冲突。

## 不负责

- QQ 侧收到 `checklog/finished` 后按 `checklogNotifyMode` 发通知、限流与目标选择 → 见 `qq.checklog`。
- `work_request` 怎么派活、工作区选择与每日上限 → 见 `fish.workspace`（或 `merge.tools` 的工具面）。
- 对话原文记忆与 `seq_id` → 见 `fish.memory`。
- 换会话的摘要与轮换 → 见 `fish.handoff`。
- `CheckLogs/` 的历史文件清理/归档 → 不在本单元；代码只写不扫。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test test/checklog.test.mjs test/worklog.test.mjs
```

重点断言：文件名格式与 sha1 前 8 位、同秒碰撞不覆盖、正文包含结果/任务/会话/时间/耗时且不抄回复、写失败返回空串不抛、写成功才 emit `checklog/finished`、`buildTaskResult` 的 `ok`/`elapsedMs`/`file` 形状、watcher 只认目标 sessionId、`turn/end` 只 finish 一次、2 小时超时写 `timeout`、没有 `ctx.on` 时返回 `null`。
