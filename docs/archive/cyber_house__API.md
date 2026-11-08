> ⚠️ 已归档。本文件是历史存档，不再作为事实来源。
> 现状见 docs/INDEX.md 的对应 id：house.api.state、house.api-features、house.api-destination、house.api-upload-shp、house.api-import-qgis、house.api-buffer、house.api-knock、house.api-battery、house.api-physical、house.db-schema、house.pathfinder、house.npc、house.campus、house.interaction
> 归档前原路径：cyber_house/API.md
> 归档日期：2026-11-08 · 任务书 T4

# 赛博小屋 API 文档

小鱼（AI 代理）住在一个 1000 × 1000 的二维「赛博小屋」世界里，里面有三个区域、
六个房间。这份文档记录网页看板（`home_leaflet.html` / `home.html`）与外部调用方
可以使用的全部 HTTP 接口。

多层级地图底座（任务书 1）：同一张 `features` 表里可以装多张地图——
`cyber_house`（小屋本体）/ `village` / `forest`…。网页右上角的下拉框切换
当前层级，轮询带上 `?map_level=`，渲染、A\* 寻路栅格、拓扑检查全部按层隔离；
QGIS 导出的 GeoJSON 直接 `POST /api/fish-home/import-qgis` 落库。

## 基础信息

| 项目 | 值 |
| --- | --- |
| Base path | `http://<本机IP>:8787`（启动日志会打印局域网地址） |
| 启动方式 | `node cyber_house/api-router.js`（可用 `FISH_HOME_PORT` 改端口，`FISH_HOME_HOST` 改监听地址） |
| 看板页面 | `GET /home_leaflet.html`（Leaflet Web GIS 版）、`GET /home.html`（Canvas 版） |
| 字符编码 | UTF-8 |
| CORS | 全部接口允许跨域（`Access-Control-Allow-Origin: *`） |

返回体统一是 JSON：

- 成功：`{ "ok": true, "data": {...} }`（knock / features GET 例外，见下）
- 失败：`{ "ok": false, "error": "原因说明" }`

默认监听 `0.0.0.0`，好让手机在局域网里打开看板；这些接口**没有鉴权**，
只适合在可信的家庭 / 宿舍局域网使用。不需要手机访问时设
`FISH_HOME_HOST=127.0.0.1` 收回本机。

## 数据层：单文件空间数据库

所有要素（家具、网页自建的墙 / 房间 / 家具、门洞）都存放在
`cyber_house/cyber_house.sqlite` 的同一张 `features` 表里：

| 列 | 说明 |
| --- | --- |
| `id` | 主键，家具形如 `living-sofa`，网页要素形如 `feat-xxx`，上传 SHP 形如 `upl-xxx-0` |
| `name` | 显示名（沙发 / 隔断 / 书房2） |
| `type` | `furniture` / `wall` / `room` / `door`（门洞）/ `custom` / `shp_feature` |
| `room` | 所属房间（家具 / 门洞有） |
| `wkt` | 几何的 WKT 字符串，世界坐标（`POLYGON ((...))` 等） |
| `properties` | 任意 JSON：除 `name` / `type` / 布局簿记外，**其余键值原样透传**（见「动态属性表」） |
| `source` | `furniture` / `door` / `custom` / `uploaded_shp`，用于区分来源 |
| `map_level` | 地图层级（任务书「多层级地图底座」）：`cyber_house` / `village` / `forest`…，`TEXT NOT NULL DEFAULT 'cyber_house'`。旧库首次启动会自动 `ALTER TABLE` 补列，既有要素一律归属赛博小屋 |
| `min_x`…`max_y` | 包围盒，SQL 空间查重时做预筛 |

同一张 `features` 表里，多张地图各画各的：渲染、A\* 寻路栅格、拓扑检查、
`GET /state` 返回的数据都按 `map_level` 隔离（见 `map_level` 查询参数与
`import-qgis` 接口）。`SELECT *` 式的全量读（`GET /features`、
`GET /geojson` 导出）仍然返回全部层级——导出进 QGIS 时每条要素的
`properties.map_level` 记着它属于哪一层。

另有 `events` 表存屋里发生的事（NPC 对白等），只追加：`id / at / type / actor / text / data`；
`shp_edits` 表存外部 SHP 要素的属性覆盖包：`id / properties / updated_at`。

### 动态属性表与 `_source` 标识

- `features.properties` 是**任意键值对**：POST 时除 `type` / `name` / `icon` /
  `color` / `interact_text` 以外，任何键（≤64 字、不以 `_` 开头）与值
  （字符串 ≤2000 字 / 数字 / 布尔 / null / 深度 ≤3 的对象数组）都会原样落盘，
  GET 时一个不漏地带回来——导入的 SHP 字段（`OBJECTID` / `BUILDING_N` /
  `HEIGHT` …）也不例外。
- 每个要素的 `properties` 里都带一个 `_source` 标识：`'custom'`（网页自建）、
  `'furniture'`（家具）、`'shp'`（校园 SHP 文件里的要素）、
  `'uploaded_shp'`（网页直传 zip 入库的要素）。网页按它区分可编辑范围。
