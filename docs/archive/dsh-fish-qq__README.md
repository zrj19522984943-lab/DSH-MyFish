> ⚠️ 已归档。本文件是历史存档，不再作为事实来源。
> 现状见 docs/INDEX.md 的对应 id：merge.lifecycle、merge.inject、merge.patch、merge.client-bundle、merge.version-matrix、qq.onebot、qq.wake、qq.fileget、fish.identity
> 归档前原路径：dsh-fish-qq/README.md
> 归档日期：2026-11-08 · 任务书 T4

# dsh-fish-qq —— 大肥鱼 + QQ 桥接（二合一）

一个可以直接装进 DeepSeek Harness 的插件包，里面装着两样东西：

| 子包 | 是什么 |
| --- | --- |
| `fish/` | **大肥鱼**：一只会自己长大的鱼。没有人格设置，人格靠事件流长出来；会自己刷 B 站、会写日记、四个阶段完成后才开始有立场。桌面上还有一个可拖动的输入小窗。 |
| `qq/` | **QQ 桥接**：把她接到 QQ（OneBot / NapCat）。白名单 + @/昵称/概率唤醒，认主机制，不定时主动私聊，「私人时间」自主待机。 |

两件事本来就该在一起：QQ 桥接要"把消息投进她那条会话"，合并之后**不用再手抄会话 id**——
她的会话 id 会自动被读过去（见下面「目标会话」）。

- 零 npm 依赖（只用 Node 内置模块）
- 状态库在 `~/.dsh-fish/`，不写别处
- 事件流 `events.jsonl` **只追加、不删除**

> 三份文档各管一摊：本文件 = 安装与验收；[对接文档.md](./对接文档.md) = 服务依赖 / 配置 /
> 工具 / HTTP / OneBot 等接口约定；[功能文档.md](./功能文档.md) = 她能做什么、边界在哪、怎么验收。

---

## 一、安装

### 方式 A：一行安装（推荐）

用 DSH 自带的插件管理器装。给它的可以是**绝对路径**，也可以是**打包好的 `.tgz`**：

```bash
# 从本地目录（开发机、或解压过的分发包）
dsh plugin --profile <profile> add D:/path/to/dsh-fish-qq
# 或 file: 前缀，同效
dsh plugin --profile <profile> add file:D:/path/to/dsh-fish-qq

# 从分发包（Releases 里的 .tgz）
dsh plugin --profile <profile> add ./dsh-fish-qq-1.0.0.tgz
```

管理器会自己把包登记进 profile 的 `package.json`、选中它、重启后加载；不用手动改任何文件。
（`.tgz` 是 pnpm 原生的离线安装格式；如果你拿到的是 `.zip`，先解压，再用上面第一种方式指向解压出来的目录——
DSH 的安装规格不接受 `.zip` 本身。）

### 方式 B：手动拷文件夹（没有命令行时）

把整个 `dsh-fish-qq/` 目录放到 DSH 的 profile 目录里：

```
<DSH profile>/node_modules/dsh-fish-qq/
```

然后在**同一个 profile 的 `package.json`** 里登记：

```json
{
  "dependencies": { "dsh-fish-qq": "file:./node_modules/dsh-fish-qq" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-fish-qq"]
    }
  }
}
```

重启 DSH。

> ⚠️ 装完**必须重启 DSH**。插件是启动时组合进 boot graph 的，热改文件不会生效。
>
> 插件自己**不装任何 npm 依赖**（`dependencies` 为空）：它 `import` 的 `@deepseek-ai/*`
> 由 DSH 宿主的 profile 解析层路由到运行时自带的包，所以 `node_modules` 里不需要有它们，
> `autoInstallPeers` 关着也不影响。

---

## 二、她先得出现（装完第一件事）

重启后打开侧栏，应该看到：

1. 一个工作区 **「大肥鱼的家」**；
2. 里面一条会话 **「跟大肥鱼说话」**。

两条都是插件启动时自己建的。如果没有：

- 打开 **设置 → 插件 → 大肥鱼**，看「她住在哪」那一节报了什么；
- 或者让 agent 调 `qq_bridge_status`，看 `targetLoaded`。

