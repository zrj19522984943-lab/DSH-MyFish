> ⚠️ 已归档。本文件是历史存档，不再作为事实来源。
> 现状见 docs/INDEX.md 的对应 id：merge.lifecycle、merge.inject、merge.patch、merge.version-matrix、qq.onebot、qq.wake、qq.settings、fish.tools、fish.identity
> 归档前原路径：dsh-fish-qq/对接文档.md
> 归档日期：2026-11-08 · 任务书 T4

# dsh-fish-qq · 对接文档

> 面向：把这个包装进 DSH、在它上面改东西、或者写代码跟它对接的人。
> 功能与使用说明看 [功能文档.md](./功能文档.md)；更新记录看 [qq/CHANGELOG.md](./qq/CHANGELOG.md)。
>
> 最后核对：2026-10-27 · 包 `dsh-fish-qq@1.1.1`（内含 `fish@0.6.1` + `qq@0.1.4`）。
> **文档与代码不一致时以代码为准**——每个结论旁边都写了它来自哪个文件，改动前先去看那一段。

---

## 0. 一分钟概览

| 项目 | 值 |
| --- | --- |
| 包名 / 版本 | `dsh-fish-qq` / `1.1.1` |
| 宿主入口 | `index.js`（一个 cordis 插件，内部依次启 fish 与 qq） |
| 浏览器入口 | `client.js`（**生成文件**，把两边的设置页合进一个 bundle） |
| bundle patch | `cordis.patch.yml`（一行 insert，config 分 `fish` / `qq` 两槽） |
| 子包 | `fish/` = dsh-fish 0.6.1；`qq/` = dsh-qq-bridge 0.1.4（带本地改动） |
| npm 依赖 | **零**（只用 Node 内置模块；`@deepseek-ai/*` 由宿主解析） |
| Node | `>= 20`（`package.json`；内置 WebSocket 与 `TextDecoder` 都依赖它） |
| 状态库 | `~/.dsh-fish/`（可用 `DSH_FISH_HOME` 改） |
| 常量 | 事件 schema v1；QQ 状态 `$DSH_HOME/qq-bridge-state.json` |

整条链路：

```
他的 QQ ──► NapCat（QQ 客户端）──正向 WebSocket──► qq/index.js ──► DSH 会话（她在说话）
                                                        │
他的 QQ ◄── NapCat ◄── send_private_msg / [QQ] 标记块 ◄─┘

DSH 宿主
 ├─ fish/lib/*      她的成长、日记、B 站、桌宠窗口、15 个工具
 └─ qq/index.js     OneBot 传输、唤醒策略、认主、主动私聊、指令词
```

---

## 1. 包结构

```
dsh-fish-qq/
├── index.js              宿主半：装配 fish + qq（手写，构建时覆盖）
├── client.js             浏览器半：**生成文件**，别手改（见 scripts/build-bundle.mjs）
├── cordis.patch.yml      bundle patch：config 分槽
├── package.json          dsh.bundle / dsh.client / peerDependencies
├── fish/                 大肥鱼
│   ├── lib/index.js      fish 的入口（apply / inject / VERSION）
│   ├── lib/*.js          工具、状态库、调度器、观测台路由、设置
│   ├── pet/              独立 Electron 桌宠窗口
│   ├── media/ docs/      静态资源与文档
│   ├── client.js         设置页（→ 被打包进 ../client.js）
│   └── test/             63 条 node:test
├── qq/                   QQ 桥接
│   ├── index.js          入口 + 传输 + 策略 + 工具 + 路由
│   ├── onebot.js         OneBot v11 正向 WS（自带 WebSocket，无 ws 依赖）
│   ├── napcat.js         NapCat 下载 / 校验 / 解包 / 配置 / 启停
│   ├── stickers.js       表情包登记表
│   ├── client/client.js  设置卡片（→ 被打包进 ../client.js）
│   └── test-*.mjs        8 个脚本式测试套件
├── CheckLogs/            **运行时生成**：`work_request` 任务完成日志
├── README.md             安装与验收（给人的）
└── 对接文档.md / 功能文档.md
```

`client.js` 是生成物：改界面要改 `fish/lib/client.js` 或 `qq/client/client.js`，再跑构建脚本。
本工作区里构建脚本在 `../scripts/build-bundle.mjs`（**不在包内**）；直接跑它会先清空本目录
再从 `dsh-fish/`（已归档）与 `dsh-qq-bridge/`（旧版）重建——那两个源目录目前落后于本包，
**别直接跑**，除非先把源码同步过来。

---

## 2. 加载与生命周期

### 2.1 宿主半 `index.js`

```js
export const name = 'dsh-fish-qq'
export const VERSION = '1.1.1'
export const inject = [...new Set([...fishInject, ...qqInject])]
export function apply(ctx, config = {}) { /* 先 fish 后 qq，各自 try/catch；返回 dispose */ }
```

- `apply(ctx, config)` 里 `config` 是 **两槽**：`config.fish` 与 `config.qq`，分别原样传给两边的 `apply`。
- **先起 fish、再起 qq**：fish 负责建「大肥鱼的家」工作区与「跟大肥鱼说话」会话；
  qq 的 `targetSessionId` 留空时会去读 `~/.dsh-fish/home.json` 拿这条会话 id（见 4.2）。
- 任何一边启动抛错只记日志，不带走另一边；两边的 `dispose` 都会被收集，卸载时逆序调用。
- `inject` 是并集，缺任一服务宿主都不会调 `apply`（宁可不启动，不要半残）。

### 2.2 浏览器半 `client.js`

- 只有一个 `window.__ModuleLoader__.load({ id: 'dsh-fish-qq', factory })`，
  **id 必须等于包名**（宿主按包名注册客户端 bundle）。
