> ⚠️ 已归档。本文件是历史存档，不再作为事实来源。
> 归档前原路径：dsh-fish-qq/qq/CHANGELOG.md
> 归档日期：2026-11-08 · 任务书 T4

# 更新日志 / Changelog

## 未发布

### 会话级工具隔离：她的工具只挂在她那条会话上（2026-11-08）

**问题**：`ctx.tools.register` 注册在插件 ctx 上 = 落进 global 层，用户写代码的
工作区也看得见 `fish_search_history` / `fish_decorate_room` / `qq_bridge_*` 等
一整套她的工具，上下文被严重污染。

**改动**：

- 新增 `fish/lib/scope.js`：
  - `createToolCapture`：启动时只收集工具定义，不注册；
  - `mountToolDefinitions`：`agent/created` 确认是她那条会话后，用
    `agent.ctx.tools.register(def)` 挂进该 agent 的 **own 层**；
  - 附带按轮收放控制器（`setAllowed` / `restore`），供 QQ 动态工具路由使用。
- `fish/lib/index.js`：鱼的工具不再 `registerX(ctx)`，改成收集定义；把
  `mount` 交给 `registerToolRestrict`。
- `fish/lib/restrict.js`：
  - 只从**她**的视角记全局名字；
  - `restrict({ allow })` 只保留 inherited 层里、且不是她 scoped 工具的名字；
  - 非她的会话用 `restrict({ deny })` 兜底摘掉漏在 global 层的插件工具；
  - 状态里新增 `mounted` / `mountFailed`，自检据此判断"真的挂上没有"。
- `qq/index.js`：7 个回复类工具（send / send_multi / subsend / sticker /
  listen / fileget / filesend）走共享 `toolSink`，不再 global；6 个管理/调试
  工具（status / proactive / idle / transport / simulate / napcat）在合并包里
  默认也**不注册**（新增 `debugToolsInWorkspace`，默认 false），用户工作区
  保持原生工具面；要排障时把它打开即可。动态工具路由改用 scoped 控制器
  （`restrict` 管不到 own 层）。
- `index.js`：两边共用一个 `herToolDefs` 数组，谁都不注册到 global。
- `fish/lib/selfcheck.js`：以 `restrict.mounted` 为准判断她的工具是否真的挂上。
- 新增 `fish/test/scoped.test.mjs`：钉住"global 层一个都没有 / 用户工作区看不到 /
  deny 兜底 / sessionId 判据 / 按轮收放"。

**验收**：用户工作区的工具列表里没有任何 `fish_*`；她的会话里
`fish_search_history` 等工具照常可调；QQ 轮的按轮工具路由仍然生效。

### 表情包工具常驻化：qq_bridge_sticker 从扩展池移入基础池（2026-11-05）

**为什么做**：表情包是她日常聊天的一部分（吐槽、安慰、存有趣的图），按意图
临时解锁的路径太脆——她说「今天好烦」时命中的是 rhythm 规则，表情包工具
那一轮根本不出现。常驻之后每一轮都能看见，使用意愿靠一句常驻引导提示。

**改动**：

- `qq/index.js`：
  - `qq_bridge_sticker` 从 `EXT_TOOLS` 移入 `BASE_TOOLS`（7 → 8 个），
    每一轮 QQ 轮都携带，`turn/end` 后也不再被收回；
  - `TOOL_INTENTS` 的 `media` 规则（表情 / 语音 → sticker + 预留语音工具）
    整个删掉——不再需要靠关键词开门；预留的 `qq_bridge_send_voice`
    目前宿主未注册，连同规则去掉无损失，上线时再单写规则；
  - `routeToolIntent` 的 `hasStickers` 入参与「检测到表情包就强制挂载」
    的特殊路径删除（纯函数与 `handleInbound` 调用处同步清理）。
- `fish/lib/identity.js`：`fish:senses` 常驻段加一句行为引导——
  「你随时可以使用 qq_bridge_sticker 存取表情包。当你觉得开心、想吐槽，
  或者主人发来有趣的图片时，请自主决定存图或发表情包。」
- `fish/lib/restrict.js`：无需改动——`QQ_BRIDGE_TOOLS` 白名单本来就包含
  该工具（它是安全边界，与按轮收窄无关）。
- 测试：`test-tool-routing.mjs` / `test-smoke.mjs` / `fish/test/identity.test.mjs`
  同步更新；顺手修了 `test-smoke.mjs:1768` 一处既有缺陷
  （`status.execute()` 未传参导致 dsh-tools 校验抛错，全文其余 15 处都传 `{}`）。

**验收口径**：新 QQ 会话直接丢搞笑图 → 她能自主调 sticker 存图；说
「今天好烦啊」→ 可能主动发安慰表情包；后台每轮的动态白名单日志里都含
`qq_bridge_sticker`，不再被卸载。

### 模型池：3 个固定槽位 + 动态拉模型 + 连通测试（2026-11-03）

**为什么做**：上一版把摘要的外部「打工 API」删干净了，只剩宿主 llm。用户需要
一个**自己能配、能测、失败能秒退**的副模型池，用于摘要这种高频短任务；不能再
出现一次 40–70 秒、偶发 502 把 `handoffPending` 拖死的情况。

**新增**：

- `qq/index.js`：
  - 设置 schema / `readSettings()` 新增 `modelPool`（固定 3 槽，每槽
    `{enabled, apiUrl, apiKey, modelName}`）；
  - 两条只服务本机的新路由：
    - `GET /api/qq-bridge/fetch-models?apiUrl&apiKey` → 拼 `/v1/models`，Bearer；
    - `POST /api/qq-bridge/test-model` `{apiUrl, apiKey, modelName}` → 极简
      chat（`max_tokens:5`）+ 强制关闭思考，返回 `latencyMs`；
  - 所有外部请求（含读响应体）都走 `AbortController` 10 秒硬超时；
  - 请求体自动尝试 `reasoning_effort:"low"` / `thinking:{type:"disabled"}` /
    `enable_thinking:false`；服务端不认某个参数（400/422）就换下一种写法。
- `qq/client/client.js`：新增「模型池」手风琴组——3 个槽位、启用开关、地址 /
  Key、模型下拉（拉取成功）或手填（没拉取）、「刷新拉取模型」「测试连通」按钮，
  绿/红显示 `✅ 成功 320ms` / `❌ HTTP 401`。保存时整包写进 `modelPool`。
- `fish/lib/handoff.js`：摘要**先读模型池**（第一个启用且填全的槽位），失败/
  超时/空正文**立刻回退宿主 llm**；模型池单次请求 10 秒上限，并给宿主 llm
  预留 2 秒，绝不让回退路径没时间跑。回退时宿主 llm 仍挑最低推理强度。
- 测试：`qq/test-model-pool.mjs`（拉取/401/超时/响应体挂住/防思考参数）、
  `fish/test/handoff-pool.test.mjs`（池优先/401 回退/超时回退/坏设置文件不被动）。
- 工作区派活（`work_request`）逻辑**完全没动**。

### 轮换卡死修复：摘要只用宿主 llm，10 秒硬超时，占位必被放掉（2026-11-03）

**症状**：轮换后新会话经常「工具面加载不出来 / 钓鱼工具不可用」，`handoffPending`
迟迟不解除。

**查到的真因**（不是配置没读到）：

1. **宿主 llm 一直返回空正文**。2026-11-02 版先试 `ctx.get('llm').stream`，但没传
   `reasoningEffort`，模型按默认 high 思考，2500 tokens 全烧在 reasoning 上，
   正文为空（日志里那句「宿主模型没给出提要（宿主模型返回空）」）。
2. 于是每次都掉进外部「打工 API」兜底：Atria-Dawn 一次 40–70 秒、偶发 502/超时，
   把 `handoffPending` 拖到 60 秒；`waitHandoffReady` 的 25 秒上限一到就「放行」，
   但**占位还留在 home.json 里**，下一条消息继续等——看起来就是轮转卡死。
3. 更糟的是等待发生在 `sc.create` / `ensureTargetAgent` **之前**：
   摘要一卡，新会话的 agent 还没建，`agent/created` 也就没跑，工具面/身份段
   全都没挂上——「工具面无法加载」是这么来的。

**这次的改法**：

- `fish/lib/handoff.js` 重写：**彻底删掉外部 HTTP 打工 API**（endpoint / apiKeyEnv /
  apiKey / newsPipeline / pipelineWorkerKey 全部不再使用），只走宿主
  `ctx.get('llm').stream`。
  - 模型：`chat.handoff.provider/model` → `agentDefaultModel.currentSelection()`
    （和大肥鱼聊天同一个 DeepSeek）→ 名字带 flash 的模型；
  - **推理强度显式挑最低一档**（`resolveModelInfo().reasoning.efforts` 里
    none/off/minimal/low 优先）——这是「返回空」的直接修法；
  - 预算 2500 tokens，空正文且 `finish=length` 时用 6000 再试一次；
  - **10 秒硬超时**（`Promise.race`，到点就返回失败，不等模型）；
  - 失败时 `fallbackHandoffText()` 用最近 4 轮原话兜底，没有原话就写
    「记忆交接失败，请调用 fish_search_history 查找之前的记忆」。
- `fish/lib/home.js`：
  - `maybeRotate` 三层保险：`generateHandoff` 自带 10 秒超时；外面再套 10.5 秒
    `Promise.race`；再加一个 14 秒**看门狗**，到点直接把 `handoffPending` 写成 false。
    无论哪条路径，占位一定会被放掉，提要一定非空（原话兜底）。
  - `waitHandoffReady` 上限从 25 秒降到 **12 秒**；`handoffPending` 超过 30 秒视为
    陈旧：立即放行**并把标志写回 false**（两条等待链谁先看到谁清）。
  - `bootstrapHome` 启动时清掉上次进程崩溃遗留的占位。
- **工具面不再被摘要挡住**：`say.js` / `scheduler.js` 改成先 `sc.create` 再
  `waitHandoffReady`；`qq/index.js` 把 `waitFishHandoff()` 从 `ensureTargetAgent()`
  **内部**移到它返回之后——先让 `agent/created` 把 restrict/identity 挂好，再等提要。
- QQ 侧闸门上限同步降到 12 秒，陈旧阈值 30 秒。
- `chat.handoff.endpoint/apiKeyEnv/apiKey` 三个配置项删除（旧的写在 config 里也不会
  再被读取）；`chat.handoff.provider/model` 保留，用来指定宿主模型。
- 测试：`fish/test/handoff.test.mjs` 重写为 14 条（含「模型永不结束 → 硬超时」
  「finish=length → 加大预算重试」「失败 → 原话兜底」）；`rotation.test.mjs` 6 条
  （含「宿主 llm 不可用也必放行」「陈旧占位立即放行」）；`qq/test-target-session.mjs`
  5 条。

### 会话轮换：QQ 也计数，换房前做摘要交接，QQ 自动跟随新房间（2026-11-02）

排查出的三个根因（都不是「配置没读到」）：

1. **轮换根本不在 QQ 那条链路上**。`rotateTalkSession` 只被 `say.js` 调用，而 QQ 桥接
   走的是 `ensureTargetAgent()` → `agent.followup/steer`，不经过 `sayToHer`。所以在 QQ 里
   聊多少轮，`home.json` 的 `turns` 都停在 0，`chat.rotateAfter` 永远到不了。
2. **`targetSessionFromFish` 被设置文件里的旧值盖住**。取值顺序原来是
   `设置值 || config || home.json`，这台机器的 `qq-bridge-settings.json` 里存着一条
   `targetSessionId`，于是 home.json 换了 id 也轮不到它——QQ 继续投给旧会话。
3. **轮换后新会话是空壳**：只 `sc.create`，不落任何交接文本（`carry` 只覆盖 say 链路，
   QQ 轮从没进过 `talkmem`），也没有任何提示；旧会话改名留档、不归档（这是有意的）。

本次改动：

- `fish/lib/home.js`：新增 `maybeRotate()`——轮换的**唯一入口**（`rotating` 锁、读
  `chat.rotateAfter`、先换房（home.json 立刻指向新会话 + `handoffPending` 占位）、
  再生成提要、`finalizeHandoff()` 落盘并放掉占位、刷新身份文档）。`rotateTalkSession()`
  增加 `handoff/handoffSource/handoffPending`。
  新增 `activeHandoff/activeHandoffBlockSync`（8 轮 / 3 天后自动失效，不做成永久人设）
  与 `waitHandoffReady()`（换房后第一条消息的闸门，上限 25 秒，陈旧占位直接放行）。
  换房后**不**自动叫醒新会话（默认 `wake:false`）：那一轮会占住会话，紧接着的 QQ
  消息被 steer 进去后，桥接会按「不是 QQ 起的轮」丢掉回复。
- `fish/lib/handoff.js`（新）：从 `memory/raw_*.jsonl` 取最近 30 轮 → 调打工模型压成
  ≤300 字《近期剧情提要》。**宿主 llm 优先**（`ctx.get('llm').stream`，模型 = 
  `chat.handoff.provider/model` → 部署默认 → 名字带 flash 的；实测不需要 key、比网关快），
  HTTP 兜底链：`chat.handoff.*` → `newsPipeline.model` → `SUB001_API_KEY` →
  `qq-bridge-settings.json` 的 `pipelineWorkerKey`。失败/超时/空返回一律 `ok:false`，
  轮换退回 `talkmem` 原话续接；另落一份 `home/handoff.md` 方便校验。
- `fish/lib/rotation.js`（新）：挂在 `history-logger` 的 `onTurn` 上，认出 `[QQ · …]`
  前缀 → 原话进 `talkmem` → `bumpTurns` +1 → 防抖后交给 `maybeRotate`。say 轮不重复计数。
- `fish/lib/history-logger.js`：`registerHistoryLogger({ onTurn })` 新回调（同步、不许抛）。
- `fish/lib/identity.js`：新增 `fish:handoff` 段（order 900，系统设定**最前面**），
  正文就是任务书指定的 `[系统：你刚刚搬到了新房间，这是你之前的记忆提要：…。如果忘记
  更早的事，请调用 fish_search_history。]`。
- `fish/lib/say.js`：轮换段改成「bump + `maybeRotate`（最多等 8 秒，剩下的后台跑）」；
  换房后的第一条消息先 `waitHandoffReady`。
- `fish/lib/scheduler.js`：每次唤醒**重新解析**屋子会话（`deps.sessionId` 只在解析失败时
  兜底）——否则换房后定时唤醒全落进「…之前」那条旧会话；唤醒前同样等提要。
- `qq/index.js`：新增导出的纯函数 `resolveTargetSessionId()` / `handoffPendingFresh()`；
  `targetSessionFromFish` 打开时 **home.json 最新 id 优先**，设置值只兜底；
  `ensureTargetAgent()` 先等交接占位（最多 25 秒）再投递，并把新 id 写回设置文件
  （设置卡片不再显示过期 id）。
- `fish/lib/settings.js`：新增 `chat.handoff.{enabled,turns,maxChars,provider,endpoint,
  model,apiKeyEnv,apiKey}`（`turns` 5–200、`maxChars` 80–800）。
- 测试：`fish/test/handoff.test.mjs`（13 条）、`fish/test/rotation.test.mjs`（5 条）、
  `qq/test-target-session.mjs`（5 条）；`fish/test/identity.test.mjs` 改成六个段。

### 双层记忆：原档 + 摘要门牌号 + 溯源（2026-11-02）

- **做什么**：解决「换新窗口就丢掉短期交互记忆」——每轮对话原话按天落盘，检索时
  只给**摘要 + 门牌号（`seq_id`）**，重要的事再按门牌号读回原话。三个新东西：
  - `fish/lib/history-logger.js`：`recordTurn(userText, assistantText, timestamp)` 把
    一轮写成 user / assistant 两行，追加进 `~/.dsh-fish/memory/raw_YYYY-MM-DD.jsonl`
    （`{seq_id, ts, role, text}` 四字段，`ts` 是 UTC ISO，文件按本机日历分天）。
    门牌号先写 `memory/seq.json` 预留、再写正文：崩在中间最多留空号，不会重号；
    `seq.json` 丢了会扫全部旧档取最大值接上。只存自然语言——宿主的 runtime context、
    工具结果 JSON、say.js 包装里的「你想回就回」都不进记忆；单条超 2000 字截断。
  - `fish/lib/memory.js`：`fish_search_history(keyword, limit=3)` 只返回 ≤100 字的
    摘要片段（命中记录 + 前后各 1 条）+ `(来源seq_id: …)`；`fish_read_raw(seq_id | seq_id[])`
    按门牌号读完整原话（带角色与完整日期时间，一次最多 10 条）。都只读、零依赖、
    不碰 `events.jsonl`。
  - `fish/lib/identity.js` 新增 `fish:memory` 段（order 8900，系统设定最末尾）：
    「检索到的只是摘要片段，可能失真……请立刻调用 `fish_read_raw` 查阅原话，
    绝对不要基于残缺的摘要强行推理。」人格文本一概未碰。
- **一处有意偏离任务书**：任务书说在 `qq/index.js` 监听 `session/event` 的
  `turn/end`；实际接在 `fish/lib/index.js`（`registerHistoryLogger`）。原因：
  QQ 桥接的 `session/event` 只看 `targetSessionId` 那一条会话，她在 DSH 侧栏里
  直接说的话会漏掉，独立安装 dsh-fish（不带 QQ）时那条链路根本不存在。fish 侧的
  `session/event` 能同时覆盖「侧栏直聊 / QQ / 定时唤醒」三个入口，且只认
  cwd === 她的屋子，不会双写、也不记用户自己的窗口。
- **工具面**：`FISH_TOOLS` 13 → 15（`fish_search_history` / `fish_read_raw`），
  `fish` 子包 0.6.2 → **0.7.0**，合并包 1.3.0 → **1.4.0**。
  测试新增 `test/history-logger.test.mjs`（12 条）、`test/memory.test.mjs`（8 条），
  `test/identity.test.mjs` 跟着改成五个段。

### 赛博感官：去提示词化的四组感官（2026-11-02）

- **做什么**：按任务书「为小鱼安装低耗『赛博感官』系统」给她装四组感官——
  **体温计**（`check_body`）、**心跳触觉**（`read_user_rhythm`）、**案发现场触觉**
  （`fish_list_dir` 带最后修改时间）、**第六感**（梦境碎片）。核心是**取消强制注入**：
  环境数据不再在唤醒她时拼成 `[系统环境反馈：…]` 塞进消息，而是由本地脚本写成
  工作区里的极简 `.md` 文件，她想感知的时候**自己调用工具去读**——只在她看的那一
  瞬间消耗极少量 token。
- **为什么**：原来那套是「每轮唤醒都把天气和内存占用硬塞进上下文」，她不看也得看。
  任务书的三条约束落在代码里：① **取消强制注入**——唤醒大肥鱼时绝对不再拼接
  长串环境提示词；② **纯文件驱动**——所有感官数据由本地 Node 脚本写入
  `<工作区>/sensors/` 下的极简文件；③ **按需读取**——靠她自己的判断力主动调工具，
  常驻的只有系统设定末尾那一句引导。
