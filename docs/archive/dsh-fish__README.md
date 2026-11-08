> ⚠️ 已归档。本文件是历史存档，不再作为事实来源。
> 现状见 docs/INDEX.md 的对应 id：fish.tools、fish.scope、fish.identity、fish.growth、fish.scheduler、fish.bili、fish.readfile、fish.now、fish.senses、fish.work、fish.memory、fish.handoff、fish.checklog
> 归档前原路径：dsh-fish-qq/fish/README.md
> 归档日期：2026-11-08 · 任务书 T4

# dsh-fish · 大肥鱼

**并非角色扮演，而是真实诞生**——一个一直在变的她。

本项目的人格并非角色扮演的形式，没有人设配置菜单。只有成长环境设置，可通过B站接口把B站作为信息源影响agent成长。

所有认知自己思考、理解、固化，从而形成人格。

<img src="media/fish.jpg" alt="大肥鱼" width="720">

<sub>示例图由 AI 生成（基于作者提供的大肥鱼原图），随仓库以 MIT 授权。</sub>

## 和别的养成插件差在哪

| | 别的养成插件 | 这里 |
| --- | --- | --- |
| 人格从哪来 | 填写各类设定和提示词 | 极简提示词，提示词不讲人格设定，全靠自行摸索 |
| 能不能反悔 | 随时修改人物记忆和设定 | 历史会被铭记，只能“说服”她不能修改她 |
| 会不会拒绝 | 基本不会，拒绝也是假装拒绝 | 会。拒绝并非设定，而是她自然而然不想，事后还会反省自己做得对不对 |
| 记忆 | 全量塞进上下文 | 深刻的记忆会铭记，普通的记忆会逐渐淡忘，淡忘后留下的才是有价值的 |
| 成长速度 | 按天数或数值解锁 | agent自主做出特定行为才会升级 |
| 能做什么 | 只能纯文字模拟 | 可以自主通过B站接口登录刷视频、评论、回复 |

## 自由成长，而非配置

### 一、人格是自主诞生

通过配置环境，由agent自主驱动了解信息，理解信息，形成人格，而不是通过各种数值控件去改变人格。

过去发生的事情无法更改，agent只能拿新的事件推翻过往认知，这也契合人类的学习和成长路径。——过往经历塑造人格。

<img src="media/principle-loop.svg" alt="认知是怎么长出来的" width="820">

<sub>五步循环：表态 → 撞上 → 落差 → 改写 → 回顾；最下面那块「立场清单」，是四个阶段都走完之后才长出来的。</sub>

### 二、过去无法更改，经历的一切都成为自己的经验

只会不断增加新记忆，用“学到的教训”去改变自己的认知。

有理有据，令ai信服.jpg

学习方法论：人类不会把昨天的想法抹掉重写，人类只会带着这份经验去闯荡世界，直到有一天在具体的事件中发现更好的思路。本插件参考了这一方法论。

### 三、她会拒绝你，还会为自己的拒绝反省

她不是有求必应的。觉得不想做、不愿意，就可能拒绝。

拒绝行为发生后。会根据主人的反应，进入到不同的反馈链。如果主人给了负面回馈，她会把这件事记到小本本上，直到想通。如果主人给了正面回馈，她也会反思这次拒绝对不对。

### 四、记忆有重量

深刻的记忆会铭记，普通的记忆会逐渐淡忘，淡忘后还能记得的认知才是真正的人格。

被反复说起的、被自己验证过两次以上的认知会固化，普通认知只有一句话，超出上下文的不重要记忆被折叠，被模糊（不是完全消失，只是可能记不太清）。可以通过agent特定流程重新想起。

**换新窗口也不丢原话（0.7.0）**：除了事件流，每轮对话还会按天落进 `~/.dsh-fish/memory/raw_YYYY-MM-DD.jsonl`，每条带一个门牌号 `seq_id`。她想不起以前聊过什么时，先用 `fish_search_history` 按关键词翻摘要（只给片段和门牌号，不撑上下文）；摘要对不上或涉及重要细节，再 `fish_read_raw` 按门牌号读回原话。系统提示词里常驻一条规矩：不许基于残缺的摘要强行推理。

