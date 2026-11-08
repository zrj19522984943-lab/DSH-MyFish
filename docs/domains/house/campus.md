owner: house.campus
anchors: cyber_house/campus/index.js; cyber_house/gis/campus.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.campus

本文档是 `house.campus` 的唯一事实来源：武大校园模式的环境切换、BBox、虚拟坐标 ↔ WGS84/GCJ02 与 POI 认知。

## 事实

- 校园 BBox（WGS84）：`114.355,30.525 ~ 114.372,30.545`；中心约 `114.3635,30.535`。
- 坐标系：
  - `virtual`：小屋世界 0–1000；
  - `geo`：WGS84；
  - `geoGcj02`：高德瓦片用的 GCJ02；
  - `virtualToGeo` / `virtualToGcj02` / `geoToVirtual` 在 `gis/campus.js`；校园模式前端直接用 `geoGcj02` 贴瓦片。
- 环境切换：`setEnvironment('home'|'campus')`；校园模式用 `L.CRS.EPSG3857` + 高德瓦片 + 武大 SHP 图层；回小屋用 `L.CRS.Simple` 1000×1000。
- POI：`loadCampusPois()` / `nearestCampusPoi()`；`/state` 的 `campusPoi` 给 `{name,kind,distance}`；校园模式下 `room` 换成最近 POI 名、`activity='campus'`。
- 跨空间认知：`_writeSpaceContext()` 把 `environment/room/status/poi/virtual/geo/geoGcj02` 写进 `cyber_house/current_space.json`；fish 的 `fish:space` 段每轮读它（见 `fish.identity`）。
- 校园 SHP 放在 `cyber_house/campus/shp/`，接口自动读取；`campus_whu.geojson` 是预设。
- 校园模式不把小屋的 room/activity 当移动目标；没有用户终点时先停在传送点（campusHold），避免被「客厅中心」拽回。

## 不负责

- `/state` 的 `geo/geoGcj02/campusBBox/campusPoi` 字段 → 见 `house.api.state`。
- 校园 SHP 导入/属性覆盖 → 见 `house.api-import-qgis` / `house.api-features`。
- 前端 Leaflet 编辑器/看板 → 见 house 前端文件（T4 未单列）。
- fish 的 `fish:space` 段渲染 → 见 `fish.identity`。

## 验收

```powershell
node cyber_house/.headless/campus-e2e.js
node cyber_house/.headless/cognition-e2e.js
```
重点断言：BBox、virtual↔WGS84/GCJ02 往返、POI 最近点、current_space 写入、campusHold、前端切图。
