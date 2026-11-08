'use strict'

/**
 * gis/overlap.js —— 两个 GeoJSON 几何是否「真的重叠」（纯算法）
 *
 * SQL 只负责快速筛出包围盒相交的候选对；最终是不是重叠，由这里用 Turf 判定：
 *   - 面 × 面：交集必须是**有面积**的面。贴边、共点不算重叠；一个面完全
 *     包含另一个面算重叠（例如在客厅上画一个大房间，把沙发整个盖住）。
 *   - 线 / 点参与时：用 booleanIntersects。墙穿过家具、点落在家具面上都算
 *     冲突——它们虽然交集面积为 0，但确实占了同一块地方。
 *
 * 坐标是 1000×1000 的小屋世界坐标（y 向下），不是经纬度；Turf 这里只做
 * 平面布尔运算，不调用球面距离 / 面积函数，所以量纲不影响结果。
 */

const turf = require('@turf/turf')

/** 平面多边形面积（shoelace）；非面几何返回 0。 */
function planarArea(geometry) {
  if (!geometry) return 0
  if (geometry.type === 'Polygon') {
    return Math.abs(ringArea(geometry.coordinates[0] || []))
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce((sum, polygon) => sum + Math.abs(ringArea(polygon[0] || [])), 0)
  }
  return 0
}

function ringArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0
  let area = 0
  for (let index = 0; index < ring.length - 1; index += 1) {
    const a = ring[index]
    const b = ring[index + 1]
    area += Number(a[0]) * Number(b[1]) - Number(b[0]) * Number(a[1])
  }
  return area / 2
}

function hasPolygon(geometry) {
  return Boolean(geometry) && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
}

/**
 * 两个几何是否有实际重叠（面积 > 0）或相交（线 / 点参与）。
 *
 * @param {object} a GeoJSON geometry
 * @param {object} b GeoJSON geometry
 * @returns {boolean}
 */
function geometryOverlaps(a, b) {
  if (!a || !b || !a.type || !b.type) return false

  const featureA = { type: 'Feature', properties: {}, geometry: a }
  const featureB = { type: 'Feature', properties: {}, geometry: b }

  // 面 × 面：必须交出一块有面积的面。Turf 的 intersect 对贴边返回 null / 线。
  if (hasPolygon(a) && hasPolygon(b)) {
    try {
      // @turf/intersect v7 的签名是 intersect(FeatureCollection)，不是两个参数。
      const intersection = turf.intersect(turf.featureCollection([featureA, featureB]))
      if (!intersection) return false
      return planarArea(intersection.geometry) > 0.01
    } catch {
      // 个别自相交 / 退化面会让 Turf 抛错：退回布尔相交，宁可多报也别漏报。
      try {
        return turf.booleanIntersects(featureA, featureB)
      } catch {
        return false
      }
    }
  }

  try {
    return turf.booleanIntersects(featureA, featureB)
  } catch {
    return false
  }
}

/**
 * 两个几何包围盒的并集，用于前端红框 / 列表定位。
 * @returns {number[]|null}
 */
function overlapBounds(a, b) {
  const boundsA = geometryBBox(a)
  const boundsB = geometryBBox(b)
  if (!boundsA || !boundsB) return null
  return [
    Math.round(Math.min(boundsA[0], boundsB[0]) * 10) / 10,
    Math.round(Math.min(boundsA[1], boundsB[1]) * 10) / 10,
    Math.round(Math.max(boundsA[2], boundsB[2]) * 10) / 10,
    Math.round(Math.max(boundsA[3], boundsB[3]) * 10) / 10,
  ]
}

function geometryBBox(geometry) {
  if (!geometry) return null
  try {
    return turf.bbox({ type: 'Feature', properties: {}, geometry })
  } catch {
    return null
  }
}

module.exports = {
  geometryOverlaps,
  overlapBounds,
  planarArea,
}