- factory 里拆成 `__fishFactory` / `__qqFactory` 两个普通函数，外层再合成一个插件形状。
- 两边的挂载点不同：
  - fish：`settings.section`（「大肥鱼」整页观测台/设置）；
  - qq：`settings.plugin.item`（0.2.0）或 `settings.plugins.tab`（0.1.5）的「QQ 桥接」卡片。
- 合并包会在 factory 里设置 `globalThis.__DSH_QQ_BRIDGE_HOST_ID__ = 'dsh-fish-qq'`，
  让 qq 半边知道宿主给这张卡片登记的 entry id 是合并包名（否则 0.2.0 的设置页里一张卡片都没有）。
- 改完必须**重启 DSH**；`client.js` 不是热更新的。

### 2.3 `cordis.patch.yml`

只有一个 `insert`，`id` / `name` 都是 `dsh-fish-qq`，`config` 分 `fish:` 与 `qq:` 两槽；槽位、合并包专有开关与写死的默认值见 [merge.patch](../docs/domains/merge/patch.md)。

### 2.4 安装

```bash
dsh plugin --profile <profile> add D:/path/to/dsh-fish-qq
# 或打好的 tgz
dsh plugin --profile <profile> add ./dsh-fish-qq-1.1.1.tgz
```

手动安装：把目录放到 `<profile>/node_modules/dsh-fish-qq/`，并在 profile 的 `package.json`
里同时登记 `dependencies` 与 `dsh.profile.bundles`（只有一边会在下次 pnpm 清理时被删）。
装完**重启 DSH**。

> `link:` 安装时依赖解析走真实路径；如果宿主包找不到，在插件目录挂一个
> `node_modules/@deepseek-ai` junction 指向 profile 的 `node_modules/@deepseek-ai`
> （详见 `qq/README.md` 的安装一节）。

---

## 3. 服务依赖（`inject`）

`inject` 是**硬依赖**：缺任一服务，宿主不会调 `apply`（整包不启动，不会半残）。下表只说明
每个服务被谁用来做什么；`workspaceRegistry` 等可选服务在下面单列。

| 服务 | 谁需要 | 用来做什么 |
| --- | --- | --- |
| `sessionController` | fish | 建屋子的工作区/会话、`prompt` 递话、`rename`、按轮回复 |
| `tools` | fish + qq | 注册工具、`restrict`/`guard` 收窄她的工具面 |
| `webServer` | fish + qq | fish 观测台 `/dsh-fish/*`；qq 设置接口与 NapCat 按钮 |
| `connection` | fish | 观测台路由的信任栅栏（`requestRejection`） |
| `agents` | qq | `get` / `resume` / `followup` / `steer` / `withInitiator` |
| `settings` | qq | 0.1.5 的命名空间 `qq-bridge`（0.2.0 只用来探测，不写） |

可选（用 `ctx.get(...)` 探测，缺了降级）：

- `workspaceRegistry`：找/建派活的工作区。缺了 `work_request` 只能派到已存在的工作区。
- `credentials`：解析 `accessTokenEnv`。缺了退回 `process.env[变量名]`。
- `attachments`：`image_look` 用它把图递给模型。缺了看图工具返回一句原因。
- `agentPresets`：resume 时挂 preset（`agentPreset` 设置）。
- `agentDefaultModel`：resume 时没有记录模型，取部署默认。

生命周期约定：所有定时器、监听、路由都挂在 `ctx.effect` 或返回的 `dispose` 上；
停用插件 = 零后台活动（桌宠窗口会一起收掉）。

---

## 4. 配置

### 4.1 优先级（从低到高）

1. 代码里的 `DEFAULTS`（fish：`fish/lib/settings.js`；qq：`Config` schema 的 `.default(...)`）；
2. `cordis.patch.yml` 的 composition config；
3. 用户层：
   - fish：`~/.dsh-fish/config.json`；
   - qq：0.1.5 = settings 命名空间 `qq-bridge`（`settings.yaml`）；0.2.0 = `$DSH_HOME/qq-bridge-settings.json`。
4. 环境变量（只对少数几个键生效，见 4.5）。

### 4.2 composition config（patch 两槽）

| 槽 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| `fish` | `root` | `''` | 状态库根；空 = `$DSH_FISH_HOME` 或 `~/.dsh-fish` |
| `fish` | `seed` | `''` | 首次播种那句话；空 = 内置 |
| `qq` | `targetSessionId` | `''` | 目标会话 id；开着 `targetSessionFromFish` 时它只是**兜底**（每次以 home.json 为准） |
| `qq` | `targetSessionFromFish` | `true` | **合并包专有**：读 `~/.dsh-fish/home.json` 的 `sessionId`，换房后自动跟随 |
| `qq` | `agentPreset` / `statePath` / `workspaceRoot` / `debugTools` | `''` / `''` / `''` / `true` | 见 4.4 |
| `qq` | OneBot / NapCat / 策略默认值 | 见 4.4 | 只是初始值 |

`targetSessionFromFish` 只在合并包里存在；单独安装 `dsh-qq-bridge` 时行为不变。
它只认 `session-<uuid>` 形状的 id，读不到就返回空串（不会把半截损坏的 json 当目标）。

打开它时，**每次读设置都会重新读一次 home.json，且 home.json 里的 id 优先**：
会话轮换换了新房间，下一条 QQ 消息就直接投到新会话；设置文件里存过的旧 id 只在
home.json 读不到时兜底（写回设置文件是为了让设置卡片别显示过期值）。

### 4.3 fish 配置（`~/.dsh-fish/config.json`）

按 `DEFAULTS` 递归补全，未知键保留（用户自己加的项不会被吃掉）；范围外的数字会被 clamp。