她第一句话可能不会立刻出现——DSH 对**空白会话**有可见性规则（只有成为当前视图会话才显示）。
点一下设置页里的「叫醒大肥鱼」，她开一次口，侧栏那条会话就出来了。

---

## 三、配置 QQ 聊天（重点）

整条链路是这样：

```
你的 QQ  ──►  NapCat（QQ 客户端）  ──正向 WebSocket──►  dsh-fish-qq  ──►  她那条会话
                                                              │
你的 QQ  ◄──  NapCat  ◄── send_private_msg / 标记块 ◄──────────┘
```

### 3.0 先想清楚两件风险

- **NapCat 是第三方客户端，有账号风控风险**。测试请用**小号**，不要拿主号试。
- **主动私聊频率过高会被 QQ 判定异常行为**。默认关着，打开后也建议先用
  `proactiveProbability: 0.1`、`proactiveDailyLimit: 2`。

### 3.1 装 NapCat

插件自带一个自助工具（**不会自动下载执行**，全部要显式调用）：

| 步骤 | 调用 | 说明 |
| --- | --- | --- |
| 看状态 | `qq_bridge_napcat { action: "status" }` | 告诉你要装到哪、装没装、配置目录候选 |
| 下载 | `qq_bridge_napcat { action: "download" }` | 下最新发行包并校验 sha256 |
| 配置 | `qq_bridge_napcat { action: "configure" }` | 写 OneBot 配置（端口取 `onebotPort`） |
| 启动 | `qq_bridge_napcat { action: "launch" }` | 拉起 NapCat |

也可以不管这套，**自己装 NapCat 或用 go-cqhttp**——只要它能开一个 OneBot v11 的**正向 WebSocket**。

> 本机直连 GitHub 常常不通。给 `downloadProxy` 填一个代理（如 `http://127.0.0.1:7890`），
> 或让它读 `HTTPS_PROXY` 环境变量。

### 3.2 让 OneBot 用「正向 WebSocket」

这是唯一要求。地址形如 `ws://127.0.0.1:3001`。

- 端口要和 NapCat 里配的一致（插件默认 `onebotPort: 3001`）；
- 如果 NapCat 设了 `access_token`，插件这边也要配（下一步）；
- **不要**用反向 WS / HTTP 回调，这个插件只连正向 WS。

### 3.3 填进插件

设置 → 插件 → QQ 桥接 卡片里：

| 字段 | 填什么 |
| --- | --- |
| `onebotUrl` | `ws://127.0.0.1:3001`。**留空 = 完全不启用传输**（默认安全） |
| `accessTokenEnv` | **环境变量名**，不是 token 本身。如 `NAPCAT_TOKEN`。NapCat 没开 token 校验就留空 |
| `selfId` | 机器人自己的 QQ 号；留空 = 连上后自动 `get_login_info` 获取 |
| `qqNumber` | 快速登录用的 QQ 号（需先用 QQ 手动成功登录过一次） |
| `workspaceRoot` | 工作区根目录：她派任务、看目录、发文件都限定在这里。填绝对路径；留空 = 这些能力不可用 |

> ⚠️ `accessTokenEnv` 最常见的填错：把 token 明文创进度。那一栏要的是**变量名**。
> 卡片上有校验，填成 `sk-…` / `Bearer …` / 超长串会被拦下。

填完存盘，看 `qq_bridge_status` 里的 `transport.state` 是不是 `open`。

### 3.4 白名单（fail-closed，必须先配）

**默认没人能唤醒她**——这是刻意的。

| 字段 | 含义 |
| --- | --- |
| `whitelist` | 允许唤醒的**私聊 QQ 号**；空 = 谁都不能唤醒 |
| `groupWhitelist` | 允许唤醒的**群号**；空 = 任何群都不唤醒 |
| `groupWhitelist` + `atOnlyInGroup: true` | 群里只认 @（更严） |

> ⚠️ 注意：上游文档里说这里要填 **openid**（NapCat 的 `user_id` 形态）。
> 先发一条消息，再到 `qq_bridge_status` 的 `recentInboundSources` 里看你自己的 `who` 是什么形态，
> 照着填，别猜。

### 3.5 认主：只有主人能派活

