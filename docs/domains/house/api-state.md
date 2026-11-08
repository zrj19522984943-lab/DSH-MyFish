owner: house.api.state
anchors: cyber_house/api-router.js#createApiRouter; cyber_house/state-engine.js#getState; cyber_house/state-engine.js#getGeoPosition
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.api.state

本文档是 `house.api.state` 的唯一事实来源：`GET /api/fish-home/state` 的完整响应字段、`campus` 时的语义，以及 `?map_level=` 的层级切换。其他接口（features / geojson / import / analyze 等）不在这里。

## 事实

### 端点

- `GET /api/fish-home/state`，可带 `?map_level=<层级>`（`cyber_house` / `village` / 森林…）。
- 成功：`{ ok: true, data: { ... } }`；失败：HTTP 500 `{ ok: false, error: 'Internal Server Error', detail }`。
- 全部接口允许跨域（`Access-Control-Allow-Origin: *`），**没有鉴权**；默认监听 `0.0.0.0`，只适合可信局域网。
- `map_level` 会先 `engine.setMapLevel()` 归一化；非法值钳回 `cyber_house`，不报错。缺省 = 维持当前层。
- 轮询只刷新状态、不「一步一步」推动移动：小鱼位置是时间的纯函数，前端用 `smoothPath` + `pathStart` + `pathDuration` 自行按 60 帧采样。`getState()` 仍会推进交互/NPC/今日统计，并把当前空间写入 `cyber_house/current_space.json`。

### 完整字段表（33 个字段）

| 字段 | 形状 | 含义 | campus 时语义 |
| --- | --- | --- | --- |
| `room` | string | 展示用房间名 | 换成最近的校园 POI 名；没有 POI 时 `武汉大学` |
| `status` | string | 展示用状态 | 换成校园状态（`campusStatusFor(poi)`） |
| `activity` | string | 活动键（`idle` / `rest` / `qq` / `campus`…） | 固定 `'campus'` |
| `homeRoom` | string | 小屋内部真实房间（不受校园影响） | 不变，仍是小屋房间 |
| `homeStatus` | string | 小屋内部真实状态 | 不变，仍是小屋状态 |
| `environment` | `'home'` / `'campus'` | 当前空间 | `'campus'` |
| `mapLevel` | string | 当前地图层级（归一化后） | 不变，仍是当前 `map_level` |
| `mapLevels` | string[] | 数据库里出现过的全部层级 | 不变 |
| `mapBounds` | `[minX,minY,maxX,maxY]` | 当前层的世界包围盒；小屋固定 `0,0,1000,1000` | 当前校园层的 bounds |
| `campusPoi` | `{name,kind,distance}` / `null` | 最近校园 POI 与距离（米） | 非 `null`；`home` 时为 `null` |
| `geo` | `{lng,lat,coordinateSystem:'wgs84'}` | 虚拟坐标换算的 WGS84 | 真实经纬度；贴高德以外的底图用它 |
| `geoGcj02` | `{lng,lat,coordinateSystem:'gcj02'}` | 虚拟坐标换算的 GCJ02 | 真实经纬度；贴高德瓦片用它 |
| `virtual` | `{x,y}` | 0–1000 世界坐标（保留 1 位） | 不变，仍是虚拟坐标 |
| `campusBBox` | `{minLng,minLat,maxLng,maxLat}` | 武大校园 WGS84 范围 | 不变 |
| `campusCenter` | `{lng,lat}` | 武大校园中心 WGS84 | 不变 |
| `position` | `{x,y}` | 当前世界坐标（1 位小数） | 不变，仍是虚拟坐标 |
| `currentRoute` | `[{x,y}]` | 剩余导航路径点（已裁掉走过的弧长） | 校园路线同样用虚拟点阵 |
| `smoothPath` | `[{x,y}]` | 稠密分段三次贝塞尔点阵；无路线时 `[]` | 校园路线同样平滑 |
| `pathStart` | number / `null` | 路径挂载时的 `Date.now()`；无路线时 `null` | 同左 |
| `pathDuration` | number | 路径总时长（ms）；无路线时 `0` | 同左 |
| `topologyErrors` | `[{type,message,room,items,featureIds,bounds}]` | 当前层的空间冲突；空数组 = 无冲突 | 只检查校园层内部 |
| `todayStats` | `{房间: 秒数}` | 今日各小屋房间停留秒数 | 仍统计小屋房间，不换成 POI |
| `todayUsage` | `{turns,tokens,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}` | 今日对话统计 | 不变 |
| `systemHealth` | `{memoryPercent,memoryLevel,chassisStatus,chassisLevel,chassisPercent,weather,weatherTempC,updatedAt}` | 环境传感器快照（`sensors/status.md`） | 不变 |
| `furniture` | object | 当前层的家具布置（`rooms` / `doors` 等） | 校园层通常为空结构 |
| `customFeatures` | FeatureCollection | 当前层网页自建要素 | 校园层只含该层自建要素 |
| `uploadedFeatures` | FeatureCollection | 当前层网页直传 SHP（`source='uploaded_shp'`）；不进 A* | 校园层同样按层返回 |
| `featureRows` | FeatureCollection（EPSG:3857） | 自建 + 家具 + 上传 SHP 的完整属性；每条的 `properties._source` 是 `custom` / `furniture` / `uploaded_shp`；门洞除外 | 校园 SHP 文件里的要素**不在**这里（走 `/campus-geojson`） |
| `interactionBubbles` | `[{id,name,text,center,at,expiresAt}]` | 当前应显示的交互气泡（约 9 秒） | 同左 |
| `interactions` | `{triggered,reset,lastAt}` | 本轮交互计数与最近触发时间 | 同左 |
| `npcs` | `[{id,name,emoji,color,room,x,y,bubble}]` | 拟南芥 / 借手的快照 | 仍返回小屋 NPC（校园层前端不使用） |
| `npcDialogue` | `{id,at,lines}` / `null` | 最近一段 NPC 对白 | 仍为小屋对白 |
| `storage` | object | 存储层自检：`file` / `driver` / `sqliteVersion` / `spatialite` / `spatialiteVersion` / `spatialiteReason` / `schemaVersion` / `revision` / `featureCount` / `eventCount` / `furnitureCount` / `doorCount` / `customCount` / `shpEditsCount` / `sizeBytes` / `migration` | 同左 |

