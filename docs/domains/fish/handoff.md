owner: fish.handoff
anchors: dsh-fish-qq/fish/lib/handoff.js#HANDOFF_TIMEOUT_MS; dsh-fish-qq/fish/lib/handoff.js#FALLBACK_TURNS; dsh-fish-qq/fish/lib/handoff.js#collectRecentTurns; dsh-fish-qq/fish/lib/handoff.js#summarizeWithModelPool; dsh-fish-qq/fish/lib/handoff.js#summarizeWithLlm; dsh-fish-qq/fish/lib/handoff.js#fallbackHandoffText; dsh-fish-qq/fish/lib/handoff.js#generateHandoff; dsh-fish-qq/fish/lib/handoff.js#renderHandoff; dsh-fish-qq/fish/lib/home.js#HANDOFF_PENDING_MAX_MS; dsh-fish-qq/fish/lib/home.js#waitHandoffReady; dsh-fish-qq/fish/lib/home.js#maybeRotate; dsh-fish-qq/fish/lib/rotation.js#createRotationHandler
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.handoff

本文档是 `fish.handoff` 的唯一事实来源：聊满多少轮换会话、换房与摘要的先后顺序、五个时间/轮数阈值、失败时怎么用原话兜底，以及 QQ 轮怎么参与计数。原文落盘归 `fish.memory`。

## 事实

### 五个关键数字（每个都标了代码出处）

| # | 数字 | 含义 | 代码出处 |
| --- | --- | --- | --- |
| 1 | **10 秒** | 摘要生成的硬超时：`HANDOFF_TIMEOUT_MS = 10_000`；`maybeRotate` 把它作为 `generateHandoff` 的 `timeoutMs`，外面还有一层 `+500ms` 的 `Promise.race` | `fish/lib/handoff.js` 的 `HANDOFF_TIMEOUT_MS`；`fish/lib/home.js` 的 `maybeRotate()` 里 `timeoutMs: HANDOFF_TIMEOUT_MS` |
| 2 | **14 秒** | 看门狗：`setTimeout(..., HANDOFF_TIMEOUT_MS + 4_000)`，到点若占位还挂着且仍是本次换出的会话，就用兜底正文 `finalizeHandoff` 放行 | `fish/lib/home.js` 的 `maybeRotate()`：`HANDOFF_TIMEOUT_MS + 4_000` |
| 3 | **12 秒** | 新房间第一条消息等待提要的上限：`waitHandoffReady(..., { timeoutMs = 12_000 })` | `fish/lib/home.js` 的 `waitHandoffReady()` 默认参数 |
| 4 | **30 秒** | 陈旧占位阈值：`HANDOFF_PENDING_MAX_MS = 30_000`；超过就立即放行并写回 `handoffPending:false` | `fish/lib/home.js` 的 `HANDOFF_PENDING_MAX_MS` |
| 5 | **4 轮** | 模型失败时兜底用的最近原话轮数：`FALLBACK_TURNS = 4`；`fallbackHandoffText()` 取 `turns.slice(-4)` | `fish/lib/handoff.js` 的 `FALLBACK_TURNS` / `fallbackHandoffText()` |

### 什么时候换

- 计数源是 `home.json` 的 `turns`；阈值是 `config.chat.rotateAfter`（0 = 关闭）。`maybeRotate()` 在 `turns >= after` 时触发。
- `say.js` 每轮 `bumpTurns` 后调 `maybeRotate`；QQ 轮由 `rotation.js` 的 `createRotationHandler()` 处理：
  - 只认正文带 `[QQ · ` 前缀的轮（`QQ_INBOUND_MARK`）；
  - 原话先 `addExchange()` 进 `talkmem`（换房后的 carry 才有内容）；
  - `bumpTurns(root, 1)` 后**立刻** `maybeRotate`（不防抖，保证下一句到达前换完）；
  - 唤醒轮不算「聊了一轮」；任何失败只记日志，不影响回话。
- 同一 root 用 `rotating` 集合防重入；换房失败返回 `{ rotated:false, reason:'failed' }`。

### 顺序：先换房，再摘要，用占位挡住第一条消息