- **向下兼容层**：渲染 / A\* / 交互仍只认 `properties.name` / `properties.type`。
  外部要素缺 `name` 时，兼容层按 `Name` / `名称` / `BUILDING_N` /
  `BUILDING_NAME` 等别名补上；缺 `type` 时外部要素补 `'shp_feature'`
  （来源里带 `landmark` 的补 `'landmark'`）。

- 驱动优先 `better-sqlite3`；不可用时自动退回 Node 内置 `node:sqlite`。
- 优先加载 SpatiaLite（`mod_spatialite`），加载失败时降级为「WKT + Turf」：
  SQL 先用包围盒自连接筛候选，Node 里再用 `turf.intersect` 判精确重叠。
- 首次启动会把旧的 `furniture.json` / `features.json` 自动迁移进数据库，
  并把旧文件备份到 `cyber_house/backups/legacy-json-<时间戳>/`。
- `furniture.json` / `features.json` 仍会在写入后更新一份**兼容镜像**，
  但运行时读取只认数据库；手工改 JSON 后需要
  `node cyber_house/db/migrate.js --force` 才会重新导入。
- 状态自检：`GET /health` 和 `GET /state` 的 `storage` 字段会返回
  驱动、SpatiaLite 是否启用、各来源要素计数。

> **`GET /home_leaflet.html` 是 Web GIS 编辑器**：左上角的绘制工具条（leaflet.draw）
> 可以在地图上画点 / 线 / 面，画完弹出属性表单填写 `type`（furniture 家具、
> wall 墙壁、room 房间）、名称与图标，保存后走下面的 `POST /features` 落盘；
> 前端按 `type` 符号化渲染（透明房间面 / 深灰厚墙 / Emoji 要素），
> 后端把 wall / furniture 栅格化进 A* 寻路障碍物。
>
> 编辑器还带两个空间工具：**「空间分析」面板**的缓冲区分析（地图选点 +
> 半径，走 `POST /analyze-buffer`，画半透明发光圆并列出圈内要素），以及
> **「要素管理」动态属性表**：点一行（或点地图上的要素 / 校园图层）打开
> 属性面板，把 `properties` 的**所有键**动态排成可编辑表单（数字 → number
> 框、长文本 → textarea、未知外部字段照原样出现），「保存修改」走
> `PATCH /features/:id/properties`；🗑️ 删除走 `DELETE /features/:id`，
> A* 障碍栅格同步刷新。
>
> 同一个面板里还有 **「📁 上传 SHP」**：选一个包含 `.shp` / `.dbf` / `.shx` 的
> zip（也可以直接把 zip 拖进页面），走 `POST /upload-shp` 解析入库，成功后
> 立刻 `refresh()` 把新要素画到地图上（琥珀色虚线层），点开就能改属性。
> 上传时自动带上当前 `map_level`（见下），这批要素就落到这一层。

页面右上角（「🏠 回小屋 / 🌲 去武大」下面）还有一组**地图层级控件**
（任务书「多层级地图底座」）：

1. **🗺️ 地图下拉框**：选项来自 `/state` 的 `mapLevels`（`赛博小屋` / `村庄` /
   `森林`…，数据库里新出现的层级按原名展示）。切换后：
   - 轮询自动带上 `?map_level=`，渲染隔离——只画当前层的家具 / 自建墙 /
     上传 SHP，房间边界与屋内 NPC 只属于赛博小屋这一层；
   - `map.fitBounds()` 把视野缩放到这一层的 `mapBounds`（任务书要求
     「视野自适应」），导入新 GeoJSON 后也会缩一次；
   - 选择记进 `localStorage`（`fishHomeMapLevel`），下次打开还在这一层。
2. **📥 导入按钮**：选一个 QGIS 导出的 GeoJSON 文件，直接 `POST` 到
   `/api/fish-home/import-qgis`（文件里没带 `map_level` 的要素会落到
   当前这一层），导入后立刻刷新。

## 接口清单

### 0. `GET /home_leaflet.html` —— Web GIS 编辑器（绘制 + 属性 + 渲染）

看板页面本身就是编辑器，流程是任务书式的「画几何体 -> 填属性 -> 存后端」：

1. 左上角 `leaflet.draw` 工具条提供画点（Marker）、画线（Polyline）、画面
   （Polygon）三个按钮；
2. 画完任意图形触发 `L.Draw.Event.CREATED`，页面中央弹出**属性表单**：
   名称、要素类型（`room` / `wall` / `furniture`）、图标 Emoji、颜色；
3. 点「保存」把图形转成标准 GeoJSON Feature `POST` 到 `/api/fish-home/features`；
4. 下一轮轮询（≤2s）把所有自定义要素按 `properties.type` 符号化画到地图上。

### 1. `GET /api/fish-home/state` —— 小鱼状态

`/state` 的完整字段表、`campus` 时语义与移动三件套，唯一事实源见 [house.api.state](../docs/domains/house/api-state.md)。

### 1b. 场景交互物块（`interact_text`）

任意自定义要素的 `properties` 里加一个 `interact_text`，它就变成可交互物块：

```json
{
  "type": "Feature",
  "properties": {
    "type": "furniture",
    "name": "宝箱",
    "icon": "🧰",
    "interact_text": "宝箱里有一枚金币"
  },
  "geometry": { "type": "Point", "coordinates": [500, 600] }
}
```