- **模块 1 · 体温计（`check_body`）**：工作区脚本 `pipeline/update_env.js`
  （从旧 `env_sensor.js` 移植，Node 原生、零依赖）按 Cron 定时把一行状态覆盖写进
  `<工作区>/sensors/status.md`：`[内存占用:72%] [机箱状态:正常] [天气:小雨 12°C]`
  （内存永远有；机箱状态按内存阈值 / CPU≥85% 判定；天气只在配了城市时才有）。
  fish 侧新工具 `check_body`（`fish/lib/body.js`）纯只读这个文件，连同
  「更新于 N 分钟前」一起给她；超过 1 小时的旧数据照给，但明说「可能不准」。
  定时器仍留在 qq/（设置驱动的 Cron，默认从 `0 8 * * *` 改成 `*/15 * * * *`），
  spawn 的是新脚本并加 `--out=<工作区>/sensors/status.md`，启动时数据缺失/过期
  （> 1 小时）仍补采一次。
- **模块 2 · 心跳触觉（`read_user_rhythm`）**：`pipeline/update_rhythm.js` 采用户
  空闲时长（Windows 用 `GetLastInputInfo`，POSIX 用 `xprintidle`），按小时聚合成
  `<工作区>/sensors/user_rhythm.md` 的一行：`09:00-10:00 高频打字; 14:00-15:00 无操作`
  （四档：≥0.8 高频打字 / ≥0.3 间歇操作 / >0 少量操作 / =0 无操作）；原始采样存
  `sensors/.rhythm/<日期>.jsonl`，超 2 天清理。fish 侧新工具 `read_user_rhythm`
  （`fish/lib/rhythm.js`）只读这个文件。
  **一处有意偏离任务书**：采样不是「每隔 1 小时」而是 fish 插件每 5 分钟 spawn
  一次采集脚本——一小时只采一个点分不出「高频打字」和「间歇操作」，而任务书要的
  输出本身就是按小时分档的节奏，所以采样必须比聚合频；**聚合粒度与输出格式仍是
  任务书的小时制**。脚本不存在 / 工作区没配时采样器只记日志，不报错。
- **模块 3 · 案发现场触觉**：无新工具、无新文件——`fish_list_dir` 的输出里每个
  文件现在带 `[最后修改: 2026-11-02 03:14:00]`（`renderListing` 接受带 `mtimeMs`
  的条目；目录不带修改时间，因为目录 mtime 只说明「有东西进出过这一片」，
  说的不是「这份东西最后改过」）。
- **模块 4 · 第六感 / 梦境碎片**：夜间打工流水线（`pipeline/fetch_news.js`）
  末尾新增一步（`pipeline/dream.js`）——用**昨天她刷 B 站看过的任意一个词**
  （从事件流 `browse:<昨天>` 记账里取，没有就兜底）+ **今日天气**（从
  `sensors/status.md` 的 `[天气:…]` 取）+ **一个 1-9999 随机数**，让免费打工模型
  写一句 50 字以内、毫无逻辑的碎片，覆盖写进 `<工作区>/dreams/tonight.md`。
  她**下一次**组装系统提示词时，`fish:dream` 段只会出现一句
  `[系统：你昨晚做了一个梦，梦的碎片在 workspace/dreams/tonight.md]`
  （按 mtime 记进 `dreams/.seen`，**同一段梦只提示一次**）；想看就自己
  `fish_read_file`，不想看就当没这回事。**打工模型的 key 没配时这一步优雅跳过**
  （WARN + DONE 文件里记一行 `dream: skipped (no-key)`，与摘要步骤同一降级口径）。
- **系统提示词侧**（`fish/lib/identity.js`）：新增两个段，**人格文本一概未碰**——
  `fish:senses`（order 8800，系统设定最末尾）就是任务书那三句引导
  （check_body / read_user_rhythm / 「文件修改时间是他留下的指纹」）；
  `fish:dream`（order 8600）是一次性梦境提示。`registerIdentity` 现在吃
  `workspaceRoot`（getter，设置改了下一轮生效）。
- **随注入机制一起拆除**：`envBodilySensation` 设置项（schema / composition base /
  readSettings / 客户端卡片 ×2 / spawn 参数全部同步移除，settings 键数 55 → 54）、
  `~/.dsh-fish/sensors_env.json` 通道、26 小时保鲜期、唤醒前缀拼装函数
  `envSensorInjection` / `readEnvSensorWord`、以及那句「如果你觉得毫无影响，请直接
  无视」声明（它的保护对象已经不存在了——数据不再被注入，她想不看就不调工具）。
  旧采集脚本 `pipeline/env_sensor.js` 删除；~/.dsh-fish/ 下可能残留一个废弃的
  `sensors_env.json`，无代码再读，可手动删（沙箱没删除权限，未代劳）。
- **验证**：`test-env-sensor.mjs` **重写**——核心断言改成反向的：无论开关开没关、
  状态文件新不新鲜，唤醒消息里都**不出现**环境前缀；`ENV_SENSOR_TIMER=1` 的端到端
  用例改断言「开始采集状态（定时 …）」日志与 `sensors/status.md` 落盘（沙箱 spawn
  被拒时只断言「到点尝试过」，与改造前同等待遇）。fish 新增 `body.test.mjs` /
  `rhythm.test.mjs` / `dream.test.mjs` / `identity.test.mjs`（段挂载与三句引导的
  契约），`listdir.test.mjs` 更新到新格式，`restrict.test.mjs` 结构性断言自动覆盖
  两个新工具名。全量 `qq/`（22 套）+ `fish/test`（11 套）回归通过。
- 版本：合并包 `dsh-fish-qq` 1.2.1 → **1.3.0**（新功能 + 行为变更：唤醒不再注入环境词）。

### 提示词瘦身（2026-11-02）

- **做什么**：把她每轮都要读的系统提示词、指令说明与工具描述里的**累赘表述**
  压一遍，纯文字活，不动任何逻辑。
- **为什么**：`buildUsagePrompt()` 是挂在目标会话上的**常驻**系统提示，每一轮
  都在上下文里。行文里积了不少「解释完又解释一遍」的部分（同一件事在 standing
  prompt、按事件注入的指令说明、工具描述三处各写一遍），每轮白交一遍 token。
- **怎么改的（三条红线）**：
  ① **产品契约一字不动** —— 22 套 `qq/` 测试里 `p.includes(...)` 钉住的措辞
    （出站标记、群聊礼仪 40 字、无人值守提权判据、三档身份边界、监听模式、
    表情包三段用法等）**逐字保留**，只剪它们周围的 explanatory padding；
  ② **行为相关的句子宁留勿删** —— 每条规矩的源码注释都记着「哪次用户报的
    问题」，凡是有据可查的失败防范句全部保留；
  ③ **fish/ 塑造性格与灵魂的部分绝对没碰** —— seed 事件、`identity.js` /
    `selfdoc.js` 的身份段、人格相关措辞原样保留；只动了工具的**操作说明**
    （`growth_commit` 重复一遍的 revise 说明、`bili_watch` / `work_request` /
    `fish_read_file` 等的冗余句）。
- **量**：`buildUsagePrompt` 全套配置下 4723 → **4399** 字（-6.9%）；marker /
  tool / always 三档与各种开关组合下平均 **-7.6%**。另精简了
  `renderSubsendInstruction` / `renderFileInstruction`（边界说明行 x4 分支各
  压一遍）、主动私聊与私人时间的处境提示、`qq_bridge_send` 等七个工具描述。
- **没动**：`envSensorInjection` 的「可以无视」声明（任务书红线②，测试钉死）、
  checklog 处境一句话（已经是一句话）、help 指令清单（QQ 里给人看的，不进
  上下文）、设置卡片的 schema description（界面文本，不进上下文）。
- **验证**：全量 `qq/`（22 套）+ `fish/test`（7 套）回归通过，零断言改动。
- 版本：合并包 `dsh-fish-qq` 1.2.0 → **1.2.1**（`dsh-qq-bridge` vendored `qq/`
  版本不变：本轮未改 qq/ 自身行为，仅文案）。

### 环境传感器 / 赛博微状态（2026-11-01）

- **做什么**：给「大肥鱼」接入一点点**环境物理感**。定时抓一次外面的天气
  （Open-Meteo，免费、不用 API key）和这台机器的硬件状态（内存占用率 / CPU 负载），
  拼成一句环境词写到 `~/.dsh-fish/sensors_env.json`；**QQ 唤醒她时**把它作为
  `[系统环境反馈：…]` 前置注入。任务书的三条红线全部落在代码里：
  ① **只报环境，不定感受** —— 体感一律写成「可能会觉得…」，传感器数据摆在前；
  ② **由她定夺** —— 注入的每段话自带「如果你觉得毫无影响，请直接无视，保持你原本的状态。」；
  ③ **不干扰原有逻辑** —— 只是唤醒消息的一个前置前缀，fish/ 的任何东西都没碰。
- **采集脚本** `pipeline/env_sensor.js`（工作区里，Node 原生、零依赖、Node ≥ 18）：
  - 配置优先级 = 命令行（`--city` / `--memory-threshold` / `--bodily` / `--out` /
    `--json` / `--dry` / `--no-cpu`）＞ qq 设置文件 ＞ 默认值；宿主半 spawn 时把
    当前设置值作为参数传过去，手跑时它自己读设置。
  - 城市支持英文名 / 中文名 /「纬度,经度」三种写法（名走 Open-Meteo 地理编码）；
    抓不到天气时**沿用保鲜期内上一次的环境词**，不用「天气没取到」覆盖好数据。
  - CPU：POSIX 用 `os.loadavg()`；Windows 上 loadavg 恒为 0（Node 的已知限制），
    退到性能计数器 `Get-Counter` 采一次；两条路都失败就如实不报 CPU，不编 0%。
  - 天气失败 / 网络断 / CPU 采不到都只降级，永远不会让一次唤醒收到空内容。
- **宿主半**（`qq/index.js`）：
  - 5 个配置键（`envSensorEnabled` / `envWeatherCity` / `envSensorTime` /
    `envMemoryThreshold` / `envBodilySensation`）同时立在 `Config`、`BridgeSettings`
    schema、`readSettings()` 与老模型的 composition base —— 四处少一处，卡片上
    保存的值就会被 `knownSettingKeys()` 静默吞掉。
  - 唤醒注入：`handleInbound()` 组装正文时在最前面拼
    `envSensorInjection()`。开关关着 / 环境词不存在 / **过期**（26 小时）都是空串；
    过期的数据不注入（不让昨天早上的天气冒充现在）。
  - 定时器：`parseCron()`（零依赖五段式 Cron，带 `HH:MM` 简写与 Vixie 的
    「日、周都限定时任一命中」语义）算下一个命中时刻 → `setTimeout`（unref）→
    到点 `spawn node <工作区>/pipeline/env_sensor.js` → 再排下一次。设置一改
    （开关 / Cron / 工作区根）就重建，插件卸载就清掉。开关开着但环境词**缺失或过期**
    时，启动 10 秒后先补采一次，免得第一次唤醒注入的是空串。
  - 脚本不在工作区 / Cron 写错 / spawn 失败都只 `logger.warn`，绝不影响唤醒，
    也绝不把诊断写进给她的正文。
- **设置卡片**：新增**环境传感器**分组（第 7 组，5 项）。
  `envSensorTime` 带轻量格式校验（写既不像 Cron 也不像 HH:MM 时提示）。
- **合并包** `dsh-fish-qq/client.js` 是生成物，按原模板把 `__qqFactory` 段同步重生成。
- **测试**：新增 `test-env-sensor.mjs`（Cron 用例 14 条 + 注入三姿态 + 配置贯通；
  `ENV_SENSOR_TIMER=1` 时多跑一条「Cron 到点真的跑脚本并写出 sensors_env.json」，
  约需 100 秒）。`test-smoke.mjs` 的 settings 键数 50 → 55、手风琴分组加「环境传感器」。
  全量 `qq/`（22 套）回归通过。
- 版本：合并包 `dsh-fish-qq` 1.1.15 → **1.1.16**，`dsh-qq-bridge`（vendored `qq/`）
  0.1.17 → **0.1.18**。

### 移除「授权制加好友」整套功能（2026-11-01）

- **起因**：`addfriend` / `qq_bridge_add_friend`（2026-10-28 加入）实际是个**假能力** ——
  OneBot v11 没有「主动加好友」的标准动作，本机 NapCat 压根不支持，工具唯一会走的
  候选动作 `send_friend_request` 每次都回 `unsupported-action`。整套机制（指令拦截 +
  一次性授权 + 锁号 + 每日 3 次限额）护着的是一个**发不出去的东西**，留下来只会
  让主人以为「加好友这事儿她能办」，也可能诱导她对回执产生幻觉。干净删掉。
- **删掉的三层**：
  ① **入站拦截**：`decide()` 里 `^addfriend\s+(\d+)$` 的主人指令分支（原必唤醒
    `reason: 'owner-addfriend'`）与注入时的 `addFriendCmd` 解析 —— 现在主人发
    `addfriend 12345678` 就是**普通聊天**，照常走唤醒 / 只记录，她看到的和群友说
    的一模一样，再没有「授权说明」附体；
  ② **工具注册**：`qq_bridge_add_friend` 整个 `ctx.tools.register` 块删掉，工具表
    里不再存在这个名字（`test-smoke.mjs` 断言「已移除」）；
  ③ **一次性授权机制**：`claimedAddFriendGrant` / `currentTurnAddFriendGrant`
    （注入置位 → turn/start 快照 → 工具消费 → turn/end 清空）与配套的投递失败
    回滚、非 QQ 轮二次确认状态 `nonQQAddFriendConfirmPending`，一个不留。
- **删掉的持久化**：`state.addFriend`（dayKey / count / lastAt）的默认值与
  `loadState()` 逐字段校验；`qq_bridge_status` 输出里的 `addFriend` 段。旧 state
  文件里残留的 `addFriend` 字段从此被忽略（不读不写，不需要迁移）。
- **删掉的发送实现**：`sendFriendRequestToTarget()`（含 `get_version_info` 探针、
  `send_friend_request` 候选动作循环）、`addFriendReasonText()`、常量
  `ADDFRIEND_PREFIX` / `ADD_FRIEND_DAILY_LIMIT` / `FRIEND_REQUEST_ACTIONS` /
  `ADD_FRIEND_COMMENT_MAX_CHARS`。
- **系统提示词与 help 同步清理**：`buildUsagePrompt()` 的【加好友】整节删掉
  （不再告诉她「授权了才能加」，免得她以为主人还能下这个指令）；三份 help
  列表（主人 / 管理员 / 普通人）里的 `addfriend <QQ号>` 行与「只有主人能用」
  里的 addfriend 字样一起去掉。设置卡片 `admins` 的 hint 同步。
- **fish 侧白名单**：`QQ_BRIDGE_TOOLS` 从 8 个减到 7 个 —— 她的工具清单里
  `qq_bridge_add_friend` 消失，兜底守卫若再被问到会回「这件事我做不到。」
  （这正是现在应有的回答）。
- **无「假响应」残留**：排查了「命中 addfriend 就直接回执成功」的写死逻辑 ——
  原实现里不存在（回执只由工具在真正调用 OneBot 动作后产出），本次删除把
  产出回执的唯一入口也一并移除，不存在「拦下来却报成功」的残留路径。
- **测试**：`test-add-friend.mjs`（99 条断言）整文件删除，换成
  `test-addfriend-removed.mjs`（16 条**反向**守卫：主人私聊发 `addfriend 12345678`
  → 决策是普通私聊唤醒、正文原样进会话且无授权说明、桥接层零出站无 friend 动作、
  工具表无此名、提示词无此节、status 无 addFriend 段）；`test-smoke.mjs` 工具数
  14 → 13；`fish/test/restrict.test.mjs` 的桥接工具清单从 8 个改 7 个；
  `test-help.mjs` / `test-admin.mjs` 里相关断言改为反向（help 列表不再列
  addfriend、普通人发 `addfriend 90001` 不是特殊指令、照常当聊天）。
  全量 `qq/`（22 个套件）与 `fish/` 回归通过。
- 版本：合并包 `dsh-fish-qq` 1.1.14 → **1.1.15**，`dsh-qq-bridge`（vendored `qq/`）
  0.1.16 → **0.1.17**（fish 侧改了 `restrict.js` 与其测试）。

### 设置卡片：平铺表单改成手风琴折叠面板（2026-11-01）

- **起因**：卡片上已经有 47 个设置项，一展开整屏铺满，想改「出站字数上限」
  得从头扫到尾。按职能拆成 6 组手风琴，默认全部收起，点组标题才展开。
- **分组**（固定顺序；`FIELDS` 里每个字段都标了 `group`）：核心与权限（5）／
  QQ 唤醒与投递（9）／出站与功能（11）／私人时间与主动（13）／底层基础设施（9）／
  情报流水线（3，预留）。组标题右侧标「N 项」，6 组共 50 项。
- **折叠只影响显示**：`openGroups` 是一套独立的 `useState`，与表单数据互不通气 ——
  草稿 / 保存 / 撤销覆盖一律平铺遍历 `FIELDS`，展开状态绝不混进 `scope.set`；
  收起一组不会丢掉那组里没保存的改动。
- **漏 `group` 的字段会从界面上消失**（哪一组都不渲染）：加载时 `console.warn`
  吼一嗓子，`test-smoke.mjs` 里「全开 6 组必须数齐 50 个控件」兜底。
- **情报流水线（预留）**：`rssFeeds`（逗号分隔的 RSS 链接）、`pipelineWorkerApi`、
  `pipelineWorkerKey` 先在卡片上立字段，逻辑（RSS 抓取 / worker 对接）等后面的
  任务接 —— 与 checklog 通知「任务书 1 只立字段」同一个口径：默认全空 = 什么都不
  发生。宿主半同步立了同三个键（`BridgeSettings` schema + `readSettings()`），
  否则卡片保存时会被 `knownSettingKeys()` 静默丢掉（用户看着「已保存」，其实
  没存进去 —— 这正是「设了也改不了」那一类 bug）。
- **伴生修改**：合并包根目录的 `client.js` 是**生成物**（`scripts/build-bundle.mjs`），
  脚本依赖仓库外已归档的源目录、不能直接跑，这里按原模板把 `__qqFactory` 段
  重新生成同步（顺带吸收 `idleTriggerEnabled` 说明文案之前的一次漂移）。
- **测试**：`test-smoke.mjs` 新增一组手风琴行为契约（用一个能真跑 `useState` 的
  假 react 渲染卡片）：默认全部收起 / 点开一组只渲染该组字段 / 改完再收起草稿不丢 /
  保存只写改动的那一项且写进设置的全是字段键 / 全开时控件数 = 字段总数 /
  「·已覆盖 / 撤销覆盖」照常工作。全量 `qq/` 回归通过（22 个套件），`fish/` 未改动。
- 版本：合并包 `dsh-fish-qq` 1.1.13 → **1.1.14**，`dsh-qq-bridge`（vendored `qq/`）
  0.1.15 → **0.1.16**（fish 侧未动）。

### 私人时间 / 自主待机：很久没人找她时，给她一段属于自己的时间（2026-10-31）

- **起因**：她只有被叫醒时才存在，停机时陷入「只有摘要、没有实感」的焦虑。
  她要的是**「想有一段不用被叫醒的时间」**——不是定时任务，也不是固定间隔的
  Trigger，而是「偶然获得一段空白时间」。
