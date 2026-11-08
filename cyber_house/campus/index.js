'use strict'

/**
 * campus/index.js —— 读取武大校园 SHP / GeoJSON
 *
 * 优先读 `campus/shp/*.shp`（可同时放建筑、道路、绿地多个 SHP），
 * 用 shpjs 解析成 GeoJSON；没有再读 `campus/campus_whu.geojson` 示例。
 *
 * SHP 约定是 WGS84（或带自己的 .prj 让 shpjs 投影）。前端高德瓦片是
 * GCJ02，所以接口支持 `?coordSystem=gcj02`，输出时统一做一次坐标转换。
 *
 * 动态属性表（外部要素无缝兼容）：每个要素拿到一个稳定的 id
 * （`shp-<文件名>-<序号>`，文件顺序稳定，id 就稳定，网页上改过的属性
 * 才能按 id 存回数据库）、properties._source = 'shp' 标识来源，
 * 并跑一层名称 / 类型兼容（BUILDING_N -> name，缺 type 给 shp_feature）。
 * 数据库里的覆盖修改（shp_edits 表）由 api-router 以 options.overrides
 * 传入，在缓存外合并，确保覆盖项永远跟着最新一次请求走。
 */

const fs = require('node:fs')
const path = require('node:path')

const { CAMPUS_BBOX } = require('../gis/campus')
const { transformGeoJSON, wgs84ToGcj02 } = require('../gis/campus')
const { applyCompatProperties } = require('../gis/features')

const CAMPUS_DIR = __dirname
const SHP_DIR = path.join(CAMPUS_DIR, 'shp')
const FALLBACK_GEOJSON = path.join(CAMPUS_DIR, 'campus_whu.geojson')

let cache = { signature: '', collection: null, source: '', files: [] }

