'use strict'

/**
 * gis/analyze.js —— 空间缓冲区分析（Turf.js）
 *
 * 给一个圆心和半径，用 turf.circle 生成缓冲面，再用 turf.booleanIntersects
 * 在小屋的要素集合里检索与缓冲面相交的要素。返回缓冲面本身（前端画圈用）
 * 和命中要素列表（前端 / QQ 工具报结果用）。
 *
 * 为什么要 Turf：缓冲区是真正的几何运算（点到圆弧的近似、面与面的相交判断），
 * 自己写一遍多边形求交既容易错也不好维护。Turf 是 GeoJSON 生态的标准库，
 * turf.circle 的 steps 默认 64，对小屋 1000×1000 的尺度完全够用。
 *
 * 坐标系：小屋世界坐标 [x, y]（y 向下）。Turf 的几何函数把坐标当作经纬度做
 * 球面运算——世界坐标直接喂进去（y=500 当纬度）会被 asin/atan2 折叠失真。
 * 所以 turf.circle 在**以圆心为原点的局部小角度平面**里生成圆（赤道附近、
 * 半径换算到 0.2 度以内，球面误差 < 0.001%），再把顶点平移回世界坐标；
 * booleanIntersects 是纯平面几何运算，不受量纲影响。
 *
 * 换算常数 SCALE：1 个世界单位 = 1/1000 度。半径 500（上限）= 0.5 度，
 * 在这个尺度上球面与平面的差别可以忽略。*/

const turf = require('@turf/turf')
const { WORLD_SIZE, clamp, roundCoordinate } = require('../world')

/** 缓冲圈的正多边形边数：64 边在 1000×1000 世界里肉眼已经是圆。 */
const BUFFER_STEPS = 64
/** 局部平面换算：1 世界单位 = 0.001 度（局部圆半径因此 ≤ 0.5 度，球面误差可忽略）。 */
const BUFFER_SCALE = 1000
/** 半径上下限：太大没有意义，太小连一格家具都圈不进去。 */
const MIN_RADIUS = 5
const MAX_RADIUS = Math.floor(WORLD_SIZE / 2)
/** 返回给前端的命中要素数量上限，避免一圈圈住半个屋子时回一屏字。 */
const MAX_HITS = 60

/**
 * 把任意要素的一个坐标点取出来当代表点（bounding box 中心），用于报告距离。
 * @param {object} geometry GeoJSON geometry
 * @returns {[number, number]|null}
 */
function representativePoint(geometry) {
  if (!geometry || !geometry.type) return null
  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
    return [Number(geometry.coordinates[0]) || 0, Number(geometry.coordinates[1]) || 0]
  }
  const flat = []
  const walk = (node) => {
    if (!Array.isArray(node)) return
    if (node.length >= 2 && Number.isFinite(node[0]) && Number.isFinite(node[1]) && !Array.isArray(node[0])) {
      flat.push([node[0], node[1]])
      return
    }
    for (const child of node) walk(child)
  }
  walk(geometry.coordinates)
  if (flat.length === 0) return null
  let x = 0
  let y = 0
  for (const point of flat) { x += point[0]; y += point[1] }
  return [x / flat.length, y / flat.length]
}

/**
 * 空间缓冲区分析。
 *
 * @param {[number, number]} centerPoint 世界坐标 [x, y]
 * @param {number} radius 半径（世界单位，1–500）
 * @param {Array} allFeatures 候选要素数组：每个是 GeoJSON Feature，
 *   至少有 properties.name 与 geometry；properties.type 缺失时按 'unknown' 处理。
 *   不传或不是数组时返回空命中。
 * @param {{ excludeKinds?: string[] }} [options]
 *   excludeKinds：要从结果里剔除的要素种类（properties.kind），比如
 *   QQ 查「我周围有什么」时传 ['fish', 'route']——她自己不该出现在答案里。
 * @returns {{
 *   center: [number, number],
 *   radius: number,
 *   steps: number,
 *   buffer: object|null,       圆缓冲面的 GeoJSON Polygon Feature（前端画圈）
 *   hitCount: number,
 *   hits: Array<{name:string, type:string, distance:number, room:string}>
 * }}
 *   distance = 圆心到要素代表点的直线距离（四舍五入到 0.1），
 *   按由近到远排序。
 */