| 键 | 默认 | 范围 / 说明 |
| --- | --- | --- |
| `growthDays` | `30` | 7–180，四个阶段的成长总天数 |
| `wakesPerDay` | `1` | 0–4，每天最多主动醒几次（0 = 只在你找她时） |
| `window` | `['20:00','23:00']` | 醒来的时间段 |
| `daily.events` | `2` | 0–6，每天推进几条成长事件 |
| `daily.questions` | `1` | 0–6，其中她提问的上限 |
| `diary.enabled` | `true` | 写不写日记 |
| `diary.visible` | `false` | 给不给你看正文（默认不给） |
| `diary.keepDays` | `0` | 0 = 永久保留 |
| `absenceAfterDays` | `2` | 1–30，多久不出现算冷落 |
| `tools.preset` | `''` | 她那条会话的 agent preset（宿主支持时） |
| `tools.restrict` | `true` | 工具面收窄总开关 |
| `tools.allow` | `[]` | 额外放行的宿主工具名（必须真实存在） |
| `avoid.keywords` | `['恐怖','血腥','鬼畜','政治']` | 她「不想看」的关键词 |
| `avoid.upMids` | `[]` | 屏蔽的 UP 主 mid |
| `avoid.minDuration` | `60` | 太短的视频不看（秒） |
| `browse.enabled` | `true` | 能不能上网 |
| `browse.perDay` | `1` | 0–4，每天最多刷几次 |
| `browse.topN` | `4` | 1–20，一次看几条 |
| `browse.deepRead` | `6` | 0–40，每条深读几条热评 |
| `browse.danmaku` | `6` | 0–30，每条抽几条弹幕 |
| `browse.keywords` | `[]` | 额外搜索词 |
| `browse.window` | `['08:00','23:00']` | 上网时段 |
| `browse.voices` | `true` | 允许她读到评论区别人的话 |
| `video.enabled` | `true` | 能不能看画面 |
| `video.perDay` | `2` | 0–6，每天最多看几条视频的画面 |
| `video.frames` | `9` | 4–16，每条取几帧（9 = 3×3） |
| `notify.enabled` | `false` | 桌面提醒（她真的开口之后才弹） |
| `comment.enabled` | `false` | 在 B 站说话的总开关 |
| `comment.perDay` | `1` | 0–5 |
| `comment.replyPerDay` | `2` | 0–10 |
| `comment.replyToReplies` | `true` | 别人回她时允许回一句 |
| `comment.scanEveryMin` | `30` | 5–720 |
| `comment.window` | `['20:00','23:00']` | 说话时段 |
| `comment.atOwner` | `true` | 评论前 @ 主人 |
| `chat.rotateAfter` | `40` | 0–500，聊满多少轮换新会话（QQ 轮也计数） |
| `chat.replyChars` | `0` | 0–2000，单轮字数预算（0 = 不限） |
| `chat.handoff.enabled` | `true` | 换会话时要不要生成《近期剧情提要》 |
| `chat.handoff.turns` | `30` | 5–200，从记忆里取最近多少轮来压缩 |
| `chat.handoff.maxChars` | `300` | 80–800，提要字数上限 |
| `chat.handoff.provider` | `''` | 摘要用的**宿主** llm provider（与 `model` 配对）；空 = 部署默认模型。2026-11-03 起不再有 HTTP endpoint / apiKey |
| `chat.handoff.model` | `''` | 摘要用的宿主模型名；空 = 部署默认（和大肥鱼聊天同一个） |
| `memory.docBudget` | `1800` | 600–4000，身份文档字数预算 |
| `memory.sleepEveryDays` | `7` | 0–60，每几天让她想一想 |
| `memory.sleepKeep` | `12` | 0–100，自述保留条数 |
| `memory.beliefsShown` | `3` | 1–8，一轮里摆几条判断 |
| `rules.offers` | `true` | 允许她提出「改一条规矩」 |
| `rules.holdDays` | `3` | 1–30，申请搁置天数 |
| `rules.cooldownDays` | `3` | 1–30，被驳回后的冷却 |
| `work.enabled` | `true` | 能不能派活 |
| `work.dir` | `''` | 派到哪儿；空 = 插件所在目录的上一级 |
| `work.perDay` | `3` | 0–10，每天最多派几件 |
| `observe.enabled` / `observe.port` | `true` / `0` | **保留项**：当前代码总会挂观测台路由，不读这两个值 |
| `ui.ownerHintDismissed` | `false` | 界面提示是否被手动关掉 |

`config.json` 坏了不会覆盖：改名备份、用默认值，并在 `/selfcheck` 与日志里报出来。

### 4.4 qq 设置（55 项）

QQ 的 55 项用户设置、默认值、存储位置与读写优先级，唯一事实源见 [qq.settings](../docs/domains/qq/settings.md)；这里不再重复表格。

### 4.5 环境变量

| 变量 | 作用 | 读取处 |
| --- | --- | --- |
| `DSH_FISH_HOME` | fish 状态库根（默认 `~/.dsh-fish`） | `store.rootDir()` |
| `DSH_HOME` | 宿主 home；qq 状态/设置/图片缓存在它下面 | `qq/index.js` |
| `DSH_FISH_WORKSPACE` | 工作区根的回退值 | `workspace.js` |
| `DSH_FISH_WORK_DIR` | 派活目录的回退值 | `work.js` |
| `DSH_FISH_CHECKLOGS_DIR` | 任务完成日志目录（默认 `<包根>/CheckLogs`） | `checklog.js` |
| `DSH_FISH_PET` | 设为 `0` 不拉桌宠窗口 | `pet/` |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | `downloadProxy` 留空时的下载代理回退（依次读） | `napcat.js` |
| `<accessTokenEnv 的值>` | 变量名由设置决定，token 从它读 | `resolveAccessToken()` |

凭据解析顺序：`ctx.credentials.resolve(变量名)` → `process.env[变量名]`。
**不要把 token 明文写进设置**；那一栏要的是变量名。

---

## 5. 工具面（对外最重要的接口）

### 5.1 她能看到什么