### 字段补充

- `featureRows.crs` 是 `{ type:'name', properties:{ name:'urn:ogc:def:crs:EPSG::3857' } }`，坐标仍是 0–1000 世界坐标（兼容旧前端）。
- `uploadedFeatures` 的几何已换算到小屋世界 0–1000，`type` 固定 `shp_feature`，不参与 A* 障碍栅格。
- `topologyErrors` 的 `bounds` 是 `[x0,y0,x1,y1]`，供地图标红；`type` 有 `overlap` / `out-of-bounds` / `blocked-door`。
- `systemHealth.updatedAt` 是 `sensors/status.md` 的 mtime ISO 串；文件不存在时各数值为 `null` / `unknown` / `0`。
- `storage.migration` 是首次建库/迁移的结果对象；`schemaVersion` 来自 `meta` 表，当前 `SCHEMA_VERSION = '1'`。

### 已知偏差

- **API.md §1 没有 `campusCenter`**：`cyber_house/API.md` 的 `/state` 响应示例只列了 `campusBBox`；`state-engine.getGeoPosition()` 实际还返回 `campusCenter: { lng, lat }`，`getState()` 把它放进响应。本表的 33 个字段以代码为准。
- **API.md §1 的 `storage` 示例不完整**：示例只列了 `file` / `driver` / `spatialite` / `featureCount` / `eventCount` / `furnitureCount` / `doorCount` / `customCount` / `shpEditsCount` / `revision`；`db.info()` 实际还返回 `sqliteVersion` / `spatialiteVersion` / `spatialiteReason` / `schemaVersion` / `sizeBytes` / `migration`。
- **「轮询只刷新状态，不驱动移动」**：API.md §1 的原话；代码 `getState()` 会调 `_applyElapsed(nowMs)` 按时间重新采样位置，并推进交互、NPC、今日统计、`current_space.json`。移动仍由 `pathStart` + `duration` 决定，不是「每次轮询走一步」；但 `getState()` 不是纯读，这一点原文档没展开。
- **`/state` 的归属**：`dsh-fish-qq/对接文档.md` §8.1 的 `/state` 行是 fish 插件的 `/dsh-fish/state`（派生模型摘要），**不是**本单元的小屋 `/api/fish-home/state`。两者同名不同接口；T3 只在该行加交叉链接，未把 fish 的 `/state` 事实替换掉。
- **`featureRows` 的层级**：`/state` 返回的 `featureRows` 只含当前 `map_level` 的自建 + 家具 + 上传 SHP；`GET /geojson` 才是全层级导出。API.md 的 `featureRows` 段落没写「按层过滤」，只写了来源组成。

## 不负责

- `smoothPathWithCubicBezier` 的算法与安全回退 → 见 `house.motion`。
- `features` 表的列、索引、迁移 → 见 `house.db-schema`。
- 其他 HTTP 端点（geojson / features / upload-shp / import-qgis / analyze-buffer / destination / knock） → 见 `house.server` 及后续 T4 单元。
- 前端 Leaflet 编辑器与动态属性面板 → 见 `house.editor`。
- 校园坐标转换与 POI 选择 → 见 `house.campus`。
- 物理传感器事件产生端 → 见 `house.sensor`。

## 验收

```powershell
# 服务起来后（另开窗口：node cyber_house/api-router.js）
curl.exe "http://127.0.0.1:8787/api/fish-home/state" | ConvertFrom-Json | Select-Object ok
# 或
node -e "fetch('http://127.0.0.1:8787/api/fish-home/state').then(r=>r.json()).then(j=>console.log(Object.keys(j.data).length,Object.keys(j.data).join(',')))"

# 层级隔离
curl.exe "http://127.0.0.1:8787/api/fish-home/state?map_level=village"
```

人工核对：`data` 至少包含本表 33 个字段；`campusPoi` 在 `home` 为 `null`；`smoothPath` / `pathStart` / `pathDuration` 在无路线时分别为 `[]` / `null` / `0`。
