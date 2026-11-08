# DSH-MyFish 文档索引（INDEX）

> **状态**：T4 最终版。本文件只负责「任务 → 单元 → 路径 / 锚点」的路由，**不承载事实**。
> 事实的唯一位置是每个单元的 L1；原文档已归档到 `docs/archive/`，原路径只留 stub。

## 0. 规则（先读这三条）

**id 与路径映射**

```
id          = <域>.<子名>
路径        = docs/domains/<域>/<子名点转连字符>.md
```

- `<域>` 是 `fish` / `qq` / `house` / `merge` / `ops` 五者之一。
- id 由小写字母、数字、`.` 和 `-` 组成；每个 `.` 在路径中变成 `-`（id 里本来就有的 `-` 原样保留）。
- 正向校验（lint L3）：把 `owner` 的 id 按上面的规则推出路径，必须等于 L1 文件自身路径。

示例：

| id | 路径 |
| --- | --- |
| `qq.settings` | `docs/domains/qq/settings.md` |
| `house.api.state` | `docs/domains/house/api-state.md` |
| `ops.config-write` | `docs/domains/ops/config-write.md` |

**anchors 行语法**（L1 顶部使用，本表同款）

```
anchors: <仓库相对路径>[#<符号或行号>]; <仓库相对路径>[#<符号或行号>]
```

- 多个锚点用 `;` 分隔；文件路径一律用 `/`，相对仓库根。
- `#` 后面可写符号名或行号；lint 只校验 `#` 前的文件存在。
- anchors 只写仓库内文件；运行时路径写进 L1 正文。

**版本核对行语法**（L1 顶部使用）

```
版本核对: <包>@<版本> / <包>@<版本>
```

- 三个包的版本唯一来源是 `merge.version-matrix`；改版本只改三个 `package.json`。
- 没有版本号的文件由 owner 自定修订标识（如 `cyber_house@2026-11-08`）。

**本表规模**：5 个域、58 个单元。任务路由表里的箭头 `→` 表示**按序打开**，不是并列。

---

## 1. 任务路由表

| 你在做什么 | 按序打开 |
| --- | --- |
| 第一次装插件、跑起来 | `ops.install` → `merge.lifecycle` → `ops.acceptance` |
| 装纯净版 / 换一台机器 | `ops.install` → `ops.config-write` → `ops.acceptance` |
| 接 QQ / 私聊没反应 | `qq.onebot` → `qq.wake` → `qq.whitelist` → `qq.owner` |
| 改唤醒策略、概率、群聊 @ | `qq.wake` → `qq.settings` → `qq.proactive` / `qq.idle` |
| 回复发不出去 / 出站方式不对 | `qq.outbound` → `qq.fileget` → `qq.safety` |
| 加改 QQ 指令词 | `qq.subsend` → `qq.fileget` → `qq.receive` → `qq.list` → `qq.help` → `qq.whitelist` → `qq.admin` |
| 主动私聊 / 私人时间 | `qq.proactive` → `qq.idle` → `qq.settings` |
| 任务完成通知 | `qq.checklog-notify` → `fish.checklog` → `merge.lifecycle` |
| 改她的人格、成长、阶段 | `fish.growth` → `fish.identity` → `fish.scheduler` |
| 事件流或状态对不上 | `fish.memory` → `fish.handoff` → `fish.identity` |
| 记忆、换会话、剧情提要 | `fish.memory` → `fish.handoff` |
| 桌宠/输入窗口 | `fish.identity` → `merge.lifecycle` |
| 刷 B 站 / 评论 / 风控 | `fish.bili` → `fish.scheduler` |
| 读文件 / 看时间 / 感官 | `fish.readfile` → `fish.now` → `fish.senses` |
| 派活 / 工作区 | `fish.work` → `fish.tools` → `fish.scope` |
| 小屋起不来 / 数据库坏了 | `house.db-schema` → `ops.db-migrate` |
| 画地图 / 改地图 / 导入 | `house.api-features` → `house.api-upload-shp` → `house.api-import-qgis` |
| 家具、NPC、交互、寻路 | `house.pathfinder` → `house.npc` → `house.interaction` |
| 校园模式 / 物理感知 | `house.campus` → `house.api-physical` → `house.api-battery` |
| 改插件装配 / 依赖 / 版本 | `merge.lifecycle` → `merge.inject` → `merge.client-bundle` → `merge.version-matrix` |
| 打包发布 / 脱敏 | `ops.release` → `ops.install` → `ops.troubleshooting` |
| 装完怎么验 / 出问题 | `ops.acceptance` → `ops.troubleshooting` |
| 文档冲突 / 新增单元 | `docs/RULES.md` §2/§5 → `node scripts/docs-lint.mjs` |