function analyzeBuffer(centerPoint, radius, allFeatures, options = {}) {
  const exclude = new Set(Array.isArray(options.excludeKinds) ? options.excludeKinds : [])
  const cx = clamp(Number(Array.isArray(centerPoint) ? centerPoint[0] : NaN) || 0, 0, WORLD_SIZE)
  const cy = clamp(Number(Array.isArray(centerPoint) ? centerPoint[1] : NaN) || 0, 0, WORLD_SIZE)
  const r = Math.round(clamp(Number(radius) || 0, MIN_RADIUS, MAX_RADIUS))

  // turf.circle：球面函数，直接喂世界坐标会失真。先在以圆心为原点的局部
  // 小角度平面（赤道附近）生成圆，再把顶点平移回世界坐标——这样得到的仍是
  // 一个以 (cx, cy) 为圆心、半径恰为 r 的正 64 边形（见文件头注释）。
  let bufferFeature = null
  try {
    const local = turf.circle([0, 0], r / BUFFER_SCALE, { steps: BUFFER_STEPS, units: 'degrees' })
    const ring = (local.geometry && local.geometry.coordinates && local.geometry.coordinates[0]) || []
    if (ring.length > 3) {
      const moved = ring.map((point) => [
        roundCoordinate(point[0] * BUFFER_SCALE + cx),
        roundCoordinate(point[1] * BUFFER_SCALE + cy),
      ])
      bufferFeature = {
        type: 'Feature',
        properties: { kind: 'buffer', radius: r, center: [roundCoordinate(cx), roundCoordinate(cy)] },
        geometry: { type: 'Polygon', coordinates: [moved] },
      }
    }
  } catch (error) {
    // 生成失败（理论上是参数不合法）：不致命，命中检索照跑，只是没有圈可画。
    console.warn(`[cyber-house] turf.circle 失败：${error?.message || error}`)
  }

  const bufferGeom = bufferFeature?.geometry || null
  const hits = []
  const candidates = Array.isArray(allFeatures) ? allFeatures : []
  for (const feature of candidates) {
    if (!feature || !feature.geometry) continue
    const props = feature.properties || {}
    // 要素种类可能在 type（小屋导出的要素）或 kind（历史/上层约定）上，两个都看。
    // 排除表只可能含 fish / route，与自定义要素的 furniture/wall/room 不会撞车。
    if (exclude.size > 0 && (exclude.has(String(props.type || '')) || exclude.has(String(props.kind || '')))) continue
    const geom = feature.geometry
    if (!geom.type || !Array.isArray(geom.coordinates)) continue

    // 只有几何真正相交才算「圈到了」。
    let intersects = false
    try {
      if (bufferGeom) {
        intersects = turf.booleanIntersects(
          { type: 'Feature', geometry: bufferGeom },
          { type: 'Feature', geometry: geom },
        )
      }
    } catch (error) {
      // 个别畸形几何（空环、单点线）会让 Turf 抛错：跳过它，不影响其他要素。
      console.warn(`[cyber-house] booleanIntersects 跳过一个要素：${error?.message || error}`)
      continue
    }
    if (!intersects) continue

    const rep = representativePoint(geom) || [cx, cy]
    const distance = Math.round(Math.hypot(rep[0] - cx, rep[1] - cy) * 10) / 10
    hits.push({
      name: String(props.name || props.type || '未命名要素'),
      type: String(props.type || props.kind || 'unknown'),
      room: String(props.room || ''),
      distance,
    })
  }

  hits.sort((a, b) => a.distance - b.distance)
  const total = hits.length
  const limited = hits.slice(0, MAX_HITS)

  return {
    center: [roundCoordinate(cx), roundCoordinate(cy)],
    radius: r,
    steps: BUFFER_STEPS,
    buffer: bufferFeature,
    hitCount: total,
    hits: limited,
    truncated: total > limited.length,
  }
}

module.exports = {
  analyzeBuffer,
  representativePoint,
  BUFFER_STEPS,
  MIN_RADIUS,
  MAX_RADIUS,
  MAX_HITS,
}
