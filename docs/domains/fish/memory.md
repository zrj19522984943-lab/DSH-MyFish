owner: fish.memory
anchors: dsh-fish-qq/fish/lib/history-logger.js#MAX_TEXT_CHARS; dsh-fish-qq/fish/lib/history-logger.js#nextSeq; dsh-fish-qq/fish/lib/history-logger.js#recordTurn; dsh-fish-qq/fish/lib/history-logger.js#registerHistoryLogger; dsh-fish-qq/fish/lib/memory.js#searchHistory; dsh-fish-qq/fish/lib/memory.js#readRaw; dsh-fish-qq/fish/lib/memory.js#normalizeSeqIds
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.memory

本文档是 `fish.memory` 的唯一事实来源：每轮对话原文怎么落盘、`seq_id` 门牌号怎么分配、什么内容算「自然语言」、以及 `fish_search_history` / `fish_read_raw` 的检索与溯源规则。换会话的摘要与轮换归 `fish.handoff`。

## 事实

### 文件与常量

| 项 | 值 | 出处 |
| --- | --- | --- |
| 记忆目录 | `<root>/memory/` | `history-logger.js` 的 `MEMORY_DIRNAME` / `memoryDir()` |
| 原始对话文件 | `raw_YYYY-MM-DD.jsonl`（本地日历分天，一行一条 JSON） | `rawFileFor()` |
| 门牌号状态 | `<root>/memory/seq.json`，结构 `{ next, updatedAt }` | `SEQ_FILENAME` / `seqFileFor()` |
| 单条上限 | **2000 字**（`MAX_TEXT_CHARS = 2000`） | `history-logger.js` |
| 检索默认 / 上限 | 3 段 / 10 段 | `memory.js` 的 `SEARCH_LIMIT` / `SEARCH_LIMIT_MAX` |
| 摘要片段上限 | 100 字 | `SNIPPET_CHARS` |
| 一次溯源上限 | 10 条 | `RAW_MAX_IDS` |

记录形状：

```json
{"seq_id": 1024, "ts": "2026-11-03T13:00:00.000Z", "role": "user", "text": "..."}
{"seq_id": 1025, "ts": "2026-11-03T13:00:05.000Z", "role": "assistant", "text": "..."}
```

### `seq_id` 门牌号规则

1. **读号**：`nextSeq(root)` 先读 `<root>/memory/seq.json` 的 `next`；是正整数就直接用。
2. **兜底扫盘**：`seq.json` 不存在 / 坏了 / `next` 不合法时，`maxSeqOnDisk()` 扫**所有** `raw_*.jsonl` 的每一行，取最大 `seq_id` 再 +1；没有文件时从 1 开始。不能假设「最新文件里一定有最大号」（补写旧档 / 时钟偏移）。
3. **先预留、再写正文**：`recordTurn()` 在同一个 root 的串行写队列里，先 `nextSeq` 得到 `start`，先把 `seq.json` 写成 `{ next: start + rows.length, updatedAt }`，再往里追加 `seq_id = start, start+1, ...` 的记录。崩溃点若在两次写之间，最多留下空号，**不会重复门牌**。
4. **串行化**：`queues` 按 root 串行化写入；队列自身永不进入 rejected，一次失败不会带走后面的写。
5. **半行修复**：追加前检查文件最后一个字节是否换行；上次崩在半行时先补 `\n`，避免新记录粘在坏行后面。
6. `ts` 是 ISO 时间；`day` 按**本机**日历（`dayKeyOf`）分文件。

### 只存自然语言

- `textOfMessage()` 只接受 `type: 'text'` 的 block；图片、工具调用、结构化段一律不进记忆。
- `cleanUserText()` 剥掉：
  - 宿主的 `Current runtime context…` 整段；
  - `{"type":"tool_result"…}` 这类工具结果 JSON；
  - `<system-reminder>…</system-reminder>` 外壳；
  - `say.js` 的包装（`## 这次` / `## 他跟你说话了` 之后才是正文）；
  - 「（你想回就回）」「（看不看、说不说）」等操作提示行；
  - 纯括号触发语（如「（醒一醒）」）。
- `cleanAssistantText()` 只去掉出站协议标记 `[QQ]` / `[/QQ]` / `[IDLE]`，保留她原话的每个字。
- **QQ 入站的 `[QQ · 昵称]` 来源前缀保留**：代码把它当成真人话的一部分（只是带来源标注），不是宿主包装。
- 空文本不落盘：他没说话、她没回，都不占一行。
- `clampText()` 统一换行、把 3 个以上连续换行折成 2 个、去首尾空白；超过 `MAX_TEXT_CHARS` 时截到 `max - 1` 个字符再加 `…`，总长不超过 2000。

### 接入：`registerHistoryLogger(ctx, { root, herDir, log, onTurn })`

