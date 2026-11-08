'use strict'

/**
 * gis/interactions.js —— 场景交互物块的距离触发状态机（纯算法）
 *
 * 任务书 1：数据库里 properties.interact_text 非空的要素就是「可交互物块」。
 * 小鱼每次移动后：
 *   - 距离 < 30 且之前没触发过 -> 触发一次固定对话；
 *   - 触发后离开到 > 50 -> 重置，允许下次再触发；
 *   - 触发时记录一个气泡，前端在地图上冒几秒。
 *
 * 距离是「小鱼到几何本体」的最近距离，不是到包围盒中心：
 * 宝箱是点、床是面、电脑可以是多边形，贴在边上就该触发。
 *
 * 本文件不读盘、不碰 this，方便单测。
 */

const { roundCoordinate } = require('../world')

/** 进入这个距离就触发（世界单位）。 */
const TRIGGER_DISTANCE = 30
/** 离开到这个距离之外才重置，避免在阈值边缘反复触发。 */
const RESET_DISTANCE = 50
/** 气泡在地图上保留多久（毫秒）。 */
const BUBBLE_MS = 9000

function hypot(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by)
}

/** 点到线段的最短距离。 */
function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return hypot(px, py, ax, ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return hypot(px, py, ax + t * dx, ay + t * dy)
}

function pointInRing(x, y, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0])
    const yi = Number(ring[i][1])
    const xj = Number(ring[j][0])
    const yj = Number(ring[j][1])
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function distanceToLine(points, x, y) {
  let best = Infinity
  for (let index = 0; index < points.length - 1; index += 1) {
    const [ax, ay] = points[index]
    const [bx, by] = points[index + 1]
    best = Math.min(best, pointToSegmentDistance(x, y, Number(ax), Number(ay), Number(bx), Number(by)))
  }
  return best
}

function distanceToPolygon(rings, x, y) {
  if (!Array.isArray(rings) || rings.length === 0) return Infinity
  const outer = rings[0]
  if (pointInRing(x, y, outer)) {
    // 在洞里 -> 到洞边界的距离；在实心区域 -> 0。
    for (let index = 1; index < rings.length; index += 1) {
      if (pointInRing(x, y, rings[index])) {
        return distanceToLine(rings[index].concat([rings[index][0]]), x, y)
      }
    }
    return 0
  }
  return distanceToLine(outer.concat([outer[0]]), x, y)
}

/**
 * 小鱼到任意 GeoJSON 几何的最近距离。无法计算时返回 Infinity。
 * @param {object} geometry
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function distanceToGeometry(geometry, x, y) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return Infinity
  const type = String(geometry.type || '')
  const coords = geometry.coordinates

  if (type === 'Point') {
    if (!Array.isArray(coords) || coords.length < 2) return Infinity
    return hypot(x, y, Number(coords[0]), Number(coords[1]))
  }
  if (type === 'MultiPoint') {
    return coords.reduce((best, point) => Math.min(best, hypot(x, y, Number(point[0]), Number(point[1]))), Infinity)
  }
  if (type === 'LineString') return distanceToLine(coords, x, y)
  if (type === 'MultiLineString') {
    return coords.reduce((best, line) => Math.min(best, distanceToLine(line, x, y)), Infinity)
  }
  if (type === 'Polygon') return distanceToPolygon(coords, x, y)
  if (type === 'MultiPolygon') {
    return coords.reduce((best, rings) => Math.min(best, distanceToPolygon(rings, x, y)), Infinity)
  }
  if (type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    return geometry.geometries.reduce((best, item) => Math.min(best, distanceToGeometry(item, x, y)), Infinity)
  }
  return Infinity
}

/** 气泡锚点：点就是本身；线取中点；面取包围盒中心。 */
function geometryCenter(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null
  const type = String(geometry.type || '')

  if (type === 'Point') {
    const [x, y] = geometry.coordinates
    return Number.isFinite(Number(x)) && Number.isFinite(Number(y))
      ? { x: roundCoordinate(Number(x)), y: roundCoordinate(Number(y)) }
      : null
  }
  if (type === 'LineString') {
    const points = geometry.coordinates
    if (points.length === 0) return null
    const middle = points[Math.floor(points.length / 2)]
    return { x: roundCoordinate(Number(middle[0])), y: roundCoordinate(Number(middle[1])) }
  }

  const points = []
  const walk = (node) => {
    if (!Array.isArray(node)) return
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      points.push([Number(node[0]), Number(node[1])])
      return
    }
    for (const child of node) walk(child)
  }
  walk(geometry.coordinates)
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (!Number.isFinite(minX)) return null
  return {
    x: roundCoordinate((minX + maxX) / 2),
    y: roundCoordinate((minY + maxY) / 2),
  }
}