---

## 2. fish 域（13 个单元）

大肥鱼本体：`dsh-fish-qq/fish/`。

| id | 一句话 | anchors |
| --- | --- | --- |
| `fish.tools` | 20 个 FISH_TOOLS + 7 个 QQ_BRIDGE_TOOLS；own 层挂载 + restrict + guard 三把刀 | `dsh-fish-qq/fish/lib/restrict.js#FISH_TOOLS`; `dsh-fish-qq/fish/lib/restrict.js#QQ_BRIDGE_TOOLS`; `dsh-fish-qq/fish/lib/restrict.js#registerToolRestrict`; `dsh-fish-qq/fish/lib/scope.js#createToolCapture`; `dsh-fish-qq/fish/lib/scope.js#mountToolDefinitions` |
| `fish.scope` | 会话级工具隔离：收集定义、挂 own 层、按轮收放、识别「她」 | `dsh-fish-qq/fish/lib/scope.js#createToolCapture`; `dsh-fish-qq/fish/lib/scope.js#mountToolDefinitions`; `dsh-fish-qq/fish/lib/scope.js#isHerAgent` |
| `fish.identity` | 「此刻的她」进 system 角色、落盘「她的身份.md」与 persona/selfdoc 装配 | `dsh-fish-qq/fish/lib/identity.js#attachIdentity`; `dsh-fish-qq/fish/lib/selfdoc.js#renderSelfDoc`; `dsh-fish-qq/fish/lib/persona.js#personaLine` |
| `fish.growth` | 四阶段、瓶颈、growth_commit 唯一写入口与立场清单 | `dsh-fish-qq/fish/lib/derive.js`; `dsh-fish-qq/fish/lib/capture.js`; `dsh-fish-qq/fish/lib/stance.js` |
| `fish.scheduler` | 生物钟：每天醒几次、事件/提问配额、刷站窗口 | `dsh-fish-qq/fish/lib/scheduler.js` |
| `fish.bili` | 刷 B 站：首页/搜索/详情/评论/弹幕、看画面、发评论、风控 | `dsh-fish-qq/fish/lib/bili.js`; `dsh-fish-qq/fish/lib/browse.js`; `dsh-fish-qq/fish/lib/look.js`; `dsh-fish-qq/fish/lib/watch.js`; `dsh-fish-qq/fish/lib/comment.js` |
| `fish.readfile` | fish_read_file：工作区 / 自身状态库两份只读沙箱 | `dsh-fish-qq/fish/lib/readfile.js` |
| `fish.now` | fish_now：只读的钟，返回日期/星期/时间/Unix 秒 | `dsh-fish-qq/fish/lib/now.js` |
| `fish.senses` | 赛博感官：check_body / read_user_rhythm 与每 5 分钟采样 | `dsh-fish-qq/fish/lib/body.js`; `dsh-fish-qq/fish/lib/rhythm.js` |
| `fish.work` | work_request：把要动手的事派到工作区新会话 | `dsh-fish-qq/fish/lib/work.js` |
| `fish.memory` | 双层记忆：raw 原话 + seq_id 检索 + 单条 2000 字截断 | `dsh-fish-qq/fish/lib/history-logger.js#recordTurn`; `dsh-fish-qq/fish/lib/memory.js#searchHistory`; `dsh-fish-qq/fish/lib/memory.js#readRaw` |
| `fish.handoff` | 换会话提要：10 秒硬超时、14 秒看门狗、12 秒等待、30 秒陈旧、4 轮回退 | `dsh-fish-qq/fish/lib/handoff.js#generateHandoff`; `dsh-fish-qq/fish/lib/home.js#maybeRotate`; `dsh-fish-qq/fish/lib/home.js#waitHandoffReady` |
| `fish.checklog` | 任务完成日志：写成功后 emit checklog/finished、2 小时超时 | `dsh-fish-qq/fish/lib/checklog.js#buildTaskResult`; `dsh-fish-qq/fish/lib/checklog.js#writeTaskLogAndAnnounce`; `dsh-fish-qq/fish/lib/checklog.js#createTaskWatcher` |