她的工具面从 global 层迁到「她那条会话的 own 层」，再由 restrict + guard 收窄；工具名单、数量与挂载策略见 [fish.tools](../docs/domains/fish/tools.md) 与 [fish.scope](../docs/domains/fish/scope.md)。

### 5.2 fish 的工具

fish 自己的工具清单、当前实际数量与三把刀见 [fish.tools](../docs/domains/fish/tools.md)；具体工具的参数与执行归各自单元。

### 5.3 qq 的 13 个工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `qq_bridge_status` | 无 | 设置 / 连接 / 唤醒日志 / 出站台账 / 闸门状态（**排障第一入口**） |
| `qq_bridge_proactive` | `action`：status/scan/force | 主动私聊；force 仍受每日上限 |
| `qq_bridge_transport` | `action`：status/reconnect | 看/重连 OneBot |
| `qq_bridge_simulate` | `text`、`userId`、`groupId`、`nickname`、`atSelf`、`dryRun` | 模拟入站，走完整唤醒策略（调试） |
| `qq_bridge_send` | `text`、`userId`/`groupId`、`atQQ`（可选） | `replyMode='tool'` 的正式通道；非 QQ 轮第一次只回确认 |
| `qq_bridge_send_multi` | `messages`（1–3 条字符串）、`userId`/`groupId`、`atQQ`（可选，只加第 1 条） | 分条发送：按顺序逐条发，条间随机停 500–1000ms；发出去过之后该轮 `[QQ]` 块整段丢弃（防重复）；非 QQ 轮同一道确认闸门 |
| `qq_bridge_subsend` | `targetQQ`、`message`、`atQQ`（可选） | **主人专用**：私聊发给指定号；限流 + 冷却 |
| `qq_bridge_fileget` | `path` | **主人专用**：把工作区文件私聊发给主人 |
| `qq_bridge_filesend` | `targetQQ`、`path` | **主人专用**：把工作区文件私聊给指定号 |
| `qq_bridge_sticker` | `action`(list/save/send)、`hash`、`fromLast`、`mood`、`description`、`userId`/`groupId` | 表情包登记与发送（base64 发送） |
| `qq_bridge_napcat` | `action`(status/download/configure/launch/stop)、`version`、`configDir`、`force` | 自助托管 NapCat，全部显式触发 |
| `qq_bridge_listen` | `minutes`、`off` | 会话跟随窗口（默认 5 分钟，上限 60） |

`qq_bridge_status` / `proactive` / `transport` / `simulate` 受 `debugTools` 控制；
其余是产品能力，始终注册。所有 qq 工具返回 **JSON 字符串**（`output.schema: { type: 'string' }`）。

### 5.4 工具返回约定（写新工具前必读）

- `parameters` 必须是根级 `type: 'object'` 的完整 JSON Schema；用 `toJsonSchema({...})` 写简写。
- `output.schema` 只描述结构化返回值；`output.render(args, value)` 才是**模型看到的内容**，
  必须返回 `[{ type:'text'|'image', ... }]` 数组。
- 回执尽量用方括号写机器状态（`[已记下 ev_x]`），不要写成一句“人话”——
  模型会把工具回执当自己的话接着复述（真实踩过）。
- 工具执行里 **不要抛异常**：路径错误、服务缺失都返回 `ok:false` + 一句中文原因。

### 5.5 扩展一个工具的最小步骤

1. 在 `fish/lib/` 或 `qq/index.js` 里 `ctx.tools.register(defineTool({...}))`；
2. 名字加进 `FISH_TOOLS` / `QQ_BRIDGE_TOOLS`（否则她的工具面收窄会把它挡住）；
3. 如果要进她的身份文档，加一条 brief（`fish/lib/persona.js`）并挂进 `selfdoc.js`；
4. 加测试；fish 用 `node:test`，qq 用脚本式断言（见第 13 节）。

---

## 6. 事件与宿主钩子

| 钩子 | 谁在用 | 用途 / 注意 |
| --- | --- | --- |
| `ctx.on('agent/created')` | fish restrict / identity | 会话创建时收窄工具面、挂 system prompt 段。**必须早于会话第一步**（同步串行） |
| `ctx.on('session/event')` | qq / fish scheduler / fish checklog | 一轮的完整生命周期，见下表 |
| `ctx.on('settings/updated')` | qq（仅 0.1.5） | 设置页改完立刻生效 |
| `ctx.emit('checklog/finished')` → `ctx.on('checklog/finished')` | fish checklog → qq | fish **写成**一条任务日志后 emit，载荷 = 日志字段（`buildTaskResult`）；qq 接住后按 `checklogNotifyMode` 分档：`'system'` 发模板、`'agent'` 投「处境」让她自己说（详见 §7.3）。fish 不 import qq，两边只约定这一个事件名 |
| `ctx.on('dispose')` | 两边 | 停定时器、注销路由、关桌宠；`ctx.on` 注册的监听一并被宿主摘掉 |
| `ctx.effect(fn)` | 两边 | 资源回收；`fn` 返回 dispose |

`session/event` 里会看到的事件（qq 与 scheduler 实际依赖的）：

| `event.type` | `event.data` | 用途 |
| --- | --- | --- |
| `turn/start` | `{ turn }` | 快照「这一轮是不是 QQ 起的」「该回哪个目的地」 |
| `user/message` | `{ message }`（或 `{turn,step,message}`） | 判断来源：自己注入的 / 人在 DSH 打字 / harness 上下文 |
| `assistant/message` | `{ message }` | 收集这一轮的回复文本（`[QQ]` 块从里面抽） |
| `turn/end` | `{ reason: { kind } }` | 出站、清状态；fish 用它写任务完成日志 |

`turn/end` 的 `reason.kind`（宿主 `TurnEndReason`）：`completed` / `max-tokens` /
`aborted` / `interrupted` / `blocked` / `error`；`forked` 只出现在种子变体里。

