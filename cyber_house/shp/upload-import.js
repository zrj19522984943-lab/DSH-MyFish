'use strict'
/**
 * upload-import.js —— 网页直传 SHP（ZIP 包）的解析与入库准备。
 *
 * 流程：zip 缓冲 -> AdmZip 解压（只认 .shp/.dbf/.shx/.prj/.cpg）-> shpjs 解析
 * -> 坐标换算到小屋世界（0–1000）-> 属性兜底（applyCompatProperties）
 * -> 交给 db.upsertFeatures(..., { source: 'uploaded_shp' })。
 *
 * 几个刻意的取舍：
 *   - **不落临时文件**：全部在内存里做完，失败不留垃圾，也不必担心并发同名。
 *   - **DBF 编码兜底**：先按 .cpg / 默认编码解析；抛错再试 gbk；再不行只读几何
 *     （属性为空也比整个上传失败强）。
 *   - **坐标**：经纬度走校园 bbox 映射（geoToVirtual，和校园模式同一套换算）；
 *     已经是 0–1000 的本地坐标原样保留；其余（投影坐标等）按包围盒等比归一化，
 *     保证图形一定落在可见范围里。
 *   - **类型固定 shp_feature**：A* 栅格只把 wall/furniture/room 当障碍，
 *     外部建筑不能因为 DBF 里恰好有个 type 列就参与寻路。
 */

const AdmZip = require('adm-zip')
const path = require('node:path')
const { applyCompatProperties, isAllowedExtraKey, allowedExtraValue } = require('../gis/features')
const { geoToVirtual } = require('../gis/campus')

const MAX_ENTRIES = 600
const MAX_ENTRY_BYTES = 80 * 1024 * 1024
const MAX_TOTAL_UNZIPPED = 160 * 1024 * 1024
const MAX_FEATURES = 5000
const MAX_PROP_KEYS = 60
const WORLD_SIZE = 1000
const WORLD_PAD = 20
const UPLOAD_SOURCE = 'uploaded_shp'

/** 带 HTTP 状态码的错误，路由层直接回给前端。 */
function uploadError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function slugify(text, fallback) {
  const cleaned = String(text || '')
    .replace(/\.zip$/i, '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
  return cleaned || fallback
}

/** 判断一个 zip 条目是不是我们要的 shapefile 组成部分。 */
function entryKind(name) {
  const lower = String(name || '').toLowerCase()
  if (lower.endsWith('.shp')) return 'shp'
  if (lower.endsWith('.dbf')) return 'dbf'
  if (lower.endsWith('.shx')) return 'shx'
  if (lower.endsWith('.prj')) return 'prj'
  if (lower.endsWith('.cpg')) return 'cpg'
  return null
}

/**
 * 读 zip 里的 shapefile 组。
 * @param {Buffer} buffer zip 二进制
 * @returns {Array<{base:string, folder:string, shp:Buffer, dbf?:Buffer, prj?:Buffer, cpg?:Buffer}>}
 */
function readShapefileSets(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw uploadError(400, '上传的文件是空的')
  // ZIP 本地文件头 "PK\x03\x04"（空包是 "PK\x05\x06"）。
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw uploadError(400, '这不是 zip 包（文件头不是 PK）——请把 .shp/.dbf/.shx 打成一个 .zip')
  }

  let zip
  try {
    zip = new AdmZip(buffer)
  } catch (error) {
    throw uploadError(400, 'zip 解压失败：' + ((error && error.message) || error))
  }

  const entries = zip.getEntries().filter((entry) => !entry.isDirectory)
  if (entries.length > MAX_ENTRIES) throw uploadError(413, `zip 里条目太多了（最多 ${MAX_ENTRIES} 个）`)

  let totalBytes = 0
  const files = new Map() // 'folder/base.ext'（小写）-> { name, buffer }
  for (const entry of entries) {
    const entryName = entry.entryName
    if (!entryName || entryName.includes('__MACOSX')) continue
    if (path.basename(entryName).startsWith('.')) continue
    const kind = entryKind(entryName)
    if (!kind) continue // 只认 shapefile 的组成部分，其余（.txt/.xml/…）直接忽略
    const declared = Number(entry.header && entry.header.size) || 0
    if (declared > MAX_ENTRY_BYTES) {
      throw uploadError(413, `「${path.basename(entryName)}」解压后太大（${Math.round(declared / 1024 / 1024)}MB）`)
    }
    let data
    try {
      data = entry.getData()
    } catch (error) {
      throw uploadError(400, `解压「${path.basename(entryName)}」失败：` + ((error && error.message) || error))
    }
    totalBytes += data.length
    if (totalBytes > MAX_TOTAL_UNZIPPED) throw uploadError(413, 'zip 解压后体积过大')
    const dir = path.posix.dirname(entryName) === '.' ? '' : path.posix.dirname(entryName)
    const base = path.posix.basename(entryName).replace(/\.[^.]+$/, '')
    files.set(`${dir}/${base}.${kind}`, { name: entryName, buffer: data })
  }

  const sets = []
  for (const [key, value] of files) {
    if (!key.endsWith('.shp')) continue
    const prefix = key.slice(0, -4)
    const dbf = files.get(prefix + '.dbf')
    const prj = files.get(prefix + '.prj')
    const cpg = files.get(prefix + '.cpg')
    sets.push({
      base: path.posix.basename(prefix),
      folder: path.posix.dirname(prefix) === '.' ? '' : path.posix.dirname(prefix),
      shp: value.buffer,
      dbf: dbf && dbf.buffer,
      prj: prj && prj.buffer,
      cpg: cpg && cpg.buffer,
      shpName: value.name,
      missing: {
        dbf: !dbf,
        prj: !prj,
      },
    })
  }

  if (sets.length === 0) {
    throw uploadError(400, 'zip 里没有 .shp 文件——至少要有一个 .shp（建议连 .dbf / .shx 一起打包）')
  }
  return sets
}

