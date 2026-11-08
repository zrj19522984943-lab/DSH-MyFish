'use strict'

/**
 * gis/geojson.js —— 把小屋世界导出成 RFC 7946 GeoJSON
 *
 * 6 个房间是面、家具是面（带 w/h 占地）、门洞是面、小鱼是点；
 * 寻路启用时附带当前路线 LineString。
 *
 * 这里只做几何组装，不推状态、不读盘。state-engine 把 getState() 的结果和
 * 当前家具传进来，输出与原来完全一致。
 */

const { WORLD_SIZE, ROOMS, ROOMS_BY_NAME, roundCoordinate } = require('../world')
const { furnitureObstacles, doorRects } = require('./pathfinder')
const { featureList } = require('./features')

/** 房间的 [x, y, w, h] -> 闭合多边形环：左上 -> 右上 -> 右下 -> 左下 -> 左上。 */
function roomRing(room) {
  const left = roundCoordinate(Number(room.x))
  const top = roundCoordinate(Number(room.y))
  const right = roundCoordinate(left + Number(room.w))
  const bottom = roundCoordinate(top + Number(room.h))

  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
    [left, top],
  ]
}

/**
 * @param {object} state getState() 的返回
 * @param {object} furniture furniture.json 内容
 * @param {Array} [rooms] 房间数组
 * @param {object} [roomsByName] 房间名 -> 房间（含中心）
 * @param {object|Array} [customFeatures] features.json 的 FeatureCollection 或要素数组
 * @returns {object} FeatureCollection
 */
function buildHouseGeoJSON(state, furniture, rooms = ROOMS, roomsByName = ROOMS_BY_NAME, customFeatures = null) {
  const features = []

  // 1. 房间：面要素。
  for (const room of rooms) {
    features.push({
      type: 'Feature',
      properties: {
        name: room.name,
        type: 'room',
        color: room.color,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [roomRing(room)],
      },
    })
  }

  // 2. 家具：面要素（与网页上的占地矩形完全一致，同一套钳制）。
  for (const item of furnitureObstacles(furniture, roomsByName)) {
    const left = roundCoordinate(item.cx - item.w / 2)
    const top = roundCoordinate(item.cy - item.h / 2)
    const right = roundCoordinate(item.cx + item.w / 2)
    const bottom = roundCoordinate(item.cy + item.h / 2)

    features.push({
      type: 'Feature',
      properties: {
        name: item.type,
        type: 'furniture',
        room: item.room,
        width: item.w,
        height: item.h,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [left, top],
            [right, top],
            [right, bottom],
            [left, bottom],
            [left, top],
          ],
        ],
      },
    })
  }

  // 3. 门洞：面要素，就是栅格寻路里的通行缺口。
  for (const door of doorRects(furniture)) {
    features.push({
      type: 'Feature',
      properties: {
        name: door.name,
        type: door.type,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [roundCoordinate(door.x0), roundCoordinate(door.y0)],
            [roundCoordinate(door.x1), roundCoordinate(door.y0)],
            [roundCoordinate(door.x1), roundCoordinate(door.y1)],
            [roundCoordinate(door.x0), roundCoordinate(door.y1)],
            [roundCoordinate(door.x0), roundCoordinate(door.y0)],
          ],
        ],
      },
    })
  }

  // 4. 小鱼：点要素，实时位置。
  features.push({
    type: 'Feature',
    properties: {
      name: '小鱼',
      type: 'fish',
      status: state.status,
      room: state.room,
      activity: state.activity,
    },
    geometry: {
      type: 'Point',
      coordinates: [state.position.x, state.position.y],
    },
  })

  // 4b. 屋里的 NPC：点要素。网页前端用它画 Emoji 与头顶气泡；
  // QGIS / 缓冲区分析也能看到“家里还有谁”。
  for (const npc of Array.isArray(state.npcs) ? state.npcs : []) {
    if (!npc) continue
    features.push({
      type: 'Feature',
      id: String(npc.id || ''),
      properties: {
        name: npc.name || 'NPC',
        type: 'npc',
        room: npc.room || '',
        emoji: npc.emoji || '',
      },
      geometry: {
        type: 'Point',
        coordinates: [Number(npc.x) || 0, Number(npc.y) || 0],
      },
    })
  }

  // 5. 当前导航路线：LineString（寻路启用时才有）。
  if (Array.isArray(state.currentRoute) && state.currentRoute.length > 1) {
    features.push({
      type: 'Feature',
      properties: {
        name: '当前路线',
        type: 'route',
      },
      geometry: {
        type: 'LineString',
        coordinates: state.currentRoute.map((point) => [point.x, point.y]),
      },
    })
  }

  // 6. 自定义要素（features.json）：网页上用 leaflet.draw 画进来的点线面，
  //    原样追加，properties.type 就是符号化渲染用的类型。
  for (const feature of featureList(customFeatures)) {
    const properties = Object.assign({}, feature.properties || {}, { source: 'custom' })
    features.push({
      type: 'Feature',
      id: String(feature.id || ''),
      properties,
      geometry: feature.geometry,
    })
  }

  return {
    type: 'FeatureCollection',
    name: '赛博小屋',
    bbox: [0, 0, WORLD_SIZE, WORLD_SIZE],
    features,
  }
}

module.exports = {
  roomRing,
  buildHouseGeoJSON,
}