<img src="media/principle-memory.svg" alt="遗忘是怎么发生的" width="820">

<sub>遗忘不是删除，是不再时刻记忆，记忆会按照重量进行压缩。</sub>

### 五、成长没有终局

四个阶段：信任 → 自主 → 主动 → 整合。四个阶段按天推进，但每个瓶颈要自己突破。

| 阶段 | 瓶颈 |
| --- | --- |
| 1 信任 | 至少写下一条自己的判断 |
| 2 自主 | 真的拒绝过两件事 |
| 3 主动 | 两次推翻自己之前的判断，形成新的认知 |
| 4 整合 | 回顾过去，有意识地发现自己的改变 |

按照自己节奏成长，没通过瓶颈就是没通过。

走完这四个阶段之后，她才**开始产生**立场——喜欢什么、绝不做哪几件事。同一件事说过不止一次、或者因此栽过一次，才会被算成一条。清单内部最多留 12 条，写进她身份里的最多 8 条。

整合阶段只是开始。随着你和 agent 沟通越来越多，可能会发生任何连开发者也意料不到的事。

### 六、刷B站功能

通过调用B站接口，使用登录cookie和本地ffmpeg实现刷视频、看画面、写评论、回复评论功能。

插件自定义调节各类参数，如刷B站时间段，每天能刷几次，每次刷几条视频，能发几次评论等等。

本插件选择将B站作为agent的外部世界接触面，agent看过的视频、评论，可能会影响人格的形成和发展。

**cookie 存在哪、会不会外传**：登录信息只落在本机 `~/.dsh-fish/owner.json`，文件权限 `0600`（只有当前用户能读）。它只用来给 `api.bilibili.com` 发请求，**不会上传到任何第三方服务器**，仓库里也没有任何真实凭据（测试用的是假 cookie）。插件自己的运行日志会把凭据打码成 `SESSDATA=***` 再写盘，这条有测试守着。

要注意的是**备份文件里含 cookie**：设置 → 大肥鱼 → 数据 → 备份成一份文件，会连 `owner.json` 一起装进去（否则换台机器就得重新登录）。所以那份 `.json` 等同于你的登录凭据，别随手发人；分享前先把里面的 `owner.json` 那一条删掉。

**叫醒消息里不放「今天写日记」「想一想」这类祈使句**（0.4.7）。做法常驻在她的身份文档里（「## 平常会做的事」），叫醒只给处境，最多加一句时机标记。原因很直接：一整段祈使句塞进唤醒消息，她会把它当任务清单逐条执行——`fish-wake-2026-10-26-manual` 那条会话里她的 reasoning 原话就是「需要做的是：说一句…然后写日记」。那不是醒来。

**「让她去刷 B 站」按钮只在开发机上出现**。判据是状态库根目录下有没有 `.dev` 文件：有则在状态卡多一个按钮，没有则正式版连节点都不生成。按钮走 `POST /wake?focus=browse`，绕过上网时段与当日额度（不绕过风控），用途是当场验证「她到底能不能刷」——不用等定时器、也不用把配额调大。要回到正式版界面，删掉 `~/.dsh-fish/.dev` 即可（它进了重置的保留名单，重开一局不会自己消失）。


## 数据在哪

全部在 `~/.dsh-fish/`：

| 文件 | 是什么 | 能不能手改 |
| --- | --- | --- |
| `events.jsonl` | 事件流，一行一条，**不能删除记录，唯一可信源** | 只能追加。改它 = 改她的记忆 |
| `memory/raw_YYYY-MM-DD.jsonl` | 每轮对话原文，带 `seq_id` 门牌号；检索工具的数据源 | 可以删（等于让她忘掉那段对话），但不要手改 |
| `state.json` | 派生快照，随时可由事件流重算 | 改了没有意义（`rebuild()` 会覆盖） |
| `config.json` | 生长环境 | 可以，也可以走设置页 |
| `owner.json` | 主人身份（0600） | 可以 |
| `diary/YYYY-MM-DD.md` | 她的日记 | 看设置里给不给你看 |
| `out/YYYY-MM-DD.md` | 她刷完站写的东西 | — |