⚠️ 时序坑（qq 已经按这个写，扩展时别改）：`followup()` / `steer()` 会**同步**触发
`turn/start`，所以「这一轮来自 QQ」「来自主人」这些标志必须在投递**之前**置位；
投递失败要按快照回滚。

### 6.9 指令一览

指令族的完整事实源已拆到 L1：解析、权限、是否唤醒/进缓冲、outbox 的 via 与限流分别见 [qq.subsend](../docs/domains/qq/subsend.md)、`qq.fileget`（T4 待建）、[qq.help](../docs/domains/qq/help.md)、[qq.whitelist](../docs/domains/qq/whitelist.md)、[qq.receive](../docs/domains/qq/receive.md)、[qq.list](../docs/domains/qq/list.md)、[qq.admin](../docs/domains/qq/admin.md)；安全闸门汇总见 [qq.safety](../docs/domains/qq/safety.md)。

---

## 7. 数据布局

### 7.1 `~/.dsh-fish/`（fish 状态库）

| 路径 | 内容 | 能不能删 |
| --- | --- | --- |
| `events.jsonl` | **唯一真相源**：只追加的事件流 | 不能删（删了等于删她） |
| `state.json` | 派生快照，可由事件流重算 | 可以删，下次启动重建 |
| `config.json` | 她的环境参数（4.3） | 可以，回落默认 |
| `owner.json` | B 站登录（cookie）等，权限 0600 | 删了等于退出登录 |
| `home.json` | 她的屋子：`{ wsId, sessionId }` | 删了下次启动重建屋子 |
| `diary/YYYY-MM-DD.md` | 她的日记 | 看 `diary.enabled/visible/keepDays` |
| `out/YYYY-MM-DD.md` | 刷站报告；`out/covers/` 是视频封面缓存 | 可删 |
| `home/` | 她那条会话的 cwd；里面是「她的身份.md」 | 不建议删 |
| `media/` | 看视频抽的帧、聊天里落盘的图片等 | 可删 |
| `logs/dsh-fish.log` | 插件自己的运行日志（带滚动） | 可删 |
| `pet/` | 桌宠窗口的文件通道 | 可删 |
| `electron/` | 桌宠用的 Electron 运行时（首次后台准备，约 144MB） | 可删 |
| `inbox.md` | 她留给你的话的纯文本副本 | 可删 |
| `talk-recent.json` | 换会话时带走的几句话 | 可删 |
| `avatar.<ext>` | 你上传的头像 | 可删 |
| `backups/` | 整包备份 | 按需 |

### 7.2 `$DSH_HOME/`

| 路径 | 内容 |
| --- | --- |
| `qq-bridge-state.json` | QQ 状态：缓冲、日志、出站台账、丢弃台账、目的地、监听窗口、主动私聊/subsend/发文件计数 |
| `qq-bridge-settings.json` | 0.2.0 上用户改过的 QQ 设置（`{version, values}`） |
| `storages/workspace.json` | 宿主的会话/工作区索引（不是本插件的） |

入站图片 / 表情包落在**大肥鱼的状态库**里，不在 `$DSH_HOME`：

| 路径 | 内容 |
| --- | --- |
| `~/.dsh-fish/attachments/<hash>.<ext>` | QQ 入站图片与表情包（收到即落盘，正文里带路径给她用 `image_look` 看；上限 200 个文件 / 64MB，按时间淘汰） |

`qq-bridge-state.json` 的形状（只列主要字段）：

```jsonc
{
  "buffer": [],            // 未唤醒期间的聊天缓冲（上限 200 条）
  "log": [],               // 最近唤醒/出站日志（上限 200）
  "outbox": [],            // 真的发到 QQ 的台账（上限 50）
  "dropped": [],           // 出站被拒的台账（上限 20）
  "lastDestination": null, // {kind:'private'|'group', userId|groupId}
  "lastMessageId": null,
  "listening": null,       // {key:'private:123', until:ms}
  "proactive": { "dayKey": "", "count": 0, "lastActivityAt": 0, "lastAt": 0 },
  "subsend":   { "dayKey": "", "count": 0, "lastAt": 0 },
  "fileSend":  { "dayKey": "", "count": 0, "lastAt": 0, "base64": false },
  "checklogNotify": { "dayKey": "", "count": 0, "lastAt": 0 },
  "addFriend": { "dayKey": "", "count": 0, "lastAt": 0 }
}
```

### 7.3 `CheckLogs/`

`work_request` 派出去的那条会话**这一轮结束**后，`fish/lib/checklog.js` 会在
`<包根>/CheckLogs/` 写一个 `.md`（可用 `DSH_FISH_CHECKLOGS_DIR` 改）：

- 文件名：`YYYYMMDD-HHmmss-<task sha1 前 8 位>.md`（同一秒同名会加随机后缀）；
- 内容：结果（成功 / 失败原因 / 中止 / 超时）、任务、会话标题与 id、派发/结束时间、耗时；
- **不抄她的回复正文**；
- 监听的是**本进程**的 `turn/end`：DSH 在任务跑完前重启、或插件被停用时，这一次没有日志。
- **写成之后**会 emit `checklog/finished`（任务完成日志 → QQ 通知的钩子）：
  - 载荷就是这条日志的字段（`buildTaskResult`：`ok` / `reason` / `task` /
    `sessionTitle` / `sessionId` / `status`（中文状态，模板据它说原因）/ `startedAt` /
    `endedAt` / `elapsedMs` / `file`）；
  - **只有写成功才 emit**——写失败时没有事实，也就不通知；
  - **任务通知只在本进程 turn/end 时触发；DSH 重启或插件停用期间结束的任务不会补发**
    （旧 `CheckLogs/` 文件不会被新进程扫描、不补发——钉死在
    `test-checklog-wire.mjs`「边界（任务书 7 钉死）」）；
  - qq 侧按 `checklogNotifyMode` 分档（默认 `'off'` = 不说）：
    - `'system'`：插件直接发一条模板——
      `[任务通知] 工作·写hello.py 完成了（耗时 3 分 12 秒）。` /
      `… 失败了：出错（耗时 …）。` / `… 超时了（等了两小时还没结束）。`
    - `'agent'`：`followup` 投一句「处境」给她（`你刚派出去的活儿有结果了：
      任务=…，结果=…，耗时=…。用一句话跟主人说一声。`），她那一轮说的话直发主人
      （绕 replyMode）；**她一个字没说就退回模板**，不静默。
    - 两档共用同一道门禁、同一个计数段：失败 / 超时必发，成功看
      `checklogNotifyOnSuccess`（默认关 = 成功是本分），另有
      `checklogNotifyDailyLimit` / `checklogNotifyTarget`。详见 `qq/CHANGELOG.md`。