- 小鱼与几何本体的距离 **< 30 世界单位**时触发一次；
- 触发后离开到 **> 50** 才重置，回来可以再次触发；
- 触发会往 `<工作区>/cyber_house/interaction-outbox.jsonl` 追加一条：
  `[系统：小鱼碰到了宝箱，触发对话：“宝箱里有一枚金币”]`
  QQ 桥接每秒消费该队列，私聊发给主人；
- `GET /state` 的 `interactionBubbles` 返回当前应显示的气泡（约 9 秒），
  网页把它画成要素上方的对话气泡。

### 1c. 多智能体 NPC（拟南芥 / 借手）

屋里固定有两位 NPC：🌱 **拟南芥** 和 🐱 **借手**。

- 他们各自在初始房间（书房 / 客厅）里随机溜达，只走直线可通的位置，
  不穿家具和墙；
- 后端每隔 **5–10 分钟** 从 `cyber_house/npc_dialogue.json` 随机抽一段对白；
- 对白逐条写进 SQLite 的 `events` 表：
  ```sql
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT, type TEXT, actor TEXT, text TEXT, data TEXT
  );
  ```
- `GET /state` 的 `npcs[].bubble` 返回头顶气泡（约 12 秒）；
  `npcDialogue` 是最近一段对白；
- 小鱼可以用 `read_house_events` 工具自己翻最近事件，不需要系统每轮硬塞进上下文。

`npc_dialogue.json` 可改间隔和台词：

```json
{
  "minIntervalMinutes": 5,
  "maxIntervalMinutes": 10,
  "bubbleMs": 12000,
  "dialogues": [
    { "id": "lazy-fish", "lines": [
      { "speaker": "拟南芥", "text": "小鱼今天又偷懒了。" },
      { "speaker": "借手", "text": "主人，要不我去把她的网线拔了？" }
    ]}
  ]
}
```

### 1d. 武大校园模式

虚拟坐标与真实经纬度用同一个 BBox 线性映射：

```text
WGS84 BBox: minLng 114.355, minLat 30.525, maxLng 114.372, maxLat 30.545
virtual (0,0)     -> maxLat / minLng（左上）
virtual (1000,1000) -> minLat / maxLng（右下）
```

- `GET /api/fish-home/campus-geojson?coordSystem=gcj02`
  读取 `cyber_house/campus/shp/*.shp`（建筑 / 道路 / 绿地），用 `shpjs`
  转成 GeoJSON；没有 SHP 时回退 `campus/campus_whu.geojson`。
  高德瓦片用 `coordSystem=gcj02`；默认 `wgs84`。
  - 每个要素的 `properties` 原样保留 DBF 全部字段（`OBJECTID` /
    `BUILDING_N` / `HEIGHT` / `FLOORS` / `ROAD_N` / `AREA_M2` …），
    并附加 `_source: "shp"`、兼容层补的 `name` / `type: "shp_feature"`，
    以及 `sourceFile`（来源文件名）。
  - id 形如 `shp-<shp 去扩展名>-<序号>`，稳定可寻址。
  - 存量 `shp_edits` 覆盖包每次都按 id 叠在文件属性之上
    （`PATCH /features/:id/properties` 对外部要素的落点），与坐标系无关。
  - 没给 `name` 的要素会被向下兼容层按别名补：
    `Name` / `NAME` / `名称` / `BUILDING_N` / `BUILDING_NAME` 等。
- `POST /api/fish-home/environment` `{"environment":"home"|"campus","teleport":true}`
  记录小鱼当前空间；`teleport=true` 时同时传送到校园 BBox 中心 / 客厅中心，
  清空旧路线。只影响展示与交互，不影响 A* / QQ。
- 校园模式点地图规划路线时，`POST /destination` 传真实坐标：
  ```json
  { "lng": 114.3699, "lat": 30.5324, "coordSystem": "gcj02" }
  ```
  后端用 `gcj02ToWgs84` + `geoToVirtual` 换算回 0–1000，再走原 A*。

前端右上角「🏠 回小屋 / 🌲 去武大」切两个独立 Leaflet 实例：
小屋用 `L.CRS.Simple`，校园用 `L.CRS.EPSG3857` + 高德瓦片；
切回小屋时校园地图 `remove()` 销毁。

### 1e. 跨空间认知同步

`environment === 'campus'` 时：

- `room` 是最近的校园 POI（老图书馆 / 樱花大道 / 珞珈山…）；
- `status` 是校园状态（“在武大校园散步”“正在珞珈山探索”“在樱花大道赏樱”）；
- `activity = 'campus'`；
- 后端把同一份快照写进 `cyber_house/current_space.json`；
- fish 的 `fish:space` system prompt 段读取该文件，动态生成：
  `[系统：你现在的环境是【武汉大学校园】，坐标 (x, y) 对应真实经纬度 (lng, lat)。你正在 {最近POI} 附近活动。]`
- 小屋状态下生成：
  `[系统：你现在的环境是【赛博小屋】，你在 客厅，在家休息。]`

点「🌲 去武大 / 🏠 回小屋」时前端调用：
```json
{ "environment": "campus", "teleport": true }
```
后端把小鱼传送到校园 BBox 中心 `(500, 500)` 或客厅中心，并清空旧路线。

