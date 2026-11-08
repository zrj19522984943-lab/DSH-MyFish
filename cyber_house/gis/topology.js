'use strict'

/**
 * gis/topology.js —— 全要素拓扑检查（家具 / 自建墙 / 自建房间 / 门洞）
 *
 * 旧实现只遍历 furniture.json 的 rooms.*.items，网页上画的墙和房间根本进不了
 * 检查范围——这是「画了大房间盖住沙发却查不出来」的根因。现在所有要素都在
 * 数据库的 features 表里，本模块对同一批行统一做三类空间冲突：
 *
 *   1. overlap        任意两个非门要素的几何真的重叠（有面积 / 线点相交）
 *   2. out-of-bounds  家具超出所属房间边界；任何要素超出小屋世界边界
 *   3. blocked-door   墙 / 家具把门洞盖住，小鱼过不去
 *
 * 重叠候选对由 db/index.js 用 SQL 预筛（SpatiaLite 时是 ST_Intersects，降级时
 * 是索引化 bbox 自连接），这里再用 Turf 做精确判定：面与面必须交出一块面积，
 * 贴边不算重叠；墙穿过家具、点落在家具上仍然算冲突。
 *
 * 纯函数：接受数据库行数组或旧版 furniture 文档，不读盘、不碰 this。
 */

const { ROOMS_BY_NAME, WORLD_SIZE, clamp, roundCoordinate } = require('../world')
const { featureList, featureBlocksDoor, TYPE_NAMES } = require('./features')
const { doorRects } = require('./pathfinder')
const { furnitureRowsFromDoc, furnitureWorldRect } = require('./furniture')
const { geometryBounds } = require('../db/wkt')
const { geometryOverlaps, overlapBounds } = require('./overlap')

function isFeatureStore(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.findOverlapPairs === 'function'
    && typeof value.snapshot === 'function',
  )
}

function rowToFeature(row) {
  const properties = Object.assign({}, row.properties || {}, {
    type: row.type,
    name: row.name,
  })
  if (row.room) properties.room = row.room
  return {
    type: 'Feature',
    id: row.id,
    properties,
    geometry: row.geometry,
  }
}

function rowBounds(row) {
  if (Number.isFinite(row.minX) && Number.isFinite(row.maxX) && row.maxX >= row.minX) {
    return [row.minX, row.minY, row.maxX, row.maxY]
  }
  return geometryBounds(row.geometry)
}

function rowsFromLegacy(furniture, customFeatures) {
  const rows = furnitureRowsFromDoc(furniture || { rooms: {} }, ROOMS_BY_NAME)
  for (const feature of featureList(customFeatures)) {
    const props = (feature && feature.properties) || {}
    const geometry = feature && feature.geometry
    if (!geometry) continue
    rows.push({
      id: String(feature.id || props.name || 'custom-feature'),
      name: String(props.name || TYPE_NAMES[props.type] || '未命名要素'),
      type: String(props.type || 'custom'),
      room: typeof props.room === 'string' ? props.room : null,
      geometry,
      properties: props,
      source: 'custom',
    })
  }
  return rows
}

function doorsFromRows(rows) {
  return rows
    .filter((row) => row.type === 'door')
    .map((row) => {
      const bounds = rowBounds(row) || [0, 0, 0, 0]
      return {
        name: String(row.name || '门'),
        type: 'door',
        x0: bounds[0],
        y0: bounds[1],
        x1: bounds[2],
        y1: bounds[3],
      }
    })
}

/** 没有 DB 提供的候选对时，自己做一遍 bbox 预筛（旧接口 / 测试用）。 */
function localCandidatePairs(rows) {
  const pairs = []
  for (let a = 0; a < rows.length; a += 1) {
    const A = rows[a]
    if (!A.geometry) continue
    const boundsA = rowBounds(A)
    if (!boundsA) continue
    for (let b = a + 1; b < rows.length; b += 1) {
      const B = rows[b]
      if (!B.geometry) continue
      const boundsB = rowBounds(B)
      if (!boundsB) continue
      if (A.type === 'door' || B.type === 'door') continue
      if (boundsA[0] > boundsB[2] || boundsB[0] > boundsA[2]) continue
      if (boundsA[1] > boundsB[3] || boundsB[1] > boundsA[3]) continue
      pairs.push({ a: A, b: B })
    }
  }
  return pairs
}

function roomLabelFor(a, b) {
  if (a.room && b.room && a.room === b.room) return a.room
  if (a.room && !b.room) return a.room
  if (b.room && !a.room) return b.room
  if (a.room && b.room) return `${a.room}/${b.room}`
  return '小屋'
}

function displayName(row) {
  return String(row.name || row.id || '未命名要素')
}

/**
 * 核心检查：输入是统一行（可以直接来自数据库，也可以由旧文档转换而来）。
 *
 * @param {Array<object>} rows
 * @param {object} [roomsByName]
 * @param {{doors?:Array, pairs?:Array<{a:object,b:object}>}} [options]
 * @returns {Array<{type:string,message:string,room:string,items:string[],featureIds:string[],bounds:number[]}>}
 */
