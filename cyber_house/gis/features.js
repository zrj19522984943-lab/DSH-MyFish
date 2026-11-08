'use strict'

/**
 * gis/features.js —— 自定义 GeoJSON 要素：校验、规范化与栅格化（纯算法）
 *
 * 网页端用 leaflet.draw 画出点 / 线 / 面，配上 properties.type（furniture 家具、
 * wall 墙壁、room 房间）后，经 POST /api/fish-home/features 落进 features.json。
 * 本模块只做三件事：
 *
 *   1. validateFeature —— 把前端送来的 GeoJSON Feature 过一遍（几何类型、坐标
 *      数值、properties 形状），不合格就抛出带 statusCode 的错误，api-router
 *      可以直接回给前端。properties 不再收敛白名单（任务书「动态属性表」），
 *      外部字段（OBJECTID / BUILDING_N / HEIGHT …）原样透传进库；
 *      applyCompatProperties 再给外部 SHP 补上 name / type 两个下游契约键。
 *   2. featureCells —— 把任意几何体栅格化到 50 × 50 的寻路格上，产出
 *      { blocked, passable } 两个「i,j」集合：
 *        · wall / furniture 的任何几何体 -> 阻挡格（A* 不可通行）
 *        · room 的 Polygon -> 可通行格（在虚空里画出的新房间，小鱼游得进去）
 *      障碍优先：同一格既是墙又是房间时按墙算；
 *   3. featureBlocksDoor —— 拓扑检查用：一面新墙有没有把门洞堵死。
 *
 * 栅格化保证：只要几何体覆盖的某个点，其周围 14.14（栅格半对角线）内必有格子
 * 中心，所以线/点用 ≥ 15 的半径采样时不会出现「画了墙但格子一个都不挡」的幻影墙。
 *
 * 纯算法：不读盘、不写盘、不碰 this。
 */

const { WORLD_SIZE, clamp, roundCoordinate, GRID_CELLS, CELL_SIZE, cellKeyOf } = require('../world')
// 注意：map-level 是 db/ 下的无依赖小模块，绝不能 require('./db/index')，
// 否则 db <-> gis 形成循环依赖。
const { DEFAULT_MAP_LEVEL, normalizeMapLevel, isValidMapLevel } = require('../db/map-level')

const FEATURE_TYPES = Object.freeze(['furniture', 'wall', 'room'])
const FEATURE_TYPE_SET = new Set(FEATURE_TYPES)

const TYPE_NAMES = Object.freeze({
  furniture: '家具',
  wall: '墙壁',
  room: '房间',
})

// 动态属性表（外部要素无缝兼容）：properties 里除统一字段外的键
// 不再收敛，不过仍要有上限，防一个恶意 / 畸形请求把行撑成数 MB。
const MAX_EXTRA_KEYS = 64
const MAX_EXTRA_KEY_CHARS = 64
const MAX_EXTRA_STRING_CHARS = 2000
const MAX_EXTRA_DEPTH = 3

/**
 * 点要素的障碍半径，与线要素的半厚：
 * 栅格半对角线是 √(10² + 10²) ≈ 14.14，取 15 保证任何落点至少盖住一格，
 * 同时最多溢出到相邻格——画一棵树就是一格障碍，画一堵墙就是一道实心墙。
 */
const OBSTACLE_RADIUS = 15