/** 从数据库行里挑出带 interact_text 的要素，返回交互视图。 */
function interactiveViews(rows) {
  const views = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.id || !row.geometry) continue
    if (seen.has(row.id)) continue
    const text = String(row.properties && row.properties.interact_text || '').trim()
    if (!text) continue
    seen.add(row.id)
    views.push({
      id: String(row.id),
      name: String(row.name || row.id),
      text,
      geometry: row.geometry,
      center: geometryCenter(row.geometry),
    })
  }
  return views
}

/**
 * 推进一步交互状态机。
 *
 * @param {Array<object>} rows 数据库要素行（含 geometry / properties）
 * @param {number} x 小鱼世界坐标
 * @param {number} y
 * @param {Map<string, object>|object} previous 上一次的状态表
 * @param {number} now 当前毫秒时间
 * @param {{triggerDistance?:number, resetDistance?:number, bubbleMs?:number}} [options]
 * @returns {{
 *   nextState: Map<string, object>,
 *   triggered: Array<object>,
 *   reset: Array<string>,
 *   bubbles: Array<object>,
 * }}
 */
function stepInteractionState(rows, x, y, previous, now, options = {}) {
  const triggerDistance = Number.isFinite(options.triggerDistance)
    ? Number(options.triggerDistance)
    : TRIGGER_DISTANCE
  const resetDistance = Number.isFinite(options.resetDistance)
    ? Number(options.resetDistance)
    : RESET_DISTANCE
  const bubbleMs = Number.isFinite(options.bubbleMs) ? Number(options.bubbleMs) : BUBBLE_MS
  const time = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const px = Number(x)
  const py = Number(y)

  const previousMap = previous instanceof Map ? previous : new Map(Object.entries(previous || {}))
  const views = interactiveViews(rows)
  const nextState = new Map()
  const triggered = []
  const reset = []

  for (const view of views) {
    const previousEntry = previousMap.get(view.id) || {}
    const distance = distanceToGeometry(view.geometry, px, py)
    const finiteDistance = Number.isFinite(distance) ? distance : Infinity
    let triggeredFlag = previousEntry.triggered === true
    let triggeredAt = Number(previousEntry.triggeredAt) || 0
    let bubbleUntil = Number(previousEntry.bubbleUntil) || 0
    let lastDistance = finiteDistance

    if (!triggeredFlag && finiteDistance < triggerDistance) {
      triggeredFlag = true
      triggeredAt = time
      bubbleUntil = time + bubbleMs
      triggered.push({
        id: view.id,
        name: view.name,
        text: view.text,
        center: view.center,
        distance: roundCoordinate(finiteDistance),
        at: time,
      })
    } else if (triggeredFlag && finiteDistance > resetDistance) {
      triggeredFlag = false
      bubbleUntil = 0
      reset.push(view.id)
    }

    nextState.set(view.id, {
      triggered: triggeredFlag,
      triggeredAt,
      bubbleUntil,
      lastDistance: roundCoordinate(Number.isFinite(lastDistance) ? lastDistance : 0),
    })
  }

  // 已经被删除 / 去掉 interact_text 的要素不再占状态。
  const bubbles = []
  for (const view of views) {
    const entry = nextState.get(view.id)
    if (!entry || entry.bubbleUntil <= time) continue
    bubbles.push({
      id: view.id,
      name: view.name,
      text: view.text,
      center: view.center,
      at: entry.triggeredAt,
      expiresAt: entry.bubbleUntil,
    })
  }

  return { nextState, triggered, reset, bubbles }
}

module.exports = {
  TRIGGER_DISTANCE,
  RESET_DISTANCE,
  BUBBLE_MS,
  distanceToGeometry,
  geometryCenter,
  interactiveViews,
  stepInteractionState,
  // 单测用
  pointToSegmentDistance,
  pointInRing,
}