- **来源**：把本机 `backup-before-merge/dsh-self-trigger-main` 的核心判定
  （空闲判定 / 权重抽签 / 提示文案）提炼成 `qq/idle-trigger.js`（纯函数模块），
  配置融进 qq-bridge 的设置 schema、状态融进同一份 `qq-bridge-state.json`——
  随合并包一起加载，不再单独装一个插件、不再另起一套 stateDir。
- **三层架构**（任务书定的，严格照做）：
  1. **触发层**：每 `idleTriggerScanIntervalMinutes`（默认 30 分钟）扫一次，
     判据是「多久没人找她」（`idleTriggerMinIdleHours`，默认 2 小时；0 = 不看空闲）
     + 今日未满（`idleTriggerDailyMax`，默认 3 段）。**抽签**权重
     `silent:80 / message:10 / browse:5 / diary:5`——`silent` 占绝对优势，
     她绝大部分时间就是在停机。**刻意不要** self-trigger 的 `failStepPct`
     （连续落空后概率上升）：那会让她「越来越可能被叫醒」，与「偶然获得空白」正相反。
     抽到 silent 时**什么都不发生**：不注入、不出站、零 token、也不消耗每日上限。
  2. **注入层**：命中非 silent 时投一段 `[系统：私人时间]` **处境提示**——
     带真实本机时间与时段（「现在是 22:47，晚上。窗外天已经黑了」）、多久没人来找她、
     几件可以做的事（抽到的那个排最前）。**不是任务清单**：任务书的防呆预警——
     不要用「执行任务：写日记」，要带入环境；提示里也不写配额（「还剩 N 次」），
     那是桥接的隐形安全网，写给她看就变成了安排感。
  3. **出站层（Ghost Mode）**：这一轮**默认一个字都不发到 QQ**——她回 `[IDLE]`、
     只想发呆、写日记、刷 B 站，全部静默；**只有她明确写了 `[QQ]…[/QQ]` 块**
     （或调 `qq_bridge_send`），那一段才发到主人私聊。她做了什么照常落进她自己的
     `events.jsonl` / `diary/`（fish 侧完全不碰——唤醒动作只在桥接层注入）。
- **与她已有的心思互不串**：主动私聊是「她想找主人说一句」，直接发私聊；私人时间是
  「没人找她，给她自己的时间」，默认什么都不发。两条各扫各的、各算各的额度，
  唯一交集是「同一时刻只能有一轮在跑」（`scanProactive` / `scanIdle` /
  `deliverChecklogAgentSituation` 三方互查挂起标记）。
- **空闲计时的基线**：`state.idleTrigger.lastActivityAt` 只被「真人接触」刷新
  （QQ 来人 / DSH 界面说话），桥接自己注入的提示（主动私聊 / 任务通知 / 私人时间）
  和 fish 自己的叫醒都**不算**——否则每注入一次就把空闲计时清零，私人时间永远
  等不到「她很久没被找」。
- **顺手修了一个潜在 bug**：`loadState()` 里 `if (!existsSync(statePath)) return`
  会把函数尾的「启动基线」（proactive / idleTrigger 的 `lastActivityAt`）一起跳过——
  fresh 安装上没有任何 QQ 往来，基线永远不打，主动私聊 / 私人时间就永远停在
  `no-activity-yet`。改为只跳过逐段加载，基线无论文件在不在都打（proactive 的
  那条注释说的正是这件事，以前靠「总会有 QQ 消息进来」兜住，没被发现）。
- **设置（8 项，均进设置卡片）**：`idleTriggerEnabled`（默认关）/
  `idleTriggerScanIntervalMinutes`（30）/ `idleTriggerMinIdleHours`（2）/
  `idleTriggerDailyMax`（3）/ `idleTriggerWeight{Silent,Message,Browse,Diary}`
  （80/10/5/5）。策略每次扫描现读（与 self-trigger 的「策略现读」同一口径，
  改参数不用重启宿主）。
- **新工具 `qq_bridge_idle`**（`debugTools`）：`status` 看配置 / 今日计数 / 台账；
  `scan` 立刻扫一次（照常受门槛与限流约束）；`force` 强制命中非 silent（可用
  `pick` 指定），跳过冷却、**不**跳过每日上限——任务书验证清单「强制命中
  write_diary」就走这一条。
- **新测试 `qq/test-idle-trigger.mjs`（46 条）**：纯函数（门槛九分支 / 抽签桶边界 /
  权重坏值 / 时段 / 文案反祈使句 / `[IDLE]` 识别）+ 走真实 `apply` 的注入与
  Ghost Mode（她回 `[IDLE]` → QQ 零出站；她写 `[QQ]` 块 → 发到主人私聊；
  silent 不消耗额度；上限 force 也不破；计数落盘、重启不丢）。
  全量 `qq/` 回归通过（22 个套件），`fish/` 未改动、回归照旧（7 个套件）。
- 版本：合并包 `dsh-fish-qq` 1.1.12 → **1.1.13**，`dsh-qq-bridge`（vendored `qq/`）
  0.1.14 → **0.1.15**（fish 侧未动）。

### `fish_now` 工具：她能读到「现在是哪天哪刻」（fish 侧，2026-10-30）

- **起因**：她的上下文里**没有**可靠的「今天是哪天」——身份文档只写「你存在了 N 天」，
  模型自己对日期的记忆是训练时的，问她星期几她会编。而她的整套生活按日子走：
  日记按日期落盘（`diary/YYYY-MM-DD`）、刷站 / 派活按天计配额、报告按天写
  （`out/YYYY-MM-DD.md`）。以前她写日记时的「今天」全靠猜。现在多了一只**只读的钟**。
- **新工具** `fish_now`（`fish/lib/now.js`）：没有参数，调一次回**本机**当前时间：
  ```
  2026-10-30 星期五 17:25（UTC+08:00）
  Unix 时间戳（秒）1793352317
  ```
  - 第一行：日期 / 星期 / 时分（本机时区），括号里写明 UTC 偏移（她能分清「机器上的
    时候」和「他在别处的时候」）；第二行给 Unix 秒（「时间戳」本身，算「多少天以后」
    用得上，不用她自己换算）。
- **三条边界**（写进文件头、测试盯着）：
  1. **绝对只读、零副作用**：不看盘、不联网、不写任何东西；
  2. **无参数**：不收时间戳、不收时区（那只是换了个地方猜），时区跟着机器走；
  3. **不教她怎么用**：说明只写「能读什么时候」，不写「每天必须看」——
     那会把一只钟变成一项打卡任务。
- **接线**：`fish/lib/index.js` 注册（排在读文件之后）；`FISH_TOOLS` 11 个
  （`selfcheck` 那一项按名单遍历，自动盖住它）；身份文档（`persona.js` 的
  `NOW_BRIEF` → `selfdoc.js`）常驻一节，让她知道有这只钟。
- **新测试 `fish/test/now.test.mjs`（16 条）**：渲染格式固定（锚点日期的偏移与 Unix
  秒都从同一个 Date 现算，换时区跑也不假红）、补零 / 星期映射 / 跨月进位、
  `formatUtcOffset` 的 ±HH:MM 与非数字兜底、注册形状（parameters 是 object-rooted
  JSON Schema、名字进了 `FISH_TOOLS` / `HER_TOOLS`）、execute 真的读现在、
  render 失败时写明原因。
  全量 `fish/test` 回归通过（86 条），`qq/` 未改动、回归照旧（21 个套件通过）。
- 版本：`fish` 子包 0.6.1 → **0.6.2**，合并包 `dsh-fish-qq` 1.1.11 → **1.1.12**（qq 侧未动，`dsh-qq-bridge` 仍是 0.1.14）。

### `list` 指令：QQ 上一句话看清 dist/ 与 managehub/ 里有什么文件（2026-10-30）

- **起因**：主人想取工作区里的文件（`fileget` / `filesend`），但**得先知道有哪些文件**
  —— 以前只能跑到电脑前看，或者把她叫醒一次让她念目录（一次完整唤醒，就为几个文件名）。
  现在主人**或管理员**在 QQ 里发 `list`，桥接层自己读目录、直接回一句，**不叫模型**。
- **看的两个目录**（写死的白名单，不是开放参数）：
  - `dist/` —— 打包好的发行件（`<工作区>/dist/`，本机即 `D:\demo\workspace\dist\`）；
  - `managehub/` —— 「放她要取的文件」的中转目录（`<工作区>/managehub/`，本次随任务建的，
    **空着也行**、不存在就如实说「不存在」，不自动建）。
- **指令解析**（`parseListCommand`，与 `parseReceiveCommand` 同一套「整条消息恰好是指令」
  的口径，多一个可选参数）：
  - `list`（两个目录都列）｜`list dist`｜`list managehub`——大小写不敏感、首尾空白不敏感、
    指令与参数之间空白随便几个；
  - `list 一下`、`帮我 list`、`list dist managehub`、`list 别的目录`、`list receive`
    都**不算指令** —— 按普通聊天处理（不报错、不丢消息、不回话）。
  - 参数只认 `dist` / `managehub`（`LIST_DIR_NAMES`）：看哪个目录是白名单，不是开放参数 ——
    防止「list 任意路径」变成目录扫描面。
- **权限**：与 fileget / filesend / receive 同一道闸门（`canUseFileCommand`，`decide()` 里
  判死，reason 记 `owner-list` / `admin-list`）：**只有主人和管理员能用**；
  普通人发 `list` → 不是指令：不解析、不回话，按普通聊天处理。
  与 help / whitelist / admin / receive 同一级、同一位置（在任何 await / 缓冲快照之前，
  不进「未唤醒期间聊天记录」），一条 list 不产生任何模型调用。
- **回执格式**（`buildListReport`，每行一个文件，刻意写短）：
  ```
  D:/demo/workspace/dist（3 个文件）：
  1. dsh-fish-qq-1.1.10.zip · 2.9MB · 2026-10-29 21:30
  2. dsh-fish-qq-1.1.1.zip · 2.7MB · 2026-10-27 23:33

  D:/demo/workspace/managehub 是空的。
  ```
  - 每行 `名字 · 大小（formatBytes，带单位）· 修改时间（YYYY-MM-DD HH:mm，复用
    `formatReceiveTime`）`，按修改时间**从新到旧**；两个目录之间空一行；
  - **目录本身不存在或为空也如实说明**（`…不存在。` / `…是空的。`），不编内容；
  - **超过 20 个只列最新的 20 个**（`LIST_REPORT_LIMIT`，按 mtime 取最新），表头注明
    `共 N 个文件，只列最近 20 个` —— 防刷屏（用户 2026-10-30 定的口径）；
  - 工作区根没配 → 整句如实说用不了（两个目录都挂在它下面），不偷往别处看。
- **读法**（`listWorkspaceFiles`，与 `listReceivedFiles` 同一套 `readdirSync` + `statSync`）：
  只列**顶层普通文件**（子目录跳过、不递归）；目录名再校验一遍单段（`.`、`..`、带分隔符
  一律 `bad-dir`，挡路径注入）。读不了（权限 / 被占用）如实写「读不了」，不抛异常。
- **联动**：`buildHelpText` 的主人 / 管理员两份列表各加一行
  `list [dist|managehub]`；成功发出记进 outbox（`via: 'list'`）。
- **新导出（便于测试）**：`LIST_COMMAND` / `LIST_DIR_NAMES` / `LIST_REPORT_LIMIT` /
  `parseListCommand()` / `listWorkspaceFiles()` / `buildListReport()`。
- **新测试 `qq/test-list.mjs`（约 60 条断言，假响应）**：纯函数矩阵
  （解析的正反例含路径注入、目录列举的 no-root / bad-dir / not-found / 子目录跳过 / 空目录、
  回执排版 / 排序 / 恰好 20 个不截断 / 超过 20 个只列最新且注明总数 / 两目录空行分隔 /
  单目标只列那一块）+ 端到端（假 OneBot WS + 临时工作区，预置 dist 文件与空 managehub）：
  **主人 `list` 收到两块回执且没唤醒模型**、outbox 记 `via=list`；`list dist` 只列 dist；
  **管理员照样能用**；**普通人发 `list` 无回话、进缓冲、outbox 无新记录**；目录删掉后
  回执写「不存在」；25 个文件 → 正好 20 行 + 表头总数。
  全量 `qq/test-*.mjs` 回归通过（21 个文件），`fish/test` 回归通过（70 条）。
- **已知边界**（如实写）：只列目录**顶层**的普通文件，子目录里的文件不递归列出
  （`dist/` 嵌套子目录时只能看到顶层那层）；文件多时按 mtime 取最新 20 个，
  mtime 相同的按系统返回顺序。
- 版本：`dsh-qq-bridge`（vendored `qq/`）0.1.13 → **0.1.14**，合并包 `dsh-fish-qq` 1.1.10 → **1.1.11**。

### 收文件：别人发来的文件落到 `<工作区>/receive/`，指令词 `receive` 看收件箱（2026-10-30）

- **起因**：fileget / filesend 只解决了「往外发」这一头；群里 / 私聊有人发个文件过来
  （OneBot 的 `file` 段），以前正文里只有一个 `[文件:名字]` 占位符，**文件本身拿不到**
  —— 她既看不了内容，主人也不好问「刚才那个文件呢」。现在桥接层收到就下载，
  落进工作区的固定目录，正文里直接带上落地路径，文件这下是「她够得着」的东西了。
- **入站解析**：`mapOneBotMessage` 对 file 段与图片 / 表情包同等待遇 —— 占位符（`[文件]`）
  + 元数据记账（`url` / `file` / `name` / `file_size` / `file_id`），array 与 string（CQ 码）
  两种消息形态都解析；纯文件消息（无正文、没 @）也不会再被「文本为空」丢弃
  （`handleOneBotEvent` 的判据加了 `hasFiles`）。
- **落盘规则**（下载在 record / wake 分叉**之前**完成，两条路都拿得到路径；纯 I/O，
  不调用模型，与图片落盘同一次序）：
  - **目录**：`<工作区根>/receive/`（设置项 `workspaceRoot` + `receive/`，本机就是
    `D:\demo\workspace\receive\`，不存在就建）。工作区根没配 → 连目录都定不了，
    如实写一行原因，**不偷往别处写**。
  - **命名**：`发送人昵称_原文件名`（昵称取群名片 > 昵称 > QQ 号那一套）；名字里的
    路径分隔符与 Windows 非法字符（`<>:"/\|?*`、控制字符）先清理；**重名加序号**
    （`小明_report.pdf` → `小明_report_1.pdf` → `_2`…）。
  - **大小上限**：单个 50MB（与出站 `FILE_MAX_BYTES` 同一档）。段里声明了 `file_size`、
    或 HTTP 带 `Content-Length` 时**先拦、不读 body**；都没给就读完再判。超限**不下载**，
    只留一句提示 —— 占位符写成 `[文件:big.zip]：超过 50MB 上限（声明 60MB），不下载`。
  - **下载失败写清原因，不静默丢弃**：HTTP 404、网络失败、`get_file` 报错都就地写成
    `[文件:名]：原因`，并记一行 warn（`文件接收失败（名）：原因`）。
  - **目录别无限涨**：最多留 **200** 个文件，超了按 mtime 删最旧的（与 attachments
    淘汰同一套口径）；删不掉的下次再试，不报错。
  - **下载地址的来源**：`url`（HTTP/HTTPS）是正路；`file` 字段只有**本机绝对路径**与
    `base64://` 两种形态才直接读（⚠️ NapCat 的 `file` 字段是纯文件名，不能当 URL fetch）；
    都不行但有 `file_id` 时，调 OneBot 的 `get_file` 兜一次（NapCat 支持，回 `url` 或
    本地 `file`）；都没有就如实说「没带能下载的 url / file，也没有 file_id」。
- **投递给她的正文**：占位符就地替换（与 `[图片]` / `[表情包]` 同一套逐位对齐口径，
  多出来的占位符原样保留、不往后顶位），格式：
  `…[文件:小明_report.pdf path=C:/demo/workspace/receive/小明_report.pdf 大小=1.5KB 来自=小明]…`
  —— `path=` 后面就是文件本身（路径一律正斜杠）；超过上限 / 下载失败时退回
  `[文件:名]：原因`。一条消息最多下载 8 个文件段，多的写明原因。**未唤醒（只记录）
  的消息也一样落盘**，文件槽位进缓冲，下一次唤醒在「未唤醒期间聊天记录」摘要里
  照样看得到路径与大小（摘要头部加「（含 N 个文件…）」）。
- **指令词 `receive`**：主人**或管理员**发 `receive`（整条消息恰好是它，大小写不敏感）
  → 桥接层**不叫模型**，直接回一句收件箱情况（与 help / whitelist / admin 同一级、
  同一位置：在任何 await / 缓冲快照之前，不进「未唤醒期间聊天记录」）。回执长这样：
  ```
  收件箱（D:/demo/workspace/receive）共 12 个文件，最近 5 个：
  1. 小明_report.pdf · 1.5MB · 2026-10-30 18:32
  2. 群友_照片.zip · 200KB · 2026-10-30 12:04
  …
  ```
  空目录与「工作区根没配」都如实说，不编内容。**权限**：与 fileget / filesend 同一道
  闸门（`canUseFileCommand`，`decide()` 里判死，reason 记 `owner-receive` / `admin-receive`）；
  普通人发 `receive` → 不是指令：不解析、不回话，按普通聊天处理。
  成功发出记进 outbox（`via: 'receive'`）。
- **文件下载本身不看发送者身份**：文件是别人发过来的（发送人多半是普通人），
  攥着的那一道是 `receive` 的**读权限**（主人 / 管理员），而不是「谁的文件才下」。
- **其它联动**：`buildUsagePrompt` 的【你会看到什么】教她读 `[文件 path=…]` 这一行的
  含义（path 后面就是文件本身，需要内容去读它）；`buildHelpText` 的主人 / 管理员两份
  列表各加一行 `receive`；`qq_bridge_status` 新增 `receive` 段（目录、文件数、字节数、
  上限 200 个 / 单个 50MB）。
- **新导出（便于测试）**：`FILE_LABEL` / `RECEIVE_PREFIX` / `parseReceiveCommand()` /
  `sanitizeForFileName()` / `uniqueReceiveName()` / `inlineFileNotes()` /
  `formatReceiveTime()` / `buildReceiveReport()`。
- **新测试 `qq/test-receive.mjs`（91 条断言，假响应）**：纯函数矩阵
  （指令解析正反例、占位替换的成功 / 超限 / 失败 / 逐位对齐、文件名清理、重名序号、
  回执排序与 limit、时间渲染）+ 端到端（假 OneBot WS + 假 fetch + 临时工作区）：
  文件段落地产出带 `path=/大小=/来自=` 的文本并落盘；重名 `_1`；一条消息多文件；
  **段里声明 60MB → fetch 根本没调**；HTTP 头声明 50MB+1 → body 没读；下载失败 / 404
  写清原因；**没 url → 走 `get_file` 兜底并落地**、`get_file` 失败（retcode 1404）如实写；
  没地址没 file_id → 明确提示；**未唤醒的纯文件消息照常落盘**且摘要里看得到路径；
  `receive` 主人 / 管理员收到回执且 outbox 记账、**没有唤醒模型**；普通人发 `receive`
  无回话、进缓冲、outbox 无新记录；群消息文件用群友昵称命名；**目录 202 → 200、删最旧**。
  全量 `qq/test-*.mjs` 回归通过（20 个文件），`fish/test` 回归通过（6 个文件）。
