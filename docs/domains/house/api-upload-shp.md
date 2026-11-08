owner: house.api-upload-shp
anchors: cyber_house/api-router.js#handleUploadShp; cyber_house/shp/upload-import.js
版本核对: dsh-fish-qq@2.0.0 / cyber_house@2026-11-08

# house.api-upload-shp

本文档是 `house.api-upload-shp` 的唯一事实来源：网页直传 SHP zip 的 multipart 契约、解析/坐标换算、`map_level` 与清空接口。

## 事实

- `POST /api/fish-home/upload-shp`，`multipart/form-data`：
  - 字段 `file`（固定，一次一个 zip）；可选 `map_level`（默认 `cyber_house`，例如 `village`）；
  - zip 上限 40MB；解压后总量上限 160MB；只处理 `.shp`/`.dbf`/`.shx`（建议连 `.prj`/`.cpg`），跳过 `__MACOSX`/隐藏文件；嵌套目录也认。
- 解析：`shpjs`（内存解压）→ 坐标换算：
  - 经纬度按校园 bbox 映射到 0–1000（与校园模式同一套）；
  - 已是 0–1000 的原样保留；其他投影按包围盒等比缩放；
  - `properties._source='uploaded_shp'`、`properties.type='shp_feature'`；名称按 `Name`/`名称`/`BUILDING_N` 等别名补，最后用 `<zip名> <序号>`；
  - id `upl-<zip名去扩展名>-<序号>`，同 zip 重传按 id 覆盖。
- 成功：`{ok:true,data:{ok:true,uploaded,source:'uploaded_shp',fileName,files:[{shp,features,encoding,hasDbf,hasPrj}],notes,transform,ids}}`。
- 错误：400 = 没文件 / 不是 zip（头不是 `PK`）/ 没有 `.shp` / 没有可用几何；413 = zip >40MB 或解压后过大/条目过多。
- `DELETE /api/fish-home/upload-shp`：清空全部网页直传 SHP，返回 `{ok:true,data:{ok:true,removed:N}}`；网页「清空上传」按钮用它。
- 上传要素不进 A* 障碍栅格；`type` 固定 `shp_feature`，PATCH 改成 `wall` 会被拒（见 `house.api-features`）。

## 不负责

- QGIS GeoJSON 导入 → 见 `house.api-import-qgis`。
- 表结构/`map_level` 列 → 见 `house.db-schema`。
- 校园 SHP 文件读取与坐标转换 → 见 `house.campus`。
- 前端上传按钮/拖拽 → 见 house 前端文件（T4 未单列）。

## 验收

```powershell
curl.exe -X POST http://127.0.0.1:8787/api/fish-home/upload-shp -F "file=@campus.zip" -F "map_level=village"
curl.exe -X DELETE http://127.0.0.1:8787/api/fish-home/upload-shp
```
重点断言：zip 头/大小/条目、map_level、坐标换算、`_source/type`、重传覆盖、400/413、清空计数。