### 7.4 `events.jsonl`（事件流）

一行一条 JSON，只追加。字段（`fish/lib/schema.js`）：

| 字段 | 说明 |
| --- | --- |
| `id` | `ev_` + 26 位 ULID（同毫秒单调递增，行序 = 时间序） |
| `v` | 事件格式版本（当前 1；没有 `v` 的老事件按 v1 读） |
| `ts` | ISO 时间 |
| `day` / `stage` | 写这条时的成长日 / 阶段（只用于信封，不回灌给模型） |
| `type` | 见下 |
| `source` | `seed` / `system` / `timer` / `tool` / … |
| `text` | 正文（≤2000 字；`meta`/`absence` 可为空） |
| `refs` | `revise` 指向的旧事件 id |
| `verdict` | `confirmed` / `refuted` / `refined`（仅 revise） |
| `confidence` | 0–1 |
| `flags` | `selfmod` / `unrecorded` / `weak` / `truncated` |
| `refuse` | `refusal` 专用：解析出的动作 + 对象 |
| `days` | `absence` 专用：真实冷落天数 |
| `grant` | `grant_offer` / `grant` 专用 |

`type` 全量：`seed`、`utterance`、`answer`、`test`、`revise`、`absence`、`reunion`、
`refusal`、`narration`、`meta`、`diary`、`voice`、`grant_offer`、`grant`。
她能写的（`HER_TYPES`）只有：`utterance` / `revise` / `reunion` / `narration` / `refusal`
（另加 `growth_commit` 的 `diary` 分支）。

铁律：**不能改写历史**。要改口就追加一条 `revise`。`state.json` 永远是派生品。

---

## 8. HTTP 接口

### 8.1 fish：`/dsh-fish/*`

35 个前缀 + 1 个 exact（`/dsh-fish` 本身是“走错门”的说明页）。全部经
`connection.requestRejection` 信任栅栏（同源/已登录），失败 503/403。

| 前缀 | 方法 | 用途 |
| --- | --- | --- |
| `/status` | GET | 旁观者状态（今天/阶段/在做什么） |
| `/state` | GET | 派生模型摘要（不返回 needs）；赛博小屋的 `/api/fish-home/state` 见 [house.api.state](../docs/domains/house/api-state.md) |
| `/events` | GET | 事件流分页/筛选 |
| `/beliefs` | GET | 她现在的判断 |
| `/diary` | GET | 日记（`?day=YYYY-MM-DD` 取某天；不可见时只给日期） |
| `/config` | GET / POST / PUT | 读配置；POST 只接受白名单键（4.3） |
| `/tools` | GET | 宿主认得的工具名（白名单输入框校验用） |
| `/rules` | GET | 规则在哪一层、待裁决申请 |
| `/decide` | POST | 对她提的规则申请做裁决 |
| `/owner` | GET / POST / PUT | B 站登录状态与存/清 cookie |
| `/browse` | GET | 刷站状态、今天的候选、屏蔽词 |
| `/history` | GET | 她看过什么（`?days=`） |
| `/selfcheck` | GET | 环境自检（`?net=0` 跳过联网） |
| `/update` | GET | 检查更新（只在点按钮时出网） |
| `/away` | GET | 你不在的时候发生了什么 |
| `/cover/BV…` | GET | 视频封面（懒下载缓存；404 = 没有） |
| `/avatar` | GET / POST | 头像：GET 出图、`/avatar/info` 元信息、POST 存/删 |
| `/media/principle-*.svg` | GET | 插件自带的两张原理图（白名单文件名） |
| `/risk` | GET / POST | 风控冷却状态；POST `{clear:true}` 解冻 |
| `/reports` | GET | 刷站报告列表/正文 |
| `/templates` | GET | 成长事件模板 |
| `/wake` | POST | 叫醒她（`?focus=browse` = 让她去刷 B 站） |
| `/say` | POST `{text, image?}` | **对话入口**：你说的话进她那里；返回她这一轮写的话 |
| `/inbox` | GET / POST | 信箱；POST = 标记已读 |
| `/home` | GET | 屋子/会话/身份文件状态 |
| `/paths` | GET | 数据目录路径（界面不显示绝对路径，复制按钮用它） |
| `/memory` | GET | 记忆/身份文档状态 |
| `/notify` | POST | 桌面提醒（受 `notify.enabled` 控制） |
| `/comment` | GET | 评论区状态（**只读**，不提供代发） |
| `/log` / `/log/export` | GET | 运行日志预览 / 导出 |
| `/log/clear` | POST | 清空日志 |
| `/backup` | GET | 备份列表 |
| `/backup/restore` | POST | 恢复备份 |
| `/reset` | GET / POST | 查状态 / 重置（POST 必须带 `confirm:"reset"`） |

### 8.2 qq：`/api/qq-bridge/*`