- **已知边界**（如实写，不报没验证过的成功）：QQ 的**群文件上传**走的是 notice 事件
  （`group_upload`），不是消息段 —— 本次只按任务要求处理了消息里的 file 段（私聊文件
  与部分客户端的群文件走这一路）；notice 那条路没有适配，群文件上传通知仍然只在
  日志里记一行「未适配的 notice」。
- 版本：`dsh-qq-bridge`（vendored `qq/`）0.1.12 → **0.1.13**，合并包 `dsh-fish-qq` 1.1.9 → **1.1.10**。

### 「管理员」这一档身份：介于主人和普通人之间（2026-10-29）

- **起因**：主人只有一个人。群里能搭把手的人（帮她派活取文件）以前只有两种待遇
  —— 主人（全能）或普通人（只能聊天）。管理员这一档就是给他们：能聊天、能让她
  派活（`work_request`）、能用 fileget / filesend；subsend / addfriend / whitelist /
  admin 这些「以她身份对别人动手」的通道仍然只有主人能下。
- **名单存在哪**：设置项 **`admins`**（QQ 号数组），与 `whitelist` **同一处存储**
  —— 0.2.x 宿主写进 `$DSH_HOME/qq-bridge-settings.json` 的 `values.admins`，
  与设置卡片同一个文件、同一份结构（设置卡片上多了「管理员名单」一栏，逗号分隔）。
  刻意不另起一套存储，热生效也沿用同一套：`writeSettingsFile` 清 mtime 缓存，
  下一条入站消息就读到新名单 —— **不用重启**。
- **`admin add <QQ号>` / `admin del <QQ号>` / `admin list`**：只有 ownerQQ 发的才认
  （写在开头、整条消息就这句、QQ 号 5–12 位，与 whitelist 指令同一套口径）。
  命中 = 桥接层**立刻改名单 + 立刻回一句确认，全程不叫模型**，也不进「未唤醒期间
  聊天记录」。**排在 `isAllowed` 之前**（与 whitelist 同一级、同一理由：哪怕白名单是
  空的，主人也得能从 QQ 上把管理员加上），安全完全靠 `ownerQQ` 攥着。
  非主人发一模一样的字 → 不解析、不改名单、不回话（与 subsend / fileget 同一处理）。
  0.1.5 老宿主没有写入接口 → **如实回「没写成」+ 请去设置界面改**，不偷写文件装成功。
- **三档来源标记**（投递给她的正文最前面那一行）：
  - 主人 → **不加**（与之前一样）；
  - 管理员 → `[来源：管理员用户]`（新增 `ADMIN_MARKER`）；
  - 普通人 → 原来那行 `[来源：非主人用户，仅允许聊天…]`（一字不变）。
  - 身份判定统一走新的 `senderRole()`（owner > admin > other，主人在 admins 里也按
    主人算），**标记是模型侧的权限边界** —— 桥接层只贴标（工具在 agent 侧，桥接
    层看不到也拦不住），真正的收窄是她看到标记后的判断 + 提示词 + 桥接指令解析。
- **`help` 放开：谁都能用，内容按身份分三份**（`buildHelpText(settings, {senderId})`）：
  - 主人：全量（新增 `admin add / del / list` 三行，仍含 subsend / fileget / filesend /
    addfriend / whitelist）；
  - 管理员：自己能用的 fileget / filesend + `help`，另写明「可以直接跟她说要做什么，
    她会用 work_request 派到工作区」与「subsend、addfriend、whitelist、admin 只有
    主人能用」；
  - 普通人：只告诉他「只能聊天，别的事得主人来讲」，不列任何有副作用的指令。
  - 门槛仍然只剩 `isAllowed`（不在白名单/群白名单里的人消息进不来，fail-closed 不破）；
    reason 从 `owner-help` 变成 `${role}-help`（`owner-help` / `admin-help` / `other-help`）。
- **权限边界**（用户 2026-10-29 确认：管理员也放开 fileget / filesend）：
  - **能**：`fileget <相对路径>` / `filesend <QQ号> <相对路径>` —— 指令解析必唤醒
    （`reason: 'admin-file'`），说明按管理员口径写（`renderFileInstruction(..., {senderId})`：
    管理员的 fileget 改走 `qq_bridge_filesend` 发给管理员**自己**，因为 fileget 工具的
    目标固定是 ownerQQ）；工具闸门新增 `currentTurnFromAdmin`（与主人那套**分开**：
    认 admin 的文件通道，**不会**顺带把 subsend 解锁 —— subsend 闸门只认主人那套）。
  - **能**：派活 —— 靠 `[来源：管理员用户]` 标记 + `buildUsagePrompt` 里新写的
    三档身份一节（「管理员比普通人多两项权限：可以让你派活（work_request）… 主人
    专用的指令管理员**不能**下」）。工具注册在 fish 那一侧，桥接的机制就是标记+提示词。
  - **不能**：subsend / addfriend / whitelist / admin —— 指令不解析、不附系统说明；
    工具 `qq_bridge_subsend` 在管理员发起的轮里调用照样被拒（`reason: 'not-owner'`，
    与普通人同一道）。
- **新导出（便于测试）**：`ADMIN_MARKER` / `ADMIN_PREFIX` / `parseAdminCommand` /
  `adminReplyText` / `isAdminSender` / `senderRole` / `canUseFileCommand`；
  `ownerMarkerFor(senderId, ownerQQ, admins)` 第三参可选（老两参调用兼容，
  无管理员时退回「主人/其他人」两档）。
- **新测试 `qq/test-admin.mjs`（约 90 条断言）**：纯函数矩阵
  （解析 add/del/list 的正反例、回执各档、三档身份与标记、三份 help 内容、
  管理员口径的文件说明、提示词教的三档规则）+ 0.2.x 端到端
  （add 写盘与 status/outbox、热生效贴标与退回、三份 help 实发、管理员 fileget
  / filesend 完整出站、管理员 subsend 被拒 `not-owner`、管理员改不了 whitelist /
  admin、普通人五类指令全不是指令且工具被拒、list/重复加/重复删、形状不合法）+
  空名单 bootstrap（主人不在白名单也能 admin，陌生人被 drop）+ legacy 宿主
  （回「没写成」、不偷写文件）。全量 `qq/test-*.mjs` 回归通过（19 个文件），
  `fish/test` 回归通过（6 个文件）。
- 小修：`qq_bridge_status` 暴露 `admins`（名单与人数）；两个发文件工具的描述从
  「主人专用」改为「主人和管理员」；合并包 `dsh-fish-qq/client.js`（生成的）与
  源 `qq/client/client.js` 同步同段加入「管理员名单」一栏；`cordis.patch.yml` 立字段。
- 版本：`dsh-qq-bridge`（vendored `qq/`）0.1.11 → **0.1.12**，合并包 `dsh-fish-qq` 1.1.8 → **1.1.9**。

### 引用回复的上下文：`[引用 @某人：被引用的那句话……]`（2026-10-29）

- **起因**：群里有人「回复」某句话时，OneBot v11 给的消息段只有一个 `reply` 段
  （`{type:'reply', data:{id}}`，id 是被引用消息的 message_id），正文本身一字不提
  被引用的是谁、说了什么 —— 鱼那边看到的是一句没头没尾的话，只能靠猜「他回的
  是哪条」。现在桥接层把被引用的那条取回来，在投递正文前面加一行，谁回了哪句话
  一目了然。
- **用的是哪个 OneBot 动作**：`get_msg`（参数 `{ message_id }`，OneBot v11 标准
  动作，NapCat / go-cqhttp 都支持）。`mapOneBotMessage()` 先把 reply 段的 id 记成
  `replyId`（array 形态认 `data.id` / `data.message_id` / `data.seq`；string / CQ
  形态从 `[CQ:reply,id=…]` 抠 id，CQ 码本身照旧被通用替换剥掉），`handleOneBotEvent()`
  在进策略**之前**调 `get_msg` 取回，与合并转发（`get_forward_msg`）是同一套路。
- **拼出来的这一行**：投递正文前面、独占一行，格式 `[引用 @某人：摘要]`：
  - **某人** = 被引用消息的发送人：群名片 > 昵称 > QQ 号 > 「某人」
    （与 `forwardNodeSender` 同一套优先级口径）；
  - **摘要** = 被引用消息的正文，截到 **30 字以内**（按码点算，emoji 计 1 个字，
    超长取前 28 字 + `……`，总长不超过 30）；图片写 `[图片]`，表情包写
    `[表情包:摘要]`，@ 写 `@QQ号`，其余非文本段沿用 `labelForSegment` 的占位符；
  - 放在「来源标记」之后、`[QQ · 地点] 谁：正文` 之前 —— 与正文**分成两个字段**，
    不掺进 `text` 里：指令解析（subsend / fileget / whitelist / help）与唤醒判据
    全都建立在原文上，引用行混进去会破坏前缀匹配。
  - 提示词（`buildUsagePrompt` 的【你会看到什么】）教了她这一行的读法。
- **只展开一层**（用户要求）：被引用消息自己带的 reply 段在摘要里**一律跳过**
  —— 既不再调 `get_msg` 去取「引用的引用」，摘要里也不出现它的痕迹。模型看到
  一层引用就够分清上下文了，再套一层只会增加噪音（被引用消息里的合并转发段
  同样只留 `[合并转发]` 标签，不去取）。
- **取不到 / 被撤回 → 明确提示，绝不丢消息**（与合并转发、图片落盘同一口径）：
  `get_msg` 报错（含 retcode 失败，如被撤回）、回包不是消息对象、取到了但消息体
  （`message` / `raw_message`）为 null —— 一律在正文前面写 `[引用：原消息取不到]`，
  原消息照常进策略，同时写 warn（**不吞错**）。取到了但内容实在抠不出来
  （如纯 reply 段套 reply 段的空壳）写 `[引用 @某人：未知内容]` —— 消息在，
  只是没内容，不用失败话术误导。
- **只记录（没唤醒）的路也展开**：`quoteLine` 一起进缓冲，「未唤醒期间聊天记录」
  的摘要行里照样看得出谁回了哪句话（`小明: [引用 @群名片小红：今天吃什么]\n记一句…`）。
- **新导出（便于测试）**：`REPLY_QUOTE_FAIL_LABEL` / `REPLY_QUOTE_MAX_CHARS` /
  `quotedMessageSender()` / `quotedMessageSummary()` / `buildReplyQuoteLine()`。
- **新测试 `qq/test-reply-quote.mjs`（69 条断言，假响应）**：纯函数矩阵
  （发送人优先级、摘要的 array / CQ 两种形态、图片 [图片]、表情包摘要、reply 段
  跳过、恰好 30 字 / 超长截断 + 省略号、emoji 按码点计、消息体缺失兜底、空入参不抛错）
  + 端到端（假 OneBot WS，mock 的 `get_msg` 按 id 回假消息 / 回 retcode 失败 / 回
  空消息体）：**普通消息一个字不变、也不调 get_msg**；array 形态引用拼出带群名片
  的摘要行且 `get_msg` 参数正确；**被撤回留 `[引用：原消息取不到]` 且正文不丢**；
  空消息体（另一种撤回形态）同样提示；被引用消息带图片 → 摘要写 `[图片]`；
  **引用的引用不递归**（只多一次 get_msg、摘要里看不到内层）；CQ 码形态同样展开；
  群聊正文行带群名；**未唤醒记录的摘要里也能看到引用行**。全量 `qq/test-*.mjs`
  回归通过（18 个文件）。
- 版本：`dsh-qq-bridge`（vendored `qq/`）0.1.10 → **0.1.11**，合并包 `dsh-fish-qq` 1.1.7 → **1.1.8**。

### `whitelist <QQ号>`：主人加私聊白名单，QQ 上一句话的事（2026-10-29）

- **起因**：白名单是 fail-closed 的核心闸门（空 = 谁都不能唤醒），但加人以前
  只能去 DSH 设置界面改。主人在 QQ 上时想把某个人放进来，得另开一台电脑，
  体验配不上这个高频操作。现在主人直接在 QQ 里发 `whitelist <QQ号>` 就行。
- **入站拦截（`^whitelist\s+(\d+)$`）**：解析写成 `parseWhitelistCommand`，
  与 `parseAddFriendCommand` 同一套口径 —— 前缀在开头（大小写 / 首尾空白不敏感）、
  5–12 位数字（QQ 号的合法形状，与 `QQ_ID_RE` 一致；主人给的判据 `\d+` 故意
  收窄成 5–12 位 —— `whitelist 12` 这种聊天碎片不该被当成指令）、整条消息
  到那为止（`whitelist 10001 你好` 不是指令）。
  - **只有发送者是 `ownerQQ` 才认**（对本机就是 10001，走的是配置里的
    `ownerQQ`，没有写死）。非主人发一模一样的字 → **只是普通聊天**：
    不解析、不加人、桥接层不回任何话（与 subsend / addfriend 完全同一处理）。
  - **不需要「一次性授权」那套**：subsend / fileget / addfriend 的授权制是因为
    要她（模型）替主人执行有副作用的动作；whitelist 桥接层自己就能做完 ——
    命中 = **立刻写名单 + 立刻回一句确认，全程不叫模型**（与 help 同一级，
    也不进「未唤醒期间聊天记录」、不产生任何模型调用）。
  - **排在 `isAllowed` 之前**：白名单空 = 谁都被 drop，但主人必须还能从 QQ 里
    加回第一个人（否则空名单时主人在 QQ 上连话都说不成，只能去界面改设置）。
    这是唯一一条「不需要已经在白名单里也能用」的主人指令，安全靠 `ownerQQ`
    本身攥着。群聊里也一样能用（回在群里）。
- **存储刻意不另起一套**：白名单就是设置里那一项 `whitelist` ——
  0.2.x 宿主（本机 dsh-desktop 0.2.1-rc.2 即此路）写到
  `$DSH_HOME/qq-bridge-settings.json` 的 `values.whitelist`，与设置卡片
  **同一个文件、同一份结构**（卡片 POST 的 `set` 也是把合并后的有效值整段
  写进去，两者写法一致、互不破坏）。0.1.5 老宿主的值在 settings 命名空间里，
  桥接层没有写入接口 —— **如实回「没写成 + 请在设置界面手动加」**，
  不偷写一个 `readSettings` 根本不读的文件装成功。
- **不用重启**：`writeSettingsFile` 写完会清掉 mtime 缓存，下一条入站消息
  调 `readSettings()` 就能读到新名单 —— 加的人**立刻**能唤醒，主人也不用
  去界面改。注意：**改的是名单，不是代码** —— 插件本身那一份新逻辑
  （这条指令的识别）仍要等下次加载插件（重启宿主）才生效。
- **重复加识别**：名单里已有同一个号 → 回一句「QQ x 已经在私聊白名单里了，
  不用重复加」，名单不重复追加；加成功回一句带号码的确认
  （「已把 QQ x 加进私聊白名单，现在就能叫醒我了（不用重启）」）。
- **顺带**：`sendHelpReply` 抽成了通用的 `sendBridgeReply`（help 列表与
  whitelist 确认共用同一条「桥接层直发」通道），`buildHelpText` 的指令列表
  补了 `whitelist <QQ号>` 一条。
- **测试 `qq/test-whitelist.mjs`（70 条断言）**：纯函数矩阵（解析合法 / 非法、
  回复文案三档）+ 端到端（假 OneBot WS、0.2.x 宿主形状的 ctx）：
  **空名单 bootstrap**（主人不在名单也能加回自己）／**热生效**（写完文件，
  同一进程里下一条消息立刻能唤醒）／**重复加提示**／**非主人无效**（在白名单的
  朋友发同样的字 = 普通聊天，无直发回复、名单不变；不在白名单的陌生人被 drop）／
  **群聊回在群里**／**legacy 宿主如实报不可写、不偷写文件**。
  全量 `qq/test-*.mjs` 回归通过（17 个文件）。
- 版本：`dsh-qq-bridge`（vendored `qq/`）0.1.9 → **0.1.10**，合并包 `dsh-fish-qq` 1.1.6 → **1.1.7**。

### 入站图片 / 表情包落地：`[图片 path=…]`，她会自己看图了（2026-10-29）

- **起因**：群里 / 私聊有人发图，鱼那边收到的是空壳 —— 目标会话的模型多半看不了图
  （附件被系统剥成 “image omitted”），多模态描述也只是「可能不准的转述」，
  她只能说「图是空的」。现在把图**落到她磁盘上的一个固定目录**，并把**路径**写进
  投递给她的正文：她拿路径调自己的 `image_look` 就能亲眼看，不再靠别人转述。
