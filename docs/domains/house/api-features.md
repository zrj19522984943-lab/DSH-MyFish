owner: house.api-features
anchors: cyber_house/api-router.js#handleFeatures; cyber_house/gis/features.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.api-features

本文档是 `house.api-features` 的唯一事实来源：网页要素的 GET/POST/DELETE/PATCH 契约、校验规则、动态属性与 A* 栅格刷新。要素的存储表归 `house.db-schema`。

## 事实

- 接口：
  - `GET /api/fish-home/features`：返回 `{ok:true, data: FeatureCollection}`（含家具/自建/上传？GET 返回全部 `features` 行的集合，`source` 标记来源）；
  - `POST /api/fish-home/features`：接收一个 Feature 或 FeatureCollection（`features` 最多 100 个），写 `source='custom'`；
  - `DELETE /api/fish-home/features/:id`：按 id 删除，A* 栅格下一轮重建；
  - `PATCH /api/fish-home/features/:id/properties`：动态属性覆盖。
- POST 校验：
  - `type` 必须是 `Feature`；`geometry.type` 只接受 Point/LineString/Polygon；
  - 坐标对必须是有限数字，钳回 0–1000；LineString ≥2 点、Polygon 每环 ≥3 点；
  - `properties.type` 必填，`furniture` / `wall` / `room` 三选一；`name` ≤40 字、`icon` ≤8、`color` `#rrggbb`、`interact_text` ≤200 字；
  - 失败 400；引擎不支持保存 501。
- A* 同步：wall 线/面按 15 单元半径栅格化为障碍；furniture 点/线/面也计入；room 多边形内部变成可通行；下一轮 `/state` 重建，进行中的平滑路径作废重算。
- PATCH：
  - 只改 `properties`，键/值走 `sanitizePatchValue`：键 ≤64 字、不以 `_` 开头，值 ≤2000 字 / 数字 / 布尔 / null / 深度 ≤3；
  - 不允许改 `type` 成 `shp_feature` 之类非法值；`uploaded_shp` 要素改 `wall` 会被拒；
  - 未知外部 SHP 属性原样保留。
- `featureRows`（见 `house.api.state`）是动态属性表的同步数据源；`_source` 区分 `custom` / `furniture` / `uploaded_shp`。

## 不负责

- `/state` 的 `featureRows` 字段 → 见 `house.api.state`。
- 表结构/索引/迁移 → 见 `house.db-schema`。
- SHP/QGIS 导入 → 见 `house.api-upload-shp` / `house.api-import-qgis`。
- 前端编辑器 → 见 `merge.client-bundle` / house 前端文件（T4 未单列）。

## 验收

```powershell
# 服务在跑
curl.exe -X POST http://127.0.0.1:8787/api/fish-home/features -H "content-type: application/json" --data-binary "@feature.json"
curl.exe http://127.0.0.1:8787/api/fish-home/features
```
重点断言：FeatureCollection ≤100、几何/坐标/属性校验、400/501、A* 重建、PATCH 键值上限与 `_source`。
