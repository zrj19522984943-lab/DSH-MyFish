'use strict'

/**
 * gis/campus-poi.js —— 校园 POI（最近地点）与校园状态文案
 *
 * 任务书「跨空间认知同步」：小鱼在 campus 时，room 不能再是“客厅”，
 * 要返回她附近真实地点（老图书馆 / 樱花大道 / 珞珈山 …）。
 *
 * POI 表由 campus/build_campus_pois.py 从 campus_whu.geojson 生成；
 * 换成真实 SHP 后可以手改 campus_pois.json，或按同样格式补几条。
 */

const fs = require('node:fs')
const path = require('node:path')
const { geoToVirtual } = require('./campus')

const POI_FILE = path.join(__dirname, '..', 'campus', 'campus_pois.json')

const FALLBACK_POIS = Object.freeze([
  { name: '老图书馆', kind: 'building', lng: 114.3612, lat: 30.5376 },
  { name: '樱花大道', kind: 'road', lng: 114.363, lat: 30.537 },
  { name: '珞珈山', kind: 'green', lng: 114.366, lat: 30.538 },
])

let cache = { file: '', mtimeMs: -1, pois: [] }

function withVirtual(poi) {
  const virtual = geoToVirtual(poi.lng, poi.lat)
  return { ...poi, x: virtual.x, y: virtual.y }
}

/** 读 POI 表（按 mtime 缓存）；文件坏掉时用 3 个兜底点。 */
function loadCampusPois(file = POI_FILE) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return FALLBACK_POIS.map(withVirtual)
  }
  if (cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.pois

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(raw?.pois) ? raw.pois : []
    const pois = list
      .filter((poi) => poi && Number.isFinite(Number(poi.lng)) && Number.isFinite(Number(poi.lat)))
      .map((poi) => withVirtual({
        name: String(poi.name || '校园地点').slice(0, 40),
        kind: String(poi.kind || 'poi').slice(0, 20),
        lng: Number(poi.lng),
        lat: Number(poi.lat),
      }))
    cache = {
      file,
      mtimeMs: stat.mtimeMs,
      pois: pois.length > 0 ? pois : FALLBACK_POIS.map(withVirtual),
    }
    return cache.pois
  } catch {
    return FALLBACK_POIS.map(withVirtual)
  }
}

/** 离 (x,y) 最近的校园 POI；没有 POI 时返回 null。 */
function nearestCampusPoi(x, y, pois = null) {
  const list = Array.isArray(pois) ? pois : loadCampusPois()
  let best = null
  for (const poi of list) {
    const distance = Math.hypot(Number(x) - poi.x, Number(y) - poi.y)
    if (!best || distance < best.distance) best = { ...poi, distance }
  }
  return best
}

/** 校园状态文案：按 POI 类型给一句人话。 */
function campusStatusFor(poi) {
  if (!poi) return '在武大校园散步'
  const name = String(poi.name || '')
  if (name === '樱花大道') return '在樱花大道赏樱'
  if (name === '樱花广场') return '在樱花广场散步'
  if (/樱花/.test(name)) return `在${name}散步`
  if (/珞珈山/.test(name)) return '正在珞珈山探索'
  if (poi.kind === 'road') return `在武大校园散步（沿着${name}）`
  if (poi.kind === 'green') return `在武大校园散步（${name}里）`
  if (poi.kind === 'building') return `在武大校园散步（${name}附近）`
  return '在武大校园散步'
}

/** 校园位置的一句话（给 prompt / 前端兜底）。 */
function campusPlaceText(poi) {
  if (!poi) return '武汉大学校园'
  return `${poi.name}附近`
}

module.exports = {
  POI_FILE,
  loadCampusPois,
  nearestCampusPoi,
  campusStatusFor,
  campusPlaceText,
}