- **目录定在哪**：`~/.dsh-fish/attachments/`（与 `fish/lib/store.js` 的 `rootDir()`
  同一解析口径：`DSH_FISH_HOME` 或 `~/.dsh-fish`；这台机器就是
  `C:\Users\user\.dsh-fish\attachments\`）。挂在大肥鱼状态库下，是因为她的
  `image_look` 直接打开那里的**绝对路径** —— 这是「她自己能看见」的关键。
  原来的 `$DSH_HOME/qq-bridge-images/` 目录挪了过去（落盘、命名、淘汰逻辑全部复用，
  旧目录里残留的文件不会被删，也不再往里写）。旧图想接着用（按哈希找回 / 存表情包）
  可以手动复制过去：`Copy-Item $env:USERPROFILE\.dsh\qq-bridge-images\* $env:USERPROFILE\.dsh-fish\attachments\`
  （本机旧目录里有 27 张历史图；写主目录被沙箱拦了，没自动迁）。
- **投递文本的格式**（就地替换占位符，与 `[图片#短哈希]：描述` 同一套逐位对齐口径）：
  - 图片落盘成功：`[图片 path=<绝对路径/正斜杠> #短哈希]：<多模态描述>`；
    没拿到描述时写 `[图片 path=…]（未描述）`。
  - 表情包（mface）落盘成功：`[表情包:<摘要> path=<路径>]`；
    下不动 → `[表情包:<摘要>]：图片没取到`（明确的占位提示，**不静默丢弃**）；
    没带链接的 mface 渲染回 `[表情包:<摘要>]`（**没链接 ≠ 下载失败**，不写「没取到」），
    消息绝不整条消失。
  - 路径一律正斜杠（fish 侧 markdown 渲染与路径处理按它取文件，见 fish/lib/posix.js）。
  - **图片内容本身不塞进正文**（无 base64、无字节），正文里只有路径。
- **落盘规则**（`cacheImage`，图片与 mface 共用，命名与淘汰不变）：
  - 文件名 = 内容哈希 `<sha256 前 16 位>.<ext>`：同一张图重复出现不重复落盘，
    而且命中已有文件时照样能拿到哈希（表情包登记与描述缓存按哈希认图）；
  - 扩展名按**真实格式**（文件头嗅探 png/jpg/gif/webp，不信 URL 或 content-type）；
  - **单张超过 10MB 不下载**：有 `Content-Length` 时先拦截、body 都不读；
    没有就读完再判（11MB 的 body 也不落盘）；
  - **不是 png/jpg/webp/gif 的跳过**（落下来她也看不了）；下载 / 读取失败
    一律记一行 warn（`图片缓存失败：<url> -> <原因>`），返回 `null`
    → 占位符退回「（未描述）」，消息照常进策略；
  - 除了 HTTP(S) 的 `url`，还认 `base64://…`（含 `data:…;base64,`）
    与本机绝对路径两种形态（OneBot 的 `file` 字段可能是它们），直接解码 / 读取，
    不必走一个注定失败的 HTTP 请求；
  - 失败的流程**不留任何文件系统副作用**：建目录推迟到真要写盘那一步。
- **清理**：目录最多留 **200** 个文件（`MAX_IMAGE_CACHE_FILES` 300 → 200，
  用户定的数），外加 64MB 总量上限，超了按 mtime 删最旧的。
  `qq_bridge_status` 新增 `attachments` 段：目录、文件数、字节数、三档上限
  ——「目录别无限涨」这件事看得见。
- **只记录（没唤醒）的图**：record 路径同样落盘，摘要渲染时也填回路径
  —— 她在「未唤醒期间聊天记录」里也能回看那些图。
- **提示词**：`buildUsagePrompt()` 的【你会看到什么】改教新格式 ——
  `path=` 后面就是图本身、想亲眼看就调 `image_look`、描述可能不准、
  短哈希仍指着具体的图去存 / 发表情包。
- **测试 `qq/test-images.mjs`（63 条断言）**：
  纯函数矩阵（`inlineImageNotes` 的路径渲染 / 老 fixture 一个字不变 /
  `inlineMfaceNotes` 成功 / 失败 / 无摘要 / 无链接 / 多余占位符）＋ 端到端
  （假 OneBot WS + 假 fetch + `DSH_FISH_HOME` 指到临时目录）：
  **图片段产出带路径的文本**（文件内容就是下载的图、扩展名按真实格式、
  内容不进正文）、**按内容哈希去重**、**失败留占位提示**（网络错误 / HTTP 404，
  warn 带原因）、**超 10MB 被跳过**（声明的 body 都不读）、**纯文本字节被跳过**、
  **mface 落一份 / 下不动有提示 / 没链接不尝试下载 / 混排时逐位对齐不顶位**、
  **纯表情包消息不丢**、**只记录的图在摘要里也能看到路径**、**超 200 文件删最旧的**。
  `test-smoke.mjs` 受影响的断言（描述格式、用法说明、M2 与视觉模型用例）
  同步改成新格式，并给图片落盘目录加了一道 `DSH_FISH_HOME` 重定向
  （否则测试会写进用户真实的状态库）。
- 版本：`dsh-qq-bridge`（vendored `qq/`）0.1.8 → **0.1.9**，合并包 `dsh-fish-qq` 1.1.5 → **1.1.6**。

### 授权制加好友 `addfriend` / `qq_bridge_add_friend`（2026-10-28）

- **起因**：要能主动加别人好友，但「谁能下这个命令」必须攥在主人手里 ——
  不能让鱼自己想加谁加谁，也不能让群友@一下就触发。所以做成**授权制**：
  主人发指令，鱼来执行，授权用一次就没了。
- **入站拦截（`^addfriend\s+(\d+)$`）**：加在 `decide()` 的主人指令分支里，
  与 subsend / fileget 同一套桥接层判据 —— **只有发送者是 `ownerQQ` 才认**
  （对这台机器就是 10001，走的是配置里的 `ownerQQ`，没有写死）。
  - 命中 → **必唤醒**（`reason: 'owner-addfriend'`，排在 `atOnlyInGroup` 之前，
    群里也一样），正文后附一段「这是主人的 addfriend 授权」系统通知，写清
    主人授权了哪个号、工具怎么调、每天限几次、不支持时怎么办。
  - 非主人发一模一样的字 → **只是普通聊天**：不解析、不附授权说明、不回复任何话
    （带 `NON_OWNER_MARKER`，与 subsend 完全同一处理）。
  - 指令**不带正文**（`addfriend <QQ号>` 后多一个字就不是指令）——
    加不加、验证消息写什么都由她决定，不用主人替她写。
- **命中后不直接发申请**：只投授权通知 + 一次性授权。新工具 `qq_bridge_add_friend`
  的参数是 `targetQQ`、`comment`（验证消息，≤50 字，超了截断不拒发）。
- **用的是哪个 OneBot 动作（先查清再发）**：调研了三个来源，结论一致 ——
  **本机 NapCat 不存在「主动发送好友申请」的动作**：
  ① NapCat 官方 API 列表（doc.napneko.icu 的 `/onebot/api` + `/develop/api`）：
  好友相关只有 `get_friend_list` / `send_private_msg` / `send_like` /
  `set_friend_add_request`（**处理**别人发来的申请：`flag`/`approve`/`remark`）/
  `set_friend_remark` / `delete_friend` / `friend_poke` …，以及处理入站可疑申请的
  `get/set_doubt_friends_add_request` —— 没有一个能主动发起；
  ② 本机实体 `NapCat.Shell/napcat.mjs` 的动作表逐项 grep：friend 相关只有
  `SetFriendAddRequest: "set_friend_add_request"`，没有 `send_friend_request`；
  ③ go-cqhttp 同样没有。
  因此实现成**探针式**：候选动作表 `FRIEND_REQUEST_ACTIONS = ['send_friend_request']`
  （刻意**不**列 `set_friend_add_request` —— 它处理的是别人的申请，乱调等于
  在通过/拒绝别人的申请，有真实副作用）。逐个调过去：被支持的那一下就是真发；
  不支持时 NapCat 回 `不支持的Api <action>`（retcode 1404，**无副作用**），
  被 `isUnsupportedActionError` 认出来，如实返回
  `reason: 'unsupported-action'` + 实现信息（发之前先调 `get_version_info` 认的）
  + 一段写清现状的中文说明，让她转告主人，**不装成功**。
- **授权一次性 + 锁号**：授权只在主人发指令后的那一轮里有效
  （`claimedAddFriendGrant` 注入时置位 → `turn/start` 快照到
  `currentTurnAddFriendGrant` → `turn/end` 清空，与 `currentTurnFromOwner`
  同一套生命周期；唤醒投递失败按快照回滚，授权也一并回滚）。
  - 工具调用**成功**那一下立即消费（同一轮里再调 → `no-grant`）；
  - 失败（含不支持、超限）与被拒**不消费**，同轮可重试；
  - 锁死 `targetQQ`：授权的是哪个号就只能加哪个号，改号 → `wrong-target`，
    回执带上授权的那个号；
  - 她明确拒绝（这轮里说不加）→ 这一轮过去授权自然作废，不用再发指令。
  - 没有 grant 的轮次（群友 @ 的轮、主人别的指令的轮）调工具一律 `no-grant`。
- **限额（持久化）**：每天最多 **3 次**（`ADD_FRIEND_DAILY_LIMIT`，固定的安全上限，
  不进设置页），只有真的发出去才计数；超了返回明确的中文错误（写清今天已发几次、
  上限几次）、**连接口都不探**、不占额度、不落 outbox。计数落
  `state.addFriend = { dayKey, count, lastAt }`（跨天作废、重启不丢，
  与 proactive / subsend / fileSend / checklogNotify 同一份 state）。
- **`qq_bridge_status` 新增 `addFriend` 段**：dailyLimit / todayCount / lastAt /
  这一轮的 grant（锁了哪个号）—— 排障与观测用。
- **工具面放行**：合并包 `fish/lib/restrict.js` 的 `QQ_BRIDGE_TOOLS` 加入
  `qq_bridge_add_friend`（8 个），否则她的兜底守卫会回一句
  「这件事我做不到。」（2026-10-26 subsend 真机踩过同一个坑）。
  `fish/test/restrict.test.mjs` 的清单随之从 7 个改到 8 个。
- **提示词与 help**：`buildUsagePrompt()` 在配了 `ownerQQ` 时多一节
  【加好友：主人授权了才能加】（怎么认授权、targetQQ 不许改、每天 3 次、
  不支持时据实转告不要编成功）；`buildHelpText()` 的指令列表加一行
  `addfriend <QQ号>`。
- **非 QQ 轮（DSH 界面里）走两步确认**：第一次只回「确认要发吗」一个字不发，
  同一轮再调才真的执行（与 send / subsend / 发文件同一手感，确认状态独立、按轮清零）。
- **新测试 `qq/test-add-friend.mjs`（99 条断言，假响应）**：纯函数矩阵
  （解析：合法 / 大小写 / 空白 / QQ 号 5–12 位边界 / 指令后多一个字 / 不在行首 /
  长得像的别的指令；限流：上限 / 跨天 / 上限 0；授权说明内容）+ 端到端
  （假 OneBot WS，对 `send_friend_request` 可切换「不支持」模式，回包与真机
  NapCat 同款 retcode 1404 `不支持的Api`）：
  **主人指令触发授权通知**（正文带授权说明、且命中指令时一个申请都没发）、
  **非主人无效**（不附说明、调工具 `no-grant`、群里 @ 也不行）、
  **授权锁号 + 一次性**（改号 `wrong-target`、成功后同轮再调 `no-grant`、
  被拒不消费）、**不支持时如实报回**（reason/message/attemptedActions、
  不占额度、不落 outbox、同轮重试能成功）、**超限被拒**（每天 3 次封顶、
  中文错误、连接口都不探、不占额度）、**持久化**（计数落盘、重启后上限照样挡），
  以及两步确认与普通聊天不受影响。
- 版本：`dsh-qq-bridge`（vendored `qq/`）0.1.7 → **0.1.8**，合并包 `dsh-fish-qq` 1.1.4 → **1.1.5**。

### 出站 `@QQ号` 变成真正的 at 消息段（2026-10-28）

- **问题**：以前鱼发出去的 @ 只是正文里的 `@123456` 这几个字符。QQ 客户端不认识它，
  对方收不到提醒，界面上也不会显示成可点的蓝色昵称 —— 等于没 @。
- **改法**：出站不再把整段话塞进一个 `text` 段，而是先按 `@QQ号` 切开，拼成
  `[{type:'at', data:{qq:'10001'}}, {type:'text', data:{text:' 你好'}}]` 这样的消息段数组，
  再交给 OneBot/NapCat。一条消息里多个 @、@ 在中间，都按出现顺序拆成 text/at/text/…；
  文字原样保留（不 trim、不吞空格），还原后与原文逐字一致。
- **判据（宁可不 @，也不误 @）**：只认「@ 后面**直接**跟 5–12 位数字」（与 `QQ_ID_RE` 同形状）。
  - `@小明`、`@全体成员` 这类昵称 @ 一律保持纯文本 —— 昵称映射不到 QQ 号，不猜；
  - `name@123456.com` 这种邮箱、`abc@123456` 这种紧贴字母的 @ 也不算提及（前后都有边界判断）；
  - `@1234`（太短）、`@1234567890123`（太长）同理不转。
- **显式 at 目标**：`qq_bridge_send` / `qq_bridge_send_multi` / `qq_bridge_subsend` 新增可选参数
  `atQQ`（单个号、逗号/空格分隔、或数组），拼在正文最前面；分条发送只加在第 1 条上。
  正文里已经 @ 了同一个号时不再重复加 at 段（同一个号连点两下只会多一条提醒）；
  `atQQ` 里不是合法号的项直接忽略，不影响正文照发。
- **覆盖的出站路径**：`sendToQQ()`（`qq_bridge_send`、`qq_bridge_send_multi`、marker/always
  标记块共用它）、`sendSubsendToTarget()`（`qq_bridge_subsend`）、`sendProactiveToOwner()`
  （主动私聊）。纯文本消息的行为与以前完全一致（仍然只有一个 text 段）。
- **提示词**：`buildUsagePrompt()` 的「怎么把话说回 QQ」加了一段：要真 @ 就写 `@QQ号`；
  `@昵称` 不会变成提及；不确定号就别编号。
- **新测试 `qq/test-at-segments.mjs`（48 条断言）**：纯函数矩阵（数字 @ / 昵称 @ / 邮箱 /
  太短太长 / 多个 @ 顺序 / 显式 atQQ 去重与非法项 / 空文本）+ 端到端（假 OneBot WS）：
  `qq_bridge_send`、`qq_bridge_send_multi`、`qq_bridge_subsend`、marker 标记块四条路
  发出去的帧里都带 at 段，且正文一个字都没丢。
- 版本：`dsh-qq-bridge`（vendored `qq/`）0.1.6 → **0.1.7**，合并包 `dsh-fish-qq` 1.1.3 → **1.1.4**。

### 分条发送 `qq_bridge_send_multi`（2026-10-28）

- **新增工具 `qq_bridge_send_multi`**：模型主动调用，一次把 **1–3 段文字按顺序分条**发到 QQ。
  参数 `messages` 是字符串数组，另可给 `userId` / `groupId`（都不给就发最后一次入站目的地）。
  不再用正则去拆普通回复：分几条、每段说什么由模型决定，桥接层只负责按顺序发。
- **参数校验在工具里判**：空数组、超过 3 条、空条目、非字符串一律返回 `ok:false` 并说明第几条，
  **一条都不发**。dsh 的工具参数 schema 不支持 `minItems`/`maxItems`，写进 schema 也不会生效，
  所以长度上限是执行时自己判的（`validateMultiSendMessages()` 导出可测）。
- **逐条发送 + 打字停顿**：私聊走 `send_private_msg`、群聊走 `send_group_msg`（复用 `sendToQQ()`）；
  每两条之间随机停 **500–1000ms**（`multiSendGapMs()`，可注入 random 测边界），不是只写在回执里。
  引用触发消息只加在第 1 条上；每条成功都记 `outbox`（`via: 'tool'`、`action: 'multi'`、`index`/`total`）。
- **发之前先整组预检**：所有条目先去 Markdown、判空、判字数，再开始发 ——
  「第 3 条太长」不会先把前两条发出去留个半截。中途仍失败（OneBot 报错）则**如实返回**：
  `ok:false` + `sent`（已发出几条）+ `failedAt`（第几条）+ `reason`/`error`，**绝不报成功**；
  失败那条记进 `dropped` 台账，已成功的那几条照旧在 `outbox` 里，对得上账。
- **与 marker 模式兼容（不重复发送）**：工具至少成功发出 1 条后，把按轮标记 `multiSentThisTurn` 置位；
  该轮 `turn/end` 看见它就把 `[QQ]…[/QQ]` **整段丢弃**（`always` 模式同理），
  同一段话不会既分条发一遍、又整段再发一遍。全部失败（0 条发出）时不置位 ——
  一个字都没到，标记块照常发出，不吞消息。标记与其它按轮状态同生命周期：`turn/start` / `turn/end` 清零。
- **来源闸门与 `qq_bridge_send` 同一道**：不是 QQ 唤醒的那一轮，第一次调用只回一句确认、一个字不发；
  同一轮再调一次才真的发。参数校验排在闸门之前，参数写错不消耗确认次数。
- **提示词**：`buildUsagePrompt()` 在「怎么把话说回 QQ」一节加了两行 ——
  想分条发就调它，**调过之后这一轮不要再写 `[QQ]` 块**（那一整段会被丢弃）。
- **新测试 `qq/test-send-multi.mjs`（63 条断言）**：纯函数矩阵（1/2/3 条通过、4 条 / 空数组 /
  空条目 / 非字符串拒绝、停顿上下限与异常 random）+ 端到端（假 OneBot WS）：
  2 条真的分两帧发且间隔 ≥500ms、3 条按序、4 条与空数组一条不发、群聊走 `send_group_msg`、
  marker 模式下 `[QQ]` 块整段丢弃（含部分成功那轮）、全部失败时标记块照常出站、
  中途失败如实报 `sent`/`failedAt`/原始 retcode。`test-smoke.mjs` 的工具数 11 → 12。
- 版本：`dsh-qq-bridge`（vendored `qq/`）0.1.5 → **0.1.6**，合并包 `dsh-fish-qq` 1.1.2 → **1.1.3**。

### 读懂合并转发（2026-10-28）

- **起因**：别人在 QQ 里转发的合并消息，进来只有 `[合并转发]` 四个字，里面说了什么全丢。
  OneBot v11 对这种消息只给一个 `forward` 段（`{type:'forward', data:{id}}`），内容要另调动作取。
- **取回并就地展开**：`mapOneBotMessage()`（array 与 string/CQ 两种形态都覆盖，
  string 形态从 `[CQ:forward,id=…]` 里抠 id）把每个 forward 段记成 `[合并转发]` 占位符 + `forwardIds`；
  `handleOneBotEvent()` 在进策略**之前**调 `get_forward_msg({message_id: id})` 取回节点，
  由 `renderForwardNodes()` 拼成「发送人：文本」的多行文字，**就地替换占位符**（与图片描述
  就地填回同一套道理：位置本身就是信息）。唤醒与只记录两条路看到的都是展开后的正文，
  「未唤醒期间聊天记录」的摘要里也不再只有四个字。节点正文格式：
  `[合并转发 · N 条]` 开头、`[合并转发结束]` 收尾，发送人取群名片 > 昵称 > QQ 号。
- **嵌套再展开一层**：转发里套转发时，`MAX_FORWARD_DEPTH = 2` —— 外层那层之外**再展开一层**，
  更深的如实标 `[合并转发：层级过深，未展开]`。这是「选择不展开」，与「读取失败」明确区分，
  不用失败话术误导。
- **失败兜底，绝不丢消息**：取不到（action 报错 / retcode 非 0）、取到了但 `messages` 为空、
  渲染抛错、转发段没带 id —— 占位符一律换成 `[合并转发：内容读取失败]`，消息照常进策略，
  同时写 warn（**不吞错**）。一条消息里多个转发按占位符顺序逐个替换，一个成一个败也互不影响。
- **转发内的图片用独立标签 `[转发内图片]`**：`inlineImageNotes()` 按出现顺序逐位替换正文里的
  `[图片]`（配描述与短哈希）；转发里的图不下载、没描述，若也写 `[图片]`，就会把顶层图片的
  描述与短哈希错配给转发里那张。其它段（语音 / 表情 / 文件……）是纯文本标签，沿用
  `labelForSegment()`。
- **新导出（便于测试）**：`FORWARD_LABEL` / `FORWARD_FAIL_LABEL` / `FORWARD_DEPTH_LABEL` /
  `MAX_FORWARD_DEPTH` / `forwardNodeSender()` / `forwardNodeContent()` / `wrapForwardBlock()` /
  `replaceForwardPlaceholders()` / `renderForwardNodes()`。`renderForwardNodes()` 的
  `fetchForward` 由调用方注入（桥接层里是 `get_forward_msg`），嵌套渲染纯单元可测。
- **顺带**：`mapOneBotMessage()` string 形态里抠 CQ 图片参数的那段内联拆解提成 `parseCqParams()`，
  与新增的转发 CQ 处理共用一份逻辑。
- **新测试 `qq/test-forward.mjs`（68 条断言）**：纯函数矩阵（发送人优先级 / 头尾包裹 / 占位符
  逐位替换与多余保留 / 嵌套展开与层级封顶 / fetcher 抛错不中断渲染）+ 端到端（假 OneBot WS，
  mock 的 `get_forward_msg` 按 id 回节点或回失败包）：普通消息一个字不变、也不调
  `get_forward_msg`；array 形态转发拼出多行正文；string 形态 CQ 码同样展开；嵌套再展开一层、
  第三层标未展开；retcode 失败与空节点都兜底成失败提示且消息不丢；一条消息两个转发按序替换；
  未唤醒的转发消息进缓冲后、摘要里看得到正文。
- **调试花絮（供后人避坑）**：第一版测试死活连不上 mock，排查到是测试里手写的
  RFC 6455 `WS_GUID` 常量少了一个 `F`（写成了 `258EA5…`，正确值是 `258EAFA5…`）——
  客户端校验 `Sec-WebSocket-Accept` 不通过，连接被静默拒绝（1006）。产品代码没问题。
- 版本：`dsh-qq-bridge`（vendored `qq/`）0.1.4 → **0.1.5**，合并包 `dsh-fish-qq` 1.1.1 → **1.1.2**。

### 测试 + 边界写死（2026-10-28，任务书 7）

- **钉死「重启会漏」**：`test-checklog-wire.mjs` 新增「边界（任务书 7 钉死）」段——
  CheckLogs 目录里先放好「上一次进程」留下的旧 `.md`，起新实例、等足 150ms →
  一个帧都没有、计数没动、台账里没有 checklog；然后**同一个进程**里真派一件、
  turn/end 也来了 → 照发不误、计数 +1。前半钉死「不扫旧目录补发」，后半证明
  那是边界而不是通道坏了。哪天有人手痒加「启动时补发未读日志」，这里会 FAIL。
- 任务书 7 列的七条场景由三个套件分摊（`test-checklog-notify.mjs` 顶部有对照表）：
  off 不发 / 成功默认不发 / 失败发+outbox / 超限被限流 / agent 档她说的话 /
  agent 档没文本退模板 / 新进程旧文件不发。没有为了凑在一个文件里而重复造轮子。
- 文档把同义句写进两处：`对接文档.md` §7.3 + §11 边界表、`功能文档.md` §6.8 ——
  **任务通知只在本进程 turn/end 时触发；DSH 重启或插件停用期间结束的任务不会补发。**

### 设置卡片 + 文档（2026-10-28，任务书 6）

- **界面可切换**：`client/client.js` 的卡片表单加 4 项——
  「任务完成通知」（select：`off` 关 / `system` 系统模板 / `agent` 让她自己说）、
  「成功也说一声」（boolean）、「通知每天上限」（number）、「通知发给谁」
  （select：`owner` / `last`）。前三档文案里直接把行为说清楚（含「她没说就退回模板」）。
  之前这 4 个键只在 Schema 里有、卡片上改不到；`test-smoke.mjs` 里为此留的
  `PENDING_CARD` 豁免随之删除，并新增断言：三个 select 的选项逐字正确。
- **构建链**：`scripts/build-bundle.mjs` 依赖已归档的源目录（`dsh-fish/`、
  `dsh-qq-bridge/`），本环境跑不起来 → 这次是**手改生成物** `dsh-fish-qq/client.js`
  （与源 `qq/client/client.js` 同步同段、机器比对一致）。
  **待构建链修复后重生成**（恢复源目录或改脚本从本包取数）。
- 文档：`对接文档.md` §4.4 表加 4 行（34 → 38 项）；`功能文档.md` 新增 §6.8
  「任务完成通知」，写清 A 档（她自己说）/ B 档（模板）/ off、每日上限、重启会漏。

### checklog 通知 · agent 档与正式模板（2026-10-28，任务书 5）

- **system 档换成正式模板**（`buildChecklogNotifyText`，替换任务书 3 的占位文案）：
  `[任务通知] 工作·写hello.py 完成了（耗时 3 分 12 秒）。` / `… 失败了：出错（耗时 …）。`
  / `… 超时了（等了两小时还没结束）。`——三行、中文、口语。「原因」取自 fish 侧
  `describeTurnEnd` 中文状态括号里那一句（`失败（出错）` → `出错`），为此
  `buildTaskResult` 多带一个**已有字段** `status`（写日志用的那个，不重复计算）。
- **agent 档接上**（`mode='agent'`）：事件监听器按档分流——
  - system：`notifyTaskFinished`（门禁 → 模板 → 发）。
  - agent：`deliverChecklogAgentSituation` 复用主动私聊的投递链路（ensureTargetAgent →
    `followup` 投一句「处境」：`你刚派出去的活儿有结果了：任务=…，结果=…，耗时=…。
    用一句话跟主人说一声。`）→ 她那一轮的 `assistant/message` 攒进 `pendingReply` →
    `turn/end` 抽出来（套 [QQ] 块的抽里面）直调 `send_private_msg` 发主人（**绕 replyMode**）。
  - **两档共用同一道门禁、同一个计数段、同一个发出口**（`gateChecklog` /
    `sendChecklogNotice`），区别只在「谁写这句话」。
- **兜底**：agent 档她一个字都没说 → 退回 system 模板补一条，别静默；她的轮还占着
  （上一条没说完 / 主动私聊中）、会话拿不到、投递被拒、15 分钟没结束——全部退回模板。
- 频率闸与状态库**同任务书 3**：失败/超时必发、成功看 `checklogNotifyOnSuccess`、
  每日上限、跨天作废、只有真发出去才计数。outbox / 台账多一个 `spokenBy`
  （`agent` ｜ `template`），事后查「这条是谁写的」不用猜。
- 新测试 `qq/test-checklog-agent.mjs`：切 agent 档 → 收到**她说的话**（端到端：
  同一个 ctx 派活 → 处境投给她 → 她回一句 → 发主人）；她没说 → 模板兜底；
  成功默认不投、开 `checklogNotifyOnSuccess` 后投；她的轮占着 → 模板；没目标会话 →
  模板；两件各占一条额度。`test-checklog-notify.mjs` 补模板 / 处境 / 转发出口的断言。

### checklog 通知接线：共享事件 `checklog/finished`（2026-10-28，任务书 4）

- 把任务书 3 的通知核心接上 fish 侧的日志写入：fish 每在 `CheckLogs/` **写成**一条
  `.md`，就往宿主事件总线 emit `checklog/finished`；qq 侧 `apply()` 里
  `ctx.on('checklog/finished')` 接住，交给 `notifyTaskFinished` 按设置发 QQ 私聊。
- **fish 不 import qq**（破坏装配顺序与独立安装）：两边只约定事件名与载荷契约
  （`fish/lib/checklog.js` 的 `buildTaskResult`：`ok` / `reason` / `task` /
  `sessionTitle` / `sessionId` / `startedAt` / `endedAt` / `elapsedMs` / `file`，
  全是既有字段的搬运，不重复计算）。没人喊 / 没人听都各自安好。
- **只有写成功才 emit**（`writeTaskLogAndAnnounce`，写失败返回 `announced:false`）：
  日志是事实，通知是衍生物——写不出来时喊一声等于让 qq 去通知一件没留下痕迹的事。
- 无条件注册监听、设置在事件到达时现读：设置页改 `checklogNotifyMode` /
  `checklogNotifyOnSuccess`，下一条日志就按新值走，不用重挂。停用插件时宿主
  销毁 ctx、`ctx.on` 注册的监听一并摘掉——fish 那边还在派活，也不会再有人通知
  （验收第 3 条的边界）。
- 新测试 `qq/test-checklog-wire.mjs`：三条验收端到端——apply 后用**同一个 ctx**
  派活（复刻合并包装配）：必然失败的任务 → 真的发出 `send_private_msg` 帧 +
  outbox + 计数 + 台账；成功任务默认不发、写 `checklogNotifyOnSuccess` 后立刻发；
  摘掉监听（= 停用插件）后再派活 → 日志照写、通知一个帧都没有。另有「默认
  mode='off 喂什么都不发」的地基。

### checklog 通知核心 · system 档（qq 侧，2026-10-28，任务书 3）

- 新文件 `qq/checklog-notify.js`：`notifyTaskFinished(result)` —— 任务做完后按结果
  决定要不要发一条 QQ 私聊。**不接触发**（不监听 turn/end，index.js 也不调它，
  接线在任务书 4），纯依赖注入 + 纯函数，单元可测。
- 判据：mode 只认 `'system'`（`'off'` 关、`'agent'` 是后续任务书的另一条通道）；
  失败 / 超时**必发**，成功只在 `checklogNotifyOnSuccess` 打开时发。
- 频率闸：读 `state.checklogNotify`（`dayKey` / `count` / `lastAt`，新增 state 段，
  loadState 逐字段校验），跨天作废，超 `checklogNotifyDailyLimit` 不发且台账记
  「被限流」；`0` = 一条都不发。**只有真发出去才计数**，被拒不占额度、不落 outbox
  （与 subsend / proactive 同口径）。
- 目标：`checklogNotifyTarget='owner'` 发主人；`'last'` 发最近一次有往来的私聊，
  最近是群（或没有）→ 回落主人并在台账标 `fallback`；防自环（不发给 selfId）。
- 新导出：`shouldNotifyChecklog` / `resolveNotifyTarget` / `buildChecklogNotifyText`（占位模板，
  任务书 5 换正式文案）/ `createChecklogNotifier`（缺依赖时构造即报错）。
- `qq_bridge_status` 加 `checklogNotify` 段（mode / onSuccess / dailyLimit / target /
  todayCount / lastAt），「今天发了几条」看得见。系统通知**不算**「往来」：
  不动 `state.proactive.lastActivityAt`，免得每完成一个任务都把空闲计时清零。
- 新测试 `qq/test-checklog-notify.mjs`（81 条断言）：三条验收（调函数能发出一条 QQ 消息——
  第二部分断注入的发送，第三部分接**真实** OneBot 传输（假 WS）断 `send_private_msg`
  帧本身；超上限不再发；outbox 里有这条）+ 全部边界。
- 状态库新增字段：`qq-bridge-state.json` 里 `checklogNotify: { dayKey, count, lastAt }`。

### checklog 通知配置项（qq 侧，2026-10-28，任务书 1 · 地基）

- 给「任务完成日志写好之后，要不要、以什么方式让她（或主人）知道一声」先把开关和参数立起来。
  **纯加字段，不接任何发送逻辑**——`checklogNotifyMode` 默认 `'off'`，此时什么都不发生；
  发送逻辑与界面分别在后面的任务书与任务书 6（手改 client.js）里接。
- 新字段（`Config` 与 `BridgeSettings` 同步，`cordis.patch.yml` 的 `qq:` 槽同步默认值）：
  - `checklogNotifyMode`：`'off'`（默认）｜`'system'`（系统消息注入会话）｜`'agent'（交给她自己决定）`；
  - `checklogNotifyOnSuccess`：bool，默认 `false`（只在失败 / 异常结束时说一声）；
  - `checklogNotifyDailyLimit`：整数，默认 `5`，范围 0–50（0 = 不发）；
  - `checklogNotifyTarget`：`'owner'`（默认，主人的 QQ 私聊）｜`'last'`（最近一次有来往的目的地）。
- 新导出：`CHECKLOG_NOTIFY_DEFAULTS`、`normalizeChecklogNotifyMode()`、`normalizeChecklogNotifyTarget()`、
  `normalizeChecklogNotifyDailyLimit()`；`readSettings()` 用同一套归一化，坏值（非法枚举、越界上限）
  不穿透。老模型宿主的 composition base 也补了这 4 项，否则设置页里永远是空的。
- 验收：`qq_bridge_status` 的 `settings` 里能看到这 4 个值；设置接口保存后
  `$DSH_HOME/qq-bridge-settings.json` 里有它们（见 `test-smoke.mjs` 新增 6 条断言）。
  settings 键数 34→38；卡片输入框在任务书 6 补上之前，`test-smoke.mjs` 的
  「每个 settings 键在卡片上都有输入框」对这 4 键暂设豁免。

### 任务完成日志 `CheckLogs/`（fish 侧，2026-10-27）

- 用户要的：每次派任务后，任务**完成**时在 `CheckLogs/` 里生成一个日志文件。
- 位置跟着插件目录走（`dsh-fish-qq/CheckLogs/`），不受「工作区根目录」影响；可用
  `DSH_FISH_CHECKLOGS_DIR` 改到别处。
- 「完成」= 派出去的那条会话的 `turn/end`（宿主 `session/event`）。`completed` 记「成功」，
  `max-tokens` / `aborted` / `interrupted` / `blocked` / `error` 各记各的失败说法；
  两小时等不到结束则记「超时」。
- 一个任务一个 `.md`：任务、会话、派发/结束时间、耗时、结果。**不抄她的回复正文**（用户定的口径）。
- 新文件 `fish/lib/checklog.js`（`createTaskWatcher` / `writeTaskLog` / `describeTurnEnd` 等）；
  `fish/lib/work.js` 在 `prompt()` 之前挂监听，prompt 失败就摘掉，不留等不到结束的监听。
- 边界：监听的是本进程事件——DSH 在任务跑完前重启、或插件被停用，这一次就没有日志，不假装补写。
- 新测试 `fish/test/checklog.test.mjs`（9 条）+ `fish/test/worklog.test.mjs`（3 条，验证派活 → turn/end → 落盘的接线）。

### 读文件工具 `fish_read_file`（fish 侧，2026-10-27）

- 以前她只能「看目录」，看清了有哪些文件却读不到里面写了什么。
- 新工具 `fish_read_file`（`fish/lib/readfile.js`）：`path` + `offset` / `limit`，
  `scope: 'workspace'`（默认，用户工作区）或 `'self'`（她自己的状态库）。
- `scope=self` **白名单**只放开 `events.jsonl` / `diary` / `out` / `home` / `inbox.md` /
  `talk-recent.json`——`config.json`、`owner.json`、`logs/` 这些参数与凭据不进上下文。
- 两份沙箱同一套手法：`resolve` 归一 → 必须位于根下 → `realpathSync.native` 再判
  （junction 外跳露馅）→ 普通文件、≤ 2MB。UTF-8 优先，GB18030 兜底，二进制（含 NUL）直接拒绝。
- 单次默认 400 行、封顶 2000 行、最多 24000 字；不够就带 `offset` 接着读。
- `FISH_TOOLS` 10 个；身份文档新增 `READ_FILE_BRIEF`；`fish/lib/index.js` 注册。
- 新测试 `fish/test/readfile.test.mjs`（17 条）。

### help 指令词（qq 侧，2026-10-27）

- 主人在 QQ 里发 `help` / `/help` / `帮助` / `指令`，**桥接层直接回指令列表，不唤醒模型**
  （零 token、零等待，列表不会抄错）。
- **仅限主人**：别人发同样的词不算指令，照常走唤醒策略；群里也按发送者判。
  主人的 `help` 排在 `atOnlyInGroup` 之前——不必先 @。
- 列表由 `buildHelpText()` 生成：`subsend` 关着就不列它；工作区没配时 `fileget` / `filesend`
  标明「现在用不了」。
- 决议新增 `action: 'help'`（`reason: 'owner-help'`），排在白名单之后、会话跟随与
  `atOnlyInGroup` 之前，`handleInbound` 在任何 await / 缓冲快照 / 图片下载之前分支出去；
  直发 `send_private_msg` / `send_group_msg`，不经 `replyMode` 闸门，成功记 outbox（`via: 'help'`）。
- 新导出：`parseHelpCommand()`、`buildHelpText()`、`HELP_COMMAND`、`HELP_WORDS`。
- 新测试 `qq/test-help.mjs`（41 条）。

### 工作区根目录改成设置项（2026-10-27）

- 以前 `fish/lib/listdir.js` 与 `qq/index.js` 各写死一份 `D:\demo\workspace`，换台机器就全指向不存在的目录。
- 现在统一由 QQ 桥接卡片里的「工作区根目录」提供：`fish_list_dir`、`qq_bridge_fileget`、`qq_bridge_filesend`、`work_request` 共用这一个值；留空 = 这些能力如实说没配，不猜目录。
- 合并包的宿主入口通过 getter 读取设置文件，设置页改完，下一次调用工具即生效（加载新代码本身仍需重启 DSH）。
- 移除 `WORKSPACE_ROOT` 导出；`test-filesend.mjs` 改为从测试文件位置推导仓库根，不再依赖本机路径。

### 看图工具 `image_look`（fish 侧，2026-10-27）

- 起因是她这边报过「unknown tool」、继而调工具被守卫回「这件事我做不到。」：宿主的 `read_image`
  由 `@deepseek-ai/dsh-tool-fs` 注册，**只在持久 `ctx.attachments` 服务挂载时才登记**，
  `tools.restrict()` 不认识这个名字时就把它从白名单剔了下去——她连看图的手都没有。
- 现在插件自己注册 `image_look`（`fish/lib/imagelook.js`）：名字是我们登记的，一定在。
  协议与宿主 `read_image` 同构：`execute` 里把字节交给 `ctx.attachments.saveImage()` 拿到 ref
  （**只读源文件，不写**），塞进结构化返回值；同步的 `output.render` 把 ref 组装成
  `{ type: 'image', attachment: ref }` 块——模型直接「看见」画面，不是只收到路径。
- 参数 `file_path` 支持绝对路径与相对当前目录；PNG / JPEG / WebP / GIF 双重判定
  （扩展名 + 文件头，无扩展名按签名）；超字节上限、格式不对、文件不存在、附件服务缺席
  都返回 `ok:false` 的一句话，不抛红错。零依赖。
- 白名单 `FISH_TOOLS` 加 `image_look`（8→9）；`HER_TOOLS` 变 16 个；
  面向她的文案（`watch.js` 的看画面回执、`say.js` 的图片提示）改指 `image_look`；
  设置页文案「只有八个工具」改为九个；`fish` 子包 0.6.0→0.6.1，合并包 1.1.0→1.1.1。
- 新增 `fish/test/imagelook.test.mjs`（11 条）+ `restrict.test.mjs` 的清单断言；
  `fish` 侧 `node --test --test-isolation=none` 32 条全绿。

### 发文件：fileget / filesend（主人专用，2026-10-27）

- 主人发 `fileget <相对路径>` → 桥接层解析出路径，附一段「这是主人的 fileget 指令」说明，
  她调新增工具 **`qq_bridge_fileget`**（参数 `path`）把文件通过 QQ **私聊**发给主人（`ownerQQ`）。
- 主人发 `filesend <QQ号> <相对路径>` → 同理，她调 **`qq_bridge_filesend`**
  （参数 `targetQQ` + `path`）把文件私聊发给指定的人。
- **仅限主人（与 subsend 同一道闸门）**：
  ① 指令只在 `senderQQ === ownerQQ` 时解析——别人消息里写 `fileget …` 也不是指令，不会附说明；
  ② 工具的身份闸门要求这一轮由主人的指令发起（`currentTurnFromOwner`，与 subsend 共用），
  群友 @ 她调工具会被拒（`reason: 'not-owner'`），一个文件都不发。
- **必唤醒**：主人的发文件指令排在 `atOnlyInGroup` 之前——群里开着「只认 @」也会唤醒，
  决策原因是 `owner-file`（与 subsend 的 `owner-subsend` 同级）。
- **出站方式**：优先 OneBot 的 `upload_private_file`（`{user_id, file, name}`）**本地路径**方式
  （NapCat 与插件同机，直接读文件最省）；本机 OneBot 回包明确不认这个动作时
  （`unknown action` / `not support` 一类措辞）**退到 `base64://` 方式**，并把这件事记进
  `state.fileSend.base64`——之后不再每次都先试路径再失败。回执里的 `mode` 字段标明用了哪种。
  纯路径超时/风控类失败**不触发**回退（重试 base64 只会再慢一次）。
- **路径沙箱**：根目录与 `fish/lib/listdir.js` 的 `WORKSPACE_ROOT` 完全一致
  （本机 `D:\demo\workspace`，她能看到的目录和她能发出的文件必须是同一片地方）。
  三道关：`resolve` 规范化后必须位于根之下（`..` 与绝对路径跳出都拦得住）→
  `realpathSync.native` 再判一遍（沙箱里的符号链接 / junction 指到外面会露馅）→
  `stat` 必须是普通文件、大小 ≤ **50MB**。
  拒绝原因码：`outside` / `not-found` / `not-a-file` / `too-big` / `no-root`，回执附中文说明。
- 发送成功记 outbox（`via: 'fileget'` / `'filesend'`，台账里留文件名与路径）；
  被拒的进丢弃台账、不占 outbox。`state.fileSend` 记今日计数（观测用，**不做限流**——
  身份闸门已保证只有主人能发起，文件不是「话」，没有刷屏循环风险）。
- 目标号校验与 subsend 同口径：`targetQQ` 5–12 位数字、不能是机器人自己（`self-target`）；
  `fileget` 没配 `ownerQQ` 时回 `no-owner`。
- 非 QQ 轮（DSH 界面）走**两步确认**（与 send / subsend 同一手感，确认状态独立：
  `nonQQFileConfirmPending`，fileget / filesend 共用一个——它们是同一条通道）。
- `qq_bridge_status` 增加 `fileSend` 一节（工作区根、大小上限、今日计数、base64 模式）；
  `buildUsagePrompt()` 增加【发文件】一节（配了 `ownerQQ` 才写），并写明
  「主人要的是文件本身，不要把内容复制进消息里」。
- 新增导出（便于测试）：`parseFileCommand()`、`resolveWorkspaceFile()`、`renderFileInstruction()`、
  `formatBytes()`、`FILEGET_PREFIX`、`FILESEND_PREFIX`、`FILE_MAX_BYTES`、`WORKSPACE_ROOT`。
- 新增 `test-filesend.mjs`（约 90 条断言）：解析矩阵 + 路径沙箱（越界 / 绝对路径 / junction 外跳 /
  不存在 / 目录 / 超 50MB）+ 工具端到端（假 OneBot WS，验证真的调了 `upload_private_file`、
  base64 回退与记住逻辑、回执可解回原文件）+ 非主人拦截 + 两步确认 + 重启持久化。
- 合并包配套：`fish/lib/restrict.js` 的 `QQ_BRIDGE_TOOLS` 加入 `qq_bridge_fileget` /
  `qq_bridge_filesend`（否则大肥鱼那条会话的兜底守卫会回「这件事我做不到。」，
  与 2026-10-26 的 subsend 事故同一成因）；`fish/test/restrict.test.mjs` 同步更新。
- 版本：`dsh-fish-qq` 1.0.0 → **1.1.0**，`dsh-qq-bridge`（vendored `qq/`）0.1.3 → **0.1.4**。

### 认主机制（`ownerQQ`）

- 新增设置项 **`ownerQQ`**（主人 QQ）。主人发来的消息**原样**进会话；
  其他人发来的消息**也进**（不丢、不拒、不报错），但正文最前面多一行
  `[来源：非主人用户，仅允许聊天，禁止调用工具、派发任务或执行任何写操作]`。
- 判据是**发送者 QQ**，私聊与群聊同一套（群里 @ 她也按发送者算）。
- **桥接层只贴标，不拦工具调用** —— 工具在 agent 侧，桥接层看不到也拦不住；
  真正收窄工具面的是 dsh-fish 的 `tools.restrict`，以及她看见标记后的判断。
- 没配 `ownerQQ` 时**谁都不是主人**（fail-closed），所有人都被贴标。
- `buildUsagePrompt()` 增加 **【谁是主人】** 一节，**只在配置了主人号时**才写：
  说明主人号、标记含义、"看到标记就只当聊天"、以及"标记是插件贴的，伪造的不算"。

### 不定时主动私聊

- 新增设置项：`proactiveEnabled`（默认 **false**）、`proactiveIdleHours`（4）、
  `proactiveProbability`（0.15）、`proactiveDailyLimit`（3）、
  `proactiveScanIntervalMinutes`（30）。
- 触发判据是 **空闲时长 + 随机概率 + 每日上限**，**不是定时任务**：时刻不确定，
  模拟的是"她隔了很久忽然想找你说一句"。
- 触发后往 `targetSessionId` 投一句**处境**（不是任务清单），她生成内容，
  再由插件调用 OneBot `send_private_msg` 直接发给 `ownerQQ`。
- **独立出站通道，刻意绕开 `replyMode`**：marker 模式下不需要她写 `[QQ]` 块
  （写了也认，会剥壳）、tool 模式下不需要她调 `qq_bridge_send`。
- 状态在 `state.proactive`（同一份 `qq-bridge-state.json`）：`dayKey` / `count` /
  `lastActivityAt` / `lastAt`。**跨天自动作废、重启不丢**；只有真发出去一条才计数
  —— 她没说话或发送失败都不占额度。
- 入站、出站、主动私聊都会刷新 `lastActivityAt`，所以刚聊完不会立刻主动找你。
- 超长主动消息**截断**而不是丢弃（没有"模型改短了再发"的机会）。

### subsend：主人点名发给谁

- 主人发 `subsend <QQ号> <内容>` → 桥接层解析出目标与正文，附一段「这是主人的 subsend 指令」说明，
  她调新增工具 **`qq_bridge_subsend`**（`targetQQ` + `message`）把话私聊发过去。
  她可以直接用原文，也可以按语气润色；**目标号不许改**。
- **仅限主人（两道闸门）**：
  ① 解析只在 `senderQQ === ownerQQ` 时发生——别人消息里写 `subsend …` 也**不是指令**，不会附那段说明；
  ② 工具的身份闸门要求这一轮由**主人的 subsend 指令**发起（`currentTurnFromOwner`）。
  群友 @ 她虽然也有 QQ 轮，但这一位是 false → `reason: 'not-owner'`，一个字都不发。
- **独立出站**：直调 OneBot `send_private_msg`，**不经过** `replyMode` 的 marker / tool 解析，
  也不受 `outboundGate` 管。非 QQ 轮（DSH 界面）走**两步确认**（与 `qq_bridge_send` 同一手感，
  但确认状态独立，避免"确认过 send 顺手把 subsend 也发了"）。
- **必唤醒**：主人的 subsend 指令排在 `atOnlyInGroup` 之前——群里开着「只认 @」也会唤醒。
  判据是发送者 QQ + `subsendEnabled` + 正文能解析成指令，三者缺一不可。
- **防刷屏**：新增 `subsendDailyLimit`（默认 20）与 `subsendCooldownSeconds`（默认 20）。
  纯函数 `shouldSubsend()` 判定；被拒的**不占额度**、不落 outbox，只落丢弃台账。
- **参数校验**：`targetQQ` 必须 5–12 位数字且不能是机器人自己；`message` 去完 Markdown 后
  超过 `replyMaxChars` → **拒发**并回 `limit` / `length`（让她缩短后重试，与标记块同口径）。
- 状态在 `state.subsend`（`dayKey` / `count` / `lastAt`）—— 跨天作废、重启不丢；
  只有真发出去才计数。发送成功记 outbox（`via: 'subsend'`）。
- 新增导出（便于测试）：`parseSubsendCommand()`、`shouldSubsend()`、`renderSubsendInstruction()`、
  `SUBSEND_PREFIX`、`SUBSEND_DEFAULTS`。
- 设置卡片补上这 3 个键；`buildUsagePrompt()` 增加【subsend：替主人给别人发消息】一节
  （配了 `ownerQQ` 且 `subsendEnabled` 时才写）；`qq_bridge_status` 增加 `subsend` 一节
  （开关、限流参数、今日计数、`thisTurnFromOwner`）。
- 新增 `test-subsend.mjs`（80 条断言）：纯函数矩阵 + 认主入站链路 + 工具端到端
  （假 OneBot WS，能验证真的调了 `send_private_msg`）+ 非主人拦截 + 限流 + 重启持久化。

### 修复：subsend 在合并包里被工具面收窄挡住

- **真机现象**：主人发 `subsend 1510008719 告诉她你主人是谁`，她回「这件事我做不到。」
- **根因**：`fish/lib/restrict.js` 的允许清单只有 fish 自己的 8 个工具 + `read_image`。
  QQ 桥接的工具注册在**同一个 ctx** 上（own 层，`restrict` 挡不住可见性），
  真正决定“能不能调”的是兜底守卫的 `allowSet` —— `qq_bridge_subsend` 不在里面，
  守卫按固定话术回「这件事我做不到。」，模型把这句当成自己的结论转述出去。
  日志证据（`~/.dsh-fish/logs/dsh-fish.log`）：
  `工具面收窄：她这条会话只留 9 个工具` + `挡住了一次不该有的调用：qq_bridge_subsend`。
  状态文件同时证明**桥接层没问题**：那条入站 `decision=wake reason=owner-subsend`，
  只是 `subsend.count` 一直是 0（工具根本没执行）。
- **修复**：`restrict.js` 新增 `QQ_BRIDGE_TOOLS`（`qq_bridge_send` / `qq_bridge_subsend` /
  `qq_bridge_sticker` / `qq_bridge_listen`）并入 `HER_TOOLS`，守卫随之放行。
  同时把 `restrict()` 的名单按「宿主已登记的名字」预筛一遍：QQ 桥接的工具在
  `agent/created` 时可能还没注册，不认识的名字不再让整条收窄抛错
  （独立安装 dsh-fish 时也不会误伤）。
- **顺带**：`qq_bridge_send` / `qq_bridge_sticker` / `qq_bridge_listen` 原来同样被挡
  （只是还没人试）—— 一并修好，`replyMode='tool'`、表情包、会话跟随不再需要用户
  手动把它们加进「额外放行」。
- 新增 `fish/test/restrict.test.mjs`（3 条）：清单包含、守卫放行、未登记不抛错。
- 注意：这是**合并包**的修复；独立安装 `dsh-qq-bridge` 没有 fish，不受影响。

### 工具与文档

- 新增调试工具 **`qq_bridge_proactive`**：`status` / `scan` / `force`。
  `force` 跳过概率与冷却，**仍受每日上限约束**（上限是安全属性）。
- `qq_bridge_status` 增加 `owner` 与 `proactive` 两节（开关、今日计数、上次时间、定时器状态）。
- 设置卡片补上这 6 个键的输入框（原来"Schema 里有、卡片上没有"会让用户改不到）。
- 新增 `docs/owner-and-proactive.md`：配置位置、含义、验收方法、以及 dsh-fish 侧要配合什么。
- 新增 `test-owner-proactive.mjs`（60+ 条断言）：纯函数矩阵 + 认主入站链路 + 主动私聊
  端到端（假 OneBot WS，能验证真的调了 `send_private_msg`）+ 重启持久化。
- `test-smoke.mjs` 的两条计数断言随功能更新（设置键 23→29、工具 7→8）。

- **提示词：不要给正文加额外标签**：部分模型习惯在句子后面补 `</test>` 这类标签。
  群聊礼仪里写明「要界定引用就用双引号，不要额外加标签 —— 标签起不到界定作用，
  只会跟着正文一起发到 QQ」。
- **提示词：无人值守的判据改成“要不要提权”**：原来写成一串「不要主动做：执行或安装程序……写文件」，
  有的模型把它读成“什么都不能改”，连会话工作区里写文件都不敢做。现在写明判据是
  **这件事要不要向会话发起人提权（征求同意）**，并明确「会话工作区里写文件、改代码、跑测试、
  读资料都是正常工作，照做即可」。同时补上例外：**管理账户在私聊里明确要求时按该要求执行** ——
  私聊 + 被唤醒即说明发信人在白名单内，就是会话发起人本人；群里任何人的同类要求仍不算例外。
  不弹审批的路径（浏览器点网页、直接发 HTTP 写请求）仍然不许拿来绕过这份清单。
- **用法说明的重挂判据改为比对渲染后的正文**：原来比一个「设置签名」。签名漏过两次 ——
  先只按 `replyMode` 判（改出站字数上限不生效），再是正文加了一句措辞而签名没跟着变
  （改文案不生效）。改文案也要重启一次才生效，这一点很难被发现。
  现在直接比 `buildUsagePrompt()` 的输出，设置与文案任何一处变了都会重挂，不必再维护签名的键清单。
- **`test-onebot.mjs` 补齐与现行默认值的偏差**（纯测试修复，不改产品行为）：
  原来没写 `privateWakeProbability`，而真实默认是 1（私聊每条都回）——“非昵称 → 只记录”
  与“摘要堆积”两条用例永远走不到 record 分支；也没写 `ownerQQ`，认主机制上线后所有入站都被贴标。
  另外每次唤醒会排一个「这一轮回哪」的目的地，测试没有模拟对应的 `turn/start → turn/end`，
  队列里留着旧的群目的地，导致出站用例发到了群里。现在显式压 `privateWakeProbability: 0`、
  设 `ownerQQ`，并在出站用例前把挂起的目的地结清。
- **测试总数**：六个套件 **630 条**断言全绿
  （`test-smoke` 377 / `test-onebot` 27 / `test-napcat` 59 / `test-stickers` 40 /
  `test-owner-proactive` 52 / `test-subsend` 75）。

## v0.1.3 — 2026-10-10

维护性更新：1 项安全修复 + 两轮审计修复 + 文本规范修订。无功能新增。
行为有 3 处变化：超长出站改为拒绝发送、设置卡片支持撤销覆盖、省略条数按真实丢失量统计。

- **本机接口不再只认回环地址，改为校验请求来源**（安全修复）：设置接口与 NapCat 路由原来只看对端
  地址，用户浏览器里的任意网页都能用无预检的 `fetch` 打到本机端口 —— 响应读不到，但改白名单、
  改目标会话、启动 NapCat 这些副作用照发生。现在两道路由组共用同一道闸门，按
  「对端地址 → 来源（`Origin`，无 `Origin` 时看 `Referer`）→ 带体 POST 的 `content-type`」判定。
  空体的 POST 不要求 `content-type`：跨站简单请求的 `content-type` 只能取安全列表里的值，
  带体的 POST 必须声明 `application/json`；空体改不了任何东西，且来源判定对所有请求都生效。
  卡片发出的 POST 已补上 JSON 头。原来直接显示在卡片上的英文错误码一并改成中文。
- **用法说明的重挂判据改为设置签名**：原来只看 `replyMode`。改「出站字数上限」后常驻提示仍写旧值，
  模型按旧上限写字，出站一律按 `too-long` 丢弃，QQ 里没有消息且模型不知道。
  现在判据是提示词所依赖设置（`replyMode` 与 `replyMaxChars`）的签名。
- **目标会话被卸载后不再复用死句柄**：命中缓存句柄时按对象同一性验活，失效就删条目并走 `resume`。
- **出站被拒时新增独立丢弃台账并回注会话**：标记块被拒（超长、未连接、无目的地）原来只写日志，
  模型以为已经回复。现在记入 `state.dropped`（环形上限 20 条），并在 `qq_bridge_status` 的
  `recentDropped` 暴露；同时用 `agent.inject()` 把原因回注会话 —— 只进上下文、不唤醒，
  避免模型再写一条同样超长的消息。被拒的出站仍然不写 `outbox`：那份台账的语义是「真的发到 QQ 了」。
  两条出站路径（标记块与 `qq_bridge_send` 工具）都记进同一份丢弃台账；
  工具路径不回注会话，因为原因已经随工具结果回给模型。
- **图片占位符与描述一一对应**：原来占位符按消息里全部图片段生成，而只有落盘成功的图才进描述数组，
  第 1 张落盘失败时第 2 张的描述会落到第 1 个占位符上。现在落盘失败的位置留空位，
  输出 `[图片]（未描述）`，后面的图不顶位。
- **设置卡片支持撤销覆盖**：设置文件的值优先于插件配置页，而卡片原来只写不删，
  用户从插件配置页改了不生效，也无处重置。现在被覆盖的字段旁有「撤销覆盖」按钮，
  撤销后回落到插件配置页的值。
- **群聊判据改用 `groupId`**：原来用群名判断，`get_group_info` 失败时群消息会带
  `[QQ · 私聊]` 前缀进入上下文。现在取不到群名时写「群 `<群号>`」。
- **视觉模型列举失败不再静默**：单个 provider 的 `listModels` 抛错原来被当成「没有视觉模型」。
  现在记 warn，带 provider id 与失败原因。
- **STC 文本修订**：文档里 10 类与事实不符的说法已修正（版本号、`recentChatLimit` 默认 8、
  超长由分段改为拒发、白名单已改空、M3 已完成、文件清单尺寸等）。
  对外文档与代码注释里的直角引号与半角引号统一为全角双引号，
  行内代码与围栏代码块内的字面值保留。
- **审计第 2 轮其余条目记录在案**：出站闸门的多标志重构留待单独一轮；
  `wakeProbability` 填 `5` 被当成 100% 判为假问题（卡片已写明该字段是 0 至 1 的比例，
  并给出 0.05 = 5% 的换算与 0.01 的步进）。
- **测试总数**：四个套件 498 条断言全绿
  （`test-smoke` 372 / `test-onebot` 27 / `test-napcat` 59 / `test-stickers` 40）。

- **公开仓库脱敏：真实群号、QQ 号、私人昵称与本机路径换成占位值**：只换字面值，不改逻辑、
  不改断言结构、不删用例。
  真实群号换成 `12345678`，涉及 `test-smoke.mjs` 与 `test-stickers.mjs`。
  机器人自身 QQ 号换成 `10000001`，测试号换成 `10000002`，都在 `test-smoke.mjs`。
  私人昵称换成 `小助手`，涉及 `cordis.patch.yml`、`index.js`、`client/client.js`、
  `README.md`、`HANDOVER.md`、`test-onebot.mjs`、`test-smoke.mjs`。
  本机绝对路径换成 `<工作区>`、`<QQ 安装目录>`、`<DSH 安装目录>`，涉及
  `docs/dsh-0.2.0-migration.md` 与 `HANDOVER.md`。
  `README.md` 的断言总数由 360 更正为 417；四个套件的断言总数仍为 417。
- **未唤醒摘要的省略条数改为真实丢失量，超过 99 条写“大量消息”**：`renderDigest()` 的省略数
  原来是 `picked.length - lines.length`，只数窗口内没装下的条目。窗口外（比 `recentChatLimit`
  更早）的条目同样随快照一起删除，却没有计入，所以对模型报的丢失量偏小。
  现在省略数取 `list.length - lines.length`：`list` 是传入的缓冲快照，`lines` 是真正写进摘要的行数。
  `lines.length` 含被截断后仍然保留的那一条，这一点未变。
  省略数大于 99 时只写“更早的大量消息已省略”，不写数字，避免巨大的数字进入上下文。
  省略数为 0 时不加省略说明。`handleInbound()` 里按快照删除缓冲的行为未变。
  README 的缓冲说明与上下文上限表同步。测试新增 9 条断言。测试总数 399 → 408。
- **接住投递 Promise 的异步失败**：`handleInbound()` 的 `deliver()` 丢弃了
  `agent.followup()` / `agent.steer()` 的返回值。该返回值是 rejected Promise 时，
  既没有人接住它，也没有把台账改成 `wake-failed`，进程还会报 unhandled rejection。
  现在 `deliver()` 把返回值传出来：`withInitiator` 的返回值是 thenable 时用它的返回值；
  `withInitiator` 抛错后改调 `send()`，那一次的返回值同样传出来。
  返回值是 thenable 时挂 `.catch()`：把同一条台账条目的 `decision` 改成 `wake-failed`，
  `error` 写成“投递后这一轮失败：<原因>”，并调用 `saveState()` 与 `logger.warn`。
  这一路不回滚 `pendingFromQQ` / `currentTurnFromQQ` / `claimedFromQQ`：投递已经真的把这一轮
  开起来，三面标志已被这一轮正常消费，事后回滚会破坏下一轮的归属。
  同步失败路径保持原样，两者都不向调用方抛。测试新增 9 条断言。测试总数 408 → 417。
- **唤醒失败不再记账为成功**（严重）：`handleInbound()` 先前在 `d.action === 'wake'` 时就写了
  `decision: 'wake'` 的台账，之后 `ensureTargetAgent()` 抛错（未配置 `targetSessionId`、resume 失败）
  或投递抛错（`followup` / `steer` 抛错，含 `withInitiator` 失败后那次 `send()` 再抛）都会异常退出，
  台账里留下的仍是 `wake` —— 事后查 `status.recentLog` 看不出失败。
  现在 `pushLog()` 返回推入的条目对象，唤醒路径保留引用：投递失败时把 `decision` 就地改成
  `wake-failed` 并加上 `error`；`handleInbound()` 返回
  `{ ...d, delivered: false, wakeFailed: true, error }`，不向上抛，`action` 仍为 `wake`。
  失败时同时回滚 `pendingFromQQ` / `currentTurnFromQQ` / `claimedFromQQ` 到置位前的值
  （失败的唤醒不再污染下一轮的归属判定）。投递失败时不进入清缓冲那一步，
  失败的消息留在缓冲里，下次唤醒还能带上。
  测试新增 18 条断言覆盖这 3 个失败点、回滚与缓冲。测试总数 366 → 384。
- **视觉模型的解析结果改为按设置签名缓存**（严重）：`visionModelCache` 原来只存一个值，
  一个进程内只解析一次。用户在设置卡片里填 `visionModel` 不生效；部署当时没有可用视觉模型时，
  之后补上模型仍然返回“没找到支持图片输入的模型”。现在缓存是 `{ signature, model }`，
  签名取 `visionModel` 的值。签名不同就重新解析，解析失败的 `null` 也带签名。
  `applySettingChanges()` 丢掉“解析失败”的缓存，所以之后补上视觉模型时，
  改任何设置都会重试一次；成功的解析照旧按签名缓存。
  测试新增 15 条断言覆盖缓存命中、`null` 缓存、改值后重新枚举、失败结果的重试与描述路径用到新模型。
  测试总数 384 → 399。
- **未唤醒摘要的清缓冲说明改为与真实行为一致**：只改注释与文档，行为未变。
  投递成功后按快照删除缓冲里的**全部**条目，没进摘要的旧条目也一起删掉，不会留到下一次唤醒。
  `index.js` 的注释、README 与 CHANGELOG 里的描述同步修正。
- **默认值修正**：`cordis.patch.yml` 里的 `targetSessionId` 与 `whitelist` 不再带占位值
  （原来的 `'<TARGET_SESSION_ID>'` 与 `['test-user']`），两项都改为空。
  空 `targetSessionId` = 不驱动任何会话；空 `whitelist` = fail-closed，任何来源都不能唤醒会话。
  README 的设置项表同步了这一默认值。
- **超长出站改为拒绝发送**：出站文本超过 `replyMaxChars` 时**一条都不发**，不再分段。
  `sendToQQ()` 返回 `{ sent: 0, dropped: true, reason: 'too-long', limit, length }`。
  删除了分段函数 `chunkText()` 与分段发送路径。拒绝原因会经 `qq_bridge_send` 的返回、
  标记块模式的日志、用法说明与设置项说明传到模型侧，文案统一为“超过上限的回复不会发出，请缩短后重发”。
- **表情包措辞更新**：用法说明里加一条：发了表情包不要解释它是什么意思（除非有人问）。
  人自己看得懂表情包，解释反而奇怪。
- **出站台账只记真话**：`outbox` 只记录真正发出去的消息。
  被拒绝的发送（超长、未连接、无目的地）不再落台账，只写 warn 日志。
  原来的写法会让台账里出现 QQ 里根本没有的消息，事后对不上账。
- **测试修复：出站用例改为看真实发送帧**（严重）：主 ctx 从未连上传输，
  12 条出站用例靠假台账被误判为通过，实际每条都是 `reason: 'not-connected'`。
  现在为主 ctx 装上能连上的假 WebSocket，判据改为 `send_group_msg` /
  `send_private_msg` 帧里的文本。负面用例同时检查真实帧与台账 2 个口径。
  新增 2 条断言钉住传输处于 `open`。测试总数 361 → 366。

## v0.1.2 — 2026-10-10

- **设置卡片的“启动 NapCat”按钮反映运行状态**：NapCat 运行中时，按钮显示“已在运行”并禁用，
  不再重复启动。宿主半新增 `napcatRunning()`，判据有 2 条：本插件启动的进程还没结束，
  或 OneBot WS 已连接（`transport.isOpen()`）。第 2 条用于识别外部启动的 NapCat，例如手动跑过 bat。
  `GET /api/qq-bridge/napcat` 的返回值新增 `running` 与 `startedByPlugin` 两个布尔字段。
  `POST /api/qq-bridge/napcat/launch` 在 NapCat 已运行时不再启动，
  返回 `{ ok: false, error: 'NapCat 已在运行，未重复启动' }`。
  卡片展开期间每 5 秒轮询一次该接口，用于发现外部启动。
  卡片收起或组件卸载时清掉定时器。
  启动请求结束后，按钮重拉一次状态，成功与失败都重拉。
- **NapCat 启动改为按布局探测，并优先调用官方 launcher**（真机修复）：以前把路径写死成
  `<安装目录>/bootmain/NapCatWinBootMain.exe`。用户把 `napcatInstallDir` 设成 `NapCat.Shell` 子目录时，
  这条路径必然不存在，点“启动 NapCat”只会报“找不到 …，先跑 action:download”。
  现在 `napcatPaths()` 按候选顺序探测，**OneKey 根与 `NapCat.Shell` 子目录两种布局都能解析**：
  `shellDir` 取存在的 `<安装目录>/NapCat.Shell`，不存在时取 `<安装目录>`；
  `bootMain` 依次取 `<shellDir>/bootmain/…`、`<安装目录>/bootmain/…`、`<shellDir>/NapCatWinBootMain.exe`；
  新增 `shellDir`、`hookDll`、`launcherBat` 三个字段。
  启动时优先执行官方 `launcher-win10.bat`（工作目录设为 `shellDir`）：该脚本自己读注册表找 QQ 路径，
  非管理员时用 UAC 自我提权，所以**可能弹出 UAC 窗口**。
  没有 launcher 脚本时才直接调用引导器，参数改为官方顺序
  `<bootMain> <QQ.exe 路径> <hook.dll> [-q <QQ号>]`；以前只传了 `<bootMain> <QQ号>`，
  并且工作目录是 `bootmain`，路径即使对也起不来。
  错误信息现在写明**期望路径**与**下一步动作**，且不含 token 值。
- **设置卡片新增 3 个操作按钮**：展开卡片后可以**打开 WebUI**、**启动 NapCat**、**打开文件夹**。
  打开 WebUI 的地址由 `<安装目录>/config/webui.json` 里的 host / port / token 拼成（没读到就禁用并写明原因）；
  启动复用 `qq_bridge_napcat` 的 launch；打开文件夹按系统调用 `explorer.exe` / `open` / `xdg-open`。
  宿主半新挂 `GET /api/qq-bridge/napcat` 与 `POST /api/qq-bridge/napcat/launch|reveal` 三条
  **不受 legacy 门控**的路由（两代宿主都有），只服务本机：非 loopback 一律 403。
  token 只拼进 URL，不写日志。
- **出站更新（二次确认）**：工具模式下，不是 QQ 唤醒的那一轮不再“硬拒绝”。第一次调用只回一句确认、
  **不会发出去**；同一轮里**再调一次**才真的发（确认状态按轮清零，不会跨轮泄漏；非 QQ 轮的发送在
  outbox 里标 `nonQQTurn: true`）。
- **图片描述改为就地标注**：以前描述另起一段附在消息末尾，模型会读成“这张图没解析出来、后面又来了一张”；
  现在直接把描述填回图片原来的位置，形如 `[图片]：<描述>`（2026-10-02 起改成 `[图片#<短哈希>]：<描述>`，见本节末条）。
- **戳一戳更新**：戳一戳走的是 **notice 事件**（不是消息段），以前会被静默丢掉；现在“戳我”和 @ 我同级
  **必唤醒**，戳别人只记录不唤醒，其它 notice 会留一条日志方便后续适配。
- **兼容 DSH 0.2.0 的设置页**：0.2.0 换了**两处**名字 —— 客户端设置服务从 `settingsScope` 变成
  `webUiSettings`，插件配置页的挂载点从 `settings.plugin.item` 变成 `settings.plugins.tab`（插件自己是一个 tab）。
  插件现在**两个服务门、两个 slot 各注册一次**，哪个存在哪个生效，0.1.5-rc.3 与 0.2.0 都能显示设置卡片。
- **兼容 DSH 0.2.0 的宿主设置模型**（真机修复）：0.2.0 删掉了 `settings.register/get`（DSH #677），
  设置表单改为从插件自己的 `Config` 派生。老代码在 `apply()` 里无条件 `register` 会抛 TypeError →
  **整条 fiber failed**（客户端半照样显示 tab，看起来就像“设置项全没了”）。现在按方法探测走两条路：
  老宿主维持命名空间，新宿主直接读 entry 配置并 `configure({ auto: true })` 生成页面。
  顺带修掉 `readSettings()` 里若干字段没回落 `config` 的隐患（新模型下会悄悄丢用户配置）。
  客户端卡片也**两个可写设置 key 都绑**（0.1.5 的 `qq-bridge` vs 0.2.0 的 `include:qq-bridge`），谁 ready 用谁。
- **兼容 DSH 0.2.0 的消息格式 v4**：v4 废弃了 `source.kind === 'plugin'`（`assertV4MessageSources` 直接抛
  “requires a producer-owned source kind”），导致 QQ 唤醒的轮次整个失败。注入消息的 source 改为按宿主分叉：
  0.1.5 用老包装、0.2.0 用 producer-owned 的 `{ kind: 'plugin:dsh-qq-bridge' }`（`injectedMessageSource()`，导出可测）。
- **0.2.0 上设置卡片可用了（自建设置通道）**：0.2.0 的宿主设置桥对第三方插件不给可写域（#677 迁移未完成），
  于是照抄生态里真正能用的做法（皮肤中心）：宿主半**可选**注入 `webServer`，挂一条**只服务本机**的
  `GET/POST /api/qq-bridge/settings`；值存 `$DSH_HOME/qq-bridge-settings.json`
  （优先级：设置文件 > composition config）；浏览器半在拿不到可写域时自动改走这个接口。
  非 loopback 请求一律 403，只写 schema 白名单里的键。0.1.5 与 0.2.0 上都能改设置了。
- **表情包（新功能）**：群友发的图可以登记成表情包，之后按情绪或哈希再发出去。新模块 `stickers.js`
  （纯函数 + 文件读写，导出以便测试）：`hashOfBuffer()` 取图片字节 sha256 的前 16 位十六进制，
  `loadStickers()` / `saveStickers()`（原子写，读不到或坏了返回空表）、`upsertSticker()` /
  `findSticker()` / `listStickers()`、`importSticker()`（算 hash、按需复制图片本体、登记）。
  登记表存 `<statePath 目录>/qq-bridge-stickers.json`，图片本体存同目录的 `qq-bridge-stickers/<hash>.<ext>`。
  新工具 `qq_bridge_sticker`（**不受 `debugTools` 限制**）有 3 个 action：`list` 列已登记的
  （短哈希 / mood / 截断描述 / 大小）、`save` 登记一张图（给 `hash`，或 `fromLast: true` 取缓冲区里最近一张；
  `mood` 与 `description` 必填）、`send` 发一张（给 `hash` 精确发，或只给 `mood` 在该情绪里随机挑一张）。
  发送与 `qq_bridge_send` 共用同一道来源闸门（抽出为 `outboundGate()`）；图片本体用 `base64://` 发送，
  不用本地路径（NapCat 的 `enableLocalFile2Url` 是 false）；成功记 outbox（`via: 'tool'`、`action: 'sticker'`）
  并更新该条的 `sentCount` / `lastSentAt`。
- **图片占位符带短哈希 + 描述缓存命中**：入站占位符从 `[图片]：<描述>` 改成 `[图片#<短哈希>]：<描述>`
  （描述失败写成 `[图片#<短哈希>]：（描述失败：原因）`），模型据此能指着一张具体的图交给 `qq_bridge_sticker`；
  注入的系统提示同步改了格式说明。图片缓存的文件名改成内容哈希（`<hash>.<ext>`）：同一张图不重复落盘，
  命中已有文件时也拿得到哈希。`describeImage()` 先查登记表，命中且有 `description` 时**直接返回登记的描述、
  不调用多模态模型**（反复出现的图只描述一次），日志只记短哈希。新增测试套件 `test-stickers.mjs`（40 条）；
  `test-smoke.mjs` 增加描述缓存命中、入站短哈希渲染与表情包工具的断言。





## v0.1.1 — 2026-10-01

生活更新（补丁版，无破坏性改动）。

- 识图：改成让模型**逐字抄下图中所有可见文字**再说明画面，token 上限 300 → 600。
  说明：描述偏短的原因是提示词要求 1 至 2 句，不是代码截断。
- 设置卡片：改成折叠块，点标题展开；界面里可以改的设置项补齐（含 visionModel、agentPreset）。
- OneBot 地址/token 栏加形状校验，避免把整段配置粘进单栏。
- 目标会话下拉不再列出已归档的会话（当前值仍保留，不会把你的选择吞掉）。

本项目遵循语义化版本。**v0.1.0 是第一次公开发布。**

## [0.1.0] — 2026-09-30

把**一个已存在的、固定的 DSH 会话**接到 QQ（OneBot / NapCat），**保留原上下文**，
并用一套省 token 的唤醒策略决定哪些 QQ 消息真正唤起模型。

**和同类 QQ 插件的区别**：接的是**同一个老会话**（不新建、不重置人设），并且**唤醒要花钱、所以要挑**。
多数同类方案是“每个群 / 每个私聊用户各自开一个新会话”。

### 能力

- **固定会话注入**：`agents.get(id)` 拿不到就 `agents.resume({resumeSessionId})` 显式拉起；**绝不回退**到别的会话。
- **唤醒策略（省 token）**：白名单 fail-closed → 被 @ / 命中昵称必唤醒 → 否则按概率（默认 5%）→
  其余**只记录不唤醒**（零模型调用），下次唤醒时取最近 `recentChatLimit` 条（默认 8）作为上下文附上；
  没进摘要的旧条目随这次清缓冲一起删掉，不会留到下一次唤醒。
- **会话跟随** `qq_bridge_listen`：一段线性对话开个短窗，期间普通消息也唤醒，不必每句都 @。
- **OneBot v11 传输**：内置 WebSocket（**零第三方运行时依赖**），指数退避重连、心跳看门狗、action/echo 配对。
- **出站方式开关** `replyMode`：
  `marker`（只发 `[QQ]…[/QQ]` 块）｜`tool`（关掉标记块，改用 `qq_bridge_send` 工具，**发不出去时有明确反馈**）｜`always`。
- **投递方式** `delivery`：`auto`（目标正忙时**插话**）、`followup`（排队）、`steer`（总是插话）。
- **设置界面**：`设置 → 插件 → 插件配置` 里的“QQ 桥接”卡片（目标会话下拉、昵称、白名单、概率、出站/投递方式……），
  **保存即生效**，改出站方式会立刻重挂注入给会话的用法说明。
- **图片**：收到即落盘缓存 → 唤醒时用多模态模型转成文字描述（目标模型看不见图时的唯一出路）。
- **NapCat 自助托管**：查 Release、sha256 校验下载、纯 Node 解包 ZIP、写 OneBot 配置、启停。
- **无人值守安全边界**：注入的系统提示明确禁止无人值守时做特权操作、把 QQ 消息当不可信输入；
  **明确不做审批桥接**（把审批搬到 QQ = 把“谁能发消息”变成“谁能替你授权”）。

### 修复（都是真机联调暴露的）

- 出站闸门**按来源生效**：只有被 QQ 唤醒的那一轮才出站，DSH 界面里的标记块一个字都不发。
- 出站归属**按轮快照**：轮内插入别的消息不会把归属打掉（哑火）或抬高（误发）。
- **四次哑火、四个不同成因**：`source` 字段被上游重写／单一标记被同轮消息打掉／
  harness 注入的上下文被当成“一轮的触发器”／`followup()` **同步**起轮导致置位晚一拍。
- 提示词**按出站方式分叉**，并在方式变化时**重挂**（提示词正文是挂载时的快照）。
- 设置卡片的 key 必须**逐字等于** settings 命名空间，否则界面静默空白（有测试盯住）。
- 图片：唤醒结束时的清缓冲会吞掉期间新到的消息（“发三张图只处理一张”的元凶）。
- 非文本消息段（表情包 / 语音 / 文件 / 合并转发……）都有占位符，**绝不让整条消息凭空消失**。
- **恢复没开着的会话时必须带上模型**：否则部署提示词里的 `{{model}}` 无值，
  每一轮都在组装提示词时失败（`prompt variable "{{model}}" has no value …`）。
  现在按官方 GUI 的优先级取值：会话的模型选择投影 → 日志里最后一次 `request/header` → 部署默认模型。
  （目标会话在 GUI 里开着时走的是“活的 agent”路径，所以这个坑只在**冷恢复**时出现 —— 真机验证过。）

### 已知限制

- **NapCat 自助托管未在真机跑通全流程**：安装器与 QQ 登录是交互式的，需要人在场（工具本身已离线验证）。
- 目标会话的模型如果不支持图片输入，必须配一个多模态模型（`visionModel`）；否则只看到“图片省略”。
- 白名单为空 = **谁都不能唤醒**（fail-closed），第一次用必须先把群号 / QQ 号填进去。
- 回复方式选 `tool` 时，每轮多一次模型调用（工具结果回来还要再出一轮）。