/** 解析一组 shapefile；DBF 编码出问题时依次退到 gbk、最后只读几何。 */
async function parseSet(set) {
  const mod = await import('shpjs')
  const shp = mod.default || mod
  const parseShp = mod.parseShp
  const parseDbf = mod.parseDbf
  const combine = mod.combine

  const failNotes = []

  // ① 常规路径：shpjs 自己按 .cpg / .prj 处理编码与投影。
  try {
    const collection = await shp({ shp: set.shp, dbf: set.dbf, prj: set.prj, cpg: set.cpg })
    const list = collection && Array.isArray(collection.features) ? collection.features : []
    if (list.length > 0) return { features: list, encoding: set.cpg ? 'cpg' : 'auto', notes: failNotes }
  } catch (error) {
    failNotes.push('自动解析失败：' + ((error && error.message) || error))
  }

  // ② 指定 gbk（国内 SHP 最常见的坑：DBF 是 GBK 但没带 .cpg）。
  if (set.dbf && parseShp && parseDbf && combine) {
    try {
      const geometries = parseShp(set.shp, set.prj)
      let properties = null
      for (const encoding of ['gbk', 'gb2312', 'utf-8']) {
        try {
          properties = parseDbf(set.dbf, encoding)
          failNotes.push('DBF 按 ' + encoding + ' 解析成功')
          return { features: combine([geometries, properties]).features, encoding, notes: failNotes }
        } catch (error) {
          failNotes.push('DBF 按 ' + encoding + ' 解析失败')
        }
      }
      // 属性实在读不出来：只读几何，属性留空。
      return { features: combine([geometries, null]).features, encoding: 'geometry-only', notes: failNotes }
    } catch (error) {
      failNotes.push('只读几何也失败：' + ((error && error.message) || error))
    }
  }

  throw uploadError(400, `「${set.shpName}」解析失败：` + (failNotes[failNotes.length - 1] || '未知原因'))
}

/* ---------------------------------------------------------------------------
 * 坐标：把任意投影的 SHP 放到小屋世界（0–1000）
 * ----------------------------------------------------------------------- */

function mapCoordinates(coords, mapper) {
  if (!Array.isArray(coords)) return coords
  if (typeof coords[0] === 'number') {
    const [x, y] = mapper(coords[0], coords[1])
    return [x, y]
  }
  return coords.map((item) => mapCoordinates(item, mapper))
}

function eachCoordinate(coords, visit) {
  if (!Array.isArray(coords)) return
  if (typeof coords[0] === 'number') {
    visit(coords[0], coords[1])
    return
  }
  for (const item of coords) eachCoordinate(item, visit)
}

function geometryExtent(features) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let count = 0
  for (const feature of features) {
    const geometry = feature && feature.geometry
    if (!geometry || !Array.isArray(geometry.coordinates)) continue
    eachCoordinate(geometry.coordinates, (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      count += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    })
  }
  if (count === 0) return null
  return { minX, minY, maxX, maxY, count }
}

/**
 * 把要素坐标统一换算到 0–1000：
 *   - 经纬度（|lng|≤180 且 |lat|≤90 且跨度 < 1°）-> geoToVirtual（和校园模式同一套）
 *   - 本来就在 0–1000 -> 只做钳制
 *   - 其它（投影坐标 / 任意本地坐标）-> 包围盒等比缩放到 [20, 980] 并居中
 */