function invalid(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function isObstacleType(type) {
  return type === 'wall' || type === 'furniture'
}

function isObstacleFeature(feature) {
  const type = String(feature && feature.properties && feature.properties.type)
  return isObstacleType(type) && feature && feature.geometry && typeof feature.geometry === 'object'
}

/* ---------------------------------------------------------------------------
 * 校验与规范化
 * ------------------------------------------------------------------------- */

function normalizeCoordinatePair(pair, path) {
  if (!Array.isArray(pair) || pair.length < 2) throw invalid(`${path} 不是 [x, y] 坐标对`)
  const x = Number(pair[0])
  const y = Number(pair[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw invalid(`${path} 的坐标不是数字`)
  return [clamp(roundCoordinate(x), 0, WORLD_SIZE), clamp(roundCoordinate(y), 0, WORLD_SIZE)]
}

function normalizePointList(coords, path, minPoints) {
  if (!Array.isArray(coords) || coords.length < minPoints) {
    throw invalid(`${path} 至少需要 ${minPoints} 个坐标点`)
  }
  return coords.map((point) => normalizeCoordinatePair(point, path))
}

/** 环不必自己闭合：这里补上首尾相接，下游一律按闭合环处理。 */
function closeRing(ring) {
  if (ring.length < 2) return ring
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) return ring.concat([[first[0], first[1]]])
  return ring
}

function normalizeGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') throw invalid('geometry 缺失')
  const type = String(geometry.type || '')

  if (type === 'Point') {
    return { type: 'Point', coordinates: normalizeCoordinatePair(geometry.coordinates, 'coordinates') }
  }
  if (type === 'LineString') {
    return { type: 'LineString', coordinates: normalizePointList(geometry.coordinates, 'coordinates', 2) }
  }
  if (type === 'Polygon') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 1) {
      throw invalid('Polygon 至少需要一个环')
    }
    const rings = geometry.coordinates.map((ring, index) =>
      closeRing(normalizePointList(ring, `coordinates[${index}]`, 3)),
    )
    return { type: 'Polygon', coordinates: rings }
  }

  throw invalid('geometry.type 只支持 Point / LineString / Polygon')
}

/**
 * allowedExtraValue —— 任务书「动态属性表与外部要素无缝兼容」：
 * 属性值只要是 JSON 可序列化的标量 / 平铺容器就允许带走。
 * 外部 SHP 的 DBF 字段都是平的（数字 / 字符串 / 布尔），这里同时容得下
 * 少量嵌套（深度 ≤ 3），但不放任任意深度的 JSON，防一个请求把库撑爆。
 *
 * @param {*} value
 * @param {number} depth
 * @returns {*} 可安全入库的值；不合法返回 undefined（调用方丢掉这个键）
 */
function allowedExtraValue(value, depth = 0) {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return value.slice(0, MAX_EXTRA_STRING_CHARS)
  if (depth >= MAX_EXTRA_DEPTH || typeof value !== 'object') return undefined

  if (Array.isArray(value)) {
    const items = value.map((item) => allowedExtraValue(item, depth + 1)).filter((v) => v !== undefined)
    return items.length > 0 ? items : undefined
  }
  const picked = {}
  let count = 0
  for (const [key, item] of Object.entries(value)) {
    if (!isAllowedExtraKey(key)) continue
    const safe = allowedExtraValue(item, depth + 1)
    if (safe === undefined) continue
    picked[key] = safe
    count += 1
    if (count >= MAX_EXTRA_KEYS) break
  }
  return count > 0 ? picked : undefined
}

function isAllowedExtraKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_EXTRA_KEY_CHARS) return false
  // 统一字段（id / name / type / room）由数据库单独列承载，
  // _ 前缀留给系统标记（_source 等），都不允许从外部属性里塞进来。
  if (key.startsWith('_')) return false
  if (key === 'id' || key === 'name' || key === 'type' || key === 'room') return false
  return true
}

