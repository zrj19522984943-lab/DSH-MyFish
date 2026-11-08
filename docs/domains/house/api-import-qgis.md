owner: house.api-import-qgis
anchors: cyber_house/api-router.js#handleImportQgis; cyber_house/db/map-level.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.api-import-qgis

本文档是 `house.api-import-qgis` 的唯一事实来源：QGIS 导出的 GeoJSON 直导入 `POST /api/fish-home/import-qgis` 的契约与多层级规则。

## 事实

- 请求：单个 Feature 或 FeatureCollection（不必包 Collection）；`map_level` 可在顶层或每个 `properties` 里；请求体上限 16MB，一次最多 500 个输入要素（拆分后上限 2000）。
- `properties` 是对象即可，外部字段（`OBJECTID` / `BUILDING_N` / `HEIGHT` …）原样透传；`props_json` / `properties_json` / `props` 的 JSON 字符串会先展开。
- 层级：优先 `properties.map_level`，其次顶层 `map_level`，最后 `cyber_house`；层级名只认小写字母/数字/`_`/`-`（1–40 字），不合法**报错跳过该要素**，不静默塞进小屋。
- 类型：`wall` / `furniture` / `room` / `door` / `custom` 原样保留（wall/furniture 计入 A*）；其他类型一律按 `shp_feature` 只展示，不变成障碍。
- 名称：`Name` / `名称` / `BUILDING_N` 等别名；没有就用 `QGIS要素-序号`。
- 几何：Point/LineString/Polygon 直接收；Multi*/GeometryCollection 拆成单部分，每部分一条要素、id 加序号；坐标 0–1000，非法点报错。
- id：有 `id` 用（≤52 字），否则 `qgis-<层级>-<序号>`；同 id 重新导入按覆盖。
- 单条失败只跳过该条并收进 `errors`，整批不废。
- 成功：`{imported,totalInputs,levelCounts,mapLevels,ids,errors}`；400 = 请求体不是对象/features 为空/全部失败/顶层层级非法；409 = id 被家具/门洞占用。
- 导入后作废 A* 栅格与进行中路径，下一轮 `/state?map_level=` 生效。

## 不负责

- 网页直传 SHP → 见 `house.api-upload-shp`。
- 表结构/`map_level` 列 → 见 `house.db-schema`。
- A* 栅格化 → 见 `house.pathfinder`。
- 前端导入按钮 → 见 house 前端文件（T4 未单列）。

## 验收

```powershell
curl.exe -X POST http://127.0.0.1:8787/api/fish-home/import-qgis -H "content-type: application/json" --data-binary "@village.geojson"
```
重点断言：层级提取/校验、Multi 拆分、类型降级、id 覆盖、levelCounts、400/409、A* 作废。
