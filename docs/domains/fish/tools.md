owner: fish.tools
anchors: dsh-fish-qq/fish/lib/restrict.js#FISH_TOOLS; dsh-fish-qq/fish/lib/restrict.js#QQ_BRIDGE_TOOLS; dsh-fish-qq/fish/lib/restrict.js#HER_TOOLS; dsh-fish-qq/fish/lib/restrict.js#PLUGIN_TOOLS; dsh-fish-qq/fish/lib/restrict.js#registerToolRestrict; dsh-fish-qq/fish/lib/scope.js#createToolCapture; dsh-fish-qq/fish/lib/scope.js#mountToolDefinitions
版本核对: dsh-fish-qq@2.0.0 / fish@0.7.0

# fish.tools

本文档是 `fish.tools` 的唯一事实来源：她**允许看见**哪些工具、这些名单的权威数组是什么、以及「own 层挂载 + restrict + guard」三把刀分别做什么。挂载机制的实现细节归 `fish.scope`。

## 事实

### 数量与清单（以代码为准）

> **数量以 `dsh-fish-qq/fish/lib/restrict.js` 的数组为准。** 本节的数字是 2026-11-08 的代码快照；原文档里的 15/16/20 三种说法见「已知偏差」。

| 数组 | 数量 | 含义 |
| --- | --- | --- |
| `FISH_TOOLS` | **20** | 插件 fish 自己产出的工具 |
| `QQ_BRIDGE_TOOLS` | **7** | 合并包里她用来回 QQ 的工具 |
| `HER_TOOLS` | **28** | `FISH_TOOLS` + `QQ_BRIDGE_TOOLS` + 宿主可选的 `read_image` |
| `PLUGIN_TOOLS` | **27** | `FISH_TOOLS` + `QQ_BRIDGE_TOOLS`（不含 `read_image`） |

**`FISH_TOOLS`（20，顺序按代码）**

| # | 工具 | 一句话 |
| --- | --- | --- |
| 1 | `growth_commit` | 记下自己的想法（唯一写入口，只追加） |
| 2 | `her_recall` | 翻自己的旧事 |
| 3 | `her_leave` | 留一句话给他 |
| 4 | `bili_look` | 看 B 站的列表 |
| 5 | `bili_watch` | 看一条视频的画面 |
| 6 | `bili_speak` | 在评论区说话 |
| 7 | `work_request` | 把要动手做的事派到工作区 |
| 8 | `fish_list_dir` | 只读地看工作区目录结构 |
| 9 | `fish_read_file` | 只读地读工作区 / 自己状态库的文本文件 |
| 10 | `image_look` | 看一张图（把画面递给她） |
| 11 | `fish_now` | 读现在是什么时候 |
| 12 | `check_body` | 赛博感官·体温计：读 `sensors/status.md` |
| 13 | `read_user_rhythm` | 赛博感官·心跳触觉：读 `sensors/user_rhythm.md` |
| 14 | `fish_search_history` | 按关键词翻旧对话，只给摘要 + 门牌号 |
| 15 | `fish_read_raw` | 按门牌号读回原话 |
| 16 | `fish_decorate_room` | 赛博小屋装修：添置 / 移动 / 收走家具 |
| 17 | `fish_check_topology` | 赛博小屋空间检查：重叠 / 越界 |
| 18 | `read_house_events` | 屋里最近发生的事（NPC 闲聊等） |
| 19 | `gis_buffer_query` | 以她为中心画圈看周围有什么（动态解锁） |
| 20 | `gis_delete_feature` | 删家具 / 要素并刷新 A* 栅格（动态解锁） |

**`QQ_BRIDGE_TOOLS`（7，顺序按代码）**

`qq_bridge_send`、`qq_bridge_send_multi`、`qq_bridge_subsend`、`qq_bridge_sticker`、`qq_bridge_listen`、`qq_bridge_fileget`、`qq_bridge_filesend`。

**`HER_TOOLS`（28）** = 上面 20 个 + 上面 7 个 + `read_image`。`read_image` 由宿主 `@deepseek-ai/dsh-tool-fs` 在附件服务存在时注册；没有它不影响她说话，只是少一只看图的手（她自己的 `image_look` 始终在）。

另外 6 个 QQ 管理/调试工具（`qq_bridge_status` / `qq_bridge_proactive` / `qq_bridge_idle` / `qq_bridge_transport` / `qq_bridge_simulate` / `qq_bridge_napcat`）**不属于** `HER_TOOLS`：合并包默认不注册它们（`debugToolsInWorkspace: false`），排障时才以 global 工具出现。

### 三把刀

1. **own 层挂载（先做，不受 `enabled` 影响）**
   - 插件启动时用 `createToolCapture` 把每个工具的**定义**收进 `herToolDefs`，**不**调用插件 ctx 的 `ctx.tools.register`；因此 global 层没有 `fish_*`。
   - `agent/created` 确认是她那条会话后，`mountToolDefinitions(agent, herToolDefs)` 调 `agent.ctx.tools.register`，把定义挂进该 agent 的 **own 层**，只有她看得见。
   - 机制细节（Proxy、WeakMap、按轮收放、`isHerAgent` 判据）见 `fish.scope`。