function readMaybe(file) {
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

function signatureOf(shpFiles) {
  const parts = []
  for (const file of shpFiles) {
    try {
      parts.push(`${path.basename(file)}:${fs.statSync(file).mtimeMs}:${fs.statSync(file).size}`)
    } catch {
      parts.push(path.basename(file))
    }
  }
  try {
    const st = fs.statSync(FALLBACK_GEOJSON)
    parts.push(`fallback:${st.mtimeMs}:${st.size}`)
  } catch {
    parts.push('fallback:none')
  }
  return parts.join('|')
}

/**
 * 把一个外部要素整理成「属性表认得出来」的 Feature：
 * 稳定 id、_source 标记、name/type 兼容层；原始字段一个都不删。
 *
 * @param {object} feature SHP / GeoJSON 里解析出来的 Feature
 * @param {number} index 在所属文件里的序号（文件顺序稳定，id 就稳定）
 * @param {string} fileLabel 文件名去扩展名，如 campus_buildings —— 拼进 id
 * @param {string} sourceFile 原始文件名（campus_buildings.shp），留在属性里
 */
function shapeCampusFeature(feature, index, fileLabel, sourceFile) {
  const properties = applyCompatProperties(
    Object.assign({}, feature.properties || {}, { sourceFile }),
  )
  properties._source = 'shp'
  return {
    ...feature,
    id: `shp-${fileLabel}-${index}`,
    properties,
  }
}

async function loadFromShp(files) {
  const mod = await import('shpjs')
  const shp = mod.default || mod
  const features = []
  for (const file of files) {
    const base = file.slice(0, -4)
    const payload = {
      shp: readMaybe(file),
      dbf: readMaybe(`${base}.dbf`),
      prj: readMaybe(`${base}.prj`),
      cpg: readMaybe(`${base}.cpg`),
    }
    if (!payload.shp) continue
    const collection = await shp(payload)
    const list = collection && Array.isArray(collection.features) ? collection.features : []
    const fileBase = path.basename(file)
    const fileLabel = fileBase.slice(0, -4)
    list.forEach((feature, index) => {
      features.push(shapeCampusFeature(feature, index, fileLabel, fileBase))
    })
  }
  return {
    type: 'FeatureCollection',
    name: '武汉大学校园（SHP）',
    bbox: [CAMPUS_BBOX.minLng, CAMPUS_BBOX.minLat, CAMPUS_BBOX.maxLng, CAMPUS_BBOX.maxLat],
    features,
  }
}

function loadFallback() {
  const raw = JSON.parse(fs.readFileSync(FALLBACK_GEOJSON, 'utf8'))
  const features = Array.isArray(raw.features) ? raw.features : []
  return {
    type: 'FeatureCollection',
    name: raw.name || '武汉大学校园（示例 GeoJSON）',
    bbox: raw.bbox || [CAMPUS_BBOX.minLng, CAMPUS_BBOX.minLat, CAMPUS_BBOX.maxLng, CAMPUS_BBOX.maxLat],
    // 示例 GeoJSON 走同一套「稳定 id + _source + 兼容层」，和 SHP 没有差别。
    features: features.map((feature, index) => shapeCampusFeature(feature, index, 'campus_whu', 'campus_whu.geojson')),
  }
}

/**
 * 把数据库里的覆盖修改按 id 合并进校园要素。
 * 在缓存外执行，覆盖项永远跟着最新一次请求走。
 *
 * @param {object} collection FeatureCollection
 * @param {Record<string, object>} overrides id -> 覆盖属性
 */
function applyShpOverrides(collection, overrides) {
  if (!overrides || typeof overrides !== 'object' || !Array.isArray(collection.features)) return collection
  const hasAny = Object.keys(overrides).length > 0
  if (!hasAny) return collection
  return {
    ...collection,
    features: collection.features.map((feature) => {
      const override = overrides[String(feature && feature.id)]
      if (!override || typeof override !== 'object') return feature
      return { ...feature, properties: Object.assign({}, feature.properties, override) }
    }),
  }
}

/**
 * 读校园数据。结果按文件 mtime 缓存；SHP 解析失败会退回示例 GeoJSON。
 *
 * @param {{coordinateSystem?: 'wgs84'|'gcj02', overrides?: Record<string, object>}} [options]
 */
async function loadCampusGeoJSON(options = {}) {
  let files = []
  try {
    files = fs.readdirSync(SHP_DIR)
      .filter((name) => name.toLowerCase().endsWith('.shp'))
      .map((name) => path.join(SHP_DIR, name))
      .sort()
  } catch {
    files = []
  }

  const signature = signatureOf(files)
  if (cache.signature !== signature || !cache.collection) {
    let collection = null
    let source = 'geojson'
    if (files.length > 0) {
      try {
        collection = await loadFromShp(files)
        source = 'shp'
      } catch (error) {
        console.warn(`[cyber-house] 校园 SHP 解析失败，退回 GeoJSON：${error?.message || error}`)
        collection = null
      }
    }
    if (!collection) {
      try {
        collection = loadFallback()
      } catch (error) {
        collection = {
          type: 'FeatureCollection',
          name: '武汉大学校园',
          bbox: [CAMPUS_BBOX.minLng, CAMPUS_BBOX.minLat, CAMPUS_BBOX.maxLng, CAMPUS_BBOX.maxLat],
          features: [],
        }
        console.warn(`[cyber-house] 校园 GeoJSON 也读不到：${error?.message || error}`)
      }
    }
    cache = { signature, collection, source, files: files.map((file) => path.basename(file)) }
    console.log(`[cyber-house] 校园数据已加载：${source}，${collection.features.length} 个要素`)
  }

  const coordinateSystem = options.coordinateSystem === 'gcj02' ? 'gcj02' : 'wgs84'
  let collection = cache.collection
  if (coordinateSystem === 'gcj02') {
    collection = transformGeoJSON(collection, (lng, lat) => wgs84ToGcj02(lng, lat))
  }
  collection = applyShpOverrides(collection, options.overrides)
  return {
    ...collection,
    metadata: {
      source: cache.source,
      files: cache.files,
      coordinateSystem,
      bbox: { ...CAMPUS_BBOX },
    },
  }
}

module.exports = {
  CAMPUS_DIR,
  SHP_DIR,
  FALLBACK_GEOJSON,
  loadCampusGeoJSON,
  applyShpOverrides,
  shapeCampusFeature,
}
