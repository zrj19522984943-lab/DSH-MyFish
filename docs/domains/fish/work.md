owner: fish.work
anchors: dsh-fish-qq/fish/lib/work.js
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.work

本文档是 `fish.work` 的唯一事实来源：`work_request` 怎么在工作区新开一条会话派活、每日上限/去重/防泄密，以及任务完成日志的接线。任务日志内容归 `fish.checklog`。

## 事实

- 工具名 `work_request`；参数 `task`（必填，最长 `MAX_TASK = 4000` 字）。
- 流程：`dispatchWork(ctx, task, deps)`：
  1. 空任务 / 超长 / `looksLikeSecret(text).hit` → 拒绝并说明原因；
  2. `config.work.enabled === false` → 不派；
  3. 工作目录优先级：`deps.workspaceRoot` → `config.work.dir` → `defaultWorkDir()`（环境变量 `DSH_FISH_WORK_DIR`）；
  4. 每日上限 `config.work.perDay`（默认 3）——`dispatchedToday(events, dk)` 按当天事件计数；
  5. 去重 `DEDUPE_MS = 120_000`：同一 `taskHash`（sha1 前 8 位）在 2 分钟内不重复派；
  6. `sessionController.create` 开新会话，标题 `workTitle()`（`工作·…`）；
  7. 用 `createTaskWatcher()` 盯这条会话的 `turn/end`，结束后 `writeTaskLogAndAnnounce()` 写 `CheckLogs/` 并 emit `checklog/finished`。
- 她没有写文件/跑命令的手；派出去的工作会话有完整工具，做的是「工作」，不是她的人格。
- `work.request` / 派活结果只进工作区会话，不改变她的成长事件流；失败只回一句原因，不抛。
- 工具清单与三把刀见 `fish.tools`。

## 不负责

- CheckLogs 的文件名/内容/2 小时超时 → 见 `fish.checklog`。
- 工作区根解析 → 见 `fish.readfile` / `merge` 相关单元。
- 日程/配额（非 work.perDay）→ 见 `fish.scheduler`。
- QQ 侧主人/管理员权限 → 见 `qq.owner`。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test test/worklog.test.mjs
```
重点断言：4000 字上限、防泄密拒绝、每日上限、2 分钟去重、工作区不存在时如实说、任务结束写 CheckLogs 并 emit。