1. **先换房**：`rotateTalkSession()` 创建新会话，`home.json` 立刻指向新会话，并写 `handoffPending: true`（`chat.handoff.enabled !== false` 时）。
2. **再摘要**：`generateHandoff()` 生成《近期剧情提要》，写 `<root>/home/handoff.md` 可读副本，再 `finalizeHandoff()` 写进 `home.json` 并放掉占位。
3. **第一条消息等待**：新房间的第一条消息在 `prompt` 前调 `waitHandoffReady()`，最多等 12 秒；读到 `handoffPending:false` 才继续，保证 system prompt 的 `fish:handoff` 段已经有内容。
4. **看门狗兜底**：14 秒到点，若 `handoffPending` 还挂着且 sessionId 仍是本次换出的会话，用 `fallback()` 正文强制放行；`finalizeHandoff()` 幂等，看门狗与主流程谁先谁后都不会覆盖已落盘的真提要。
5. **启动清理**：进程启动时若发现上次崩溃留下的 `handoffPending:true`，直接写回 false（`进程重启，交接中断`）。

### 摘要生成

`generateHandoff(root, opts)`：

1. `collectRecentTurns(root, 30)`：从 `memory/raw_*.jsonl` 按 `ts` / `seq_id` 排序，user + assistant 配成一轮，取最近 `HANDOFF_TURNS = 30` 轮；`renderTranscript()` 每条最多 400 字、全文最多 9000 字。
2. 若 `chat.handoff.enabled === false`，直接返回 `ok:false`（不生成）。
3. **模型池优先**：`loadModelPool()` 读 `$DSH_HOME/qq-bridge-settings.json` 的 `values.modelPool`（或调用方传入的数组），固定 3 槽；`pickModelPoolSlot()` 取第一个 `enabled && apiUrl && apiKey && modelName` 的槽位。
   - 槽位请求硬上限 `MODEL_POOL_TIMEOUT_MS = 10_000`；实际预算 = `min(10s, 总 deadline - now - HOST_FALLBACK_RESERVE_MS(2s))`，给宿主 llm 留至少 2 秒。
   - 请求体强制关闭思考（`reasoning_effort: 'low'` / `thinking:{type:'disabled'}` / `enable_thinking:false` 几种变体）；正文预算 `MODEL_POOL_MAX_TOKENS = 800`。
   - 失败/超时/空正文 → `ok:false`，继续走宿主 llm。
4. **宿主 llm 兜底**：`pickHostSelection()` 顺序是 `chat.handoff.provider/model` → `agentDefaultModel.currentSelection()` → provider 列表里名字带 `flash|mini|cheap|small|fast` 的第一个 → 第一个可用模型；`pickLowestEffort()` 从 `resolveModelInfo().reasoning.efforts` 里挑 `none/off/minimal/low/medium/high/max` 中最低的一档（默认 high 会把预算全烧在思考上、正文为空）。
   - 第一次 `FIRST_MAX_TOKENS = 2500`；只有空正文且 `finish` 是 `length` / `max-tokens` / `max_tokens` 才用 `RETRY_MAX_TOKENS = 6000` 再试一次。
   - 两次共用同一个 deadline（`HANDOFF_TIMEOUT_MS = 10s`）；到点 `AbortController.abort()`，不再等模型。
5. **失败兜底**：`fallbackHandoffText(turns, maxChars)` 取最近 `FALLBACK_TURNS = 4` 轮，每轮 user / assistant 各截 100 字，`cleanSummary()` 压成一段；一条原话都没有就返回 `FAILED_HANDOFF_TEXT = '记忆交接失败，请调用 fish_search_history 查找之前的记忆'`。
6. **提要正文**：`cleanSummary()` 去掉模型自带的标题、引号、`提要：` 前缀，压成一行，按 `maxChars`（默认 300，夹 80–800）截断；`renderHandoff()` 包成
   `[系统：你刚刚搬到了新房间，这是你之前的记忆提要：…。如果忘记更早的事，请调用 fish_search_history。]`

### 提要在 system prompt 里的生命周期

