owner: house.api-buffer
anchors: cyber_house/api-router.js#handleAnalyzeBuffer; cyber_house/gis/analyze.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.api-buffer

本文档是 `house.api-buffer` 的唯一事实来源：`POST /api/fish-home/analyze-buffer` 的请求、半径/坐标钳制、平面圆算法与命中结果。

## 事实

- 请求：`{"x":640,"y":500,"radius":200,"excludeKinds":[...]}`；`x/y` 钳回 0–1000；`radius` 钳到 5–500；`excludeKinds` 默认 `["fish","route"]`（小鱼自己和导航路线不算「周围的东西」）。
- 算法：Turf `circle` + `booleanIntersects`；因为 `turf.circle` 是球面三角，直接喂 0–1000 世界坐标会把 y 当纬度失真——后端在圆心局部小角度平面生成圆再把顶点平移回世界坐标，得到精确平面圆（`gis/analyze.js` 文件头）。
- 成功：`{center:[x,y],radius,steps:64,buffer:Feature(Polygon),hitCount,hits:[{name,type,room,distance}],truncated}`。
  - `buffer` 是正 64 边形 Polygon，前端 `L.geoJSON` 直接画圈；
  - `hits` 按圆心到要素代表点直线距离由近到远，最多 60 条；`distance` 四舍五入到 0.1；
  - 超过 60 条时 `truncated:true`。
- 与 `gis_buffer_query` 工具同源：网页「空间分析」面板和小鱼在 QQ 里问「周围有什么」走同一实现。
- 只读：不改盘面、不触发交互。

## 不负责

- `fish_check_topology` 的拓扑冲突 → 见 `house.api-features` / `house.pathfinder`。
- A* 寻路 → 见 `house.pathfinder`。
- 前端面板 → 见 house 前端文件（T4 未单列）。
- 空间数据库表 → 见 `house.db-schema`。

## 验收

```powershell
curl.exe -X POST http://127.0.0.1:8787/api/fish-home/analyze-buffer -H "content-type: application/json" -d "{\"x\":640,\"y\":500,\"radius\":200}"
```
重点断言：坐标/半径钳制、64 边形、距离排序、60 条截断、`excludeKinds` 默认、只读。