### 1f. 物理环境感知（局域网抖动 / Type-C 手机电量）

任务书模块 2 / 3。两类感知都走同一条链路：

```
api-router / hardware-sensor
        │ engine.injectPhysicalEvent(text, meta)
        ▼
cyber_house/physical_events/<timestamp>.json  （跨进程队列）
cyber_house.sqlite events 表（type=physical，可回看）
        │ fish 插件每轮组装 system prompt
        ▼
fish:physical 段 → 小鱼自己决定要不要说
```

事件正文示例：

```
[物理感知：局域网信号极其不稳定，可能有人走动机箱，或者网卡过载。]
[物理感知：主人的手机插上了电脑，当前电量 85%。]
[物理感知：主人的手机拔下了电脑，当前电量 85%。]
```

事件文件**读走即删**，每条只交付一次；30 分钟没被读走则过期。

#### 局域网延迟

`hardware-sensor.js` 每 5 秒 ping 一次默认网关（拿不到网关时用 `114.114.114.114`）：

- 延迟 > 500ms -> 触发；
- 与上一次相比波动 > 300ms -> 触发；
- 同一类事件 5 分钟冷却，连续波动不重复注入。

启动服务时可用 `FISH_HOME_PING_HOST` 指定探测目标；`FISH_HOME_HOST=127.0.0.1`
可关闭局域网访问（同时也不会启动手机电量页的跨设备场景）。

#### 手机电量接口

```http
GET  /api/fish-home/hardware/battery
POST /api/fish-home/hardware/battery
Content-Type: application/json
```

请求体：

```json
{ "action": "plug_in", "level": 0.85, "charging": true }
```

- `action`：`plug_in` / `unplug` / `update`
- `level`：0–1（也兼容 0–100 的百分数）
- `charging`：可选，手机上报的充电状态

行为：

| action | 内存 phoneBattery | 注入 |
| --- | --- | --- |
| `plug_in` | `plugged=true`、`charging=true`、覆盖电量 | 第一次插上才注入；重复 plug_in 去重 |
| `unplug` | `plugged=false`、`charging=false`、覆盖电量 | 第一次拔下才注入；重复 unplug 去重 |
| `update` | 覆盖电量与 charging，静默 | **不注入** |

响应：

```json
{
  "ok": true,
  "data": {
    "action": "plug_in",
    "injected": true,
    "battery": {
      "level": 0.85,
      "percent": 85,
      "charging": true,
      "plugged": true,
      "updatedAt": "2026-11-07T13:09:00.000Z",
      "updatedAtMs": 1794056940000,
      "source": "battery-status-api"
    }
  }
}
```

`GET` 返回同样的 `data.battery`。最新值同时落盘到
`cyber_house/phone_battery.json`；fish 的 `fish:physical` 段只在「插着且 3 分钟内
更新过」时显示 `[系统：主人的手机正插在电脑上充电，当前电量 85%。]`。

> 浏览器限制：`navigator.getBattery()` 需要安全上下文。手机用
> `http://<局域网IP>:8787` 打开时，部分浏览器（尤其 Android Chrome）不会暴露
> 这个 API；页面会显示「此浏览器不支持电量读取」，但地图和其余功能正常。
> 想在手机上稳定使用，需要 HTTPS（自签证书）或改用本机 localhost 调试；
> 也可以先用 `curl` 直接 POST 这个接口验收后端。

#### 启动时的局域网地址

`node api-router.js` 现在默认监听 `0.0.0.0`，并在启动日志里直接打印：

```
[cyber-house] 局域网访问: http://192.168.1.100:8787
[cyber-house] 手机看板  http://192.168.1.100:8787/home_leaflet.html
```

前端不再手写 IP：非 `file://` 页面统一用 `window.location.origin` 拼接口地址。
只想本机使用时设 `FISH_HOME_HOST=127.0.0.1`。

## 2. `GET /api/fish-home/geojson` —— GeoJSON 矢量导出

同一份小屋数据导出为 RFC 7946 GeoJSON，可直接加载进 QGIS 等 GIS 软件。

**请求**

```http
GET /api/fish-home/geojson
Accept: application/json
```

**响应**

`FeatureCollection`。坐标对按 GeoJSON 的 `[x, y]` 顺序书写，数值仍是小屋自己的
1000 × 1000 世界坐标（不是真实经纬度）；在 QGIS 里加载后把 CRS 手动指成
EPSG:3857 即可按米制单位对齐显示。基础 Features 共 31 个（不含自定义要素）：

| kind | geometry | 数量 | 说明 |
| --- | --- | --- | --- |
| `room` | Polygon | 6 | 房间占地 |
| `furniture` | Polygon | 14 | 家具占地 |
| `door` | Polygon | 7 | 房间之间的门洞 |
| `fish` | Point | 1 | 小鱼当前位置 |
| `npc` | Point | 2 | 拟南芥 / 借手 |
| `route` | LineString | 1 | 当前导航路线 |

每个 feature 的 `properties` 里带 `name`（中文名）、`kind`、`room`（所属房间）等字段。

网页上画的自定义要素会追加在最后，`properties` 里额外带 `source: "custom"`
和自己的 `type`（`wall` / `furniture` / `room`），几何体原样保留（点 / 线 / 面）。