- 监听 `agent/created` 与 `session/event`；只记**她的会话**——先看 `agent/created` 登记过的 sessionId，再退回 `sessionIsHers(session, herDir)`（cwd 比对，Windows 大小写不敏感）。
- 每个 session 一份草稿：`turn/start` 清空；`user/message` 追加（同一文本连续重复只留一条；`plugin:@deepseek-ai/` 与 `tool` 来源跳过）；`assistant/message` 追加（`surfaceOp !== 'append'` 时整段替换，避免重复）。
- `turn/end`：`cleanUserText` + `cleanAssistantText`，调 `recordTurn()`；再同步调 `onTurn({ sessionId, userText, assistantText, time })` 给轮换计数。`onTurn` 的异常被吞掉——计数失败不影响记忆。
- 返回 dispose：注销两个监听并清空草稿；记录失败只记日志，不影响对话。

### 检索：`searchHistory(root, keyword, { limit })`

- 关键词先经 `tokensOf()` 切 token；没有 token 返回空结果。
- 文件按 `raw_*.jsonl` 文件名新 → 旧遍历；每条记录按 token 命中打分（token 长度 ≥3 记长度，否则记 1），整串原样命中额外 +20；同分时新的在前。
- 每命中一条取「前 1 条 + 命中 + 后 1 条」窗口，窗口里任一 `seq_id` 已被前一段覆盖就跳过，避免重复。
- 每段摘要：前一条/后一条各截 16 字，命中条围绕关键词截 58 字，整段压成一行并封顶 100 字；带角色「他 / 你」与 `来源seq_id`。
- 最多返回 `limit` 段（夹在 1–10，默认 3）；`renderSearch()` 输出 `[检索到以下相关回忆]`，末尾提示「不连贯就 `fish_read_raw` 看原话」。
- 解析结果按 `(mtimeMs, size)` 缓存；坏行/半行跳过，不阻塞整份文件。

### 溯源：`readRaw(root, seqInput)`

- `normalizeSeqIds()` 接受数字、数字数组、`"1024, 1025"` 字符串；去重保序，只留正整数。
- 一次最多取前 10 个；多出来的在结果末尾明确说「后面的没读」。
- 按文件新 → 旧找；`found` / `missing` 分开；输出 `[YYYY-MM-DD HH:mm] 他/你：原文`。
- 一个都找不到时返回 `ok:false` 和「没找到这些原话」，不编。
- 两个工具都只读：`fish_search_history` 只给摘要 + 门牌号，`fish_read_raw` 才给原文；不碰 `events.jsonl`。

### 已知偏差

- **「只存自然语言」的边界**：`功能文档.md` §5.3 写「只存自然语言：宿主 runtime context、工具调用 JSON、say.js 包装都不进记忆」；代码确实剥掉这些，但**保留** QQ 入站的 `[QQ · 昵称]` 来源前缀（`cleanUserText()` 只删包装、不删这个前缀）。所以严格说，落盘的是「带来源标注的自然语言」，不是裸文本。
- **2000 字截断**：文档写「单条超 2000 字截断」；代码 `clampText()` 截到 `max - 1` 再加 `…`，总长最多 2000（含省略号）。这是同一口径的两种说法。
- **`seq.json` 的写入时机**：文档写「先预留号再写正文」；代码先写 `seq.json` 的 `next`，再 `appendFile` 正文，与文档一致。文档没有展开「崩溃最多留空号」的细节，代码注释有。
- **检索排序**：`功能文档.md` §5.3 只说「关键词检索，返回 ≤100 字摘要 + 门牌号」；代码实际还会按 token 权重 + 整串命中加成排序、跳过已覆盖窗口，并按文件新→旧遍历。这是补充，不是冲突。
- **`events.jsonl` 不被本链路读写**：`功能文档.md` 说「`events.jsonl` 依然是权威源，这条链路不碰它」；代码只读 `memory/raw_*.jsonl`，不碰事件流，一致。

## 不负责

- 换会话的摘要生成、10 秒超时、4 轮兜底与轮换计数 → 见 `fish.handoff`。
- `her_recall` 翻事件流（她自己的判断），不是对话原文 → 见 `fish.say` / `fish.growth` 相关单元；本单元只负责 `raw_*` 对话记忆。
- `fish_search_history` / `fish_read_raw` 在 `FISH_TOOLS` 里的清单与数量 → 见 `fish.tools`。
- `memory.docBudget` / `memory.beliefsShown` / `memory.sleepEveryDays` 等配置默认值 → 见 `fish.settings`。
- 身份文档里的 `fish:memory` 常驻段已于 2026-11-04 删除 → 见 `fish.identity`。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test test/history-logger.test.mjs test/memory.test.mjs
```

重点断言：`seq.json` 预留号 / 崩后不重复、只存 text 块、runtime context 与工具 JSON 被剥掉、单条 2000 字截断、摘要 ≤100 字且带 seq_id、`read_raw` 一次最多 10 条、坏行不阻塞、缓存按 mtime+size 失效。
