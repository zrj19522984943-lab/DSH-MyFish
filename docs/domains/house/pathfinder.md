owner: house.pathfinder
anchors: cyber_house/gis/pathfinder.js#planRoute
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.pathfinder

本文档是 `house.pathfinder` 的唯一事实来源：A* 栅格、障碍/门洞/房间处理、折线简化与寻路失败语义。贝塞尔平滑与时间契约归 `house.motion`。

## 事实

- 世界 1000×1000，栅格 `GRID_CELLS = 50`，`CELL_SIZE = 20`；`cellKeyOf`/`isPassablePoint` 由 `world.js` 提供。
- `buildWalkGrid(rooms, obstacles, doors)`：房间内部可通行；家具/墙栅格化为障碍；门洞是通行口；`wall` 线/面按 15 单位半径栅格化；`furniture` 点/线/面计入障碍；`room` 多边形内部变成可通行。
- `planRoute(furniture, rooms, roomsByName, fromX, fromY, toX, toY, options)`：
  - 起点/终点先 `nearestPassableCell()` 贴到最近可走格；
  - A* 8 邻域寻路，返回折线；`simplifyWaypoints()` 去掉共线点；
  - 直线可达时 `waypoints` 为 `null`（调用方直接用终点）；
  - 走不通返回 `null` / 空，不抛；`planSmoothRoute` 再把折线交给 `smoothPathWithFallback`。
- 障碍来源：`furniture.json` / `features` 表（`type` 为 wall/furniture）；`uploaded_shp` 要素**不进** A*。
- 目的地到达/活动换房间/自主游荡都走同一 `planRoute`；地图层级隔离时栅格只由当前 `map_level` 的墙/家具构成（见 `house.api.state`）。
- 拓扑检查（重叠/越界/堵门）是独立实现（`gis/topology.js`），不在本单元。

## 不负责

- 贝塞尔平滑/穿模回退/`pathStart`/`pathDuration` → 见 `house.motion`。
- 要素 CRUD 与 A* 刷新 → 见 `house.api-features`。
- 拓扑冲突 → 见 `house.api-features` / `gis/topology.js`（T4 未单列）。
- 前端渲染 → 见 house 前端文件（T4 未单列）。

## 验收

```powershell
node cyber_house/.headless/motion-test.js
```
重点断言：50×50 栅格、墙/家具障碍、门洞通行、起点/终点贴可走格、折线简化、直线返回 null、走不通不抛。