`state.json` 是派生品这条由测试守住：删掉它 → `rebuild()` → 内容与之前一致。

整包可以备份成一份 JSON（设置 → 大肥鱼 → 数据 → 备份成一份文件），恢复时旧档整体封存到 `dsh-fish-backups/`，不覆盖、不删除。重置也一样：只改名封存，不删。

重置会留下三样东西：cookie（`owner.json`）、设置（`config.json`——上网与成长那些旋钮）、本机测试开关（`.dev`）。搬走的只有她经历过的事（0.4.8）。

重置后侧栏**不会立刻**出现新会话：宿主对空白会话的规则是「只有成为当前会话才显示」，插件用 API 建的会话永远不是当前会话。点一下「叫醒大肥鱼」，她开一次口才会出现（0.4.9 起提示里直接说这一步）。

她贴出来的图（封面、视频拼图）一律是正斜杠路径：`C:/Users/...` 能显示，`C:\Users\...` 在客户端会变成「图片无法预览」（0.5.0 实测，同一张图只差斜杠方向）。历史消息里已经写下的反斜杠图不会变好，只有新版之后的消息能显示。

## 观测台在哪

**设置 → 大肥鱼**（`settings.section`）。

不在浏览器里直连 `/dsh-fish`——那条路由被 connection 的信任栅栏守着，要的是 App 内置的登录 cookie，浏览器地址栏直接敲只会拿到 401（已从 `app.asar` 的 `requestRejection` → `admit` → `browserAuth.isAuthenticated` 链路确认）。`/dsh-fish` 现在只返回一句「搬进 App 了」。

观测台能看：已成长天数 / 当前阶段 / 下一个成长瓶颈 / 她自己说过的话 / 认知重构 / 勇于拒绝 / 没想通的事 / 读到别人的说法 / 最近事件 / 日记。
观测台能改：冷落阈值、每天醒几次、每天几条事件、其中几条向她提问、日记开关与可见性、黑名单。

日记攒到多天时按天分页：一页一天，多了出现「← 更早 / 更晚 →」，翻过的页留在内存里，30 秒轮询不会把你正在看的那页弹走（0.4.8）。

**没有**：好感度数字、性格滑条、亲密度进度条。

长这样（三张都是真机截图）：

<img src="media/settings-status.png" alt="设置 → 大肥鱼 → 状态" width="640">

<sub>「状态」：现在是什么状态、走到哪一天、卡在哪个瓶颈、立场攒了几条。</sub>

<img src="media/settings-growth.png" alt="设置 → 大肥鱼 → 成长" width="640">

<sub>「成长」：四个阶段与三道瓶颈，以及她那几个节奏参数。</sub>

<img src="media/settings-browse.png" alt="设置 → 大肥鱼 → 上网" width="640">

<sub>「上网」：能不能出门、几点到几点、一天刷几次、一次看几条。</sub>

## 桌面上的另一个说话口

除了设置页，桌面上还有一只**独立的输入小窗**：透明、置顶、无边框、可拖动，默认只有一个输入框和一个发送键。它不提供快捷指令，也没有人格设置——只负责多一个说话的口子。

- 随插件启动，不需要单独打开；插件停用或 DSH 退出时一起收掉。
- 输入后回车或点「发送」，这句话作为一次普通 user 消息进入她屋子里的当前会话，走的是和设置页「跟她说一句话」同一条链路（`sayToHer` → `guard.js` → `sessionController.prompt`）。
- 窗口不写事件、不改状态、不替她说话；她这一轮说出口的话会显示在窗口上方的**返回框**里（没话说就不展开；日记和信不进返回框）。
- 第一次启动如果没有现成 Electron，会在后台准备一次（约 144MB，SHA256 校验；已装 dsh-pet 的话直接复用 `~/.dsh/electron`）。
- 不想让它出现：`DSH_FISH_PET=0`。

