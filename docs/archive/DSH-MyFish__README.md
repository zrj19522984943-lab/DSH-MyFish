> ⚠️ 已归档。本文件是历史存档，不再作为事实来源。
> 现状见 docs/INDEX.md 的对应 id：house.motion、house.api.state、house.interaction、house.npc、house.campus、house.api-physical、ops.release、ops.db-migrate
> 归档前原路径：README.md
> 归档日期：2026-11-08 · 任务书 T4

# DSH-MyFish —— 小鱼的全部家当

这个目录把「大肥鱼 / dsh-fish-qq」相关的东西收在一起，和外层的
`dsh-subagent-injection-master/`、`gateway/`、`NapCat.Shell/`、
`backup-before-merge/`、`dist/` 等分开。

## 目录

| 目录 | 是什么 |
| --- | --- |
| `dsh-fish-qq/` | 大肥鱼 + QQ 桥接插件包（`fish/` + `qq/`） |
| `cyber_house/` | 赛博小屋：SQLite 空间数据库、A* 寻路、拓扑检查、Leaflet 看板 |
| `sensors/` | 环境状态 `status.md`、用户节奏 `user_rhythm.md` |
| `pipeline/` | 环境采集、资讯流水线、梦/节奏更新脚本 |
| `rss/` | 资讯流水线的 raw / summary / archive 存档 |
| `scripts/` | 合并包构建、OneBot 探针、DSH 会话查看脚本 |
| `tools/` | ffmpeg 下载辅助脚本（可选，看视频画面用） |

`dist/`（发布 zip/tgz）、`managehub/`（QQ `list` 的交换目录）、
`NapCat.Shell/`（QQ 运行时）按用户要求留在外层，不放进小鱼目录。
`node_modules/` 与根 `package.json` 也留在外层，作为共享依赖
（`cyber_house` 的 `@turf/turf` / `better-sqlite3` 从外层解析）。

## 启动赛博小屋

```powershell
cd D:\demo\workspace\DSH-MyFish\cyber_house
node api-router.js
```

启动时会自动打印本机和局域网地址，手机可以直接打开「手机看板」那行：

```
[cyber-house] 局域网访问: http://192.168.1.100:8787
[cyber-house] 手机看板  http://192.168.1.100:8787/home_leaflet.html
```

默认监听 `0.0.0.0`（手机要能访问），可用 `FISH_HOME_PORT` 改端口；
只想本机用时设 `FISH_HOME_HOST=127.0.0.1`。前端非 `file://` 页面统一用
`window.location.origin`，不再需要手写 IP。第一次监听局域网时 Windows 防火墙
可能弹窗，勾选「专用网络」允许 Node 即可。

## 物理环境感知

- **局域网延迟**：`cyber_house/hardware-sensor.js` 每 5 秒 ping 默认网关
  （拿不到网关用 `114.114.114.114`）。延迟 > 500ms 或与上次波动 > 300ms
  时注入一条 `[物理感知：局域网信号极其不稳定…]`，冷却 5 分钟。
- **Type-C 手机电量**：手机打开看板时用 `navigator.getBattery()` 监听
  `chargingchange`；插上 / 拔下各上报一次，插着期间每分钟静默覆盖一次电量。
  后端接口 `POST /api/fish-home/hardware/battery`，最新值落在
  `cyber_house/phone_battery.json`。
- 两类事件都进 `cyber_house/physical_events/` 队列，fish 插件的
  `fish:physical` system prompt 段读走即删，由小鱼自己决定反应。
  详见 [`cyber_house/API.md`](cyber_house/API.md) 的 1f 节。

> 手机从局域网 HTTP 打开时，部分浏览器不会暴露 Battery API（需要安全上下文）；
> 页面会显示「此浏览器不支持电量读取」，但地图功能不受影响。

验收：`node cyber_house/.headless/hardware-e2e.js`。

## 数据库

```powershell
node cyber_house/db/migrate.js --status
node cyber_house/db/migrate.js --check
node cyber_house/db/migrate.js --list
node cyber_house/db/migrate.js --force   # 从旧 JSON 重新导入
node cyber_house/.headless/db-inspect.js # 用 node:sqlite 直读，验证标准 SQLite 文件
```

数据库文件：`cyber_house/cyber_house.sqlite`。