### 2b. `GET /api/fish-home/features` —— 读自定义要素

返回数据库里 `source='custom'` 的全部要素（没有要素时返回空集合）：

```jsonc
{
  "type": "FeatureCollection",
  "name": "赛博小屋·自定义要素",
  "updatedAt": "2026-11-05T03:12:00.000Z",
  "features": [
    {
      "type": "Feature",
      "id": "feat-mw2z5xl7-98volj",
      "properties": { "type": "room", "name": "书房2", "icon": "📚" },
      "geometry": { "type": "Polygon", "coordinates": [[[20, 20], [180, 20], [180, 120], [20, 120], [20, 20]]] }
    }
  ]
}
```

## 2c. `POST /api/fish-home/features` —— 保存绘制的要素

接收一个标准 GeoJSON Feature（或一次塞一整个 FeatureCollection），校验后
写入 `features` 表（`source='custom'`），**同时刷新 A* 寻路障碍物栅格与拓扑检测**。

**请求**

```http
POST /api/fish-home/features
Content-Type: application/json

{
  "type": "Feature",
  "properties": { "type": "wall", "name": "隔断", "icon": "🧱", "color": "#39434f" },
  "geometry": { "type": "LineString", "coordinates": [[375, 60], [375, 340]] }
}
```

**校验规则**

| 字段 | 规则 |
| --- | --- |
| `type` | 必须是 `"Feature"`（或外层为 FeatureCollection，`features` 数组最多 100 个） |
| `geometry.type` | 只接受 `"Point"` / `"LineString"` / `"Polygon"` |
| `geometry.coordinates` | 每个坐标对必须是两个有限数字；LineString ≥ 2 点、Polygon 每环 ≥ 3 点，坐标钳回 0–1000 |
| `properties.type` | 必填，`furniture` / `wall` / `room` 三选一 |
| `properties.name` | 可选，最多 40 字；空着后端按类型补默认名 |
| `properties.icon` | 可选 Emoji，最多 8 字 |
| `properties.color` | 可选，`#rrggbb` |
| `properties.interact_text` | 可选，固定互动文本，最多 200 字；填了就会在 30 单位内触发气泡 + QQ 通知 |

**A\* 寻路同步**

- `type: "wall"` 的线 / 面按 15 单元半径栅格化成障碍格，小鱼会被挡住、绕路走；
- `type: "furniture"` 的点 / 线 / 面同样计入障碍物（点就是一格半径的占地）；
- `type: "room"` 的多边形则相反：内部格子变成可通行区域（在虚空里画出
  新房间，小鱼游得进去），不挡路；
- 障碍栅格在下一轮 `GET /state`（≤2s）按数据签名重建，同时进行中的平滑路径
  会被作废并按新栅格重算（前端那边会看到新 `pathStart` 而无缝续播）；
- 如果新要素把某扇门的一半以上格子盖住，`topologyErrors` 会报
  `blocked-door`（「新画的墙壁把『卧室-书房 门』堵住了」），网页拓扑检查面板
  会在地图上把那扇门标红。

**成功响应**

```json
{ "ok": true, "data": { "type": "FeatureCollection", "...": "存盘后的完整集合，同 GET" } }
```

**错误**

| 状态码 | 场景 |
| --- | --- |
| 400 | 不是 Feature / geometry 类型不支持 / 坐标不是数字 / properties.type 不在白名单 |
| 501 | 引擎未提供保存能力（理论上不会出现） |

## 2d. `DELETE /api/fish-home/features/:id` —— 删除要素

按 id 删除一个要素，**同时作废 A\* 寻路障碍栅格**：被它挡住的格子下一轮
就恢复可通行。查找范围是统一要素表：

- 网页画的要素（id 形如 `feat-mw2z5xl7-98volj`）；
- 家具（id 形如 `living-sofa`，中文 id 走百分号编码，
  如 `DELETE /api/fish-home/features/%E5%AE%A2%E5%8E%85-%E6%B2%99%E5%8F%91`）；
- 门洞（id 形如 `door-living-balcony`，一般不从网页删）。

网页「要素管理」属性表的 🗑️、地图右键菜单、以及小鱼在 QQ 里调
`gis_delete_feature` 走的都是这一个口子。

**成功响应**

```json
{
  "ok": true,
  "data": {
    "ok": true,
    "source": "furniture",
    "id": "living-sofa",
    "name": "沙发",
    "target": "客厅",
    "remaining": 2
  }
}
```

- `source` = `features`（自定义要素）、`furniture`（家具）或 `door`（门洞）；
- `target` = 自定义要素的类型（`wall` / `furniture` / `room`）或家具所在的房间名；
- 自定义要素全删光时兼容镜像 `features.json` 会自动删除，`GET /features` 回空集合。

**错误**

| 状态码 | 场景 |
| --- | --- |
| 400 | 路径里缺 id |
| 404 | 数据库里没有这个 id |
| 501 | 引擎未提供删除能力（理论上不会出现） |

## 2d-bis. `PATCH /api/fish-home/features/:id/properties` —— 动态属性编辑

按 id 修改要素的属性，配合网页「要素管理」的动态属性面板使用。请求体是一个
**扁平的 `{ 键: 新值 }` 修改包**，后端读出原始 properties、合并后整体写回：