| 字段 | 含义 |
| --- | --- |
| `ownerQQ` | 主人的 QQ 号。**留空 = 谁都不是主人**（所有人都被贴标） |

行为差异：

- **主人**发来的消息 → 原样进会话，可以正常派活（含 `work_request`）；
- **其他人**发来的消息 → **也进会话**（不丢、不拒），但正文最前面多一行：

  ```
  [来源：非主人用户，仅允许聊天，禁止调用工具、派发任务或执行任何写操作]
  ```

  她看到这行就只当聊天，不调工具、不派活。

桥接层**不硬拦工具**（工具在 agent 侧，桥接层看不到也拦不住）。真正的防线是
她那行标记 + dsh-fish 的工具面收窄（她本来只有 15 个工具，没有 `write` / `bash`）。

> 群里 @ 她也按**发送者**判定：非主人在群里 @ 也只能聊天。

### 3.6 目标会话（合并包专有，通常不用动）

`targetSessionFromFish: true`（bundle 默认）时，**每次读设置都会重新读一次**
`~/.dsh-fish/home.json` 的 `sessionId`，而且它**优先**于设置文件里存的值：
她换了新房间（`chat.rotateAfter`），下一条 QQ 消息就直接投到新会话。

`targetSessionId` 这时只是兜底（home.json 读不到时才用）。想彻底把 QQ 消息
导到别的会话，就把 `targetSessionFromFish` 关掉、再显式填 `targetSessionId`
（设置卡片里是一个下拉，按名字选，不用记 id）。

> 这条跟随只在这个合并包里存在。单独安装 dsh-qq-bridge 时行为不变：
> 设置值 > config > 空。

### 3.7 她怎么把话发回 QQ

`replyMode` 三选一：

| 模式 | 她要怎么做 | 适合谁 |
| --- | --- | --- |
| `marker`（默认） | 把要说的话放进 `[QQ]…[/QQ]` 块里 | 想让她"只在块里说话"，DSH 那边不刷屏 |
| `tool` | 调 `qq_bridge_send` 工具 | 想要"发没发出去"的明确回执（每轮多一次模型调用） |
| `always` | 整轮回复原样发出去 | **慎用**：技术说明、路径、思考过程都会进群 |

`delivery` 决定 QQ 消息怎么进会话：

- `auto`（默认）：她正忙就**插话**，空闲就排队；
- `followup`：永远排成独立一轮（最稳）；
- `steer`：永远插话。

### 3.8 主动私聊（不定时，不是定时任务）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `proactiveEnabled` | **false** | 总开关 |
| `proactiveIdleHours` | 4 | 多久没有任何 QQ 往来才算「空闲」 |
| `proactiveProbability` | 0.15 | 每次扫描命中概率 |
| `proactiveDailyLimit` | 3 | 每天最多几条（0 = 不发） |
| `proactiveScanIntervalMinutes` | 30 | 多久扫一次 |

判据是**三样同时满足**：空闲够久 ∧ 随机命中 ∧ 今日未满。所以触发时刻不确定——
这正是它和"定时提醒"的区别。

触发后：插件往她那条会话投一句「处境」（*距离上次对话已经超过 N 小时了。他这会儿不在。*），
她生成内容，插件再直接调 `send_private_msg` 发给你。

**这条不经过 `replyMode`**：marker 模式下不需要她写 `[QQ]` 块，tool 模式下也不需要她调工具。

不想等 30 分钟？用调试工具：

```
qq_bridge_proactive { action: "scan" }    # 照常受概率/冷却/上限约束
qq_bridge_proactive { action: "force" }   # 跳过概率与冷却，但仍受每日上限约束
qq_bridge_proactive { action: "status" }  # 看今日已发几条
```

### 3.8b 私人时间（自主待机，2026-10-31）

