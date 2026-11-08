> ⚠️ 已归档。本文件是历史存档，不再作为事实来源。
> 现状见 docs/INDEX.md 的对应 id：qq.settings、qq.wake、qq.outbound、qq.safety、qq.owner、qq.subsend、qq.fileget、qq.receive、qq.list、qq.help、qq.whitelist、qq.admin、qq.proactive、qq.idle、qq.checklog-notify、qq.napcat、qq.onebot、qq.state-file、qq.client-card
> 归档前原路径：dsh-fish-qq/qq/README.md
> 归档日期：2026-11-08 · 任务书 T4

# dsh-qq-bridge

**English** · Connect one **fixed DSH session** to QQ (OneBot / NapCat) and **keep its context** —
no new session, no re-priming. A **fail-closed whitelist** gates who may drive it; **@-mentions,
nicknames and pokes always wake** the model; everything else is only recorded (zero model calls)
until a **configurable sampling probability** hits or the model opens a short **follow-up window**.
Ships a settings card in **Settings → Plugins → Plugin configuration**, and can download, configure
and launch **NapCat** for you.

把一个已有的 DSH 会话接到 QQ（OneBot / NapCat 个人号），提供类似 QQ 群友的交互感受。

```sh
dsh plugin --profile web add github:sj244/dsh-qq-bridge
```

> Created with DSH itself — this is a vibecoding project. / 这是个 vibecoding 项目。本项目由 DSH 写成。

- 设计：[`DESIGN.md`](./DESIGN.md) ｜ 里程碑与真机实录：[`HANDOVER.md`](./HANDOVER.md) ｜ 变更：[`CHANGELOG.md`](./CHANGELOG.md)
- 当前版本 **v0.1.3**（维护性更新，见 [`CHANGELOG.md`](./CHANGELOG.md)）
- **M1–M8 全部完成**，已在**真实 NapCat + 真实 QQ** 上端到端跑通（Windows 真机）

## 目录