function normalizeProperties(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const type = String(raw.type || '').trim().toLowerCase()
  if (!FEATURE_TYPE_SET.has(type)) {
    throw invalid('properties.type 必须是 furniture / wall / room 其中之一')
  }

  const name = String(raw.name || '').trim().slice(0, 40) || `未命名${TYPE_NAMES[type]}`
  const icon = String(raw.icon || '').trim().slice(0, 8)
  const color = /^#[0-9a-f]{6}$/i.test(String(raw.color || '')) ? String(raw.color).toLowerCase() : ''
  // 互动文本（任务书 1）：小鱼走到要素 30 单位内时触发的固定对话。
  // 空串 = 普通要素；最多 200 字，避免把 QQ 消息撑爆。
  const interactText = String(raw.interact_text || '').replace(/\s+/g, ' ').trim().slice(0, 200)

  // 任务书「动态属性表」：properties 不再做白名单收敛。
  // 除统一字段外的任意键（OBJECTID / BUILDING_N / HEIGHT …）原样透传，
  // 同一时刻也保护数据库不被畸形结构写坏。
  const properties = { type, name }
  if (icon) properties.icon = icon
  if (color) properties.color = color
  if (interactText) properties.interact_text = interactText
  let extraCount = 0
  for (const [key, rawValue] of Object.entries(raw)) {
    if (!isAllowedExtraKey(key)) continue
    if (extraCount >= MAX_EXTRA_KEYS) break
    const safeValue = allowedExtraValue(rawValue)
    if (safeValue === undefined) continue
    properties[key] = safeValue
    extraCount += 1
  }
  return properties
}

/* ---------------------------------------------------------------------------
 * 运行时改名兼容层（任务书「向下兼容」）
 *
 * 外部 SHP 的字段名千差万别：GB/T 标准叫 BUILDING_N，ESRI 默认给 Name，
 * 老一点的图层只有中文名。下游 A* 栅格、网页渲染和交互都只认
 * properties.name / properties.type 两个键。这里在要素入库 / 出库时
 * 补一层映射，原始字段一个都不删。
 * ------------------------------------------------------------------------- */

/** 名称候选键：命中任意一个就当作 name，优先级从高到低。 */
const NAME_ALIASES = Object.freeze([
  'name', 'Name', 'NAME', '名称', '名稱',
  'BUILDING_N', 'BUILDING_NAME', 'BLDG_N', 'BLDG_NAME',
  'FNAME', 'FULLNAME', 'FULL_NAME', 'title', 'TITLE', 'label', 'LABEL',
])

/** 外部要素兜底类型，A* / 渲染都不把它当障碍，只在地属性表里展示。 */
const DEFAULT_EXTERNAL_TYPE = 'shp_feature'
const FALLBACK_EXTERNAL_TYPE = 'landmark'

/**
 * 给一组外部属性补上下游契约要的 name / type，原始键原样保留。
 *
 * @param {object} properties 外部要素（如 SHP 解析出来）的属性对象
 * @param {{type?: string}} [hints] 已知类型提示（如 sourceFile 推出来的 kind）
 * @returns {object} 新对象：{ ...原始属性, name?, type? }
 */
function applyCompatProperties(properties, hints = {}) {
  const source = properties && typeof properties === 'object' && !Array.isArray(properties) ? properties : {}
  const merged = Object.assign({}, source)

  if (!String(merged.name || '').trim()) {
    for (const alias of NAME_ALIASES) {
      const candidate = source[alias]
      if (typeof candidate === 'string' && candidate.trim()) {
        merged.name = candidate.trim().slice(0, 80)
        break
      }
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        merged.name = String(candidate)
        break
      }
    }
  }

  if (!String(merged.type || '').trim()) {
    const hinted = String((hints && hints.type) || '').trim()
    merged.type = hinted || (String(source.kind || '').includes('landmark') ? FALLBACK_EXTERNAL_TYPE : DEFAULT_EXTERNAL_TYPE)
  }
  return merged
}