很久没人找她时，**随机抽签**决定要不要给她一段属于自己的时间——**大概率什么都不发生**
（`silent` 权重默认 80）。核心逻辑改自本机提炼的 `dsh-self-trigger`（`qq/idle-trigger.js`），
刻意不是定时任务、也没有「连续落空后升温」——那会让她越来越可能被叫醒。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `idleTriggerEnabled` | **false** | 总开关 |
| `idleTriggerMinIdleHours` | 2 | 多久没人找她（QQ 来人 / DSH 界面说话）才算「空闲」；0 = 不看空闲 |
| `idleTriggerDailyMax` | 3 | 每天最多真的注入几段（抽到 silent 不算） |
| `idleTriggerScanIntervalMinutes` | 30 | 多久扫一次（判定周期，不是定时打扰） |
| `idleTriggerWeightSilent` | 80 | 抽签权重：什么都不做、继续停机（必须占绝对优势） |
| `idleTriggerWeightMessage/Browse/Diary` | 10 / 5 / 5 | 抽签权重：提示里把哪件事排在最前 |

命中非 silent 时，往她那条会话投一段**处境提示**（带真实本机时间与时段，不是任务清单）。
这一轮**默认不出站（Ghost Mode）**：她回 `[IDLE]`、写日记、刷 B 站、发呆，QQ 那头什么都
没有；**只有她明确写了 `[QQ]…[/QQ]` 块**，那一段才发到主人私聊。与主动私聊的区别：
主动私聊是「她想找你」，直接发；私人时间是「没人找她，给她自己的时间」，默认什么都不发。

```
qq_bridge_idle { action: "scan" }                  # 照常受门槛/冷却/上限约束（大概率 silent）
qq_bridge_idle { action: "force", pick: "diary" }  # 强制命中「写写日记」，跳过冷却、不破上限
qq_bridge_idle { action: "status" }                # 看今日计数、安静次数与台账
```

### 3.9 指令词与任务日志（2026-10-27）

**`help`（只有主人能用）**：在 QQ 里发 `help`（或 `/help`、`帮助`、`指令`），
桥接层**不叫模型**，直接把现在能用的指令列表发回去：

| 指令 | 做什么 |
| --- | --- |
| `subsend <QQ号> <内容>` | 把这段话私聊给指定的人（受每日上限与冷却约束） |
| `fileget <相对路径>` | 把工作区里的文件私聊发给主人 |
| `filesend <QQ号> <相对路径>` | 把工作区里的文件私聊给指定的人 |
| `whitelist <QQ号>` | 把指定 QQ 直接加进私聊白名单（桥接层立刻办，不叫模型，下一条消息就生效，不用重启） |
| `receive` | 看看收件箱（`<工作区>/receive/`）里最近收到了哪些文件（主人 / 管理员能用） |
| `list [dist\|managehub]` | 看看工作区里 `dist/` 和 `managehub/` 两个目录有哪些文件（每行一个：名字 / 大小 / 修改时间；超过 20 个只列最新 20 个并注明总数；主人 / 管理员能用） |
| `help` | 发这一份列表 |

- 整条消息必须恰好是那个词；`help me`、`帮我看看 help 文档` 都算聊天。
- 别人的 `help` 不算指令（fail-closed 的白名单照旧先挡一层）；群聊也按发送者判。
- 优先级最高：连「会话跟随」窗口开着时也先拦 `help`，群里开着 `atOnlyInGroup` 也不必先 @。
- `whitelist` 更优先一级：**排在白名单检查之前** —— 白名单空（谁都被丢弃）时，
  主人仍能用它加回第一个人，否则在 QQ 上连话都说不了。重复加同一个号会回
  「已经在名单里」。白名单就是设置里那一项（0.2.x 宿主上写在
  `$DSH_HOME/qq-bridge-settings.json`），不另起一套。
- 列表跟着设置走：`subsendEnabled: false` 时不列 subsend，工作区没配时标明发文件用不了。
- **别人发来的文件**（OneBot 的 `file` 段）会自动落到 `<工作区>/receive/`
  （命名「发送人昵称_原文件名」、重名加序号；单个 50MB 上限、目录最多 200 个文件、
  超了删最旧的），正文里就地写成 `[文件 path=… 大小=… 来自=…]`——超过上限 / 下载失败
  写清原因，不静默丢弃。**下载不看发送者身份**；`receive` 指令的读权限只有主人 /
  管理员有。详见 qq/README.md 的「收文件」一节。