```http
PATCH /api/fish-home/features/shp-campus_buildings-3/properties
Content-Type: application/json

{ "HEIGHT": 88 }
```

### 路由范围

- **屋内要素**（`feat-*` 自建、`living-sofa` 家具）：直接改 `features` 表，
  修正版写回 `properties` 列；`name` / `type` / `room` 单独落列，
  兼容镜像同步刷新，快照与 A\* 签名作废（下一轮 `GET /state` 生效）。
- **外部 SHP 要素**（id 形如 `shp-<文件名>-<序号>`）：**SHP 文件本身只读**，
  修改写进独立的 `shp_edits` 覆盖包；`GET /campus-geojson` 每次都会把
  覆盖包按 id 叠在文件属性之上，所以刷新页面 / 重启服务都不会丢。

### 校验规则（修改包）

| 字段 | 规则 |
| --- | --- |
| 整体 | 必须是平面对象、非空、最多 32 个键 |
| 键名 | 长度 ≤64，不得以 `_` 开头，不得是 `id` |
| `name` | 若存在：去空格后非空，最多 40 字 |
| `type` | 家具必须保持 `furniture`；门洞必须保持 `door`；自建要素三选一 |
| 布局簿记 | 家具 / 门洞的 `localX` / `localY` / `localW` / `localH` / `width` / `height` 等**拒绝修改**（A\* 栅格与 `furniture.json` 镜像各读一边，从属性表改会造成两侧失同步） |
| 值 | 字符串 ≤2000 字 / 有限数字 / 布尔 / null / 深度 ≤3 的对象数组 |

> 「要素管理」面板对只读字段（`_source`、家具布局簿记、派生 type）做了
> **只读展示**而不是隐藏——核对数据时用得上，改不动是为了不弄坏寻路账本。

### 成功响应

```jsonc
{
  "ok": true,
  "data": {
    "id": "shp-campus_buildings-3",
    "source": "shp",              // "custom" / "furniture" / "shp"
    "feature": { "id": "...", "properties": { /* 合并后的完整属性 */ } }
  }
}
```

### 错误

| 状态码 | 场景 |
| --- | --- |
| 400 | 修改包不是对象 / 为空 / 超过 32 键；键名带 `_` 或是 `id`；`name` 为空；家具 / 门洞改了 `type` 或布局簿记；`room` 不是已知房间名 |
| 404 | 数据库里没有这个 id（SHP 要素在校园数据里找不到） |
| 501 | 引擎未提供属性编辑能力（理论上不会出现） |


## 2d-ter. `POST /api/fish-home/upload-shp` —— 网页直传 SHP（zip）解析入库

网页「要素管理」面板里的「📁 上传 SHP」按钮（或直接把 zip 拖进页面）走这个接口。
上传一个包含 `.shp` / `.dbf` / `.shx`（建议连 `.prj` / `.cpg` 一起）的 zip，
后端在内存里解压、用 `shpjs` 解析、换算坐标、补属性，然后整体写进 `features` 表。

**请求**

```http
POST /api/fish-home/upload-shp
Content-Type: multipart/form-data; boundary=...

--...
Content-Disposition: form-data; name="file"; filename="武大校园.zip"
Content-Type: application/zip
<zip 二进制>
--...
Content-Disposition: form-data; name="map_level"
village
--...--
```

- 字段名固定 `file`，一次一个 zip；zip 上限 40MB，解压后总量上限 160MB；
- 会自动跳过 `__MACOSX`、隐藏文件和非 shapefile 条目；嵌套目录里的 shapefile 也认；
- 可选表单字段 `map_level`（任务书「多层级地图底座」）：网页在某一层级下上传时
  会带上它，这批要素就落到该图层（例如 `village`）；不传则默认 `cyber_house`。

**解析约定**

| 项目 | 行为 |
| --- | --- |
| 编码 | 先按 `.cpg` / 默认编码解析；报错再依次试 `gbk` / `gb2312` / `utf-8`；都失败就只读几何（属性留空），不让整次上传失败 |
| 坐标 | 经纬度按校园 bbox 映射到小屋世界 0–1000（和校园模式同一套换算）；已经是 0–1000 的原样保留；其余投影坐标按包围盒等比缩放进可见区域 |
| `properties._source` | 强制 `'uploaded_shp'` |
| `properties.type` | 强制 `'shp_feature'`（不参与 A\* 寻路，改名 / 改属性都行，改成 `wall` 会被 PATCH 拒绝） |
| 名称 | 没有 `name` 时用兼容层按 `Name` / `名称` / `BUILDING_N` 等别名补；再没有就用「<shp 文件名> <序号>」 |
| id | `upl-<zip 文件名去掉扩展名>-<序号>`，同一份 zip 重传会按 id 覆盖，不会重复 |

**成功响应**

```jsonc
{
  "ok": true,
  "data": {
    "ok": true,
    "uploaded": 16,
    "source": "uploaded_shp",
    "fileName": "武大校园.zip",
    "files": [{ "shp": "campus_buildings.shp", "features": 10, "encoding": "cpg", "hasDbf": true, "hasPrj": true }],
    "notes": [],
    "transform": { "mode": "geo->virtual", "features": 16 },
    "ids": ["upl-武大校园-0", "..."]
  }
}
```