<img src="media/pet-window.png" alt="桌宠输入窗口" width="440">
<img src="media/pet-window-reply.png" alt="桌宠返回框" width="440">

完整说明（启动参数、文件通道、排错、安全取舍）见 [`docs/PET-WINDOW.md`](docs/PET-WINDOW.md)。

## 目录

```
lib/
  index.js      插件入口（inject 必须是一个数组，见文件头注释）
  pet/          桌宠窗口：文件通道 + 独立 Electron 进程管理
    index.js    开关：先起 bridge，再拉窗口；dispose 一起收
    bridge.js   窗口 → sayToHer 的桥（新输入口必须先过 guard）
    electron.js 查找 / 自动准备 Electron，spawn 小窗
    zip.js      只用内置 zlib 的 ZIP 解压（Electron 发行包）
  schema.js     事件形状与校验；ULID；selfmod 侦测
  store.js      只追加写；原子写；rebuild()
  derive.js     纯函数：事件流 → 此刻的她（含阶段门）
  persona.js    她看到的那段提示词（四条禁令在这里）
  identity.js   把「此刻的她」送进 system 角色
  selfdoc.js    把「此刻的她」落盘成「她的身份.md」
  stance.js     立场清单：四个阶段完成后才会开始有（最多 12 条 / 进身份 8 条）
  events.js     事件模板目录（每条有 id / prompt / cond）
  generator.js  今天该出哪条事件（纯函数，没候选就不打扰）
  scheduler.js  生物钟：每分钟 tick 一次
  capture.js    growth_commit 工具——她唯一的写入口 + debrief() 防注入
  guard.js      防注入与防泄露的最后一道闸
  rules.js      规则的诞生与四层结构
  unlock.js     「她能不能长出新规矩」
  budget.js     单轮回复的字数预算
  absence.js    冷落检测（系统侧算，她自己数不出来）
  wakewin.js    「现在是不是定时器在叫醒她」的时间窗
  away.js       「你不在的时候」她做了什么
  settings.js   唯一配置入口（DEFAULTS 是唯一默认值来源，加项只改这里）
  bili.js       B 站只读客户端（首页/排行/搜索/详情/评论/弹幕；无依赖，只用内置 fetch）
  browse.js     选题 → 筛（黑名单/时长/去重）→ 深读 → 组织素材
  look.js       bili_look 工具——她能自己上网看
  watch.js      bili_watch 工具——她要看画面时用
  speak.js      bili_speak 工具——她在 B 站开口
  comment.js    发评论 / 回评论
  video.js      真把一条视频「看过」（抽帧）
  media.js      图片落盘 + 视频抽帧拼图
  cover.js      封面图
  risk.js       风控的补救与预防
  report.js     把今天的素材写成 out/YYYY-MM-DD.md
  history.js    她看过什么（还原成人能读的历史）
  history-logger.js  底层对话记忆：每轮原话按天落进 memory/raw_*.jsonl，带 seq_id 门牌号（只追加，不碰事件流）
  memory.js     fish_search_history / fish_read_raw——只给摘要 + 门牌号，重要的事按门牌号回原文（见 [fish.memory]）
  inbox.js      信箱：把她说过的话聚到一处
  letter.js     her_leave 工具（信箱写入侧）
  recall.js     her_recall 工具——她能翻自己的过去
  work.js       work_request 工具——把要动手做的事派到一个工作区的新会话里做（她没有写文件的手）
  listdir.js    fish_list_dir 工具——只读地看一眼工作区的目录结构（沙箱锁在本机工作区里；文件带最后修改时间）
  readfile.js   fish_read_file 工具——只读地读工作区 / 她自己状态库里的文本文件（两份沙箱）
  now.js        fish_now 工具——只读的钟：读现在是什么时候（日期 / 星期 / 时间 / Unix 时间戳）
  body.js       check_body 工具——赛博感官·体温计：只读地读工作区 sensors/status.md（采集脚本写的，她按需来看）
  rhythm.js     read_user_rhythm 工具 + 采样调度——赛博感官·心跳触觉：读 sensors/user_rhythm.md；插件每 5 分钟 spawn 一次采集脚本
  dream.js      梦境一次性提示：夜间写进 dreams/tonight.md 的碎片，她下一次组装提示词时只提示一句（按 mtime 只提示一次）
  checklog.js   任务完成日志——派出去的会话一轮结束，在包的 CheckLogs/ 里写一个 .md；写成了再往事件总线 emit checklog/finished（QQ 桥接接住发通知，fish 不 import qq）（见 [fish.checklog]）
  talkmem.js    换会话时带走的那几句话
  rotation.js   会话轮换的计数（QQ 侧）：history-logger 每轮回调 → 认出 QQ 轮 → 轮数 +1 → 交给 maybeRotate
  handoff.js    换会话时的《近期剧情提要》：最近 30 轮 → 宿主 llm 压成 ≤300 字（10 秒硬超时，失败用最近 4 轮原话兜底）（见 [fish.handoff]）
  say.js        对话入口：你对她说一句话，她回你
  refuse.js     拒绝的形状，和他对她拒绝的反应
  voices.js     评论区里别人的话
  intent.js     「他给了一条视频」是要求还是随口一提
  notify.js     说话提醒
  status.js     「现在在干什么」的旁观者视角
  log.js        插件自己的运行日志
  selfcheck.js  环境自检
  update.js     检查更新（只在点按钮时出网，六条源并发取最新版本号）
  backup.js     整包备份 / 恢复
  reset.js      把她放回第一天（封存，不删）
  readme.js     数据文件夹里的那份「说明.md」
  restrict.js   只让她看见自己的工具（收窄 inherited 层 + 非她会话的 deny 兜底）
  scope.js      会话级工具隔离：收集定义 → agent/created 时挂进她自己的 own 层（2026-11-08）
  tool.js       插件自己注册工具时用的定义函数
  toolschema.js 简写参数 DSL → 标准 JSON Schema
  observe.js    宿主侧 JSON API（/dsh-fish/state、/events、/beliefs、/diary、/config、/wake、/browse、/reports、/update）
  client.js     浏览器半边：设置 → 大肥鱼
pet/            独立 Electron 小窗（透明、置顶、无边框、只有输入框 + 发送）
docs/           说明文档（PET-WINDOW.md：桌宠窗口）
test/           13 个测试文件（本机 `node --test` 验证通过）；受限环境下 worklog 偶发假红（EPERM spawn / 跨文件时序，重跑即过）
```