## 丝滑移动引擎（60帧）

小鱼的位置是时间的纯函数：A* 折线经分段三次贝塞尔平滑后下发 `smoothPath` / `pathStart` / `pathDuration`，前端按 60 帧采样；完整契约见 [house.motion](docs/domains/house/motion.md)。

## 场景交互物块

在网页绘制要素时填写「互动文本（可选）」，或给任意要素的 `properties`
加 `interact_text`，它就会变成可交互物块：

- 小鱼走到几何本体 30 单位内 -> 触发一次固定对话；
- 离开 50 单位外 -> 重置，下次可以再触发；
- 触发时网页地图冒对话气泡（`GET /state` 的 `interactionBubbles`），
  同时往 `cyber_house/interaction-outbox.jsonl` 追加一条
  `[系统：小鱼碰到了{名称}，触发对话：“{文本}”]`；
- QQ 桥接每秒消费该队列，私聊发给主人（需重启 DSH 加载新版桥接代码）。

验收：`node cyber_house/.headless/interaction-e2e.js`。

## 两个 NPC

🌱 **拟南芥** 和 🐱 **借手** 会在书房 / 客厅随机溜达，每 5–10 分钟从
`cyber_house/npc_dialogue.json` 抽一段对白，写进 `cyber_house.sqlite` 的
`events` 表；网页上两人头顶会冒气泡。

小鱼用 `read_house_events` 工具自己翻最近事件，不需要系统每轮把闲话塞进上下文。

验收：`node cyber_house/.headless/npc-e2e.js`。

## 武大校园模式

网页右上角两个按钮：

- 🏠 **回小屋**：原来的 `L.CRS.Simple` 1000×1000 赛博小屋；
- 🌲 **去武大**：切换到 `L.CRS.EPSG3857` + 高德瓦片，叠加武大 SHP 图层。

后端 BBox（WGS84）：`114.355,30.525 ~ 114.372,30.545`。
虚拟坐标 <-> WGS84/GCJ02 的双向转换在 `cyber_house/gis/campus.js`。
真实 SHP 放进 `cyber_house/campus/shp/`，接口会自动读取；详见
[`cyber_house/campus/README.md`](cyber_house/campus/README.md)。

验收：`node cyber_house/.headless/campus-e2e.js`、
`node cyber_house/.headless/cognition-e2e.js`。

校园模式下后端会把最近 POI 写进 `current_space.json`，fish 的 `fish:space`
system prompt 段再把它变成“你现在在武汉大学 / 老图书馆附近”的动态前缀；
网页面板也会把「当前房间」改成「当前地点（武大）」。

## 与工作区根的关系

DSH 设置里的「工作区根目录」现在指向
`D:\demo\workspace\DSH-MyFish`。插件也兼容外层根：如果填的是
`D:\demo\workspace`，`fish/lib/workspace.js` 会自动向下探测
`DSH-MyFish/`，`qq/index.js` 对 sensors / pipeline / receive / 发文件走同样的探测。
`dist` 和 `managehub` 的 `list` 会自动回退到外层工作区。

DSH profile 里的插件 link 已指向：

```
D:\demo\workspace\DSH-MyFish\dsh-fish-qq
```

重启 DSH 后从新位置加载。

## 发布纯净版

```powershell
cd D:\demo\workspace\DSH-MyFish
node pack-release.js
```

输出：`D:\demo\workspace\DSH-MyFish-Release.zip`（解压后是
`DSH-MyFish-Release/`，里面带 `README-RELEASE.md` 和 `config.example.json`）。

脚本会按黑名单剔除记忆、日记、事件流、日志、`cyber_house.sqlite`、`backups/`、
`.headless/`、测试与本机调试脚本，并把真实 API Key / QQ 号 / B 站 Cookie /
本机绝对路径替换成占位符；打包前还会扫描一遍暂存目录，发现残留就中止。

打包依赖 `archiver`（不进发布包）：

```powershell
cd packaging
npm install
```

`config.example.json` 是从本机 `~/.dsh-fish/config.json` 脱敏生成的，
QQ 段来自 `~/.dsh/qq-bridge-settings.json`，全部替换成
`YOUR_API_KEY_HERE` / `YOUR_QQ_NUMBER_HERE` 等占位符。