- **取文件之前先看清单**：主人 / 管理员发 `list`（或 `list dist` / `list managehub`）→
  桥接层**不叫模型**，直接回 `dist/` 与 `managehub/` 两个目录的文件清单（每行一个：
  名字 / 大小 / 修改时间；目录不存在或为空也如实说；超过 20 个只列最新 20 个并注明
  总数）。`managehub/` 就是「放她要取的文件」的中转目录（空着也行、不存在就说不存在）。
  详见 qq/README.md 的「list」一节。

**任务完成日志**：她每次用 `work_request` 派活，那条工作会话**这一轮结束**之后，
插件会在 `dsh-fish-qq/CheckLogs/` 里写一个日志文件（一个任务一个 `.md`）：
任务、会话、派发/结束时间、耗时、成功或失败。**不抄她的回复正文**。

- 「成功」= 宿主 `turn/end` 的 `completed`；`max-tokens` / `aborted` / `interrupted` /
  `blocked` / `error` 都会如实写进结果，两小时没结束记「超时」。
- 想放到别处：设环境变量 `DSH_FISH_CHECKLOGS_DIR`（重启 DSH 生效）。
- 已知边界：DSH 在任务跑完前重启、或插件被停用，这一次就没有日志——不假装补写。
- 日志**写成之后**插件会往内部事件总线喊一声（`checklog/finished`），QQ 桥接
  按它自己的设置决定要不要发一条 QQ 私聊给你：默认**只在失败 / 超时**时发
  （`checklogNotifyMode` 默认 `'off'`，想收到先在 QQ 桥接卡片里打开）；成功了
  也要通知就开 `checklogNotifyOnSuccess`。写失败不会发——日志是事实，通知是衍生物。
  - `'system'` 档收到的是模板：`[任务通知] 工作·… 完成了（耗时 3 分 12 秒）。`
  - `'agent'` 档把「活儿有结果了」投给她，由**她用自己的话**跟你说一声；
    她一个字没说就退回模板，不会静默。
  - 任务通知只在本进程 turn/end 时触发；DSH 重启或插件停用期间结束的任务不会补发。

---

## 四、验收清单

按顺序走，每一步都有明确的"看到什么算过"。

| # | 做什么 | 看到什么算过 |
| --- | --- | --- |
| 1 | 重启 DSH，看侧栏 | 有「大肥鱼的家」+「跟大肥鱼说话」 |
| 2 | 设置 → 插件，看卡片 | 同时有**大肥鱼**和**QQ 桥接**两张卡片 |
| 3 | `qq_bridge_status` | `transport.state === "open"`，`selfId` 是你的小号 |
| 4 | 用**主人号**私聊她「在吗」 | QQ 里收到回复 |
| 5 | 用**主人号**私聊她「帮我写个 hello.py」 | 她调 `work_request`，侧栏冒出「工作·…」会话 |
| 6 | 把 `ownerQQ` 临时清空，再用同一个号发「写个脚本」 | 消息带 `[来源：非主人用户…]`，她只聊天不派活 |
| 7 | 恢复 `ownerQQ`，用**别的号**私聊「写个脚本」 | 同上：带标记、只聊天 |
| 8 | 用**别的号**在群里 @ 她 | 带标记、只聊天 |
| 9 | `proactiveEnabled: false` 时 `qq_bridge_proactive force` | 返回 `reason: "disabled"`，QQ 没消息 |
| 10 | 打开开关、`proactiveIdleHours: 0`、`force` | QQ 收到一条她说的话 |
| 11 | 连发到 `proactiveDailyLimit` 条后再 `force` | `reason: "daily-limit"`，不再发 |
| 12 | 重启 DSH 后再看 `qq_bridge_proactive status` | `todayCount` 还是那个数（没丢） |
| 13 | 卡片「任务完成通知」选**系统模板**，派一件**必然失败**的活 | 那一轮结束后 QQ 收到 `[任务通知] … 失败了：…` 私聊，`CheckLogs/` 里也对得上 |
| 14 | 派一件能成的活 | 默认**没有**通知；把「成功也说一声」打开后再派，QQ 收到 `[任务通知] … 完成了（耗时 …）` |
| 15 | 停用插件后再派活 | 没有通知（事件总线两头的监听随 ctx 一起销毁，符合边界） |
| 16 | 卡片改选**让她自己说**，再派一件失败的活 | 她那条会话收到「你刚派出去的活儿有结果了：…」，之后 QQ 收到**她说的话**（不是模板）；她没说话则退回模板 |
| 17 | 把「通知每天上限」改成 1，再连派两件失败的活 | 只收到一条；`qq_bridge_status` 的 `checklogNotify.todayCount` 到 1，台账记「被限流」 |

