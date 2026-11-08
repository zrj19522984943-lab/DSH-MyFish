#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从 campus_whu.geojson 生成 campus_pois.json（最近的校园 POI 表）。"""

import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(ROOT, "campus_whu.geojson")
TARGET = os.path.join(ROOT, "campus_pois.json")


def center(geometry):
    coords = geometry["coordinates"]
    points = coords[0] if geometry["type"] == "Polygon" else coords
    if points and points[0] == points[-1]:
        points = points[:-1]
    lng = sum(point[0] for point in points) / len(points)
    lat = sum(point[1] for point in points) / len(points)
    return round(lng, 6), round(lat, 6)


def main():
    with open(SOURCE, encoding="utf-8") as handle:
        collection = json.load(handle)
    pois = []
    for feature in collection["features"]:
        props = feature["properties"]
        lng, lat = center(feature["geometry"])
        pois.append({
            "name": props["name"],
            "kind": props.get("kind", "poi"),
            "lng": lng,
            "lat": lat,
        })
    payload = {
        "version": 1,
        "source": os.path.basename(SOURCE),
        "pois": pois,
    }
    with open(TARGET, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"wrote {TARGET}: {len(pois)} POIs")


if __name__ == "__main__":
    main()