2. **`restrict({ allow })`（收窄 inherited/global 层）**
   - `allow = [...new Set([...HER_TOOLS, ...config.tools.allow])]`。
   - 真正传给宿主的是 `restrictAllow = allow.filter((n) => knownNow.has(n) && !mountedSet.has(n))`：只保留宿主全局层里真实登记、且**不是**她 own 层工具的名字；宿主标准工具（bash / write / 联网 / 子代理 / 技能）不在其中，全部看不见。
   - `restrict` 只能减不能加；把 own 层名字写进 allow 会被宿主判 unknown，所以必须排除。`knownNow` 为空时传空 allow，宁可只留她自己的工具，也不把拼错的名字塞进去导致整条收窄失效。
   - `config.tools.restrict === false` 时只跳过这一步，**不影响** own 层挂载。

3. **`guard(...)`（兜底执行闸门）**
   - `guardSet = new Set([...allow].filter((n) => mountedSet.has(n) || knownNow.has(n)))`；守卫对不在集合里的调用返回 `'这件事我做不到。'`。
   - 为什么需要：own 层的工具不受 `restrict` 的 allow/deny 影响；`guard` 是把「她自己的工具」显式放行的兜底，也是宿主版本缺少 `restrict` 时的最后一道。
   - 宿主没有 `tools.guard` 时只记日志（`这个宿主版本没有 tools.guard，只能靠 restrict`），不阻止插件启动。

**非她会话的兜底**：`denyPluginTools()` 用 `PLUGIN_TOOLS` 与对方 `restrictableNames` 求交集后 `restrict({ deny })`，只摘真实存在的名字；正常路径下 fish 工具根本不在 global 层，这一条是第二道锁。

### 注册顺序与热重载

`fish/lib/index.js` 在工具定义收集完成后、`bootstrapHome()` **之前**调用 `registerToolRestrict(ctx, { root, herDir, extra, enabled, mount, onResult })`：必须早于她那条会话创建，`agent/created` 是同步串行监听，晚一步就漏掉第一次。插件热重载时，`registerToolRestrict` 会对 `ctx.get('agents').list()` 里已经活着的 agent 补跑一遍 `onCreated`，让她的会话重新挂载、让非她会话补 deny。

### 已知偏差

- **15 / 16 / 20 三种工具数**：
  - `dsh-fish-qq/对接文档.md` §5.1 写 `FISH_TOOLS（20）`；同一文件的 §5.2 标题写「fish 的 15 个工具」，表里 15 行。
  - `dsh-fish-qq/功能文档.md` §5 开头写「15 个」，表里 16 行（多出 `read_house_events`）。
  - 代码 `FISH_TOOLS` 是 **20** 个。原文档缺的是：`fish_decorate_room`、`fish_check_topology`、`gis_buffer_query`、`gis_delete_feature`；对接文档的 15 行表还缺 `read_house_events`。**以代码的 20 个为准。**
- **`ctx.tools.register` 直注册**：对接文档 §5.5 第 1 步写「在 `fish/lib/` 或 `qq/index.js` 里 `ctx.tools.register(defineTool({...}))`」；2026-11-08 起 fish 工具改为「先 `createToolCapture` 收定义，再由 `mountToolDefinitions` 挂进 `agent.ctx.tools` 的 own 层」，不再直接注册到插件 global ctx。qq 的 scoped 工具也走共享 `toolSink`，理由见 `fish.scope`。
- **「两把刀」**：对接文档 §5.1 把 restrict + guard 称作「两把刀」；代码实际是三层（own 层挂载 + restrict + guard），另有非她会话的 deny 兜底。这是命名口径差异，不是行为差异。
- **`HER_TOOLS` 的 `read_image`**：原文档只把它写成「宿主给就有」，没有把它算进任何总数；代码 `HER_TOOLS` 固定把它拼在末尾，所以 28 = 20 + 7 + 1。宿主没注册 `read_image` 时，`knownNow` 里没有它，`restrictAllow` 会自动把它过滤掉，不报错。

## 不负责

- `createToolCapture` / `mountToolDefinitions` / `isHerAgent` 的实现细节 → 见 `fish.scope`。
- 每个工具的参数、返回值、执行逻辑 → 分别见工具所在的单元（如 `fish.workspace`、`fish.bili`、`fish.memory`）；本单元只负责「她看得见哪些工具」。
- QQ 侧 13 个工具的注册与 `debugTools` 开关 → 见 `qq.tools`。
- 合并包层面的 20 + 13 工具面与 `debugToolsInWorkspace` → 见 `merge.tools`。
- `config.tools.allow` / `config.tools.restrict` 的默认值与存储 → 见 `fish.settings`。

## 验收

```powershell
cd dsh-fish-qq/fish
node --test test/restrict.test.mjs test/scoped.test.mjs

# 数量快照（应输出 FISH=20 QQ=7 HER=28 PLUGIN=27）
node -e "import('./lib/restrict.js').then(m=>console.log('FISH='+m.FISH_TOOLS.length,'QQ='+m.QQ_BRIDGE_TOOLS.length,'HER='+m.HER_TOOLS.length,'PLUGIN='+m.PLUGIN_TOOLS.length))"
```