function toWorldCoordinates(features) {
  const extent = geometryExtent(features)
  const report = { mode: 'unchanged', features: features.length }
  if (!extent) return report

  const spanX = extent.maxX - extent.minX
  const spanY = extent.maxY - extent.minY
  const geographic =
    Math.abs(extent.minX) <= 180 && Math.abs(extent.maxX) <= 180 &&
    Math.abs(extent.minY) <= 90 && Math.abs(extent.maxY) <= 90 &&
    spanX > 0 && spanX < 1 && spanY > 0 && spanY < 1

  if (geographic) {
    for (const feature of features) {
      if (!feature || !feature.geometry) continue
      feature.geometry = Object.assign({}, feature.geometry, {
        coordinates: mapCoordinates(feature.geometry.coordinates, (lng, lat) => {
          const point = geoToVirtual(lng, lat)
          return [point.x, point.y]
        }),
      })
    }
    report.mode = 'geo->virtual'
    return report
  }

  const insideWorld =
    extent.minX >= 0 && extent.maxX <= WORLD_SIZE &&
    extent.minY >= 0 && extent.maxY <= WORLD_SIZE
  if (insideWorld) {
    for (const feature of features) {
      if (!feature || !feature.geometry) continue
      feature.geometry = Object.assign({}, feature.geometry, {
        coordinates: mapCoordinates(feature.geometry.coordinates, (x, y) => [
          Math.min(WORLD_SIZE, Math.max(0, x)),
          Math.min(WORLD_SIZE, Math.max(0, y)),
        ]),
      })
    }
    report.mode = 'local'
    return report
  }

  // 投影坐标：等比缩放进可见区域，保持长宽比并居中。
  const usable = WORLD_SIZE - WORLD_PAD * 2
  const scale = Math.min(
    spanX > 0 ? usable / spanX : Infinity,
    spanY > 0 ? usable / spanY : Infinity,
  )
  const finalScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  const width = spanX * finalScale
  const height = spanY * finalScale
  const offsetX = (WORLD_SIZE - width) / 2
  const offsetY = (WORLD_SIZE - height) / 2
  for (const feature of features) {
    if (!feature || !feature.geometry) continue
    feature.geometry = Object.assign({}, feature.geometry, {
      coordinates: mapCoordinates(feature.geometry.coordinates, (x, y) => [
        Math.round((offsetX + (x - extent.minX) * finalScale) * 10) / 10,
        Math.round((offsetY + (y - extent.minY) * finalScale) * 10) / 10,
      ]),
    })
  }
  report.mode = 'normalized'
  report.scale = Math.round(finalScale * 1000) / 1000
  return report
}

/** 属性清洗：只留可平铺的标量，键名/长度按属性表的限制来。 */
function sanitizeProperties(raw, fallbackName) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const props = {}
  let count = 0
  for (const key of Object.keys(source)) {
    if (count >= MAX_PROP_KEYS) break
    if (!isAllowedExtraKey(key)) continue
    const value = source[key]
    if (typeof value === 'string') {
      const text = value.trim()
      if (!text) continue
      if (text.length > 2000) continue
      props[key] = text
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      props[key] = value
    } else if (typeof value === 'boolean' || value === null) {
      props[key] = value
    } else {
      continue
    }
    count += 1
  }
  // 类型固定：外部建筑不能因为 DBF 里有个 type 列就变成障碍物。
  delete props.type
  delete props.id
  const merged = applyCompatProperties(props, { type: 'shp_feature' })
  if (!String(merged.name || '').trim()) merged.name = fallbackName
  return merged
}

/**
 * 解析整个 zip，产出可直接入库的要素列表。
 *
 * @param {Buffer} buffer zip 二进制
 * @param {{fileName?: string}} [options]
 * @returns {Promise<{features: Array<object>, files: Array<object>, notes: string[]}>}
 */
async function parseShpZip(buffer, options = {}) {
  const sets = readShapefileSets(buffer)
  const slug = slugify(options.fileName || 'upload', 'upload')
  const notes = []
  const files = []
  const features = []
  let runningIndex = 0

  for (const set of sets) {
    const parsed = await parseSet(set)
    for (const note of parsed.notes) notes.push(`${set.base}: ${note}`)
    let count = 0
    for (const feature of parsed.features) {
      if (!feature || !feature.geometry) continue
      if (features.length >= MAX_FEATURES) break
      const index = runningIndex
      runningIndex += 1
      const id = `upl-${slug}-${index}`.slice(0, 60)
      const properties = sanitizeProperties(feature.properties, `${set.base} ${index + 1}`)
      properties._source = UPLOAD_SOURCE
      properties.sourceFile = set.shpName
      features.push({
        type: 'Feature',
        id,
        properties,
        geometry: feature.geometry,
      })
      count += 1
    }
    files.push({
      shp: set.shpName,
      features: count,
      encoding: parsed.encoding,
      hasDbf: Boolean(set.dbf),
      hasPrj: Boolean(set.prj),
    })
    if (features.length >= MAX_FEATURES) break
  }

  if (features.length === 0) throw uploadError(400, 'zip 里的 shapefile 没有任何可用的几何')
  if (features.length >= MAX_FEATURES) notes.push(`要素太多，只导入了前 ${MAX_FEATURES} 个`)

  const transform = toWorldCoordinates(features)

  // 几何清理：确保每条都有坐标且不是空环。
  const usable = features.filter((feature) => {
    const geometry = feature.geometry
    if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) return false
    const extent = geometryExtent([feature])
    return Boolean(extent && extent.count > 0)
  })

  return { features: usable, files, notes, transform }
}

module.exports = {
  parseShpZip,
  toWorldCoordinates,
  sanitizeProperties,
  readShapefileSets,
  UPLOAD_SOURCE,
}
