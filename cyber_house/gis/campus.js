'use strict'

/**
 * gis/campus.js —— 虚拟小屋坐标 <-> 武汉大学真实经纬度（任务书 3）
 *
 * 小屋是 1000×1000 的平面世界（y 向下）；校园是 WGS84 经纬度（y 向上）。
 * 两边用同一个 BBox 做线性映射：
 *
 *   minLng / minLat  -> 左下（虚拟 x=0, y=1000）
 *   maxLng / maxLat  -> 右上（虚拟 x=1000, y=0）
 *
 * 高德瓦片是 GCJ02 火星坐标，SHP 通常是 WGS84；所以另外提供
 * wgs84ToGcj02 / gcj02ToWgs84，前端用 GCJ02 叠加瓦片，后端存 WGS84。
 *
 * 纯算法，不读盘、不碰 this。
 */

const WORLD_SIZE = 1000

const CAMPUS_BBOX = Object.freeze({
  minLng: 114.355,
  minLat: 30.525,
  maxLng: 114.372,
  maxLat: 30.545,
})

const CAMPUS_CENTER = Object.freeze({
  lng: (CAMPUS_BBOX.minLng + CAMPUS_BBOX.maxLng) / 2,
  lat: (CAMPUS_BBOX.minLat + CAMPUS_BBOX.maxLat) / 2,
})

function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function round6(value) {
  return Math.round(Number(value) * 1e6) / 1e6
}

/** 虚拟坐标 -> WGS84。y 向下，所以 lat 从 maxLat 往 minLat 走。 */
function virtualToGeo(x, y) {
  const fx = clamp01(Number(x) / WORLD_SIZE)
  const fy = clamp01(Number(y) / WORLD_SIZE)
  return {
    lng: round6(CAMPUS_BBOX.minLng + fx * (CAMPUS_BBOX.maxLng - CAMPUS_BBOX.minLng)),
    lat: round6(CAMPUS_BBOX.maxLat - fy * (CAMPUS_BBOX.maxLat - CAMPUS_BBOX.minLat)),
  }
}

/** WGS84 -> 虚拟坐标（不 clamp 之前先算比例，最后钳进 0–1000）。 */
function geoToVirtual(lng, lat) {
  const fx = (Number(lng) - CAMPUS_BBOX.minLng) / (CAMPUS_BBOX.maxLng - CAMPUS_BBOX.minLng)
  const fy = (CAMPUS_BBOX.maxLat - Number(lat)) / (CAMPUS_BBOX.maxLat - CAMPUS_BBOX.minLat)
  return {
    x: Math.round(Math.min(WORLD_SIZE, Math.max(0, fx * WORLD_SIZE)) * 10) / 10,
    y: Math.round(Math.min(WORLD_SIZE, Math.max(0, fy * WORLD_SIZE)) * 10) / 10,
  }
}

/* ---------------------------------------------------------------------------
 * WGS84 <-> GCJ02（国测局火星坐标）
 * ------------------------------------------------------------------------- */

const PI = Math.PI
const A = 6378245.0
const EE = 0.00669342162296594323

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(lng, lat) {
  let ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng))
  ret += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0
  ret += (20.0 * Math.sin(lat * PI) + 40.0 * Math.sin(lat / 3.0 * PI)) * 2.0 / 3.0
  ret += (160.0 * Math.sin(lat / 12.0 * PI) + 320 * Math.sin(lat * PI / 30.0)) * 2.0 / 3.0
  return ret
}

function transformLng(lng, lat) {
  let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng))
  ret += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0
  ret += (20.0 * Math.sin(lng * PI) + 40.0 * Math.sin(lng / 3.0 * PI)) * 2.0 / 3.0
  ret += (150.0 * Math.sin(lng / 12.0 * PI) + 300.0 * Math.sin(lng / 30.0 * PI)) * 2.0 / 3.0
  return ret
}

/** WGS84 -> GCJ02；国外坐标原样返回。 */
function wgs84ToGcj02(lng, lat) {
  const x = Number(lng)
  const y = Number(lat)
  if (!Number.isFinite(x) || !Number.isFinite(y) || outOfChina(x, y)) return { lng: x, lat: y }
  let dLat = transformLat(x - 105.0, y - 35.0)
  let dLng = transformLng(x - 105.0, y - 35.0)
  const radLat = y / 180.0 * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI)
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI)
  return { lng: round6(x + dLng), lat: round6(y + dLat) }
}

/** GCJ02 -> WGS84（迭代反算，2 次已经到厘米级）。 */
function gcj02ToWgs84(lng, lat) {
  const x = Number(lng)
  const y = Number(lat)
  if (!Number.isFinite(x) || !Number.isFinite(y) || outOfChina(x, y)) return { lng: x, lat: y }
  let wgsLng = x
  let wgsLat = y
  for (let i = 0; i < 2; i += 1) {
    const gcj = wgs84ToGcj02(wgsLng, wgsLat)
    wgsLng -= gcj.lng - x
    wgsLat -= gcj.lat - y
  }
  return { lng: round6(wgsLng), lat: round6(wgsLat) }
}

/** 虚拟坐标 -> 前端高德地图用的 GCJ02。 */
function virtualToGcj02(x, y) {
  const geo = virtualToGeo(x, y)
  return wgs84ToGcj02(geo.lng, geo.lat)
}

/** 前端高德地图的 GCJ02 -> 虚拟坐标。 */
function gcj02ToVirtual(lng, lat) {
  const geo = gcj02ToWgs84(lng, lat)
  return geoToVirtual(geo.lng, geo.lat)
}

/** 递归转换 GeoJSON 几何坐标（WGS84 -> GCJ02 / 反向）。 */
function transformGeometry(geometry, transform) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return geometry
  const walk = (node) => {
    if (!Array.isArray(node)) return node
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      const next = transform(node[0], node[1])
      return [next.lng, next.lat]
    }
    return node.map(walk)
  }
  return { ...geometry, coordinates: walk(geometry.coordinates) }
}

function transformGeoJSON(collection, transform) {
  if (!collection || !Array.isArray(collection.features)) return collection
  return {
    ...collection,
    features: collection.features.map((feature) => ({
      ...feature,
      geometry: transformGeometry(feature.geometry, transform),
    })),
  }
}

module.exports = {
  WORLD_SIZE,
  CAMPUS_BBOX,
  CAMPUS_CENTER,
  virtualToGeo,
  geoToVirtual,
  wgs84ToGcj02,
  gcj02ToWgs84,
  virtualToGcj02,
  gcj02ToVirtual,
  transformGeometry,
  transformGeoJSON,
}