| 路径 | 方法 | 用途 | 准入 |
| --- | --- | --- | --- |
| `/api/qq-bridge/settings` | GET / POST | 读写 QQ 设置（只写 schema 白名单键）。**只在 0.2.0 类宿主上挂**；0.1.5 走 settings 命名空间 | 仅本机 + 来源校验 + JSON content-type |
| `/api/qq-bridge/fetch-models` | GET | 用 `apiUrl` / `apiKey` 拉 `/v1/models`（模型池卡片的「刷新拉取」）；10 秒硬超时 | 仅本机 + 来源校验 |
| `/api/qq-bridge/test-model` | POST | 极简 chat 测连通，body `{apiUrl, apiKey, modelName}`；强制关思考 + 10 秒硬超时，返回 `latencyMs` | 仅本机 + 来源校验 + JSON content-type |
| `/api/qq-bridge/napcat` | GET | NapCat 安装/运行/WebUI 信息 | 同上 |
| `/api/qq-bridge/napcat/launch` | POST | 启动 NapCat（已在跑则不重复） | 同上 |
| `/api/qq-bridge/napcat/reveal` | POST | 在文件管理器里打开安装目录 | 同上 |

`sendJson()` 统一返回 `{ ok, error? }`；动作失败也是 200 + `ok:false`（请求本身是成功的）。

### 8.3 观测台在哪

浏览器直接敲 `/dsh-fish` 会被信任栅栏挡成 401/503——真正的观测台是设置页里的
「大肥鱼」section（同源请求，cookie 天然带着）。`/dsh-fish` 只留一个说明页。

---

## 9. OneBot 对接

### 9.1 连接

- 只支持 **正向 WebSocket**（插件作为客户端连 NapCat / go-cqhttp），地址 `onebotUrl`。
- token 走查询串 `?access_token=…`（WHATWG WebSocket 不支持自定义头）。
- 连接建立后调 `get_login_info` 取 `selfId`（用于过滤自己的消息，防回环）。
- 掉线按 1s→30s 指数退避重连；心跳超时（`heartbeatTimeoutMs`，默认 90s）判定死连接。
- 所有定时器都归 `dispose()` 管。

### 9.2 用到的 OneBot action

| action | 用途 |
| --- | --- |
| `get_login_info` | 连上后取 selfId |
| `get_group_info` | 群名（只用于渲染，失败不影响策略） |
| `get_forward_msg` | 合并转发取回节点内容（失败只留提示，不丢消息） |
| `get_file` | 收文件的**兜底**：file 段没带 url / 可下载路径、但有 file_id 时调它取回 url（NapCat 支持） |
| `send_private_msg` | 私聊出站、主动私聊、subsend、help、receive 回执 |
| `send_group_msg` | 群聊出站、help、receive 回执 |
| `upload_private_file` | fileget / filesend；本机不认时退 `base64://` |

### 9.3 入站映射

- `post_type=message`：`message_type=private/group`；`message` 支持**数组段**与 CQ 码字符串两种形态。
- 文本 / @ / 图片以外的段（表情、语音、视频、文件、卡片、合并转发、戳一戳…）都变成
  占位符（`[表情12]`、`[图片]`、`[文件]`…），**绝不让整条消息因为“没文字”而消失**。
- 图片：除占位符外收集 URL，唤醒时下载落盘并交给多模态模型写描述，描述就地填回占位符。
- **文件（`file` 段，2026-10-30）**：占位符 + 记账（`url` / `file` / `name` / `file_size` /
  `file_id`），record / wake 分叉**之前**下载到 `<工作区>/receive/`（命名「发送人昵称_原文件名」、
  重名加序号；50MB 上限；失败写清原因不静默丢弃），正文就地写成
  `[文件 path=… 大小=… 来自=…]`。下载源：`url` > 本机路径 / base64 的 `file` >
  `file_id` → `get_file` 兜底。
- 合并转发（`forward` 段）：调 `get_forward_msg` 取回节点，拼成「发送人：文本」的多行文字
  就地替换 `[合并转发]` 占位符；嵌套转发再展开一层，更深的标「层级过深，未展开」；
  取不到 / 报错时换成 `[合并转发：内容读取失败]`，消息与正文都不丢。两种 `message` 形态都处理。
- `post_type=notice`：目前适配戳一戳（`poke`），其它 notice 只记日志不吞。
- `post_type=meta_event`：只用于观察连接健康，不进策略。
- `post_type=message_sent` 与 `user_id === selfId`：直接忽略（防回环）。

### 9.4 出站形态

`marker` / `tool` / `always` 三种出站方式、来源闸门，以及 subsend / 主动私聊等独立通道，见 [qq.outbound](../docs/domains/qq/outbound.md)。

### 9.5 唤醒策略（`decide()` 的完整顺序）

唤醒决策的分支顺序与各分支条件见 [qq.wake](../docs/domains/qq/wake.md)；以 `decide()` 代码为准，本节不再维护流程清单。

### 9.6 NapCat 托管

`qq_bridge_napcat` 的动作顺序：

```
status → download（下最新发行包 + sha256 校验 + 纯 Node 解包，拒绝 zip-slip）
       → 手动跑 NapCatInstaller.exe 并完成 QQ 首次登录（交互式，插件转不了键盘）
       → configure（写 config/onebot11.json，把正向 WS 端口与 token 配好）
       → launch / stop
```

插件**加载时绝不下载或执行任何东西**；启动优先走 `launcher-win10.bat` / `launcher.bat`
（可能弹 UAC），没有脚本时直接调 `NapCatWinBootMain.exe` + `NapCatWinBootHook.dll`。
NapCat 由宿主的 subprocess 服务托管，插件卸载 / DSH 退出时会一并结束。

---

## 10. 安全闸门（改之前必须知道）

白名单 fail-closed、认主 / 管理员、help / receive / list 的解析形状与权限见 [qq.safety](../docs/domains/qq/safety.md)；出站闸门与文件沙箱分别见 [qq.outbound](../docs/domains/qq/outbound.md) 与 INDEX 的 qq.files / fish.workspace。

