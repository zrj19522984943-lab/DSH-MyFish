# 武大校园数据

后端 `GET /api/fish-home/campus-geojson` 优先读这个目录下的 `shp/*.shp`：

```
campus/
├─ shp/
│  ├─ campus_buildings.shp / .dbf / .shx / .prj / .cpg
│  ├─ campus_roads.shp     / ...
│  └─ campus_greens.shp    / ...
├─ campus_whu.geojson      # 没有 SHP 时的回退数据
├─ campus_pois.json        # 最近 POI 表（老图书馆 / 樱花大道 / 珞珈山…）
├─ build_campus_shp.py     # 生成示例 SHP 的脚本
└─ build_campus_pois.py    # 从 GeoJSON 重建 POI 表
```

## 放真实 SHP

把学校给的建筑轮廓 / 道路 SHP 直接放进 `shp/`，保持同名 `.dbf` / `.shx`，
有 `.prj` 就一起放（WGS84 或 CGCS2000 均可，`shpjs` 会按 prj 处理）。
不需要改代码；接口按文件 mtime 自动重新加载。

## 坐标口径

- SHP / GeoJSON 存 **WGS84**；
- 前端高德底图是 **GCJ02**，接口 `?coordSystem=gcj02` 会统一转换；
- 虚拟小屋坐标与 WGS84 的映射在 `cyber_house/gis/campus.js`。

## 重新生成示例

```powershell
python cyber_house/campus/build_campus_shp.py
```

示例包含老图书馆、樱顶、行政楼、教五、图书馆、万林、梅园食堂、
宿舍、珞珈山庄、信息学部教学楼，以及樱花大道、八一路、珞珈山路、学府路。