---

## 3. qq 域（19 个单元）

QQ 桥接：`dsh-fish-qq/qq/`。

| id | 一句话 | anchors |
| --- | --- | --- |
| `qq.settings` | 55 项用户设置、Config/BridgeSettings 两个 schema 与本机设置接口 | `dsh-fish-qq/qq/index.js#Config`; `dsh-fish-qq/qq/index.js#BridgeSettings`; `dsh-fish-qq/qq/index.js#readSettings` |
| `qq.wake` | 唤醒策略：白名单 → 直回指令 → @/昵称 → 概率 → 只记录 | `dsh-fish-qq/qq/index.js#decide` |
| `qq.outbound` | 三种 replyMode、来源闸门、sendToQQ/subsend/proactive 通道 | `dsh-fish-qq/qq/index.js#outboundGate`; `dsh-fish-qq/qq/index.js#sendToQQ`; `dsh-fish-qq/qq/index.js#sendSubsendToTarget` |
| `qq.safety` | 身份判定与 help/receive/list 解析：fail-closed、主人/管理员 | `dsh-fish-qq/qq/index.js#isAllowed`; `dsh-fish-qq/qq/index.js#isOwnerSender`; `dsh-fish-qq/qq/index.js#canUseFileCommand` |
| `qq.owner` | 认主、管理员、来源标记与三档权限 | `dsh-fish-qq/qq/index.js#senderRole`; `dsh-fish-qq/qq/index.js#ownerMarkerFor`; `dsh-fish-qq/qq/index.js#isOwnerSender` |
| `qq.subsend` | 主人 subsend：解析、唤醒、每日 20/冷却 20、via=subsend | `dsh-fish-qq/qq/index.js#parseSubsendCommand`; `dsh-fish-qq/qq/index.js#shouldSubsend`; `dsh-fish-qq/qq/index.js#renderSubsendInstruction` |
| `qq.fileget` | fileget/filesend：主人/管理员、工作区沙箱、50MB、via=fileget | `dsh-fish-qq/qq/index.js#parseFileCommand`; `dsh-fish-qq/qq/index.js#resolveWorkspaceFile`; `dsh-fish-qq/qq/index.js#renderFileInstruction`; `dsh-fish-qq/qq/index.js#FILE_MAX_BYTES` |
| `qq.receive` | receive 指令与收文件：命名、占位、回执、200 个/50MB | `dsh-fish-qq/qq/index.js#parseReceiveCommand`; `dsh-fish-qq/qq/index.js#buildReceiveReport` |
| `qq.list` | list / list dist / managehub：解析、目录白名单、20 行回执 | `dsh-fish-qq/qq/index.js#parseListCommand`; `dsh-fish-qq/qq/index.js#listWorkspaceFiles`; `dsh-fish-qq/qq/index.js#buildListReport` |
| `qq.help` | help 四词、按身份三档列表、不唤醒、via=help | `dsh-fish-qq/qq/index.js#parseHelpCommand`; `dsh-fish-qq/qq/index.js#buildHelpText` |
| `qq.whitelist` | whitelist：主人专用、写 values.whitelist、立刻生效 | `dsh-fish-qq/qq/index.js#parseWhitelistCommand`; `dsh-fish-qq/qq/index.js#whitelistReplyText` |
| `qq.admin` | admin add/del/list：仅主人、写 values.admins、立刻生效 | `dsh-fish-qq/qq/index.js#parseAdminCommand`; `dsh-fish-qq/qq/index.js#adminReplyText`; `dsh-fish-qq/qq/index.js#isAdminSender` |
| `qq.proactive` | 不定时主动私聊：空闲 + 概率 + 每日上限 | `dsh-fish-qq/qq/index.js#shouldProactivelyMessage`; `dsh-fish-qq/qq/index.js#proactivePromptText` |
| `qq.idle` | 私人时间/自主待机：抽签、Ghost Mode、每日额度 | `dsh-fish-qq/qq/idle-trigger.js` |
| `qq.checklog-notify` | 任务完成通知：system/agent 两档、门禁与计数 | `dsh-fish-qq/qq/checklog-notify.js` |
| `qq.napcat` | NapCat 下载/校验/解包/配置/启停 | `dsh-fish-qq/qq/napcat.js` |
| `qq.onebot` | OneBot v11 正向 WS：重连、心跳、入站映射、防回环 | `dsh-fish-qq/qq/onebot.js` |
| `qq.state-file` | `qq-bridge-state.json` 的形状、加载/保存、缓冲/台账 | `dsh-fish-qq/qq/index.js` |
| `qq.client-card` | 浏览器半设置卡片：settings.section、字段与保存 | `dsh-fish-qq/qq/client/client.js` |