function checkRows(rows, roomsByName = ROOMS_BY_NAME, options = {}) {
  const errors = []
  const list = Array.isArray(rows) ? rows.filter((row) => row && row.geometry) : []
  const pairs = Array.isArray(options.pairs) ? options.pairs : localCandidatePairs(list)
  const doors = Array.isArray(options.doors) ? options.doors : doorsFromRows(list)

  /* ---------------------------- 1. 要素重叠 ---------------------------- */
  for (const pair of pairs) {
    const A = pair.a
    const B = pair.b
    if (!A || !B) continue
    if (A.type === 'door' || B.type === 'door') continue
    if (!geometryOverlaps(A.geometry, B.geometry)) continue

    const room = roomLabelFor(A, B)
    const bounds = overlapBounds(A.geometry, B.geometry) || rowBounds(A) || rowBounds(B)
    if (!bounds) continue
    errors.push({
      type: 'overlap',
      message: `要素重叠：${room}里的「${displayName(A)}」和「${displayName(B)}」压在同一块地方`,
      room,
      items: [String(A.id || ''), String(B.id || '')],
      featureIds: [String(A.id || ''), String(B.id || '')],
      bounds: bounds.map(roundCoordinate),
    })
  }

  /* --------------------------- 2. 越界检查 ---------------------------- */
  for (const row of list) {
    const bounds = rowBounds(row)
    if (!bounds) continue
    const name = displayName(row)

    // 2a. 所有要素：是否超出 1000×1000 的世界边界（迁移脏数据 / 手工改库兜底）。
    const worldOver = []
    if (bounds[0] < -0.5) worldOver.push('左')
    if (bounds[2] > WORLD_SIZE + 0.5) worldOver.push('右')
    if (bounds[1] < -0.5) worldOver.push('上')
    if (bounds[3] > WORLD_SIZE + 0.5) worldOver.push('下')
    if (worldOver.length > 0) {
      errors.push({
        type: 'out-of-bounds',
        message: `${name}超出了小屋世界边界（探出${worldOver.join('')}侧）`,
        room: row.room || '小屋',
        items: [String(row.id || '')],
        featureIds: [String(row.id || '')],
        bounds: [
          roundCoordinate(clamp(bounds[0], 0, WORLD_SIZE)),
          roundCoordinate(clamp(bounds[1], 0, WORLD_SIZE)),
          roundCoordinate(clamp(bounds[2], 0, WORLD_SIZE)),
          roundCoordinate(clamp(bounds[3], 0, WORLD_SIZE)),
        ],
      })
      continue
    }

    // 2b. 家具：按原始本地坐标判断有没有探出所属房间（和旧逻辑一致）。
    if (row.source !== 'furniture' || !row.room) continue
    const base = roomsByName[row.room]
    if (!base) continue
    const props = row.properties || {}
    const lx = Number(props.localX)
    const ly = Number(props.localY)
    if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue
    const w = Math.max(28, Number(props.localW) || Number(props.width) || 58)
    const h = Math.max(28, Number(props.localH) || Number(props.height) || 48)

    const over = []
    if (lx - w / 2 < -0.5) over.push('左')
    if (lx + w / 2 > base.w + 0.5) over.push('右')
    if (ly - h / 2 < -0.5) over.push('上')
    if (ly + h / 2 > base.h + 0.5) over.push('下')
    if (over.length === 0) continue

    const rect = furnitureWorldRect(base, { x: lx, y: ly, w, h })
    errors.push({
      type: 'out-of-bounds',
      message: `${row.room}的${name}超出了房间边界（探出${over.join('')}侧）`,
      room: row.room,
      items: [String(row.id || '')],
      featureIds: [String(row.id || '')],
      bounds: [
        roundCoordinate(rect.x0),
        roundCoordinate(rect.y0),
        roundCoordinate(rect.x1),
        roundCoordinate(rect.y1),
      ],
    })
  }

  /* --------------------------- 3. 堵门检查 ---------------------------- */
  if (doors.length > 0) {
    const obstacles = list.filter((row) => row.type === 'wall' || row.type === 'furniture')
    for (const row of obstacles) {
      const feature = rowToFeature(row)
      for (const door of doors) {
        if (!featureBlocksDoor(feature, door)) continue
        const kind = TYPE_NAMES[row.type] || '要素'
        errors.push({
          type: 'blocked-door',
          message: `「${door.name}」的门洞被堵塞：${kind}「${displayName(row)}」把整扇门盖住了，小鱼过不去`,
          room: door.name,
          items: [String(row.id || ''), String(door.name || '')],
          featureIds: [String(row.id || '')],
          bounds: [
            roundCoordinate(door.x0),
            roundCoordinate(door.y0),
            roundCoordinate(door.x1),
            roundCoordinate(door.y1),
          ],
        })
      }
    }
  }

  return errors
}

/**
 * 从数据库跑一次拓扑检查：SQL 查候选对，Turf 判精确重叠。
 * @param {import('../db/index').FeatureStore} store
 */
function checkStoreTopology(store, roomsByName = ROOMS_BY_NAME) {
  const snapshot = store.snapshot()
  return checkRows(snapshot.rows, roomsByName, {
    doors: snapshot.doors,
    pairs: store.findOverlapPairs(),
  })
}

/**
 * 兼容入口：
 *   - checkTopology(store)                 新：数据库
 *   - checkTopology(furnitureDoc)          旧：纯家具文档
 *   - checkTopology(furnitureDoc, rooms, features) 旧：家具 + 自定义要素
 */
function checkTopology(input, roomsByName = ROOMS_BY_NAME, features = null) {
  if (isFeatureStore(input)) return checkStoreTopology(input, roomsByName)
  const rows = rowsFromLegacy(input, features)
  return checkRows(rows, roomsByName)
}

module.exports = {
  checkTopology,
  checkStoreTopology,
  checkRows,
  // 单元测试 / 其他地方可能用到的纯工具
  rowToFeature,
  rowsFromLegacy,
}
