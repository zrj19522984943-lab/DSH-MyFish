'use strict'

/**
 * gis/furniture.js —— 家具 / 门洞 JSON 文档与统一要素行之间的纯转换
 *
 * 数据层现在以 SQLite 的 features 表为准。但在这些场合仍然需要「旧的
 * furniture.json 文档」这一形状：
 *   - 启动时把 furniture.json 迁移进数据库；
 *   - 兼容旧测试 / 旧工具（checkTopology(furnitureDoc)）；
 *   - 写回 furniture.json 兼容镜像，让还没改过来的工具继续能读。
 *
 * 本文件不读盘、不碰 this，只做坐标与结构转换。
 */

const { ROOMS_BY_NAME, clamp, roundCoordinate } = require('../world')

/** 家具的本地 x,y,w,h -> 钳制后的世界矩形（与 pathfinder/topology 同一套规则）。 */
function furnitureWorldRect(roomBase, item) {
  const w = Math.max(28, Number(item && item.w) || 58)
  const h = Math.max(28, Number(item && item.h) || 48)
  const lx = Number(item && item.x)
  const ly = Number(item && item.y)
  const cx = roomBase.x + clamp(Number.isFinite(lx) ? lx : roomBase.w / 2, w / 2, Math.max(w / 2, roomBase.w - w / 2))
  const cy = roomBase.y + clamp(Number.isFinite(ly) ? ly : roomBase.h / 2, h / 2, Math.max(h / 2, roomBase.h - h / 2))
  return {
    cx,
    cy,
    w,
    h,
    x0: cx - w / 2,
    y0: cy - h / 2,
    x1: cx + w / 2,
    y1: cy + h / 2,
    localX: Number.isFinite(lx) ? lx : roomBase.w / 2,
    localY: Number.isFinite(ly) ? ly : roomBase.h / 2,
  }
}

/** 世界矩形 -> 闭合 GeoJSON 环。 */
function rectRing(x0, y0, x1, y1) {
  const left = roundCoordinate(x0)
  const top = roundCoordinate(y0)
  const right = roundCoordinate(x1)
  const bottom = roundCoordinate(y1)
  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
    [left, top],
  ]
}

function furnitureGeometry(rect) {
  return { type: 'Polygon', coordinates: [rectRing(rect.x0, rect.y0, rect.x1, rect.y1)] }
}

/**
 * furniture.json 文档 -> 统一要素行（家具 + 门洞）。
 *
 * 行结构（数据库层再补 wkt / bbox / updated_at）：
 *   { id, name, type, room, geometry, properties, source }
 *
 * @param {object} furniture furniture.json 内容
 * @param {object} [roomsByName] 房间名 -> 世界房间
 * @returns {Array<object>}
 */
function furnitureRowsFromDoc(furniture, roomsByName = ROOMS_BY_NAME) {
  const rows = []
  const rooms = (furniture && furniture.rooms) || {}

  for (const [roomName, roomFurniture] of Object.entries(rooms)) {
    const base = roomsByName[roomName]
    if (!base) continue
    const items = Array.isArray(roomFurniture && roomFurniture.items) ? roomFurniture.items : []
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object') return
      const rect = furnitureWorldRect(base, item)
      const id = String(item.id || `${roomName}-${index}`)
      const type = String(item.type || item.name || id)
      rows.push({
        id,
        name: type,
        type: 'furniture',
        room: roomName,
        geometry: furnitureGeometry(rect),
        source: 'furniture',
        properties: {
          icon: String(item.icon || ''),
          width: rect.w,
          height: rect.h,
          localX: roundCoordinate(rect.localX),
          localY: roundCoordinate(rect.localY),
          localW: Math.max(28, Number(item.w) || 58),
          localH: Math.max(28, Number(item.h) || 48),
        },
      })
    })
  }

  const doors = Array.isArray(furniture && furniture.doors) ? furniture.doors : []
  doors.forEach((door, index) => {
    if (!door || typeof door !== 'object') return
    const x = Number(door.x)
    const y = Number(door.y)
    const w = Number(door.w)
    const h = Number(door.h)
    if (![x, y, w, h].every(Number.isFinite)) return
    const x0 = Math.min(x, x + w)
    const y0 = Math.min(y, y + h)
    const x1 = Math.max(x, x + w)
    const y1 = Math.max(y, y + h)
    rows.push({
      id: String(door.id || `door-${index}`),
      name: String(door.name || door.id || '门'),
      type: 'door',
      room: null,
      geometry: { type: 'Polygon', coordinates: [rectRing(x0, y0, x1, y1)] },
      source: 'door',
      properties: {
        x: roundCoordinate(x),
        y: roundCoordinate(y),
        width: roundCoordinate(w),
        height: roundCoordinate(h),
      },
    })
  })

  return rows
}

/**
 * 统一要素行 -> furniture.json 文档（兼容镜像 / 旧接口）。
 * 房间尺寸以 world.js 的 ROOMS 为准。
 *
 * @param {Array<object>} rows 已解析的行（含 properties / geometry）
 * @param {object} [roomsByName]
 * @returns {object}
 */
function furnitureDocFromRows(rows, roomsByName = ROOMS_BY_NAME) {
  const rooms = {}
  for (const roomName of Object.keys(roomsByName)) {
    const base = roomsByName[roomName]
    rooms[roomName] = { w: base.w, h: base.h, items: [] }
  }

  const doors = []
  for (const row of rows) {
    if (!row) continue
    if (row.type === 'door') {
      const props = row.properties || {}
      doors.push({
        id: row.id,
        name: row.name,
        x: Number(props.x) || 0,
        y: Number(props.y) || 0,
        w: Number(props.width) || 50,
        h: Number(props.height) || 50,
      })
      continue
    }
    if (row.source !== 'furniture' || !row.room) continue
    const room = rooms[row.room]
    if (!room) continue
    const props = row.properties || {}
    room.items.push({
      id: row.id,
      type: row.name,
      icon: String(props.icon || ''),
      x: Number(props.localX) || 0,
      y: Number(props.localY) || 0,
      w: Number(props.localW) || Number(props.width) || 58,
      h: Number(props.localH) || Number(props.height) || 48,
    })
  }

  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    rooms,
    doors,
  }
}

module.exports = {
  furnitureWorldRect,
  rectRing,
  furnitureGeometry,
  furnitureRowsFromDoc,
  furnitureDocFromRows,
}