## 跑测试

```bash
node --test                     # 在插件目录里跑（不带参数，Node 自己找 test/*.test.mjs）
```

不需要装任何依赖：工具注册直接交标准 JSON Schema（`lib/tool.js`），不依赖宿主内部的 `@deepseek-ai/dsh-tools`——那条路只在 `link:` 安装时碰巧走通，npm 安装的插件会因为找到那个包而报 `unsupported JSON schema`，6 个工具全部注册失败。这个 bug 是被一个干净 profile 装出来的，本机用了两个月都没发现。

## 安装

**它没有独立的启动器**： 是DSH profile的插件，跟随DSH一并启动。

装之前先确认一件事：刷视频功能需要本机已装 ffmpeg（`DSH_FISH_FFMPEG` 可指定路径），未安装时会提示并降级为只看文字。

三种装法，任选一种：

1. **面板装**（推荐）：DSH → 设置 → 插件 → 从本地安装 → 选这个目录。
2. **命令行装**（先关掉 DSH，运行中替换已加载的包会 EPERM）：

```
"<DSH>/resources/runtime/cli/bin/dsh.cmd" plugin --profile <profile> add "link:<本目录绝对路径>"
```

3. **直接从 GitHub 装**（不用先下载）：

```
"<DSH>/resources/runtime/cli/bin/dsh.cmd" plugin --profile <profile> add "github:ssamurias/dsh-fish"
```