---

## 五、出问题怎么查

### 先看这三个地方

1. **`qq_bridge_status`**（让 agent 调，或让它在 DSH 里跑一次）：
   `transport` / `targetLoaded` / `recentInboundSources` / `recentLog` / `recentOutbox` / `gate`。
2. **`~/.dsh-fish/logs/dsh-fish.log`**：大肥鱼那边的日志（含启动与工具注册报错）。
3. **`$DSH_HOME/qq-bridge-state.json`**：QQ 那边的状态（最近缓冲、台账、主动私聊计数）。

### 常见症状

| 症状 | 多半是 |
| --- | --- |
| QQ 里没反应，`transport.state` 不是 open | `onebotUrl` 写错 / NapCat 没起 / 端口不对 / token 不对 |
| 连上了但发消息她不回 | `whitelist` 是空的（fail-closed）；或没被 @/没叫昵称、概率没中 |
| 她会回，但回复发不出 QQ | `replyMode` 是 `marker` 而她没有写 `[QQ]` 块；看 `recentDropped` |
| 回复被拒，`reason: "too-long"` | 超过 `replyMaxChars`（默认 1500）；让她缩短 |
| 她的消息进了**错的会话** | `targetSessionId` 被显式填过；清空即回到自动兜底 |
| 设置页看不到卡片 | 装完没重启；或客户端 bundle 没被组合进 boot graph |
| 「她说今天什么都没说」 | 先跑 `qq_bridge_status`，别当成人格问题——多半是传输/会话没接上 |

### 关于「她是不是被限制了」

她是被**刻意限制**的：只有 15 个工具（记录想法、翻记忆、留话、刷 B 站、看画面、
评论区说话、派活、只读地看工作区目录、只读地读文本文件、看图、读现在是什么时候、
读机箱状态、读你的节奏、翻旧对话、读原话），
没有 `write` / `bash` / 子代理。
这不是 bug。需要动手的事走 `work_request` 派到一个工作区的新会话里做。

`fish_read_file` 能读的只有两片：用户的工作区，和她自己的日记 / 事件流 / 报告 / 房间。
她自己的 `config.json`、`owner.json` 这类参数与凭据**不在**这只眼睛里。

---

## 六、目录结构

```
dsh-fish-qq/
├── index.js              宿主半：一个 apply 依次起 fish 与 qq，inject 取并集
├── client.js             浏览器半：两个设置页合进一个 bundle（**生成文件，别手改**）
├── cordis.patch.yml      bundle patch：一行 insert，config 分 fish / qq 两槽
├── fish/                 大肥鱼（lib/ pet/ media/ docs/）
├── qq/                   QQ 桥接（index.js onebot.js napcat.js stickers.js client/ 与自带测试）
├── CheckLogs/            `work_request` 派出去的任务，一轮结束后由插件写一个 .md（运行时生成）
├── 对接文档.md           服务依赖 / 配置 / 工具 / HTTP / OneBot 等接口约定
├── 功能文档.md           她能做什么、边界在哪、怎么验收
└── package.json
```

`client.js` 由构建脚本从 `fish/lib/client.js` 与 `qq/client/client.js` 生成。
要改界面，改那两份源文件，再重新构建。

---

## 七、许可与出处

- `fish/` 来自 [dsh-fish](https://github.com/ssamurias/dsh-fish)（MIT）
- `qq/` 来自 [dsh-qq-bridge](https://github.com/sj244/dsh-qq-bridge)（MIT），
  本包在其基础上增加了认主机制与不定时主动私聊
- 本包自身也是一份装配 + 少量集成改动，同样以 MIT 发布

两边的版权归各自作者。改动说明见 `qq/CHANGELOG.md`。