后端控制台同时打印：`[cyber-house] 成功解析 16 个要素（武大校园.zip → uploaded_shp，坐标 geo->virtual）`。

**错误**

| 状态码 | 场景 |
| --- | --- |
| 400 | 没收到文件 / 不是 zip（文件头不是 `PK`）/ zip 里没有 `.shp` / shapefile 没有任何可用几何 |
| 413 | zip 超过 40MB，或解压后体积过大、条目过多 |

**`DELETE /api/fish-home/upload-shp`** —— 清空网页直传的全部 SHP 要素，
返回 `{ ok: true, data: { ok: true, removed: 16 } }`。网页上的「🗑️ 清空上传」
按钮走这个（只有真的传过东西才会出现）。

## 2d-quater. `POST /api/fish-home/import-qgis` —— QGIS GeoJSON 直导入（多层级地图底座）

QGIS 里加载 `GET /api/fish-home/geojson` 导出的矢量（或自己画的图），
右键「导出」→ GeoJSON 后直接 POST 到这里，**不需要任何预处理**。
解析、规范化、入库一条龙，写进同一张 `features` 表（`source = 'custom'`，
和网页绘制的要素同一套渲染 / 编辑 / 删除语义）。

**请求**

```http
POST /api/fish-home/import-qgis
Content-Type: application/json

{
  "map_level": "village",        // 可选：整批要素的缺省层级
  "type": "FeatureCollection",
  "name": "村庄",
  "crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::3857" } },
  "features": [
    {
      "type": "Feature",
      "properties": { "type": "wall", "name": "北木墙", "map_level": "village" },
      "geometry": { "type": "LineString", "coordinates": [[40, 220], [700, 220]] }
    },
    { "type": "Feature", "id": "vil-house",
      "properties": { "type": "wall", "name": "村长家", "map_level": "village" },
      "geometry": { "type": "MultiPolygon", "coordinates": [ ... ] } }
  ]
}
```

单个 Feature 也能收（不必包成 Collection）。请求体上限 16MB，
一次最多 500 个输入要素（拆分后上限 2000 个）。

**解析约定**

| 项目 | 行为 |
| --- | --- |
| `properties` | 是对象即可；里面所有外部字段（`OBJECTID` / `BUILDING_N` / `HEIGHT` …）原样透传 |
| 内嵌长 JSON | `properties.props_json`（或 `properties_json` / `props`）的值如果是 JSON 字符串，先 `JSON.parse` 展开再取字段（任务书点名要求） |
| `map_level` | **强制提取 `properties.map_level`**；没有就用请求体顶层的 `map_level`；再没有就默认 `'cyber_house'` |
| 层级名校验 | 只认小写字母 / 数字 / `_` / `-`（1–40 字）。**不合法直接报错跳过该要素**，不静默塞进小屋——免得在另一张图上找不到自己的数据 |
| `type` | `wall` / `furniture` / `room` / `door` / `custom` 原样保留（**`wall` / `furniture` 计入 A\* 障碍栅格**）；其余任意类型（BUILDING / terrain…）一律按 `shp_feature` 只展示，绝不把整片导出区默默变成障碍 |
| 名称 | 先按 `Name` / `名称` / `BUILDING_N` 等别名补；再没有就「QGIS要素-序号」 |
| 几何 | `Point` / `LineString` / `Polygon` 直接收；`MultiPoint` / `MultiLineString` / `MultiPolygon` / `GeometryCollection` **拆成单部分几何**（每部分一条要素，id 加序号后缀），因为 A\* 栅格化与网页渲染只认单部分 |
| 坐标 | 世界坐标 0–1000，非法 / 非数字点直接报错；和绘制接口同一套钳制 |
| id | 有 `id` 就用（≤52 字）；没有就 `qgis-<层级>-<序号>`。**重新导入同 id 按覆盖走**，适合反复改图 |
| 单条失败 | 只跳过该条并把原因收进 `errors`，不影响其余——整批不会因为一条全废 |

**成功响应**

```jsonc
{
  "ok": true,
  "data": {
    "ok": true,
    "imported": 7,                // 实际入库的要素数（拆分后）
    "totalInputs": 7,             // 请求里的原始输入个数
    "levelCounts": { "village": 6, "cyber_house": 1 }, // 按层级统计这一批
    "mapLevels": ["cyber_house", "village"],           // 数据库里现在的全部层级
    "ids": ["qgis-village-0", "vil-house-0", "..."],
    "errors": ["第 6 个：map_level「Bad Level」不合法…"]
  }
}
```

导入后立刻作废 A\* 栅格与进行中的路径，下一轮 `GET /state?map_level=village`
就能看到导入的地形，小鱼也会避开其中的 `wall` / `furniture`。
`levelCounts` 方便确认没有要素漏网到别的图层。

**错误**

| 状态码 | 场景 |
| --- | --- |
| 400 | 请求体不是 GeoJSON 对象 / `features` 为空 / 全部要素解析失败 / 请求体顶层 `map_level` 不合法 |
| 409 | 有要素 id 已经被家具 / 门洞占用（把这批换掉或改 id 重来） |

## 2e. `POST /api/fish-home/analyze-buffer` —— 空间缓冲区分析