---

## 4. house 域（15 个单元）

赛博小屋：`cyber_house/`。

| id | 一句话 | anchors |
| --- | --- | --- |
| `house.api.state` | GET /state 的 33 个字段、campus 语义与 map_level | `cyber_house/api-router.js#createApiRouter`; `cyber_house/state-engine.js#getState` |
| `house.api-features` | features 的 GET/POST/DELETE/PATCH 动态属性 | `cyber_house/api-router.js#handleFeatures`; `cyber_house/gis/features.js` |
| `house.api-destination` | POST /destination：规划/清除路线 | `cyber_house/api-router.js#handleDestination`; `cyber_house/state-engine.js` |
| `house.api-upload-shp` | POST /upload-shp：网页直传 zip 解析入库 | `cyber_house/api-router.js#handleUploadShp`; `cyber_house/shp/upload-import.js` |
| `house.api-import-qgis` | POST /import-qgis：QGIS GeoJSON 多层级导入 | `cyber_house/api-router.js#handleImportQgis`; `cyber_house/db/map-level.js` |
| `house.api-buffer` | POST /analyze-buffer：缓冲区分析 | `cyber_house/api-router.js#handleAnalyzeBuffer`; `cyber_house/gis/analyze.js` |
| `house.api-knock` | POST /knock：跨屏敲门 | `cyber_house/api-router.js#handleKnock` |
| `house.api-battery` | POST /hardware/battery：手机电量上报 | `cyber_house/api-router.js#handlePhoneBattery`; `cyber_house/hardware-sensor.js` |
| `house.api-physical` | 物理感知：局域网抖动/手机插拔事件队列 | `cyber_house/hardware-sensor.js`; `cyber_house/telemetry/dsh-telemetry.js` |
| `house.pathfinder` | A* 栅格、折线寻路与房间/门洞/家具障碍 | `cyber_house/gis/pathfinder.js#planRoute` |
| `house.npc` | 拟南芥/借手：溜达、对白、事件表 | `cyber_house/gis/npcs.js` |
| `house.campus` | 武大校园模式与虚拟坐标 ↔ WGS84/GCJ02 | `cyber_house/campus/index.js`; `cyber_house/gis/campus.js` |
| `house.interaction` | interact_text 物块、敲门、气泡与 outbox | `cyber_house/gis/interactions.js` |
| `house.motion` | 贝塞尔平滑、穿模校验与回退、pathStart/pathDuration | `cyber_house/gis/pathfinder.js#smoothPathWithCubicBezier`; `cyber_house/state-engine.js#FISH_PATH_SPEED`; `cyber_house/state-engine.js#_startPathTo` |
| `house.db-schema` | SQLite 表结构、索引、map_level 补列、旧 JSON 迁移 | `cyber_house/db/schema.sql`; `cyber_house/db/migrate.js#main`; `cyber_house/db/index.js#_ensureSchema` |