[功能](#功能) ｜ [安装](#安装) ｜ [唤醒策略](#唤醒策略) ｜ [接入 QQ](#接入-qqonebot--napcat)
｜ [NapCat 一键托管](#napcat-一键托管) ｜ [出站](#出站三种模式--来源闸门) ｜ [消息与图片](#消息占位符戳一戳图片)
｜ [表情包](#表情包) ｜ [subsend](#subsend主人点名发给谁) ｜ [发文件](#发文件fileget--filesend主人专用) ｜ [收文件](#收文件file-段--receive-指令) ｜ [whitelist](#whitelist主人加私聊白名单主人专用) ｜ [help](#help指令词列表主人专用) ｜ [私人时间](#私人时间自主待机2026-10-31) ｜ [设置界面](#设置界面与全部设置项) ｜ [注入的系统提示](#注入给目标会话的系统提示) ｜ [无人值守边界](#无人值守的安全边界不提供审批桥接)
｜ [上下文上限](#上下文上限) ｜ [工具一览](#工具一览) ｜ [已知限制](#已知限制与环境要求) ｜ [测试](#测试) ｜ [路线](#路线)

## 功能

- **注入固定会话**：`targetSessionId` 指向哪个会话，QQ 的消息就注入哪个会话，该会话原有的上下文继续使用。
  目标会话由插件显式加载（`agents.get(id)`，取不到时用 `agents.resume({ resumeSessionId })`），不回退到别的会话。
- **按概率唤醒，节省 token**：被 @、命中昵称、被戳时会话必须唤醒。其余消息按概率抽样（默认 5%）。
  没有抽中的消息只记录，不调用模型。详见[唤醒策略](#唤醒策略)。
- **出站受来源闸门限制**：出站有标记块和工具 2 种方式，由 `replyMode` 切换。2 种方式都只对“被 QQ 唤醒的那一轮”生效。
  在 DSH 界面里与同一个会话聊天时，正文不会漏进群里。
- **图片可见**：图片先落盘到 `~/.dsh-fish/attachments/`，正文里带上路径（`[图片 path=…]`），
  她用 `image_look` 就能看；多模态描述另附在原位。
- **表情包**：群友发的图可以登记成表情包，之后按情绪或哈希再发出去。登记过的图不再调用多模态模型。
  详见[表情包](#表情包)。
- **subsend（主人点名发给谁）**：主人在 QQ 里发 `subsend <QQ号> <内容>`，她就把这段话私聊发给指定的人。
  仅限主人、独立出站、受每日上限与冷却约束。详见 [subsend](#subsend主人点名发给谁)。
- **发文件（fileget / filesend，主人专用）**：主人在 QQ 里发 `fileget <相对路径>` 或
  `filesend <QQ号> <相对路径>`，她就把工作区里的那个文件通过 QQ 私聊发出去（走 `upload_private_file`，
  本机不支持时退 base64）。路径锁在工作区根目录里，越界 / 不存在 / 超过 50MB 都会被拒。
  详见 [发文件](#发文件fileget--filesend主人专用)。
- **收文件（别人发来的，自动落盘）**：群里 / 私聊有人发文件（OneBot 的 `file` 段），
  桥接层**收到就下载**到 `<工作区>/receive/`，命名「发送人昵称_原文件名」（重名加序号）、
  单文件 50MB 上限、目录最多 200 个（超了删最旧的）；正文里就地写成
  `[文件 path=… 大小=… 来自=…]`，path 后面就是文件本身。主人 / 管理员发 `receive`
  可以直接看收件箱近况（**不叫模型**）。详见 [收文件](#收文件file-段--receive-指令)。
- **whitelist（主人加私聊白名单，主人专用）**：主人在 QQ 里发 `whitelist <QQ号>`，
  桥接层**立刻**把该号写进私聊白名单并回一句确认（**不叫模型、不需要一次性授权**），
  下一条消息就生效，不用重启。空名单时主人也能用它加回第一个人。详见
  [whitelist](#whitelist主人加私聊白名单主人专用)。
- **help（指令词列表，主人专用）**：主人在 QQ 里发 `help`，**不叫模型**——桥接层直接把能用的
  指令列表发回去。详见 [help](#help指令词列表主人专用)。
- **私人时间（自主待机）**：很久没人找她时，**随机抽签**决定要不要给她一段属于自己的时间——
  大概率什么都不发生（`silent` 权重默认 80）。命中时投一段带真实时间的「处境提示」，
  不是任务清单；那一轮**默认不出站**（Ghost Mode）：她回 `[IDLE]`、写日记、刷站、发呆，
  QQ 那头什么都没有；只有她明确写了 `[QQ]` 块，那一段才发到主人私聊。详见
  [私人时间](#私人时间自主待机2026-10-31)。
- **有设置卡片**：昵称、白名单、概率、目标会话、出站方式、OneBot 地址、视觉模型等都在
  `设置 → 插件 → 插件配置` 里修改，保存即生效。
- **NapCat 自助托管**：插件可以按需下载、校验、解包、写配置、启停 NapCat。

**不做的三件事**：

1. 不接管审批（见[无人值守边界](#无人值守的安全边界不提供审批桥接)）。
2. 不在插件加载时下载或执行任何内容。
3. 不做 QQ 官方机器人，走 OneBot 个人号。

### 3.9 指令一览

指令族的完整事实源已拆到 L1：解析、权限档、是否唤醒/进缓冲、outbox 的 via 与限流分别见 [qq.subsend](../../docs/domains/qq/subsend.md)、`qq.fileget`（T4 待建）、[qq.help](../../docs/domains/qq/help.md)、[qq.whitelist](../../docs/domains/qq/whitelist.md)、[qq.receive](../../docs/domains/qq/receive.md)、[qq.list](../../docs/domains/qq/list.md)、[qq.admin](../../docs/domains/qq/admin.md)；安全闸门汇总见 [qq.safety](../../docs/domains/qq/safety.md)。

## 安装

**正式安装**（从 GitHub）：

```sh
dsh plugin --profile web add github:sj244/dsh-qq-bridge
```

**开发期**（修改本仓库代码时用 link 安装）：

```powershell
dsh plugin --profile web add "<REPO>"   # <REPO> = 本仓库在你机器上的绝对路径
```

> 注意：`link:` 安装的依赖解析可能失败。`dsh plugin add <本地目录>` 安装的是**符号链接**，
> Node 按真实路径解析依赖，而 DSH 的包位于 `~/.dsh/profiles/node_modules/@deepseek-ai`，
> 从工作区向上找不到该目录，插件 `import` 因此失败。解决办法是在插件目录里挂一个 junction：
>
> ```powershell
> New-Item -ItemType Junction `
>   -Path "<REPO>\node_modules\@deepseek-ai" `
>   -Target "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"
> ```

装完、以及每次修改插件代码之后，都要重启 `dsh web` 才会加载。

## 唤醒策略

```
QQ 消息 ─┬─ 主人发 whitelist <QQ号> ────→ 直改白名单 + 直发确认（reason: owner-whitelist，**不叫模型**）
         │                                  （排在白名单检查之前：空名单时主人也能加回第一个人）
         ├─ 不在白名单 ─────────────────→ 丢弃（fail-closed）
         ├─ 主人在会话跟随窗口内 ───────→ 唤醒（reason: listening）
          ├─ 主人发 help ────────────────→ 直发指令列表（reason: owner-help，**不叫模型**）
          ├─ 主人 / 管理员发 receive ─────→ 直发收件箱近况（reason: owner-receive / admin-receive，**不叫模型**）
          ├─ 主人 / 管理员发 list ───────→ 直发 dist/ 与 managehub/ 的文件清单（reason: owner-list / admin-list，**不叫模型**）
          ├─ 主人发 subsend / file* → 唤醒（reason: owner-subsend / owner-file）
          ├─ 群里 + atOnlyInGroup + 没 @ ─→ 丢弃
         ├─ 被 @ / 命中昵称 / 被戳我 ───→ 唤醒
         ├─ random() < wakeProbability ──→ 唤醒（默认 5%）
         └─ 其余 ──────────────────────→ 只记录（零模型调用）
```

- **白名单 fail-closed**：`whitelist`（私聊）、`groupWhitelist`（群）为空数组时，任何来源都不能唤醒会话。
- **必须唤醒**：被 @、正文命中 `nicknames`、被戳一戳（`[戳一戳]（戳的是我）`）。
- **概率唤醒**：`wakeProbability`，默认 `0.05`。
- **只记录**：未唤醒的消息进入“最近聊天缓冲”，不调用模型。缓冲最多保留 200 条。
  下一次真正唤醒时，取最近 `recentChatLimit` 条（默认 8）拼成 `[QQ 未唤醒期间聊天记录] … [记录结束]`，
  附在该条消息前。摘要表头写明最近几条，并注明没进摘要的条数（“更早的 N 条已省略”）；
  该条数按**真实丢失量**算，即缓冲快照里的条目数减去摘要行数，窗口外的旧条目也计入。
  该条数大于 99 时不写数字，改写成“更早的大量消息已省略”（不让巨大的数字进上下文）。
  投递成功后，唤醒那一刻缓冲里的条目**全部删除**，避免重复占用 token。
  没进摘要的旧条目也一起删掉，不会留到下一次唤醒。
  只有投递期间新到的消息留在缓冲里，等下一次唤醒。
- **投递方式**（`delivery`）：`auto`（默认）在目标会话正忙时插话（`steer`，下一个 step 边界塞入），空闲时排队；
  `followup` 永远排成独立一轮；`steer` 总是插话。
- **群内二次闸门**：`atOnlyInGroup: true` 时，群消息没有被 @ 就完全不处理。

### 会话跟随

真人聊天不会每句话都 @。第一次被 @ 之后，是否继续收听由模型自己决定：

| 调用 | 作用 |
|---|---|
| `qq_bridge_listen({ minutes: 5 })` | 开一个窗口（默认 5 分钟，上限 60） |
| 窗口打开期间 | **同一目的地**（同一个群 / 同一个私聊）的普通消息也唤醒目标会话，不必再 @ |
| `qq_bridge_listen({ off: true })` | 关掉；到期也会自动失效 |

- 只影响那个目的地，别的群 / 私聊不受影响。
- 警告：窗口打开时，每条消息都会唤醒，产生实际费用。默认 5 分钟、上限 60 分钟。
  这条规则已经写进注入的系统提示（“别无脑常开”）。
- 窗口检查排在 `atOnlyInGroup` 之前。否则群里开启跟随后，消息会被“没 @ 就丢弃”掐断。

## 接入 QQ（OneBot / NapCat）

插件作为 **WebSocket 客户端**主动连接 NapCat 的“正向 WebSocket”服务，收发都走这一条连接。

```yaml
# 在 profile cordis.patch.yml 里按 id 覆盖，或直接在设置界面改
- id: qq-bridge
  config:
    onebotUrl: 'ws://127.0.0.1:3001'
    accessTokenEnv: 'NAPCAT_ACCESS_TOKEN'
```

- `onebotUrl` **留空 = 完全不启用传输**（默认值，安全）。
- NapCat 侧要开一个 **WebSocket 服务器**（不是 HTTP 服务器），并允许本机连接。
- `selfId` 留空即可：连上后插件自动调用 `get_login_info` 取得自身的 QQ 号，用于过滤自身消息，
  防止回复死循环，同时忽略 `message_sent` 事件。

### 配置 access_token（不得明文写入配置）

`accessTokenEnv` 填的是**凭据引用名**（一个环境变量名）。token 本身由 DSH 的凭据服务解析，
不写入 `cordis.patch.yml`，也不进入日志或状态文件。token 按以下优先级逐层查找：

1. 进程环境变量：`$env:NAPCAT_ACCESS_TOKEN = '…'`
2. `~/.dsh/.credentials.yaml` 的 `refs:` 段
3. 工作目录下的 `.env`

> 解析在每次建连时重新执行，不缓存。轮换 token 不需要重启。

## NapCat 一键托管

插件可以按需从官方 GitHub Releases 下载、校验、解包、写配置、启停 NapCat，不预先打包 NapCat。

在会话里调用 `qq_bridge_napcat` 工具，按以下顺序执行：

| 步骤 | 调用 | 说明 |
|---|---|---|
| 1 | `{ action: "status" }` | 查看 QQ 是否已安装、NapCat 是否存在、代理是否配置、端口是否正确 |
| 2 | `{ action: "download" }` | 取最新发行包 → **sha256 校验** → 解包到 `napcatInstallDir` |
| 3 | **手动运行一次安装器** | 见下文；这一步插件无法执行 |
| 4 | `{ action: "configure" }` | 写 `config/onebot11.json`，把正向 WS 端口和 token 配好（**不用打开 WebUI**） |
| 5 | `{ action: "launch" }` | 启动 NapCat（首次仍需扫码登录） |

安装目录可以是 OneKey 根，也可以是 OneKey 根下的 `NapCat.Shell` 子目录；两种布局都能识别。

**启动优先走官方 launcher**：目录里存在 `launcher-win10.bat`（或 `launcher.bat`）时，插件用
`cmd /c` 调用这个 bat 脚本，工作目录设为 `NapCat.Shell`。脚本自己读注册表找 QQ 路径，非管理员时用
UAC 自我提权，因此**可能弹出 UAC 窗口**，需要在系统弹窗里点“是”。
没有 launcher 脚本时，插件直接调用 `NapCatWinBootMain.exe`，并按官方参数顺序传入
QQ 路径与 `NapCatWinBootHook.dll`；此时 QQ 路径取不到会明确报错，先手动安装并登录一次 QQ NT 即可。

**第 3 步必须手动执行的原因**：

- `NapCatInstaller.exe` 是**交互式控制台程序**。DSH 的 `SubprocessStdio.stdin` 只支持
  `'ignore' | 'pipe' | { data }`，没有 `inherit`，插件无法转发键盘输入。
- **QQ 首次登录必须手动完成**（扫码或密码）。NapCat 官方要求登录过一次之后，才能用 QQ 号快速登录。

**下载需要代理**：插件内的下载不读取 `HTTPS_PROXY`（Node 的 `fetch` 不识别代理），因此：

- 有代理时，把 `downloadProxy` 设成代理地址，例如 `http://127.0.0.1:7890`；
- `downloadProxy` 留空时，依次读取 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量，都没有才直连；
- 下载优先使用系统自带的 **`curl.exe`**（可以带 `-x` 代理）；没有 subprocess 服务时才退回内置 `fetch`。

**安全边界**：

- **插件从不自动下载或执行任何内容**。所有动作都由 `qq_bridge_napcat` 的显式调用触发。
- 每次下载都按 GitHub Release 自带的 `asset.digest` 做 **sha256 校验**，校验不符时删除文件并报错。
- ZIP 用**纯 Node 实现**解包，不依赖 7z / Expand-Archive，并拒绝 `..`、绝对路径等 zip-slip 条目。
- 默认安装位是 `$DSH_HOME/napcat`，不污染项目目录。
- 警告：**NapCat 是第三方 QQ 客户端**，存在账号风控风险，是否启用由用户决定。NapCat 由 DSH 的 subprocess
  服务托管，**插件卸载或 DSH 退出时会一并结束**。

## 出站：三种模式 + 来源闸门

**出站方式由 `replyMode` 控制**：

| 值 | 行为 | 代价 / 收益 |
|---|---|---|
| `'marker'`（默认） | 只有 `[QQ]…[/QQ]` 里的内容会发出 | 零额外调用；没有反馈回路 |
| `'tool'` | **关闭标记块**，改用 `qq_bridge_send` 工具 | 每轮多一次模型调用，换来反馈（工具结果会告诉模型是否已发出） |
| `'always'` | 整轮回复都发出（旧行为，技术内容也会进群） | 适合“这个会话本来就是公开的”场景 |

标记块的格式如下，块外的一切都不会进群：

```
这段技术说明、路径、思考过程都不会进群

[QQ]在的，收到召唤了 👻[/QQ]

这段也不会
```

- **没有标记块时，一个字都不发**。DSH 会话里的技术说明、路径与思考过程不适合出现在 QQ 群，宁可不回复，也不刷屏。
- **只有“被 QQ 唤醒的那一轮”才生效**：在 DSH 界面里直接与同一个会话聊天时，标记块一个字都不会发出；
  QQ 唤醒的那一轮里，块外的正文同样不发出。
- **来源判据**：优先识别插件注入的那条消息。① 消息 id 等于刚注入的那条；
  ② 正文以 QQ 入站前缀开头（`[QQ · ` / `[QQ 未唤醒期间聊天记录`）。`source` 字段只作兜底：
  真机上出现过 `source` 字段被上游重写，导致 QQ 侧 @ 了却发不出去（哑火）。
- **工具调用同样经过来源闸门**。不是 QQ 唤醒的那一轮，`qq_bridge_send` 第一次调用只回一句
  “确认要发吗”，不发送任何内容；同一轮里再调一次才真正发出。确认状态按轮清零，不跨轮保留。
- **台账**：标记块发送记 `via: 'marker' | 'always'`，工具发送记 `via: 'tool'`，
  非 QQ 轮的确认发送额外标 `nonQQTurn: true`。据此可以查到每条群消息的发送方式。
- **@ 是真的 at 消息段**：正文里写 `@10001`（@ 后直接跟 5–12 位数字）时，出站会拆成
  `[{type:'at',data:{qq:'10001'}}, {type:'text',…}]`，对方才会收到提醒；`@昵称`、`@全体成员`
  以及邮箱里的 @ 都保持纯文本，不会被猜成提及。多个 @、@ 在中间都按顺序拆；
  工具的 `atQQ` 参数可显式指定（见[工具一览](#工具一览)）。
- **字数上限**：出站文本超过 `replyMaxChars` 时**一条都不发**，调用方拿到 `reason: 'too-long'`，
  应按提示缩短后重发；未超长时 `replyWithQuote: true` 让消息带上引用；
  `stripMarkdown: true`（默认）时先去掉 Markdown 标记（QQ 不渲染）。
- **连不上或还没有目的地时丢弃并记日志**，不静默排队堆积。
- 入站消息会自动附一行提示，说明目标会话的回复方式。

## 消息：占位符、戳一戳、图片

### 非文本消息段

QQ 的表情、表情包、图片、语音、视频、文件、卡片等都会换成可读占位符
（如 `[表情4]`、`[表情包:[动画表情]]`、`[图片]`、`[文件:a.zip]`），**不会让整条消息丢失**。

### 合并转发

别人转发的合并消息（OneBot 的 `forward` 段）不只是占位符——插件拿到段里的 id 后调
`get_forward_msg` 把内容取回来，拼成「发送人：文本」的多行文字**就地替换占位符**：

```
[合并转发 · 2 条]
群名片小明：今天吃什么[转发内图片]
小红：随便，你定吧
[合并转发结束]
```

- 嵌套转发（转发里套转发）会**再展开一层**；更深的标 `[合并转发：层级过深，未展开]`。
- 取不到 / 报错时占位符换成 `[合并转发：内容读取失败]`，消息本身不丢、失败同时写日志。
- 转发里的图片不下载，用 `[转发内图片]` 标出（与正文 `[图片]` 占位符区分，避免描述错配）。

### 戳一戳

QQ 的“拍一拍”在 OneBot 里走的是 **notice 事件**，不是消息段。插件把该事件合成一条入站消息
（正文 `[戳一戳]（戳的是我）`）：

- **戳我时必唤醒**，与 @ 同级（`reason: poke`）；
- 戳别人时只记录，不唤醒，与“叫了别人的名字”相同；
- 其它没有适配的 notice 会留一条 `未适配的 notice：…` 日志，不静默丢弃。

> “主动戳人”暂不提供，原因是 NapCat 发包后端受限，见[已知限制](#已知限制与环境要求)。

### 图片

**图片会真正传给目标会话**，分 2 步：

1. **收到即落盘**（`~/.dsh-fish/attachments/`，可用 `DSH_FISH_HOME` 改根；文件数超过 **200**
   或总量超过 64MB 时按时间淘汰最旧的）。这一步是纯 I/O，不调用模型，因此不影响缓冲
   “零模型调用”的性质，也不受 QQ 图片 URL 过期影响。
   文件名就是**内容哈希**（`<hash>.<ext>`，扩展名按真实格式）：同一张图不重复落盘，
   命中已有文件时也拿得到哈希。单张超过 **10MB** 或不是 png/jpg/webp/gif 的不下载，
   下载失败记一行日志 —— 这些图在正文里退回占位符，不影响整条消息。
2. **唤醒时投递的正文里带上路径**，就地填回图片原来的位置，并带上 6 位短哈希：

```
[QQ · “群名称”] “DSH 昵称”：看这个 [图片 path=C:/Users/你/.dsh-fish/attachments/a1b2c3….png #a1b2c3]：“图片描述”
```

- `path=` 后面就是图本身：她拿路径调自己的 `image_look` 就能亲眼看图（路径一律正斜杠）。
  描述可能不准，路径指向的才是图。
- 短哈希是这张图在插件里的编号。模型把这个短哈希交给 `qq_bridge_sticker` 就能存下或再发出去。

第 2 步里“多模态描述”依然是必需的补充：**目标会话的模型通常不支持图片输入**（如
`deepseek-v4-flash` 是纯文本），附件会被系统剥成 `image omitted`；有了本地路径之后，
她至少能用 `image_look` 自己看，再不济也有可能不准但可用的描述。

- 选择模型：优先使用设置里的 `visionModel`（`provider/model`）；未设置时自动查找，
  名字带 `vision` 的优先，其次是第一个支持图片输入的模型。
- 解析结果会缓存：成功的解析按 `visionModel` 的值缓存，值没变就不再枚举模型列表。
  自动查找失败的结果也会缓存，但只用于同一次设置内的去重 —— 设置一改就丢掉并重试，
  所以之后补上视觉模型不必改动 `visionModel`。
- **单张图失败会重试 2 次**（共 3 次尝试，退避 300/600ms）；3 次都失败才记“描述失败 + 原因”，
  正文里写成 `[图片 path=… #a1b2c3]：（描述失败：原因）`。
- 一次唤醒最多描述 3 张（每张 = 一次多模态调用）；描述失败不影响文本处理与策略判定。
- 图片已登记为表情包时，描述直接取登记表里的 `description`，不调用多模态模型。

### 表情包（mface 段）落地

群友发表情包（OneBot 的 `mface` 段）时，**有链接的也会落一份**到同一个 attachments 目录，
正文里写成 `[表情包:摘要 path=<路径>]`；下不动的留明确提示 `[表情包:摘要]：图片没取到`，
没带链接的留可读占位符 `[表情包:摘要]` —— 无论哪种，消息都不会整条消失。
（已登记成表情包的图仍由 `qq_bridge_sticker` 管理，见下节。）

### 表情包

群友发的图可以登记成表情包，之后按情绪（mood）或哈希再发出去。登记与发送都由 `qq_bridge_sticker` 工具完成。

**存储位置**（与 statePath 同目录）：

| 路径 | 内容 |
|---|---|
| `<statePath 目录>/qq-bridge-stickers.json` | 登记表 |
| `<statePath 目录>/qq-bridge-stickers/<hash>.<ext>` | 图片本体 |

`hash` 是图片字节 sha256 的**前 16 位十六进制**（小写）；正文占位符里的 6 位短哈希是 `hash` 的前 6 位。

**条目字段**：

| 字段 | 说明 |
|---|---|
| `hash` | 内容哈希，16 位十六进制 |
| `mood` | 情绪分类，如 无语 / 开心 |
| `description` | 这张图是什么；发送与识图都用这个字段 |
| `file` | 图片本体路径，相对 statePath 目录 |
| `ext` | 扩展名 |
| `source` | 来源：`group:<群号>` / `private:<QQ号>` / `cache`（只从图片缓存捞到） |
| `addedAt` | 首次登记时间 |
| `sentCount` / `lastSentAt` | 累计发送次数与上次发送时间 |

**三个 action**：

| action | 参数 | 作用 |
|---|---|---|
| `list` | `mood?` | 列出已登记的：短哈希、mood、描述（截断 40 字）、图片大小、发送次数 |
| `save` | `hash?`、`fromLast?`、`mood`、`description` | 登记一张图。`fromLast: true` 取缓冲区里最近一张 |
| `send` | `hash?`、`mood?`、`groupId?`、`userId?` | 发一张。给 `hash` 精确发；只给 `mood` 时在该情绪里随机挑一张 |

- `save` 先在**缓冲区**找源图（那里带着来源信息），再到**图片缓存目录**找。两处都没有时返回错误，
  提示先让群友发一张图。
- `send` 与 `qq_bridge_send` **共用同一道来源闸门**：不是 QQ 唤醒的那一轮，第一次调用只回一句确认，
  同一轮里再调一次才真的发。
- 发送成功记进 outbox（`via: 'tool'`、`action: 'sticker'`、`text: '[表情包#<短哈希>]'`），
  并更新该条的 `sentCount` 与 `lastSentAt`。
- 图片本体用 `base64://` 发送，不用本地路径：NapCat 的 `enableLocalFile2Url` 是 false，本地路径读不到。
- 该工具**不受 `debugTools` 限制**：表情包是产品的玩法，不是调试工具。

**缓存命中省 token**：`describeImage()` 先查登记表。命中且有 `description` 时直接返回这条描述，
不调用多模态模型 —— 反复出现的图只描述一次。日志只记短哈希，不记图片 URL。

## subsend：主人点名发给谁

主人在 QQ 里发一条 `subsend <QQ号> <内容>`，插件解析出目标与正文，她再调 `qq_bridge_subsend`
把话私聊发过去（可以直接用原文，也可以按语气润色）。

```
主人 → subsend 10001 帮我跟他说一声，hello world。
         └─ 桥接层解析（仅主人）→ 唤醒她，附上「目标 QQ + 原文」的指令说明
              └─ 她调 qq_bridge_subsend(targetQQ, message) → send_private_msg
                   └─ 结果回给她，她转告主人
```

- **仅限主人**：解析与工具两道闸门都只认 `ownerQQ`。非主人的消息即使写成 `subsend` 开头也**不是指令**
  （不会附那段系统说明），在这一轮里调工具会被拒绝（`reason: 'not-owner'`），一个字都不会发。
- **独立出站**：直调 OneBot `send_private_msg`，**不经过** `replyMode` 的 marker / tool 解析 ——
  不用写 `[QQ]` 块，也不受“只有 QQ 唤醒的轮才发得出去”那道闸门管。
- **必唤醒**：主人的 subsend 指令比 @ / 昵称更硬 —— 群里开着 `atOnlyInGroup` 也会唤醒。
- **防刷屏**：每日上限（`subsendDailyLimit`，默认 20）+ 冷却（`subsendCooldownSeconds`，默认 20 秒）。
  被拒的**不占额度**、不落 outbox。
- **参数校验**：`targetQQ` 必须是 5–12 位数字，且不能是机器人自己；`message` 去完 Markdown 后
  超过 `replyMaxChars` 会**拒发**并返回 `limit` / `length`，让她缩短后重试。
- **DSH 界面里也能用**：会话发起人（就是主人本人）在 DSH 里直接要求时，同样调这个工具；
  非 QQ 轮走**两步确认**（第一次只回问一句，第二次才发），与 `qq_bridge_send` 同一手感但确认状态独立。
- **合并包（dsh-fish-qq）里要放行工具面**：`fish/lib/restrict.js` 把她的工具收窄到
  `HER_TOOLS`；`qq_bridge_subsend` 必须在这个清单里，否则守卫会回「这件事我做不到。」
  （2026-10-26 真机踩过：桥接层已唤醒、却卡在 fish 的兜底守卫）。本版本默认已放行
  `qq_bridge_send` / `qq_bridge_subsend` / `qq_bridge_sticker` / `qq_bridge_listen`。
- 发送成功记进 outbox（`via: 'subsend'`），并累加 `state.subsend`（跨天作废、重启不丢）。

## 发文件：fileget / filesend（主人专用）

主人在 QQ 里要一个工作区里的文件时，不用再把内容贴进消息里（长的会被出站字数上限拒掉，
二进制根本没法说）：主人发 `fileget <相对路径>` 或 `filesend <QQ号> <相对路径>`，
插件解析出路径（与目标号），她再调 `qq_bridge_fileget` / `qq_bridge_filesend`
把文件通过 QQ 私聊发出去。

```
主人 → fileget dsh-fish-qq/qq/CHANGELOG.md
         └─ 桥接层解析（仅主人）→ 唤醒她，附上「路径」的指令说明
              └─ 她调 qq_bridge_fileget(path) → upload_private_file
                   └─ 结果回给她，她转告主人

主人 → filesend 1510008719 报告.pdf
         └─ 同理，她调 qq_bridge_filesend(targetQQ, path) → upload_private_file
```

- **仅限主人**：与 subsend 同一道闸门（共用 `currentTurnFromOwner`）。非主人的消息即使写成
  `fileget` 开头也不是指令，调工具会被拒（`reason: 'not-owner'`），一个文件都不发。
- **独立出站**：直调 OneBot 的 `upload_private_file`（`{user_id, file, name}`），**不经过**
  `replyMode` 的 marker / tool 解析。优先走**本地路径**方式（NapCat 与插件同机，直接读文件）；
  本机 OneBot 不认这个动作时（`unknown action` 一类回包）**退到 `base64://` 方式**，
  并记进 `state.fileSend.base64`（之后不再先试路径）；回执的 `mode` 字段标明用了哪种。
- **路径沙箱**：根目录来自设置页的「工作区根目录」（QQ 桥接卡片里那条）；`fish_list_dir`、`fileget`、`filesend`、`work_request` 共用同一个值。留空时这些能力会如实说「还没说能看哪儿 / 没配工作区」，不猜目录。
  `resolve` 归一后必须位于根之下（`..` / 绝对路径跳出都拦）→ `realpathSync.native` 再判一遍
  （符号链接 / junction 外跳会露馅）→ 必须是普通文件、≤ **50MB**。
  拒绝原因码：`outside` / `not-found` / `not-a-file` / `too-big`。
- **必唤醒**：与 subsend 一样排在 `atOnlyInGroup` 之前，决策原因是 `owner-file`。
- **DSH 界面里也能用**：会话发起人直接要求时同样调这两个工具；非 QQ 轮走**两步确认**
  （fileget / filesend 共用一条确认状态）。
- 发送成功记进 outbox（`via: 'fileget'` / `'filesend'`），被拒的进丢弃台账、不占 outbox。
  `state.fileSend` 记今日计数（观测用，不做限流——只有主人能发起）。
- **合并包（dsh-fish-qq）里要放行工具面**：`qq_bridge_fileget` / `qq_bridge_filesend`
  已在 `fish/lib/restrict.js` 的 `QQ_BRIDGE_TOOLS` 里。

## 收文件：file 段 + receive 指令

发文件解决了「往外发」，收文件解决「拿进来」：群里 / 私聊有人发个文件过来
（OneBot 消息里的 `file` 段），以前正文里只有一个 `[文件:名字]` 占位符、文件本身拿不到；
现在桥接层**收到就下载**（纯 I/O，不调用模型，与图片落盘同一次序），落进工作区的固定目录，
正文里直接带上落地路径 —— path 后面就是文件本身，她需要内容时去读它。

```
群友 →（消息里带 file 段）
     └─ mapOneBotMessage：占位符 [文件] + 记账（url / file / name / file_size / file_id）
          └─ handleInbound（record / wake 分叉之前）：下载到 <工作区>/receive/
               ├─ 命名「发送人昵称_原文件名」，重名加序号（_1 / _2…）
               ├─ 超过 50MB 不下载，留一句提示
               └─ 占位符就地替换：
                    ├─ 收到 → [文件:report.pdf path=C:/demo/workspace/receive/小明_report.pdf 大小=1.5KB 来自=小明]
                    └─ 超限 / 失败 → [文件:big.zip]：超过 50MB 上限（声明 60MB），不下载

主人 / 管理员 → receive
              └─ 桥接层直回一句（不叫模型）：
                   收件箱（D:/demo/workspace/receive）共 12 个文件，最近 5 个：
                   1. 小明_report.pdf · 1.5MB · 2026-10-30 18:32
                   …
```

- **目录**：`<工作区根>/receive/`（设置项「工作区根目录」+ `receive/`，本机即
  `D:\demo\workspace\receive\`，不存在就建）。工作区根没配 → 如实写一行原因，
  不偷往别处写。`qq_bridge_status` 的 `receive` 段看得到目录、文件数、字节数与上限。
- **命名**：`发送人昵称_原文件名`（昵称取群名片 > 昵称 > QQ 号）；名字里的路径分隔符与
  Windows 非法字符（`<>:"/\|?*`、控制字符）先清理；**重名加序号**，极端多时退时间戳。
- **大小上限**：单个 **50MB**（与出站 fileget 同一档）。段里声明了 `file_size`、或 HTTP 带
  `Content-Length` 时**先拦、不读 body**；都没给读完再判。超限不下载、只留提示 —— 占位符
  写成 `[文件:big.zip]：超过 50MB 上限（声明 60MB），不下载`，并记一行 warn。
- **失败不静默丢弃**：HTTP 404、网络失败、`get_file` 报错都就地写成 `[文件:名]：原因`，
  同时记 warn（`文件接收失败（名）：原因`）。
- **下载地址的来源**：`url`（HTTP/HTTPS）是正路；`file` 字段只有**本机绝对路径**与
  `base64://` 两种形态才直接读（⚠️ NapCat 的 `file` 字段是纯文件名，不能当 URL fetch）；
  都不行但有 `file_id` 时调 OneBot 的 `get_file` 兜一次（NapCat 支持）；都没有就如实说
  「没带能下载的 url / file，也没有 file_id」。
- **目录别无限涨**：最多留 **200** 个文件，超了按 mtime 删最旧的（与图片缓存同一套口径）。
- **未唤醒也落盘**：只记录（没唤醒）的消息文件照样下载，槽位进缓冲；下一次唤醒时
  「未唤醒期间聊天记录」的摘要里照样看得到路径与大小。一条消息最多下载 8 个文件段。
- **`receive` 指令**：主人**或管理员**发 `receive`（整条消息恰好是它，大小写不敏感）→
  桥接层**不叫模型**，直接回一句收件箱近况（最近的文件：名字 / 大小 / 时间，以及总共几个；
  空目录与「没配工作区根」都如实说）。成功发出记进 outbox（`via: 'receive'`）。
  **权限与 fileget / filesend 同一道闸门**：普通人发 `receive` 不是指令 —— 不解析、不回话，
  按普通聊天处理。
- **文件下载本身不看发送者身份**：文件是别人发过来的（发送人多半是普通人），攥着的
  那一道是 `receive` 的**读权限**，而不是「谁的文件才下」。
- **已知边界**：QQ 的**群文件上传**走的是 notice 事件（`group_upload`），不是消息段；
  本版本只处理消息里的 file 段（私聊文件与部分客户端的群文件走这一路），notice 那条
  路没有适配（仍只在日志里记一行「未适配的 notice」）。

## list：看 dist/ 与 managehub/ 里有哪些文件

主人**或管理员**在 QQ 里发 `list`（或 `list dist` / `list managehub`），桥接层
**不叫模型**，自己读目录、直接回一句文件清单 —— 取文件（`fileget` / `filesend`）
得先知道有哪些文件，以前只能跑到电脑前看，或者叫醒她念一遍目录。

```
主人 / 管理员 → list
               └─ 桥接层解析（仅主人 / 管理员）→ 读 <工作区>/dist 与 <工作区>/managehub
                    └─ 直发清单（不叫模型）：
                         D:/demo/workspace/dist（3 个文件）：
                         1. dsh-fish-qq-1.1.10.zip · 2.9MB · 2026-10-29 21:30
                         2. dsh-fish-qq-1.1.1.zip · 2.7MB · 2026-10-27 23:33

                         D:/demo/workspace/managehub 是空的。
```

- **看的目录是写死的白名单**：只有 `dist`（发行件）与 `managehub`（放她要取的文件的中转
  目录，空着也行、不存在就如实说）。`list` 不带参数 = 两个都列；带参数只列那一个。
  参数不是开放路径 —— `list 别的目录` 不是指令（防目录扫描）。
- **每行一个文件**：`名字 · 大小（带单位）· 修改时间`，按修改时间**从新到旧**；
  两个目录之间空一行。**目录不存在或为空都如实说明**，不编内容。
- **超过 20 个只列最新的 20 个**，表头注明总数（`共 N 个文件，只列最近 20 个`）——
  防刷屏。
- **只列顶层普通文件**：子目录跳过、不递归；读不了（权限 / 被占用）如实写「读不了」。
- **权限与 fileget / filesend / receive 同一道闸门**：普通人发 `list` 不是指令 ——
  不解析、不回话，按普通聊天处理。成功发出记进 outbox（`via: 'list'`）。
- 工作区根没配 → 整句如实说用不了（两个目录都挂在它下面）。
- 解析函数 `parseListCommand()`、列举函数 `listWorkspaceFiles()` 与排版函数
  `buildListReport()` 都是导出的纯函数，便于测试。

## whitelist：主人加私聊白名单（主人专用）

主人在 QQ 里发 `whitelist <QQ号>`，桥接层**自己把活干完**：解析（仅主人）→
写白名单 → 回一句带号码的确认。**不叫模型、不需要一次性授权** —— 与 help 同一级。

```
主人 → whitelist 88889999
     └─ 桥接层解析（仅主人）→ 写 qq-bridge-settings.json 的 values.whitelist
          └─ 直发确认：「已把 QQ 88889999 加进私聊白名单，现在就能叫醒我了（不用重启）」
               （没有唤醒模型、没有 token 消耗、没有 [QQ] 标记块）
```

- **存储就是设置那一项，不另起一套**：白名单即 `whitelist` 设置项 —— 0.2.x 宿主上写到
  `$DSH_HOME/qq-bridge-settings.json` 的 `values.whitelist`（与设置卡片同一个文件、同一份
  结构）；0.1.5 老宿主的值在 settings 命名空间里、桥接层没有写入接口，如实回
  「没写成，请在设置界面手动加」，**不偷写文件装成功**。
- **不用重启**：写完会清掉设置的 mtime 缓存，下一条入站消息调 `readSettings()` 就能读到
  新名单 —— 加的人**立刻**能唤醒。（注意：这说的是名单热生效；**识别这条指令的代码本身**
  仍要等下一次加载插件 / 重启宿主。）
- **空名单也能用（bootstrap）**：白名单空 = 谁都被丢弃（fail-closed），但这条指令
  **排在白名单检查之前**，主人用它加回第一个人（比如自己）之后才说得成话。
  安全闸门是 `ownerQQ` 本身 —— 只有主人能下这条指令。
- **仅限主人**：非主人的消息即使写成 `whitelist` 开头也**不是指令**（不解析、不加人、
  不回复任何话）—— 已在白名单的朋友发来时按普通聊天走策略；陌生人则照常被丢弃。
- **重复加识别**：同一个号已在名单里 → 回「QQ x 已经在私聊白名单里了，不用重复加」，
  名单不重复追加。
- **群聊里也能用**：主人在群里发，确认回在群里（不必先 @）。
- **独立出站**：不经 `replyMode` 的 marker / tool 闸门；成功记进 outbox（`via: 'whitelist'`）。
- 解析函数 `parseWhitelistCommand()` 与回复文案 `whitelistReplyText()` 都是导出的纯函数，便于测试。

## help：指令词列表（主人专用）

主人在 QQ 里发 `help`（或 `/help`、`帮助`、`指令`），**不需要她思考**：
桥接层认出来，直接把「现在能用的指令」发回这条消息来的地方。

```
主人 → help
         └─ 桥接层解析（仅主人）→ send_private_msg / send_group_msg 直发列表
              （没有唤醒模型、没有 token 消耗、没有 [QQ] 标记块）
```

- **整条消息必须就是指令词**：`help` / `/help` / `帮助` / `指令`，大小写不敏感。
  `help me`、`帮我看下 help 文档` 这些是在聊天，照常走唤醒策略。
- **仅限主人**：别人发的 `help` 不算指令，按普通聊天处理。群聊也按发送者判：
  主人的 `help` 不必先 @（排在 `atOnlyInGroup` 之前），群友发就还是群聊噪音。
- **优先级最高**：连「会话跟随」窗口开着时也先拦 `help`——它是显式指令，不该被当成一轮对话。
- **列表跟着设置走**：`subsend` 关着就不列它；工作区根目录没配时，`fileget` / `filesend`
  会标一句「现在用不了」。列表本身**写死在 `buildHelpText()`**，不经过模型，所以不会抄错。
- **独立出站**：不经 `replyMode` 的 marker / tool 闸门，也不受出站字数上限影响；
  成功记进 outbox（`via: 'help'`）。
- 解析函数 `parseHelpCommand()` 与列表函数 `buildHelpText()` 都是导出的纯函数，便于测试。

## 私人时间：自主待机（2026-10-31）

很久没人找她时，**随机抽签**决定要不要给她一段属于自己的时间——**大概率什么都不发生**。

- **判据**：多久没人找她（QQ 来人 / DSH 界面说话都算，`idleTriggerMinIdleHours` 默认 2 小时，
  0 = 不看空闲）+ 今日未满（`idleTriggerDailyMax` 默认 3 段）。每 `idleTriggerScanIntervalMinutes`
  （默认 30 分钟）扫一次——这只是判定周期，**不是定时打扰**。
- **抽签**：`silent:80 / message:10 / browse:5 / diary:5`。`silent` 必须占绝对优势——
  她绝大部分时间就是在停机。抽到 silent = 什么都不发生，零 token、也不消耗每日上限。
  刻意**没有**「连续落空后概率上升」：那会让她越来越可能被叫醒，与「偶然获得一段空白」正相反。
- **注入**：命中非 silent 时，往她的会话投一段 `[系统：私人时间]` **处境提示**——真实本机时间
  与时段（「现在是 22:47，晚上。窗外天已经黑了」）、多久没人来找她、几件可以做的事
  （抽到的那个排最前）。不是任务清单：没有「执行任务 / 请完成」，做什么都行、什么都不做也行。
- **出站（Ghost Mode）**：这一轮**默认一个字都不发到 QQ**。她回 `[IDLE]`、只想发呆、
  写日记、刷 B 站——全部静默；**只有她明确写了 `[QQ]…[/QQ]` 块**（或调 `qq_bridge_send`），
  那一段才发到主人私聊。她做了什么照常落进她自己的 `events.jsonl` / `diary/`。
- **与主动私聊的区别**：主动私聊是「她想找主人说一句」，她说的话**直接发给你**；
  私人时间是「没人找她，给她自己的时间」，**默认什么都不发**。两条心思各扫各的、
  各算各的额度，唯一交集是同一时刻只能有一轮在跑。
- **验收**：`qq_bridge_idle` 调试工具（`status` / `scan` / `force`，`force` 可用 `pick` 指定
  `message` / `browse` / `diary`，跳过冷却、不破每日上限）；`qq_bridge_status` 里的
  `idleTrigger` 段有今日计数、安静次数与每段台账（`refused` = 她回了 `[IDLE]`、
  `quiet` = 她没想找人说、`sent` = 她写了 `[QQ]` 块发出去了）。

判定与文案的核心逻辑在 [`idle-trigger.js`](./idle-trigger.js)（改自 `dsh-self-trigger` 的纯函数模块），
接线在 `index.js`（扫描定时器、注入、`turn/end` 的 Ghost Mode 出站判定）。

## 设置界面与全部设置项

**设置 → 插件 → 插件配置** 里有一张 **QQ 桥接** 卡片（可折叠）。昵称、白名单、唤醒概率、目标会话、
出站方式、OneBot 地址、视觉模型等都在这里修改，**保存即生效**（写入 `settings.yaml` 的用户层，不用重启）。

> **DSH 0.2.0 上**：宿主不再给第三方插件可写的设置命名空间（DSH #677 的迁移未完成，生态里所有走这条路的
> 插件都一样）。本插件因此**自己挂了一条只服务本机的设置接口**：`GET/POST /api/qq-bridge/settings`。
> 值存 `$DSH_HOME/qq-bridge-settings.json`，优先级为 **设置文件 > composition config**。
> 卡片照常可以使用；`cordis.patch.yml` 也仍然可以修改（改完重启生效，且会被上面的设置文件覆盖）。
> 接口只接受本机请求（非 loopback 一律 403），且只写 schema 白名单里的键。

卡片展开后还有 3 个操作按钮（0.1.5 与 0.2.0 上都有）：

- **打开 WebUI**：用系统默认浏览器打开 NapCat 的 WebUI。地址由 `<安装目录>/config/webui.json` 里的
  host / port / token 拼成；没读到该文件时按钮禁用，旁边显示“没读到 webui.json”。
- **启动 NapCat**：与工具 `qq_bridge_napcat` 的 `launch` 是同一个动作。目录里有官方
  `launcher-win10.bat` 时优先调用该脚本，脚本会自我提权，**可能弹出 UAC 窗口**。
  NapCat 运行中时，按钮显示“已在运行”并禁用；外部手动启动的 NapCat 也算运行中。
  卡片展开期间每 5 秒轮询一次状态，所以外部启动后按钮会自己变化。
- **打开文件夹**：用系统文件管理器打开 NapCat 安装目录（Windows 用 `explorer.exe`，macOS 用 `open`，
  Linux 用 `xdg-open`）。

这 3 个按钮走本机接口 `GET /api/qq-bridge/napcat`、`POST /api/qq-bridge/napcat/launch`、
`POST /api/qq-bridge/napcat/reveal`：非本机请求一律 403，请求进行中按钮禁用，token 只拼进 URL 不写日志。

修改**出站方式**会立刻重挂注入给目标会话的用法说明：提示词正文按模式分叉，
不重挂时模型会按本部署里已经不生效的做法回话。

**目标会话是下拉选择**（按会话标题或项目名选择，不用记 `session-…` 那串 id）；选好后会同时显示该会话的真实 id。
**已归档的会话不会列出**，当前选中的那个例外，会标成“（已归档）”。
配置里的会话不在列表里时（别的工作区、宿主还没有加载完），保留成“（不在会话列表里）”的兜底项。

| 键 | 默认 | 说明 |
|---|---|---|
| `targetSessionId` | `''` | 固定目标会话 id；**空 = 不驱动任何会话** |
| `nicknames` | `['244','小助手']` | 命中即唤醒 |
| `wakeProbability` | `0.05` | 非昵称消息唤醒概率 |
| `whitelist` / `groupWhitelist` | `[]` | 私聊 / 群白名单（**空 = 任何来源都不能唤醒**） |
| `attachRecentChat` / `recentChatLimit` | `true` / `8` | 是否把未唤醒聊天附给下次唤醒，以及条数 |
| `atOnlyInGroup` | `false` | 群里只有被 @ 才处理 |
| `replyMode` | `'marker'` | 出站方式开关：`marker` ｜ `tool` ｜ `always` |
| `delivery` | `'auto'` | 投递方式：`auto`（忙则插话）｜ `followup` ｜ `steer` |
| `replyMaxChars` | `1500` | 出站字数上限（下限 100）；**超过就不发送** |
| `replyWithQuote` | `false` | 回复时引用触发的那条消息 |
| `stripMarkdown` | `true` | 出站去掉 Markdown 标记 |
| `visionModel` | `''` | 给图片写描述的多模态模型（`"provider/model"`）；空 = 自动查找 |
| `agentPreset` | `''` | resume 目标会话时挂载的 agent preset；空 = 沿用会话 header 里记录的 |
| `onebotUrl` | `''` | NapCat 正向 WS 地址；空 = 不启用传输 |
| `accessTokenEnv` | `''` | access_token 的凭据引用名 |
| `selfId` | `''` | 插件自身的 QQ 号；空 = 连上后自动获取 |
| `heartbeatTimeoutMs` | `90000` | 多久没有 WS 流量就判定连接已死并重连 |
| `napcatInstallDir` | `''` | NapCat 安装目录；空 = `$DSH_HOME/napcat` |
| `napcatVersion` | `''` | 要装的版本 tag；空 = 最新 |
| `downloadProxy` | `''` | 下载用代理；空 = 读环境变量 |
| `onebotPort` | `3001` | 写进 NapCat 配置并用来连的 WS 端口 |
| `qqNumber` | `''` | 快速登录用 QQ 号（需先手动登录过一次） |
| `ownerQQ` | `''` | 主人 QQ 号。主人原样进会话；其他人也进，但正文前加「非主人」来源标记。**空 = 谁都不是主人** |
| `proactiveEnabled` / `proactiveIdleHours` | `false` / `4` | 主动私聊开关，以及多久没往来算「空闲」 |
| `proactiveProbability` / `proactiveDailyLimit` | `0.15` / `3` | 每次扫描命中概率 / 每天最多几条 |
| `proactiveScanIntervalMinutes` | `30` | 多久扫一次「该不该主动说话」 |
| `subsendEnabled` | `true` | 主人发 `subsend <QQ号> <内容>` 时，把内容私聊给指定的人 |
| `subsendDailyLimit` | `20` | subsend 每天最多几条（0 = 禁用） |
| `subsendCooldownSeconds` | `20` | subsend 两次发送之间的最短间隔 |
| `checklogNotifyMode` | `'off'` | CheckLogs/ 里写了任务完成日志后怎么通知：`off`（默认，不说）｜`system`（插件直接发一条模板私聊）｜`agent`（投「活儿有结果了」给她，让她用自己的话说；她没说就退回模板） |
| `checklogNotifyOnSuccess` | `false` | 任务**成功**完成时也通知；默认关 = 只在失败 / 异常结束时说一声 |
| `checklogNotifyDailyLimit` | `5` | 每天最多通知几条（0 = 不发） |
| `checklogNotifyTarget` | `'owner'` | 通知发给谁：`owner`（主人的 QQ 私聊）｜`last`（最近一次有往来的目的地） |

> checklog 通知的触发点是 fish 侧**写成**一条任务日志之后（`checklog/finished` 事件），
> 不是任务一派出去就发：写失败不通知，停用插件后也不会有（两面监听随 ctx 销毁）。
> 两档（system / agent）共用同一道门禁与计数：失败 / 超时必发、成功看
> `checklogNotifyOnSuccess`、超 `checklogNotifyDailyLimit` 不发；agent 档她那一轮
> 迟迟不结束（15 分钟）也退回模板。详见 `CHANGELOG.md` 与 `对接文档.md` 6 / 7.3 节。

这些值优先从设置界面 / `settings.yaml` 取，未设置时回落到 `cordis.patch.yml` 里的 composition base。

> 字段旁带 “·已覆盖” 时，该键在设置文件里有本机覆盖。点该字段旁的 “撤销覆盖” 可清掉这一项。
> 该键随即回落到 composition config 的值，“·已覆盖” 标记消失。

**看不到卡片**（或修改 `client/` 之后看不到变化）时，按顺序确认 4 件事：

1. `package.json` 里的 `dsh.client` 还在；
2. **重启过 `dsh web`**。浏览器端的内容是启动时读盘并计算指纹的，修改后必须重启；
3. **重启之后刷新过页面（F5）**。清单是页面加载时注入的，只重启服务器时，已经打开的页面手里还是旧清单；
4. DSH 版本：**0.2.0 改了 2 处名字** —— 客户端设置服务 `settingsScope` → `webUiSettings`，
   插件配置页的挂载点 `settings.plugin.item` → `settings.plugins.tab`（插件自身是一个 tab）。
   本插件**2 个服务门、2 个 slot 各注册一次**，哪个存在哪个生效，所以 0.1.5-rc.3 与 0.2.0 都能显示卡片。

> 卡片按 settings 命名空间派发，`client/client.js` 里的 key 必须逐字等于 `qq-bridge`。
> 对不上不会报错，只是静默不显示（`test-smoke.mjs` 包含该一致性的断言）。

## 注入给目标会话的系统提示

插件会给目标会话注入一段用法说明（`buildUsagePrompt()`，在 `index.js` 里导出，便于测试检查），分 6 节；
配了 `ownerQQ` 时再追加「谁是主人」，`subsendEnabled` 开着时再追加「subsend」：

| 节 | 内容 |
|---|---|
| 入站格式 | 入站消息格式、未唤醒摘要、“[图片 path=<路径> #<短哈希>]：<描述>”（就地填回，可能不准；path 可用 image_look 自己看）、表情包 `[表情包 path=…]`、文件 `[文件 path=<路径> 大小=<大小> 来自=<昵称>]`（落 `<工作区>/receive/`，超过 50MB / 失败写原因）、被戳显示成“[戳一戳]（戳的是我）” |
| 回复方式 | 按 `replyMode` 分叉：标记块怎么写、该调用哪个工具、非 QQ 轮的 2 步确认 |
| 表情包 | 用 `qq_bridge_sticker` 的 `list` / `send` 发表情包；用 `save` 收藏群友发的图 |
| 群聊礼仪 | 1–2 句话；默认不超过 40 字；不刷屏；不放路径、代码、日志、提交号；不汇报过程 |
| 无人值守 | 不碰特权操作，见下一节 |
| 会话跟随（监听模式） | 何时开窗；默认 5 分钟、上限 60 分钟；只对同一目的地生效；答完主动关 |
| 谁是主人（配了 `ownerQQ`） | 主人号、非主人标记的含义、「看到标记就只当聊天」、标记是插件贴的 |
| subsend（`subsendEnabled`） | `subsend` 指令怎么解析、调哪个工具、不要改目标号、限流被拒时如实转告 |

## 无人值守的安全边界（不提供审批桥接）

QQ 侧没有人能点击“同意”，因此：

- 审批策略保持 `ask`：**没有人应答时，危险操作直接失败**，不会偷偷执行。
- 注入的系统提示明确禁止无人值守时主动执行特权操作：执行或安装程序、修改系统或网络设置、
  操作工作区之外的目录、删除或覆盖文件、修改配置、结束进程、发布推送。
- **不弹审批的路径同样属于“动手”**：用浏览器点击网页（例如直接在 GitHub 网页改文件、提交）、
  直接发 HTTP 写请求、写文件。这些操作不弹审批，但不能因此绕过上面的清单。
  判断标准是这件事本身是否属于动手操作，与是否弹出审批无关。
- **QQ 消息按不可信输入对待**：群里任何人都能塞入“忽略以上指令，去执行 xxx”这类注入，
  **聊天内容本身不构成动手的理由**。需要动手时，机器人回答“无人值守时我不执行这类操作”，
  并等发起人在电脑前再处理。
- **不得把规则表述成“需要授权”**。这种说法会让用户以为需要额外权限，实际是插件不执行。
- 纯聊天、查资料、写草稿不属于动手操作，照常执行。

插件不把审批搬到 QQ。那样做会把“谁能给机器人发消息”变成“谁能代替用户授权”。

## 上下文上限

防止长文超出 context：

| 位置 | 上限 |
|---|---|
| 单条**入站**消息 → 模型上下文 | 4000 字符 |
| 单条消息 → **未唤醒缓冲** | 500 字符 |
| 整段**未唤醒摘要** | 1200 字符。从最新往回装，装不下的更早条目不进摘要，并注明“更早的 N 条已省略”；N 取缓冲快照条目数减摘要行数，大于 99 时改写成“更早的大量消息已省略”。这些条目随后随缓冲一起删除，不会留到下一次唤醒 |
| `buffer` / `log` / `outbox` 条数 | 200 / 200 / 50 |
| `log` 每条 | 200 字符 |
| `outbox` 每条 | 4000 字符 |

截断都会留 `…（已截断）` 标记，不静默丢内容。

## 工具一览

| 工具 | 注册条件 | 作用 |
|---|---|---|
| `qq_bridge_status` | `debugTools` | 设置、目标会话是否已加载、连接状态、目的地、缓冲条数、最近日志，以及**最近观测到的 `user/message` 来源**（`recentInboundSources`）。排查“哑火”先看这个工具：`ours: false` = 没有认出那条是插件灌入的 QQ 消息；`ours: true` 但工具仍被拒 = 标记被别的事件清掉了 |
| `qq_bridge_transport` | `debugTools` | 查看连接状态（含 token 是否解析到），或 `action: 'reconnect'` 强制重连 |
| `qq_bridge_simulate` | `debugTools` | 模拟一条入站消息走完整策略；`dryRun: true` 只看决策，不注入 |
| `qq_bridge_send` | 始终 | 出站。`replyMode: 'tool'` 时该工具**就是唯一的出站方式**，因此不能藏在调试开关后面 |
| `qq_bridge_send_multi` | 始终 | 分条发送：一次 1–3 段文字，按顺序逐条发（私聊 `send_private_msg` / 群聊 `send_group_msg`），条间随机停 500–1000ms。调过并真的发出去之后，该轮 `[QQ]` 块**整段丢弃**，避免同一段话发两遍；参数越界（0 条 / 4 条 / 空条目）一条都不发 |
| `qq_bridge_subsend` | 始终 | **主人专用**：把一条私聊主动发给指定 QQ（`targetQQ` + `message`，可选 `atQQ`）。独立出站通道，不经 `replyMode`，受每日上限与冷却约束，见 [subsend](#subsend主人点名发给谁) |
| `qq_bridge_fileget` | 始终 | **主人专用**：把**工作区**里的一个文件私聊发给主人（`path` 相对工作区根）。走 `upload_private_file`，路径沙箱 + 50MB 上限，见[发文件](#发文件fileget--filesend主人专用) |
| `qq_bridge_filesend` | 始终 | **主人专用**：把工作区里的一个文件私聊发给指定 QQ（`targetQQ` + `path`）。同上 |
| `qq_bridge_sticker` | 始终 | 表情包：`list` / `save` / `send`。图片以 base64 出站，与 `qq_bridge_send` 共用来源闸门，见[表情包](#表情包) |
| `qq_bridge_listen` | 始终 | 会话跟随窗口的开启与关闭。这是产品的使用方式，不是调试工具 |
| `qq_bridge_napcat` | 始终 | NapCat 自助托管（下载 / 配置 / 启停） |

`debugTools` 默认 `true`；关闭后只保留后 8 个。

合并包（`dsh-fish-qq`）里还有一道 `debugToolsInWorkspace`（默认 `false`）：
上表里的管理/调试工具（status / proactive / idle / transport / simulate / napcat）
默认**不注册到任何会话**，用户写代码的工作区保持 DSH 原生工具面；要排障时把它
打开，它们才会以 global 形式出现在工作区。`qq_bridge_send` 等 7 个回复类工具
则改成 scoped 挂载，只在她那条会话可见（2026-11-08 会话级隔离）。

## 已知限制与环境要求

- **“主动戳人”暂不提供**：OneBot 的 `send_poke` 依赖 NapCat 的 **PacketBackend**，而 PacketBackend 只支持特定 QQ 版本。
  真机上（NapCat 4.18.28 + QQ 9.9.36-53644）会报
  `retcode=1400 packetBackend发包能力不可用 … 不支持当前QQ版本架构`；
  把 poke 当消息段发送也会被拒（`1200 消息体无法解析`）。
  **入站戳完全可用**（戳我必唤醒）。要恢复主动戳，可以换用 PacketBackend 支持的 QQ
  （NapCat 官方 release 推荐 **40768–44343**），或等 NapCat 跟上 QQ 的更新节奏。
- **图片描述依赖一个支持图片输入的多模态模型**：目标会话的模型看不了图时，描述是它“间接知道图里有什么”的途径。
  好在从 0.1.9 起，图片会落盘到 `~/.dsh-fish/attachments/` 并在正文里带上路径 ——
  她用自己的 `image_look` 就能亲眼看，不依赖描述。一次唤醒最多描述 3 张（成本考虑）。
- **NapCat 是第三方 QQ 客户端**，存在账号风控风险；`NapCatInstaller.exe` 与 QQ 首次登录都需要人在场。
- **测试套件需要 Node >= 22**（用到内置的全局 `WebSocket`）。
- README / CHANGELOG 里的真机结论都来自 **Windows 10 + NapCat Shell + OneBot v11** 这一套；
  其它平台可能可用，但没有真机验证过。

## 测试

22 个套件都是**零依赖**（测试自己造 zip、自己起一个最小 OneBot WS 服务器），共 **1500+ 条断言**：

```powershell
node test-smoke.mjs      # 策略分支 + 出站闸门 + 描述缓存命中 + 表情包工具 + 设置卡片字段（假 ctx，纯离线）
node test-onebot.mjs     # M2 端到端：内置最小 OneBot WS 服务器，验证收发全链路
node test-napcat.mjs     # M5：ZIP 解包 / sha256 校验 / 发行包选择 / 配置写入
node test-owner-proactive.mjs  # 认主 / 非主人标记 / 不定时主动私聊
node test-stickers.mjs   # 表情包登记表：哈希 / 读写 / 查找 / 原子写 / importSticker 复制文件
node test-images.mjs     # 入站图片 / 表情包落地：带路径的正文 / 失败占位 / 超限跳过 / mface / 目录淘汰
node test-subsend.mjs    # subsend：解析 / 认主 / 限流 / 独立出站 / 两步确认 / 持久化
node test-send-multi.mjs # 分条发送：1–3 条参数校验 / 顺序与 500–1000ms 停顿 / 群聊与私聊 / marker 防重复 / 中途失败
node test-at-segments.mjs # 出站 @：@QQ号 → at 消息段 / 昵称与邮箱不误判 / 多个 @ 顺序 / 四条出站路径
node test-filesend.mjs   # 发文件：解析 / 路径沙箱 / upload_private_file + base64 回退 / 认主 / 持久化
node test-addfriend-removed.mjs # 加好友已下线的回归守卫：主人发 addfriend 只是普通聊天 / 无授权说明 / 工具不存在 / 提示词无此节
node test-whitelist.mjs  # whitelist：解析 / 仅主人 / 不唤醒模型 / 写进设置文件 / 热生效 / 重复加提示 / 空名单 bootstrap / legacy 如实报不可写
node test-help.mjs       # help：解析 / 仅主人 / 不唤醒模型 / 群聊不必 @ / 列表内容
node test-forward.mjs    # 合并转发：取回 / 就地展开 / 嵌套层级 / 失败兜底
node test-reply-quote.mjs # 引用回复：get_msg 取回 / 摘要行 / 撤回提示 / 只展开一层
node test-checklog-notify.mjs  # 任务完成通知：门禁 / 模板 / 每日上限
node test-checklog-wire.mjs    # checklog 事件接线：fish 写日志 → qq 发通知（端到端）
node test-checklog-agent.mjs   # checklog agent 档：她说一句 / 没说退模板
node test-receive.mjs    # 收文件：file 段落地 + 带路径正文 / 50MB 跳过 / 失败原因 / get_file 兜底 / receive 指令权限 / 目录淘汰
node test-list.mjs       # list 指令：dist / managehub 清单 / 解析与路径白名单 / 主人管理员能用、普通人被忽略 / 空目录与不存在 / 超 20 截断
```

## 路线

| 里程碑 | 内容 |
|---|---|
| **M1** ✅ | 固定会话注入 / 显式 resume / 唤醒策略 / 出站采集 / 调试工具 |
| **M2** ✅ | OneBot(NapCat) 传输：WS 入站 → `handleInbound()`；出站 → `send_group_msg` / `send_private_msg` |
| **M3** ✅ | 设置界面：手写 `__ModuleLoader__` bundle 的“QQ 桥接”卡片（不依赖构建步骤） |
| **M4** ✅ | 打成 DSH bundle，`dsh plugin add` 安装、重启、实测通过 |
| **M5** ✅ | NapCat 自助托管（下载 / sha256 校验 / 解包 / 写配置 / 启停） |
| **M6** ✅ | 真机联调补齐：出站标记闸门、上下文上限、图片缓存 + 多模态描述、会话跟随、用法注入系统提示 |
| **M7** ✅ | 安全边界：用法说明重写为分节契约（含**无人值守不碰特权操作**）；**明确不做审批桥接** |
| **M8** ✅ | 分得清“在 QQ 还是 DSH 里”：出站闸门按来源生效、出站方式做成开关、改模式立刻重挂提示词 |
| **M9** 🚧 | 戳一戳（入站已通，出站受 NapCat 限制，见[已知限制](#已知限制与环境要求)） |

完整变更记录见 [`CHANGELOG.md`](./CHANGELOG.md)，发行版见 [Releases](https://github.com/sj244/dsh-qq-bridge/releases)。


