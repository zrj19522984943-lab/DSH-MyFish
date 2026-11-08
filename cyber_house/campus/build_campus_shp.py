#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_campus_shp.py —— 生成一份可被 shpjs 读取的武大示例 Shapefile。

真实部署时把学校给的 .shp/.dbf/.shx/.prj（可以带 .cpg）直接放进
cyber_house/campus/shp/ 即可，后端会优先读它们；本脚本只是给没有现成
SHP 的开发机一份可运行的示例（老图书馆 / 樱顶 / 樱花大道一带）。

示例刻意带上了学校给的 SHP 常见的「不认识」字段（OBJECTID / BUILDING_N /
HEIGHT / FLOORS / ROAD_N / AREA_M2）：它们不属于内部家具模型，动态属性表
照单全收地透传到网页面板里。另有一条建筑（樱顶学生宿舍）故意只给
BUILDING_N 不给 name，用来验证运行时的名称兼容层。

运行：python cyber_house/campus/build_campus_shp.py
"""

import json
import math
import os
import shapefile

ROOT = os.path.dirname(os.path.abspath(__file__))
SHP_DIR = os.path.join(ROOT, "shp")
os.makedirs(SHP_DIR, exist_ok=True)

WGS84_PRJ = (
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
    'SPHEROID["WGS_1984",6378137.0,298.257223563]],'
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
)


def rect(lng, lat, width_m, height_m):
    """以 (lng,lat) 为中心、按米给的矩形，返回 GeoJSON 环。"""
    dlat = height_m / 111000.0
    dlng = width_m / (111000.0 * math.cos(math.radians(lat)))
    x0, x1 = lng - dlng / 2, lng + dlng / 2
    y0, y1 = lat - dlat / 2, lat + dlat / 2
    ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    return ring


# name 留空的这条（樱顶学生宿舍）只给 BUILDING_N，留给后端兼容层补 name。
BUILDINGS = [
    dict(name="老图书馆", lng=114.3612, lat=30.5376, w=90, h=60, floors=3, height=15.5, building_n="老图书馆"),
    dict(name="", lng=114.3625, lat=30.5370, w=72, h=46, floors=4, height=18.0, building_n="樱顶学生宿舍"),
    dict(name="行政楼", lng=114.3598, lat=30.5359, w=82, h=52, floors=6, height=24.0, building_n="行政楼"),
    dict(name="教五楼", lng=114.3584, lat=30.5342, w=68, h=46, floors=5, height=21.5, building_n="教五楼"),
    dict(name="图书馆", lng=114.3638, lat=30.5352, w=86, h=56, floors=7, height=29.0, building_n="图书馆"),
    dict(name="万林艺术博物馆", lng=114.3608, lat=30.5345, w=62, h=46, floors=4, height=20.0, building_n="万林艺术博物馆"),
    dict(name="梅园食堂", lng=114.3652, lat=30.5334, w=72, h=50, floors=3, height=14.0, building_n="梅园食堂"),
    dict(name="学生宿舍", lng=114.3660, lat=30.5362, w=56, h=72, floors=6, height=22.5, building_n="学生宿舍"),
    dict(name="珞珈山庄", lng=114.3628, lat=30.5400, w=62, h=42, floors=2, height=11.0, building_n="珞珈山庄"),
    dict(name="信息学部教学楼", lng=114.3672, lat=30.5320, w=82, h=52, floors=5, height=23.0, building_n="信息学部教学楼"),
]

ROADS = [
    ("樱花大道", [[114.3578, 30.5402], [114.3610, 30.5388], [114.3645, 30.5368], [114.3680, 30.5348]]),
    ("八一路", [[114.3540, 30.5295], [114.3600, 30.5298], [114.3660, 30.5302], [114.3725, 30.5305]]),
    ("珞珈山路", [[114.3560, 30.5350], [114.3590, 30.5330], [114.3630, 30.5310], [114.3670, 30.5298]]),
    ("学府路", [[114.3650, 30.5405], [114.3660, 30.5370], [114.3672, 30.5330], [114.3680, 30.5305]]),
]

GREENS = [
    ("珞珈山", [[114.3620, 30.5415], [114.3680, 30.5410], [114.3700, 30.5370],
                [114.3675, 30.5340], [114.3630, 30.5350], [114.3605, 30.5385],
                [114.3620, 30.5415]]),
    ("樱花广场", [[114.3605, 30.5380], [114.3625, 30.5380], [114.3625, 30.5392],
                 [114.3605, 30.5392], [114.3605, 30.5380]]),
]


def building_props(index, rec):
    """一条建筑的 DBF 字段： OBJECTID / BUILDING_N / HEIGHT / FLOORS。"""
    return {
        "name": rec["name"],
        "kind": "building",
        "OBJECTID": index + 1,
        "BUILDING_N": rec["building_n"],
        "HEIGHT": float(rec["height"]),
        "FLOORS": int(rec["floors"]),
    }


def write_shape(name, shape_type, records, geometry_key, fields):
    """records 的每个元素已经是最终 DBF 属性（含 OBJECTID），fields 声明字段。"""
    base = os.path.join(SHP_DIR, name)
    writer = shapefile.Writer(base, shapeType=shape_type, encoding="utf-8")
    for field_name, field_type, size, decimal in fields:
        writer.field(field_name, field_type, size, decimal)
    for rec in records:
        writer.record(*[rec.get(field_name) for field_name, *_ in fields])
        if geometry_key == "polygon":
            writer.poly([rec["coordinates"]])
        else:
            writer.line([rec["coordinates"]])
    writer.close()
    with open(base + ".prj", "w", encoding="utf-8") as f:
        f.write(WGS84_PRJ)
    with open(base + ".cpg", "w", encoding="utf-8") as f:
        f.write("UTF-8")
    print("wrote", base + ".shp")


def ring_area_m2(ring):
    """经纬度环按米估算面积（演示值，不是测绘精度）。"""
    total = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        total += x1 * y2 - x2 * y1
    deg = abs(total) / 2.0
    return deg * 111000.0 * 111000.0 * math.cos(math.radians(30.53))


def main():
    features = []
    for index, rec in enumerate(BUILDINGS):
        features.append({
            "type": "Feature",
            "properties": building_props(index, rec),
            "geometry": {"type": "Polygon", "coordinates": [rect(rec["lng"], rec["lat"], rec["w"], rec["h"])]},
        })
    for index, (name, coords) in enumerate(ROADS):
        features.append({
            "type": "Feature",
            "properties": {
                "name": name,
                "kind": "road",
                "OBJECTID": index + 1,
                "ROAD_N": name,
            },
            "geometry": {"type": "LineString", "coordinates": coords},
        })
    for index, (name, coords) in enumerate(GREENS):
        features.append({
            "type": "Feature",
            "properties": {
                "name": name,
                "kind": "green",
                "OBJECTID": index + 1,
                "AREA_M2": round(ring_area_m2(coords), 1),
            },
            "geometry": {"type": "Polygon", "coordinates": [coords]},
        })

    collection = {
        "type": "FeatureCollection",
        "name": "武汉大学示例校园",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": features,
    }
    with open(os.path.join(ROOT, "campus_whu.geojson"), "w", encoding="utf-8") as f:
        json.dump(collection, f, ensure_ascii=False, indent=2)
        f.write("\n")

    buildings = [dict(f["properties"], coordinates=f["geometry"]["coordinates"][0])
                 for f in features if f["properties"]["kind"] == "building"]
    roads = [dict(f["properties"], coordinates=f["geometry"]["coordinates"])
             for f in features if f["properties"]["kind"] == "road"]
    greens = [dict(f["properties"], coordinates=f["geometry"]["coordinates"][0])
              for f in features if f["properties"]["kind"] == "green"]

    write_shape("campus_buildings", shapefile.POLYGON, buildings, "polygon", [
        ("name", "C", 60, 0), ("kind", "C", 20, 0), ("OBJECTID", "N", 8, 0),
        ("BUILDING_N", "C", 40, 0), ("HEIGHT", "N", 12, 1), ("FLOORS", "N", 6, 0),
    ])
    write_shape("campus_roads", shapefile.POLYLINE, roads, "line", [
        ("name", "C", 60, 0), ("kind", "C", 20, 0), ("OBJECTID", "N", 8, 0), ("ROAD_N", "C", 40, 0),
    ])
    write_shape("campus_greens", shapefile.POLYGON, greens, "polygon", [
        ("name", "C", 60, 0), ("kind", "C", 20, 0), ("OBJECTID", "N", 8, 0), ("AREA_M2", "N", 12, 1),
    ])
    print("wrote", os.path.join(ROOT, "campus_whu.geojson"))


if __name__ == "__main__":
    main()