---

## 11. 兼容性与坑

| 事项 | 说明 |
| --- | --- |
| 宿主两代设置模型 | 0.1.5：`settings.register/get`、命名空间 `qq-bridge`；0.2.0：`register` 被删，表单从插件 `Config` schema 派生。qq 按**方法探测**，不按版本号 |
| 0.2.0 设置桥不可写 | 第三方插件拿不到可写域，qq 自己挂 `/api/qq-bridge/settings` + `qq-bridge-settings.json` |
| `tools.guard` | 老宿主可能没有：只记日志，`restrict` 仍生效（own 层那一个漏网工具挡不住） |
| `read_image` | 由宿主 `@deepseek-ai/dsh-tool-fs` 注册，只在持久 `attachments` 服务挂载时才有；缺了用 `image_look` |
| `tools.restrict` 名字必须存在 | 写错名字会整条抛错；代码会从报错里捡回真名单并按交集重收一次 |
| WebSocket | 用 Node 内置（>=20），**没有 `ws` 依赖**；别引入裸 `ws`，link 安装时解析不到 |
| 客户端 bundle | 一个包只能有一个客户端入口，id 必须等于包名；改完重启 |
| 源目录 | `dsh-fish/` 已归档到 `backup-before-merge/`，`dsh-qq-bridge/` 落后于本包；**不要直接跑构建脚本** |
| `CheckLogs` 边界 | 只监听本进程的 `turn/end`；重启/停用会漏记。停用插件 = 日志没有、`checklog/finished` 通知也没有（事件总线两头的监听随 ctx 一起销毁）。**任务通知只在本进程 turn/end 时触发；DSH 重启或插件停用期间结束的任务不会补发** |
| 事件流 | 只追加、不能删；`state.json` 可重建 |

---

## 12. 排查入口

| 症状 | 先看 |
| --- | --- |
| QQ 没反应 | `qq_bridge_status` → `transport.state` / `targetLoaded` / `recentLog` |
| 她能回但发不出 | `recentDropped`（太多是 `too-long` / `no-destination`） |
| 消息进错会话 | `targetSessionId` 是否被显式填过；清空回到自动兜底 |
| 设置页没有卡片 | `qq_bridge_status.clientHalf`；多半是装完没重启 / boot graph 没组合 |
| 她说什么都不做 | `~/.dsh-fish/logs/dsh-fish.log`；再看工具面收窄是否失败 |
| 她看不见图 | `image_look` 是否注册；`attachments` 服务是否在；`visionModel` 是否可用 |
| 派活没有日志 | `CheckLogs/` 是否可写；任务那一轮是否真的结束（重启会漏） |
| 派活没收到通知 | `qq_bridge_status` 的 `checklogNotify` 段：`mode` 是不是 `system`/`agent`、`todayCount` 是不是到上限；`CheckLogs/` 是否可写（写不出来就不 emit） |
| agent 档没收到她说的话 | 她那一轮是否结束（`turn/end` 没来就不发）；她是否一个字没说（此时已退回模板，`recentLog` 里 `spokenBy=template`）；`targetSessionId` 是否配了 |
| 读文件被拒 | 路径是否在工作区内；`scope=self` 是否在白名单（日记/事件流/报告/房间） |
| 收到的文件没了 | `qq_bridge_status` 的 `receive` 段：`files` / `maxFiles`（超 200 删最旧）；收件箱在 `<工作区>/receive/` |
| B 站风控 | `/dsh-fish/risk`，必要时 POST `{clear:true}` |

`qq_bridge_status` 里几个容易看错的字段：

- `gate.currentTurnFromQQ` 才是“这一轮发不发”的决定值；`pendingFromQQ` 只是注入时的意图。
- `targetLoaded=false` 但 `resumedHandles` 有值：句柄可能已死，下一次唤醒会 `resume`。
- `recentInboundSources[].ours=false`：插件没认出自己注入的消息 → 闸门会哑火。

---

## 13. 测试

```bash
# fish：70 条 node:test
cd dsh-fish-qq/fish
node --test --test-isolation=none

# qq：21 个脚本式套件（零依赖，自己造 WS 服务器 / zip）
cd dsh-fish-qq/qq
node test-help.mjs        # 新增：help 拦截 / 仅主人 / 不唤醒模型
node test-smoke.mjs       # 策略分支 / 出站闸门 / 设置卡片 / 遮挡
node test-onebot.mjs      # 收发全链路
node test-owner-proactive.mjs  # 认主 / 非主人标记 / 主动私聊
node test-subsend.mjs
node test-filesend.mjs
node test-stickers.mjs
node test-napcat.mjs
node test-checklog-notify.mjs   # 任务书 3+5：通知核心与文案（模板 / 处境 / 门禁 / 限流 / outbox）
node test-checklog-wire.mjs     # 任务书 4：接线验收（派失败任务 → QQ 收到通知；成功默认不发、开开关后发；停用插件后没通知）
node test-checklog-agent.mjs    # 任务书 5：agent 档（她说的话发主人；没说 → 模板兜底；成功看开关；她的轮占着 → 模板）
node test-receive.mjs     # 收文件：file 段落地 / 50MB 跳过 / 失败原因 / get_file 兜底 / receive 权限 / 目录淘汰
node test-list.mjs        # list 指令：dist / managehub 清单 / 路径白名单 / 权限三档 / 空目录与不存在 / 超 20 截断
```

本工作区另有 `scripts/verify-bundle.mjs`（不在包内）：验客户端 bundle 的 id / 两边的挂载点 /
宿主 `apply` 不抛 / 工具齐全 / 路由齐全 / vendored 子包与源目录一致。
最后一项目前会 FAIL——`dsh-qq-bridge/` 源目录落后于本包（缺 subsend/fileget），
不是本包的运行时问题。