---

## 5. merge 域（5 个单元）

二合一包装配层：`dsh-fish-qq/` 根目录。

| id | 一句话 | anchors |
| --- | --- | --- |
| `merge.lifecycle` | 先 fish 后 qq、各自 try/catch、dispose 逆序 | `dsh-fish-qq/index.js`; `dsh-fish-qq/client.js` |
| `merge.inject` | 硬依赖清单与可选服务降级 | `dsh-fish-qq/index.js`; `dsh-fish-qq/package.json` |
| `merge.client-bundle` | 生成的 client.js：__ModuleLoader__、双设置页合并 | `dsh-fish-qq/client.js`; `dsh-fish-qq/package.json` |
| `merge.version-matrix` | 三个包的版本唯一表：dsh-fish-qq / fish / qq | `dsh-fish-qq/package.json`; `dsh-fish-qq/fish/package.json`; `dsh-fish-qq/qq/package.json` |
| `merge.patch` | bundle patch：一行 insert、fish/qq 两槽与合并包开关 | `dsh-fish-qq/cordis.patch.yml` |

---

## 6. ops 域（6 个单元）

发布、安装与运维。

| id | 一句话 | anchors |
| --- | --- | --- |
| `ops.install` | 纯净版五步安装：解压/依赖/配置/导入/启动 | `README-RELEASE.md`; `packaging/setup.js` |
| `ops.config-write` | setup.js：config.json → 两个系统位置、规范化、备份 | `packaging/setup.js#main`; `packaging/setup.js#QQ_KEYS` |
| `ops.release` | 打包：黑名单、脱敏、残留扫描、发布 zip | `pack-release.js`; `packaging/setup.js` |
| `ops.db-migrate` | 小屋 SQLite 迁移 CLI 与 --status/--check/--force | `cyber_house/db/migrate.js#main` |
| `ops.acceptance` | 装/跑/QQ/fish/house/发布六组验收唯一表 | `README-RELEASE.md`; `dsh-fish-qq/qq/README.md`; `dsh-fish-qq/功能文档.md` |
| `ops.troubleshooting` | 常见问题/排查入口唯一表 | `README-RELEASE.md`; `dsh-fish-qq/qq/README.md`; `dsh-fish-qq/功能文档.md` |

---

## 7. 维护

- 新增 / 删除单元：先改本表，再按 `RULES.md` §5 同步 L1 与代码注释。
- 本表只允许出现「路由信息」：id、一句话、anchors。事实、默认值、验收步骤一律写进 L1。
- 新增事实：建 L1 → INDEX 加行 → 代码加 `// @doc` → 若引用旧 id 则改链接 → 跑 lint；**禁止新增任何根目录/子目录的散文档**。

## 迁移完成记录

- 日期：2026-11-08
- 总单元数：58（fish 13 / qq 19 / house 15 / merge 5 / ops 6）
- lint 规则版本：T4（L1 missing→fail；L6 复述→fail；新增 L7 归档、L8 原路径防回写）
- 归档文件（`docs/archive/`，9 份）：
  - `DSH-MyFish__README.md`
  - `cyber_house__API.md`
  - `dsh-fish-qq__README.md`
  - `dsh-fish-qq__对接文档.md`
  - `dsh-fish-qq__功能文档.md`
  - `dsh-fish__README.md`
  - `dsh-qq-bridge__README.md`
  - `dsh-qq-bridge__DESIGN.md`
  - `dsh-qq-bridge__CHANGELOG.md`
- 未归档：`README-RELEASE.md`（发布包安装指南，留在根）
- 已删除重复副本：未发现。当前仓库每份原文档只有一份；`diff` 结论为「无重复副本，无独有内容丢失」，因此没有删除动作。