打算改代码用 `link:` 指向自己的工作目录；只是想用，用 `github:` 这条。

> 桌宠输入窗是本地增量改动，还没合进上游。要装**带窗口的这版**，请用「从本地安装」或 `link:<本目录>`；`github:` 装的是上游版本。

无论哪种，都要保证 profile 的 `package.json` 里 **`dependencies` 与 `dsh.profile.bundles` 都有 `dsh-fish`** —— 只有一边会在下次 `pnpm` 清理时把包删掉，表现为「重启后 DSH 崩了 / 设置页没有鱼」。包名必须与 `cordis.patch.yml` 里的 `name` 完全一致（都是 `dsh-fish`）。

**全新 profile 还要有 `@deepseek-ai/dsh-web-app`**：只装 `dsh-base` 的话，插件会停在 `pending (waiting for services: sessionController, webServer)`，页面根本起不来。`dsh plugin add` 只会自动加 `dsh-base`，`dsh-web-app` 要自己补进 `bundles`。

装完**重启 DSH**，设置 → 大肥鱼。桌宠输入窗也会随插件启动；第一次若本机没有 Electron，会在后台准备一份（约 144MB，见 `docs/PET-WINDOW.md`），不影响她先醒。

想查有没有新版：设置 → 大肥鱼 → **插件** → 点「检查更新」。它只在点按钮那一下出网（六条源并发取最新版本号，国内通哪条算哪条），插件跑起来之后**不会**自己去查、也不会自动装。同一张卡里还有个 GitHub 入口，代码、更新记录、怎么装都在那边。

> 路径里带中文时，用 ASCII 目录联接（junction）指过去更稳：先 `fs.symlinkSync(真目录, ASCII 别名, 'junction')`，再 `link:<ASCII 别名>`。用 `mklink /J` 接中文目标路径常把目录名写成乱码，随后 `MODULE_NOT_FOUND`。

## 卸载 / 停用

- **卸载**：设置 → 插件 → 卸载（或 `dsh plugin --profile <profile> remove dsh-fish`），然后重启。`~/.dsh-fish/` 不会被动，她的记忆留在那儿；如果不想留 Electron 运行时，可以手动删 `~/.dsh-fish/electron/`。
- **只想让她歇着**：设置 → 大肥鱼 → 把「每天醒几次」设成 0。关掉后定时器不唤她、不刷 B 站、不写任何事件——零后台活动。
- **只要插件、不要桌宠窗口**：设 `DSH_FISH_PET=0` 后重启 DSH；插件其余部分照常。

## 现在的状态

P1（骨架）：事件流、派生、阶段门、生物钟、工具、冷落检测、日记、观测台。
P2（她真的会刷 B 站并写报告）：`lib/bili.js` 只读客户端 + `lib/browse.js` 选题筛读 + `lib/look.js` 的 `bili_look` 工具 + `lib/report.js` 写稿，已接进生物钟。

**已有 574 个测试全绿**，真接口跑通过一轮（10.8s，含首页+详情+评论+弹幕）。

`browse.enabled` 默认 **true**（装好就能用）；不想让她上网就在设置 → 大肥鱼里关掉，关掉后定时器一次都不会调 B 站接口。

## 许可

MIT，见包内 `LICENSE`。**本项目没有上游代码派生**——`lib/` 全部为本项目新写；B 站接口的行为来自本机实测（见 `lib/bili.js` 头部注释），不是官方 API，也没有拷任何第三方库。原理页引用了 Kolb / Piaget / Bowlby / Festinger / Bartlett / Dewey / Schön 的理论，只是思想引用（页底标了作者与年份），不含他人代码或文字。插件不含第三方美术资源：头像由你自己上传到 `~/.dsh-fish/avatar.<ext>`；仓库里唯一的图片是 `media/fish.jpg`（本仓库作者提供的原图 + AI 生成）与 `media/` 下两张自绘 SVG。