- `home.json` 的 `handoff` 正文由 `identity.js` 的 `fish:handoff` 段（order 900）每轮同步求值；外壳由 `renderHandoff()` 生成。
- 有效期与 carry 同一把尺：**8 轮或 3 天**，谁先到算谁（`CARRY_TURNS = 8`、`CARRY_DAYS = 3`）；`activeHandoff()` / `activeHandoffBlockSync()` 过期返回空串，等于这一段不存在。不是永久人设。
- `activeHandoffBlockSync()` 用 `readFileSync`（system prompt 同步求值），读不到/坏 JSON 返回空串，永不抛。

### `waitHandoffReady` 的放行条件

按顺序：

1. `home.json` 读不到 → `true`（没有占位可等）。
2. `handoffPending` 不为 true → `true`。
3. 传了 `sessionId` 且与 `home.json` 的 sessionId 不同 → `true`（不是这次换出来的会话）。
4. `rotatedAt` 可解析且已超过 `HANDOFF_PENDING_MAX_MS = 30s` → 清掉占位并 `true`。
5. 到了 `deadline`（默认 12s）→ `true`（绝不拿她的回复去等摘要）。
6. 否则每 200ms 轮询一次；等待定时器**不 unref**，否则事件循环会空转结束、Promise 永远等不到 resolve。

### 已知偏差

- **模型池「10 秒」的实际预算**：`功能文档.md` §5.4 写「池未配置或失败/超时 10 秒就立刻回退宿主 llm」；代码槽位自身确实是 10 秒硬上限，但 `generateHandoff()` 给模型池的实际预算是 `min(10s, 总 deadline - now - 2s 预留)`，在总预算正好 10 秒时通常是 **8 秒**，不是完整 10 秒。这是「给宿主兜底留时间」的实现细节，不是文档说的「池一定跑满 10 秒」。
- **外层 10.5 秒 race**：`功能文档.md` 只写「摘要硬超时 10 秒」；`maybeRotate()` 在 `generateHandoff` 外还套了一层 `HANDOFF_TIMEOUT_MS + 500ms` 的 `Promise.race`，防止上游 `await` 卡住。10 秒是目标，10.5 秒是最后一道 race。
- **`CARRY_TURNS` 与 `FALLBACK_TURNS` 不是同一个数**：`CARRY_TURNS = 8` 是提要/ carry 在 system prompt 里的有效期；`FALLBACK_TURNS = 4` 是模型失败时喂给兜底正文的轮数。原文档在 §5.4 同时提到「8 轮」与「4 轮」，但没点明是两个不同常量。
- **QQ 轮的计数位置**：`功能文档.md` §5.4 说「`history-logger` 每记完一轮就把清洗后的原话交给 `rotation.js`」；代码确实如此，但 `rotation.js` 只处理带 `[QQ · ` 前缀的轮，侧栏/唤醒轮由 `say.js` 自己 bump，避免双计。文档没有展开这个分工。
- **`fish:handoff` 段在 `identity.js`，不在本文件**：`handoff.js` 只负责生成正文与外壳；挂段、order 900、8 轮/3 天过期由 `home.js` 的 `activeHandoffBlockSync` + `identity.js` 负责。本单元记录「提要内容与生成」，section 挂载细节见 `fish.identity`。

## 不负责

- 原始对话怎么落盘、`seq_id`、2000 字截断 → 见 `fish.memory`。
- `fish:handoff` 段的 system prompt 挂载、order 与七个段的关系 → 见 `fish.identity`。
- `chat.rotateAfter` / `chat.handoff.*` 的默认值与存储 → 见 `fish.settings`。
- QQ 侧等待提要的轮询实现 → 见 `qq.session`；本单元只记录 fish 的 `waitHandoffReady`。
- 任务完成日志 → 见 `fish.checklog`。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test test/handoff.test.mjs test/handoff-pool.test.mjs test/rotation.test.mjs
```

重点断言：30 轮收集与 4 轮兜底；10 秒硬超时 / 14 秒看门狗 / 12 秒等待 / 30 秒陈旧；模型池 3 槽与宿主 llm 回退；提要 ≤300 字、外壳正确；8 轮或 3 天后 `fish:handoff` 段消失；QQ 轮计数只认 `[QQ · ` 前缀、不双计。