以给定圆心和半径生成一个缓冲面（Turf `circle` + `booleanIntersects`），
在整屋 GeoJSON 里检索相交的要素。网页「空间分析」面板的「缓冲区分析」
按钮、小鱼在 QQ 里调的 `gis_buffer_query` 都走这一个口子。

**请求**

```http
POST /api/fish-home/analyze-buffer
Content-Type: application/json

{"x": 640, "y": 500, "radius": 200}
```

- `x` / `y`：圆心世界坐标，会被钳回 0–1000；
- `radius`：半径（世界单位），钳到 5–500；
- `excludeKinds`：可选数组，指定要从结果里剔除的要素种类；默认
  `["fish", "route"]`——小鱼自己和当前导航路线不是「周围的东西」。

**成功响应**

```jsonc
{
  "ok": true,
  "data": {
    "center": [640, 500],
    "radius": 200,
    "steps": 64,
    "buffer": { "type": "Feature", "properties": { "kind": "buffer", "radius": 200, "center": [640, 500] },
                "geometry": { "type": "Polygon", "coordinates": [ /* 64 边形外环 */ ] } },
    "hitCount": 8,
    "hits": [
      { "name": "书房-客厅 门", "type": "door", "room": "", "distance": 149.7 },
      { "name": "椅子", "type": "furniture", "room": "书房", "distance": 186 }
    ],
    "truncated": false
  }
}
```

- `hits` 按圆心到要素代表点的直线距离由近到远排序，最多 60 条
  （`distance` = 四舍五入到 0.1 的直线距离）；
- `buffer` 是正 64 边形的 Polygon Feature，前端用 `L.geoJSON` 直接画圈。

> **坐标口径**：`turf.circle` 内部是球面三角，直接喂 0–1000 的世界坐标
> 会因为把 y 当纬度而失真。后端在以圆心为原点的局部小角度平面（赤道附近）
> 生成圆再把顶点平移回世界坐标，得到的是精确的平面圆（见
> `gis/analyze.js` 文件头注释）。

**错误**

| 状态码 | 场景 |
| --- | --- |
| 400 | x / y 不是数字、radius 不是正数 |
| 501 | 引擎未提供整屋导出能力（理论上不会出现） |

## 4. `POST /api/fish-home/destination` —— 规划 / 清除路线

给小鱼指定一个终点，后端用 A\* 在家具障碍栅格上算出途径点，再经分段三次贝塞尔
平滑成密集点阵；小鱼会立刻沿这条路线游过去（前端 60 帧播放），直到到达或者
她所在的活动房间改变。

**规划路线**

```http
POST /api/fish-home/destination
Content-Type: application/json

{"x": 500, "y": 500}
```

成功响应：

```jsonc
{
  "ok": true,
  "data": {
    "ok": true,
    "destination": { "x": 500, "y": 500 }, // 实际终点（会钳回 0-1000）
    "route": [                             // 剩余路径点（含脚下位置与终点；直线可达时为空数组）
      { "x": 480, "y": 540 },
      { "x": 500, "y": 500 }
    ],
    "smoothPath": [                        // 平滑贝塞尔点阵，前端 60 帧引擎直接消费
      { "x": 452.3, "y": 610.5 },
      // ...
      { "x": 500, "y": 500 }
    ],
    "pathStart": 1762300000000,            // 挂载时间戳；近在咫尺直接就位时为 null
    "pathDuration": 3818                   // 总时长 ms
  }
}
```

终点落在通行格内时最后一个点就是精确终点；点在家具 / 墙上时会自动贴到
最近的可走格。平滑度（smoothness）默认 0.2；若圆角会切进家具，后端自动
降级到 0.1 重试，仍不安全时退回直角折线（`smoothPath` 变两个点）。

**清除路线**

清除「网页规划的终点」，让小鱼回到自然活动目标（不改变家具、不影响她正在做的事）：

```http
POST /api/fish-home/destination
Content-Type: application/json

{"clear": true}
```

```json
{ "ok": true, "data": { "ok": true, "cleared": true } }
```

**错误**

| 状态码 | 场景 |
| --- | --- |
| 400 | 请求体不是 JSON 对象；缺 `x`/`y`；`x`/`y` 不是数字；坐标超出 -1000~2000 |
| 501 | 引擎未提供规划能力（理论上不会出现） |

## 5. `POST /api/fish-home/knock` —— 跨屏敲门

从网页给小鱼的 DSH 会话留一句话。她会收到这条消息，并在两分钟内把「有人敲门」
当作当前活动，游到客厅附近。

```http
POST /api/fish-home/knock
Content-Type: application/json

{"message": "我回来了"}
```

**响应**

```json
{ "ok": true }
```

成功只回 `ok`，不带 `data`。

**错误**

| 状态码 | 场景 |
| --- | --- |
| 400 | `message` 为空、或超过 500 个字 |
| 502 / 其他 | 投递失败（DSH 会话不可达等），错误体里有 `error` 字段 |

## 附：小鱼自己的空间检查工具

小鱼在 DSH 侧注册了 `fish_check_topology` 工具，和她自己说「检查一下房间」效果
一样：读 `cyber_house/cyber_house.sqlite`，跑同一份拓扑检查（重叠 + 越界 + 堵门），
把结果用人话告诉她。纯只读，不改家具。