function newFeatureId() {
  return `feat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 校验并规范化一个 GeoJSON Feature。
 *
 * @param {object} input 前端送来的 Feature 对象
 * @returns {object} 干净的 Feature（带新分配的 id）
 * @throws {Error} 带 statusCode=400 的错误，message 可以直接回给前端
 */
function validateFeature(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('请求体需要是 GeoJSON Feature 对象')
  }
  if (String(input.type || '') !== 'Feature') throw invalid('type 必须是 "Feature"')

  return {
    type: 'Feature',
    id: String(input.id || newFeatureId()).slice(0, 60),
    properties: normalizeProperties(input.properties),
    geometry: normalizeGeometry(input.geometry),
  }
}

/* ---------------------------------------------------------------------------
 * 几何工具
 * ------------------------------------------------------------------------- */

function cellKey(i, j) {
  return `${i},${j}`
}

function ringBounds(ring) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

function geometryBounds(geometry) {
  const type = geometry && geometry.type
  if (type === 'Point') {
    const [x, y] = geometry.coordinates
    return [x, y, x, y]
  }
  if (type === 'LineString') return ringBounds(geometry.coordinates)
  if (type === 'Polygon') return ringBounds(geometry.coordinates[0])
  return [0, 0, 0, 0]
}

/** 射线法点在环内（环可闭合可不闭合）。 */
function pointInRing(x, y, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 点在多边形内：在外环内、且不在任一环洞内。 */
function pointInPolygon(x, y, rings) {
  if (rings.length === 0) return false
  if (!pointInRing(x, y, rings[0])) return false
  for (let index = 1; index < rings.length; index += 1) {
    if (pointInRing(x, y, rings[index])) return false
  }
  return true
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay)
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1)
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function pointToPolylineDistance(px, py, points) {
  let best = Infinity
  for (let index = 0; index < points.length - 1; index += 1) {
    const distance = pointToSegmentDistance(px, py, points[index][0], points[index][1], points[index + 1][0], points[index + 1][1])
    if (distance < best) best = distance
  }
  return best
}

/* ---------------------------------------------------------------------------
 * 栅格化
 * ------------------------------------------------------------------------- */

/**
 * 在 [x0,y0]-[x1,y1] 的外接盒范围内逐格回调。
 * @param {number[]} bounds
 * @param {(i:number, j:number, px:number, py:number)=>void} visit
 */
function visitBoundsCells(bounds, visit) {
  const i0 = clamp(Math.floor(bounds[0] / CELL_SIZE), 0, GRID_CELLS - 1)
  const j0 = clamp(Math.floor(bounds[1] / CELL_SIZE), 0, GRID_CELLS - 1)
  const i1 = clamp(Math.floor(bounds[2] / CELL_SIZE), 0, GRID_CELLS - 1)
  const j1 = clamp(Math.floor(bounds[3] / CELL_SIZE), 0, GRID_CELLS - 1)
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      visit(i, j, i * CELL_SIZE + CELL_SIZE / 2, j * CELL_SIZE + CELL_SIZE / 2)
    }
  }
}

/** 多边形的所有边（环集合）展开成线段端点列表。 */
function polygonSegments(rings) {
  const segments = []
  for (const ring of rings) {
    for (let index = 0; index < ring.length - 1; index += 1) {
      segments.push([ring[index], ring[index + 1]])
    }
  }
  return segments
}

/**
 * 把任意几何体覆盖的栅格收集出来。
 *
 * @param {object} geometry Point / LineString / Polygon
 * @param {(key:string)=>void} add 收到 "i,j" 格式的格子键
 */
function rasterizeGeometry(geometry, add) {
  const type = geometry && geometry.type
  if (!type) return

  if (type === 'Point') {
    const [x, y] = geometry.coordinates
    visitBoundsCells([x - OBSTACLE_RADIUS, y - OBSTACLE_RADIUS, x + OBSTACLE_RADIUS, y + OBSTACLE_RADIUS], (i, j, px, py) => {
      if (Math.hypot(px - x, py - y) <= OBSTACLE_RADIUS) add(cellKey(i, j))
    })
    return
  }

  if (type === 'LineString') {
    const points = geometry.coordinates
    const [minX, minY, maxX, maxY] = ringBounds(points)
    visitBoundsCells(
      [minX - OBSTACLE_RADIUS, minY - OBSTACLE_RADIUS, maxX + OBSTACLE_RADIUS, maxY + OBSTACLE_RADIUS],
      (i, j, px, py) => {
        if (pointToPolylineDistance(px, py, points) <= OBSTACLE_RADIUS) add(cellKey(i, j))
      },
    )
    return
  }

  if (type === 'Polygon') {
    const rings = geometry.coordinates
    // 面 = 实心填充 + 边界墙体。边界单独再扫一遍半径，小到只有一格缝的多边形
    // 也不会变成「画了跟没画一样」的幻影障碍。
    const segments = polygonSegments(rings)
    const [minX, minY, maxX, maxY] = ringBounds(rings[0])
    visitBoundsCells(
      [minX - OBSTACLE_RADIUS, minY - OBSTACLE_RADIUS, maxX + OBSTACLE_RADIUS, maxY + OBSTACLE_RADIUS],
      (i, j, px, py) => {
        if (pointInPolygon(px, py, rings)) {
          add(cellKey(i, j))
          return
        }
        for (const [a, b] of segments) {
          if (pointToSegmentDistance(px, py, a[0], a[1], b[0], b[1]) <= OBSTACLE_RADIUS) {
            add(cellKey(i, j))
            return
          }
        }
      },
    )
  }
}

/** features.json 的 FeatureCollection -> 要素数组（损坏时退空数组）；传数组则原样过滤一遍。 */
function featureList(collection) {
  const list = Array.isArray(collection)
    ? collection
    : collection && Array.isArray(collection.features)
      ? collection.features
      : []
  return list.filter((feature) => feature && typeof feature === 'object')
}

/**
 * 把全部自定义要素栅格化成 A* 可用的格集合。
 *
 * @param {Array|object} features 要素数组或 FeatureCollection
 * @returns {{blocked:Set<string>, passable:Set<string>}}
 *   blocked —— wall/furniture 要素盖住的格子，一律不可通行；
 *   passable —— room 多边形的内部格子，可以走进去；
 *   两者重叠时 blocked 胜出（在墙上画房间不等于能穿墙）。
 */
function featureCells(features) {
  const list = Array.isArray(features) ? features : featureList(features)
  const blocked = new Set()
  const passable = new Set()

  for (const feature of list) {
    const type = String(feature && feature.properties && feature.properties.type)
    if (isObstacleType(type)) {
      rasterizeGeometry(feature.geometry, (key) => blocked.add(key))
    } else if (type === 'room' && feature.geometry && feature.geometry.type === 'Polygon') {
      // 房间只取实心填充：边界不另加墙，靠门洞 / 与既有房间相接走进去。
      rasterizeGeometry(feature.geometry, (key) => passable.add(key))
    }
  }

  for (const key of passable) {
    if (blocked.has(key)) passable.delete(key)
  }
  return { blocked, passable }
}

/* ---------------------------------------------------------------------------
 * 拓扑检查支持
 * ------------------------------------------------------------------------- */

function pointCoveredByFeature(feature, x, y) {
  const geometry = feature && feature.geometry
  if (!geometry) return false
  if (geometry.type === 'Point') {
    const [px, py] = geometry.coordinates
    return Math.hypot(x - px, y - py) <= OBSTACLE_RADIUS
  }
  if (geometry.type === 'LineString') {
    return pointToPolylineDistance(x, y, geometry.coordinates) <= OBSTACLE_RADIUS
  }
  if (geometry.type === 'Polygon') {
    return pointInPolygon(x, y, geometry.coordinates)
  }
  return false
}

/**
 * 门洞里被这个要素盖住的寻路格中心占比过半，即视为堵门。
 * 与 buildWalkGrid 用同一把尺（格子中心点），所以「报堵门」和「小鱼真的
 * 过不去」永远是同一件事。
 *
 * @param {object} feature wall/furniture 要素
 * @param {{x0:number,y0:number,x1:number,y1:number}} door 门洞矩形
 * @returns {boolean}
 */
function featureBlocksDoor(feature, door) {
  const coverage = featureDoorCoverage(feature, door)
  return coverage.total > 0 && coverage.covered * 2 >= coverage.total
}

/**
 * 门洞矩形里有几个寻路格中心、其中几个被这个要素盖住。
 *
 * @returns {{covered:number, total:number}}
 */
function featureDoorCoverage(feature, door) {
  if (!isObstacleFeature(feature) || !door) return { covered: 0, total: 0 }

  const i0 = clamp(Math.floor(door.x0 / CELL_SIZE), 0, GRID_CELLS - 1)
  const j0 = clamp(Math.floor(door.y0 / CELL_SIZE), 0, GRID_CELLS - 1)
  const i1 = clamp(Math.floor(door.x1 / CELL_SIZE), 0, GRID_CELLS - 1)
  const j1 = clamp(Math.floor(door.y1 / CELL_SIZE), 0, GRID_CELLS - 1)

  let covered = 0
  let total = 0
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const px = i * CELL_SIZE + CELL_SIZE / 2
      const py = j * CELL_SIZE + CELL_SIZE / 2
      if (px < door.x0 || px > door.x1 || py < door.y0 || py > door.y1) continue
      total += 1
      if (pointCoveredByFeature(feature, px, py)) covered += 1
    }
  }
  return { covered, total }
}

/* ---------------------------------------------------------------------------
 * QGIS GeoJSON 直传导入（任务书 1「QGIS 数据无缝接入」）
 *
 * 与网页绘制（validateFeature）不同：QGIS 导出的要素字段千差万别，
 * 这里走一条更宽松的规范化路径——
 *   1. properties 里如果塞着长 JSON 串（props_json 之类），先 JSON.parse 展开；
 *   2. 强制提取 properties.map_level，没有就按请求级默认 / 赛博小屋；
 *   3. type 只保留有语义的那几个（wall / furniture / room / door / custom），
 *      其余（BUILDING、terrain 等任意 GIS 字段）一律按 shp_feature 只展示，
 *      绝不把整片导出区默默变成 A* 障碍；
 *   4. Multi* / GeometryCollection 拆成单部分几何，因为 A* 栅格化与
 *      前端渲染只认 Point / LineString / Polygon；
 *   5. 保留 element 级 id（缺则生成 qgis-<层级>-<序号>），重新导入按 id 覆盖。
 * ------------------------------------------------------------------------- */

/** 参数合法性提示。 */
const MAX_IMPORT_INPUTS = 500
const MAX_IMPORT_FEATURES = 2000

/** 可能内嵌长 JSON 串的属性键，命中就尝试展开（任务书点名 props_json）。 */
const EMBEDDED_JSON_KEYS = Object.freeze(['props_json', 'properties_json', 'props'])

/** 导入时允许保留的 type；不在表里的 type 一律降级为只展示的 shp_feature。 */
const IMPORT_TYPE_SET = new Set(['furniture', 'wall', 'room', 'door', 'custom', 'shp_feature', 'landmark'])
const IMPORT_FALLBACK_TYPE = 'shp_feature'

/** 属性键里以这些串结尾的，当作长 JSON 展开一次（去掉 _json 后缀比对）。 */
function looksLikeEmbeddedJsonKey(key) {
  return EMBEDDED_JSON_KEYS.some((suffix) => String(key).toLowerCase() === suffix)
}

/**
 * 把 properties 里内嵌的长 JSON 串展开：props_json / properties_json / props
 * 的值如果是 JSON 字符串，解析出来的键值合并回 properties（解析值优先）。
 * 解析失败（不是 JSON / 不是对象）就原样保留，不让一个畸形字段炸掉整次导入。
 */
function expandImportProperties(raw) {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
  for (const key of Object.keys(base)) {
    if (!looksLikeEmbeddedJsonKey(key)) continue
    const value = base[key]
    if (typeof value !== 'string' || !value.trim()) continue
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(base, parsed)
      }
    } catch {
      // 不是合法 JSON：保留原串，继续试下一个键。
    }
  }
  return base
}

/** 导入用的属性清洗：保留全部键（含 name / type / room 以外的一切外部字段）。 */
function sanitizeImportProperties(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const properties = {}
  let count = 0
  for (const [key, rawValue] of Object.entries(source)) {
    if (key.length > MAX_EXTRA_KEY_CHARS) continue
    if (count >= MAX_EXTRA_KEYS) break
    if (key === 'id' || key.startsWith('_')) continue
    const safeValue = allowedExtraValue(rawValue)
    if (safeValue === undefined) continue
    properties[key] = safeValue
    count += 1
  }
  return properties
}

/**
 * 把任意 GeoJSON 几何拆成单部分几何（Point / LineString / Polygon）。
 * QGIS 常导出 MultiPolygon / GeometryCollection，而 A* 栅格化与网页渲染
 * 只认单部分几何——拆开后每个部分是一条独立要素，id 加部分序号后缀。
 */
function explodeGeometry(geometry) {
  const type = geometry && geometry.type
  if (!type) return []
  if (type === 'Point' || type === 'LineString' || type === 'Polygon') {
    return Array.isArray(geometry.coordinates) ? [geometry] : []
  }
  if (type === 'MultiPoint' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.map((point) => ({ type: 'Point', coordinates: point }))
  }
  if (type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.map((line) => ({ type: 'LineString', coordinates: line }))
  }
  if (type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.map((polygon) => ({ type: 'Polygon', coordinates: polygon }))
  }
  if (type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    return geometry.geometries.flatMap((child) => explodeGeometry(child))
  }
  return []
}

/**
 * 规范化一个导入要素（宽松版，供 POST /api/fish-home/import-qgis 使用）。
 *
 * @param {object} input 导入的 GeoJSON Feature（或裸 geometry 对象）
 * @param {{mapLevel?:string, index?:number, idPrefix?:string}} [defaults]
 *   mapLevel —— 元素自己没有 map_level 时的缺省层级（请求级覆盖）
 * @returns {Array<object>} 拆分后的 Feature 数组（每条带 mapLevel）
 * @throws {Error} 带 statusCode=400 的错误
 */
function normalizeImportFeature(input, defaults = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('导入的每个成员必须是 GeoJSON Feature 对象')
  }

  // properties 优先从 input.properties 取；裸 geometry 对象兜底走空属性。
  const expanded = expandImportProperties(input.properties)

  // 强制提取 map_level（任务书 1）：元素级 > 请求级默认 > 赛博小屋。
  // 层级名不合法时直接报错，而不是静默把它塞进赛博小屋——
  // 否则用户传错层级名会在另一张图上找不到自己的数据。
  const rawLevel = String(expanded.map_level || defaults.mapLevel || '').trim()
  if (rawLevel && !isValidMapLevel(rawLevel)) {
    throw invalid(
      `map_level「${rawLevel}」不合法：只能用小写字母、数字、下划线、连字符（1–40 字），例如 village / forest`,
    )
  }
  const mapLevel = rawLevel ? normalizeMapLevel(rawLevel) : DEFAULT_MAP_LEVEL

  // type：只保留有 A* / 渲染语义的那几个，其余降级为只展示的 shp_feature。
  const rawType = String(expanded.type || '').trim().toLowerCase()
  const type = IMPORT_TYPE_SET.has(rawType) ? rawType : IMPORT_FALLBACK_TYPE

  // 名称：先按外部字段别名补一遍（Name / 名称 / BUILDING_N …），再没有就用默认名。
  const compat = applyCompatProperties(sanitizeImportProperties(expanded), { type })
  const properties = Object.assign({}, compat, { type })
  if (!String(properties.name || '').trim()) {
    properties.name = `QGIS要素-${defaults.index !== undefined ? defaults.index + 1 : 1}`
  }

  // 几何：Multi* / GeometryCollection 先拆成单部分，再逐个走严格校验。
  const parts = explodeGeometry(input.geometry)
  if (parts.length === 0) {
    throw invalid(
      `要素「${String(properties.name || '')}」没有可用的几何：只支持 Point / LineString / Polygon / Multi* / GeometryCollection`,
    )
  }

  const baseId = String(input.id || '').trim().slice(0, 52) || `qgis-${mapLevel}-${defaults.index !== undefined ? defaults.index : 0}`
  const features = []
  parts.forEach((part, partIndex) => {
    const geometry = normalizeGeometry(part)
    features.push({
      type: 'Feature',
      id: parts.length > 1 ? `${baseId}-${partIndex}`.slice(0, 60) : baseId.slice(0, 60),
      properties,
      geometry,
      mapLevel,
    })
  })
  return features
}

/**
 * 整体入口：一个 FeatureCollection、单个 Feature 或裸数组都收。
 * 逐条规范化，单条失败不影响其余（失败原因收集进 errors 一起返回）。
 *
 * @param {object|Array} payload 请求体
 * @param {{mapLevel?:string}} [defaults] 请求级默认层级
 * @returns {{features:Array, errors:Array, totalInputs:number}}
 * @throws {Error} 带 statusCode=400 的错误（请求体形状不对 / 全部失败）
 */
function normalizeImportFeatures(payload, defaults = {}) {
  let incoming = []
  if (Array.isArray(payload)) {
    incoming = payload
  } else if (payload && typeof payload === 'object' && Array.isArray(payload.features)) {
    incoming = payload.features
  } else if (payload && typeof payload === 'object' && String(payload.type || '') === 'Feature') {
    incoming = [payload]
  } else {
    throw invalid('请求体需要是标准 GeoJSON FeatureCollection（或单个 Feature）')
  }
  if (incoming.length === 0) throw invalid('没有收到任何要素')
  if (incoming.length > MAX_IMPORT_INPUTS) {
    throw invalid(`一次性最多导入 ${MAX_IMPORT_INPUTS} 个要素（当前 ${incoming.length} 个）`)
  }

  const features = []
  const errors = []
  incoming.forEach((input, index) => {
    try {
      const parts = normalizeImportFeature(input, {
        mapLevel: defaults.mapLevel,
        index,
      })
      features.push(...parts)
      if (features.length > MAX_IMPORT_FEATURES) {
        throw invalid(`拆分后要素总数超过上限（${MAX_IMPORT_FEATURES}），请分批导入`)
      }
    } catch (error) {
      errors.push(`第 ${index + 1} 个：${String(error && error.message || error).slice(0, 120)}`)
    }
  })

  if (features.length === 0) {
    throw invalid(`没有任何可导入的要素——${errors.join('；')}`)
  }
  return { features, errors, totalInputs: incoming.length }
}

module.exports = {
  FEATURE_TYPES,
  TYPE_NAMES,
  OBSTACLE_RADIUS,
  validateFeature,
  isObstacleType,
  isObstacleFeature,
  normalizeProperties,
  applyCompatProperties,
  NAME_ALIASES,
  DEFAULT_EXTERNAL_TYPE,
  isAllowedExtraKey,
  allowedExtraValue,
  featureList,
  featureCells,
  featureBlocksDoor,
  featureDoorCoverage,
  // QGIS 导入（任务书 1）
  normalizeImportFeature,
  normalizeImportFeatures,
  expandImportProperties,
  explodeGeometry,
  MAX_IMPORT_INPUTS,
  MAX_IMPORT_FEATURES,
  // 导出给单元测试用的几何工具
  pointInPolygon,
  geometryBounds,
}
