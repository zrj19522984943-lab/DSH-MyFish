'use strict'

/**
 * db/wkt.js —— GeoJSON 几何与 WKT 字符串互转（纯算法，不读盘）
 *
 * 空间数据库统一用 `features.wkt` 保存几何（WKT 1，世界坐标，无 SRID 前缀）。
 * 这样即使 SpatiaLite 原生扩展在 Windows 上加载失败，SQLite 里仍然是一份
 * 可读、可查、可导出的标准几何；Node 侧再用 Turf 做精确相交判断。
 *
 * 支持 Point / LineString / Polygon 以及对应的 Multi* 类型。
 * 坐标统一保留 1 位小数（与 world.roundCoordinate 同一口径），避免同一块
 * 几何因为浮点尾数在「存进去 / 读出来」之后被判定成不同。
 */

const { roundCoordinate } = require('../world')

/* ---------------------------------------------------------------------------
 * 数字与环
 * ------------------------------------------------------------------------- */

function formatNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`WKT 坐标不是有效数字：${value}`)
  const rounded = roundCoordinate(number)
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

function formatPoint(point) {
  if (!Array.isArray(point) || point.length < 2) throw new Error('坐标点必须是 [x, y]')
  return `${formatNumber(point[0])} ${formatNumber(point[1])}`
}

/** 补上首尾相接；不足 3 个点的环原样返回，交给调用方决定是否合法。 */
function closeRing(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return []
  const points = ring.map((point) => [Number(point[0]), Number(point[1])])
  const first = points[0]
  const last = points[points.length - 1]
  if (points.length >= 3 && (first[0] !== last[0] || first[1] !== last[1])) {
    points.push([first[0], first[1]])
  }
  return points
}

function ringWkt(ring) {
  return `(${closeRing(ring).map(formatPoint).join(', ')})`
}

/* ---------------------------------------------------------------------------
 * GeoJSON -> WKT
 * ------------------------------------------------------------------------- */

/**
 * 任意 GeoJSON geometry -> WKT 字符串。
 *
 * @param {object} geometry GeoJSON geometry
 * @returns {string} 例如 `POLYGON ((55 50, 340 50, 340 310, 55 310, 55 50))`
 * @throws {Error} 几何缺失 / 类型不支持 / 坐标不合法
 */
function geometryToWkt(geometry) {
  if (!geometry || typeof geometry !== 'object') throw new Error('geometry 缺失')
  const type = String(geometry.type || '')
  const coordinates = geometry.coordinates

  switch (type) {
    case 'Point':
      if (!Array.isArray(coordinates)) throw new Error('Point 缺少 coordinates')
      return `POINT (${formatPoint(coordinates)})`

    case 'LineString':
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        throw new Error('LineString 至少需要 2 个点')
      }
      return `LINESTRING (${coordinates.map(formatPoint).join(', ')})`

    case 'Polygon':
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        throw new Error('Polygon 至少需要一个环')
      }
      return `POLYGON (${coordinates.map(ringWkt).join(', ')})`

    case 'MultiPoint':
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        throw new Error('MultiPoint 至少需要一个点')
      }
      return `MULTIPOINT (${coordinates.map((point) => `(${formatPoint(point)})`).join(', ')})`

    case 'MultiLineString':
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        throw new Error('MultiLineString 至少需要一条线')
      }
      return `MULTILINESTRING (${coordinates.map((line) => `(${line.map(formatPoint).join(', ')})`).join(', ')})`

    case 'MultiPolygon':
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        throw new Error('MultiPolygon 至少需要一个面')
      }
      return `MULTIPOLYGON (${coordinates
        .map((polygon) => `(${polygon.map(ringWkt).join(', ')})`)
        .join(', ')})`

    default:
      throw new Error(`不支持的几何类型：${type || '(空)'}`)
  }
}

/* ---------------------------------------------------------------------------
 * WKT -> GeoJSON
 * ------------------------------------------------------------------------- */

function tokenizeWkt(text) {
  const tokens = String(text).match(/[A-Za-z]+|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[(),]/g)
  if (!tokens || tokens.length === 0) throw new Error('WKT 为空')
  return tokens
}

/**
 * 递归解析括号组：`(1 2, 3 4)` -> `[[1,2],[3,4]]`。
 * 数字节点是 number，分组节点是数组——几何类型决定它最终的嵌套层级。
 */
function parseWktTree(tokens, cursor) {
  const state = cursor || { index: 0 }

  function expect(token) {
    if (tokens[state.index] !== token) {
      throw new Error(`WKT 解析失败：期望 ${token}，实际 ${tokens[state.index] ?? '结束'}`)
    }
    state.index += 1
  }

  function parseGroup() {
    expect('(')
    const group = []
    if (tokens[state.index] === ')') {
      state.index += 1
      return group
    }
    for (;;) {
      if (tokens[state.index] === '(') {
        group.push(parseGroup())
      } else {
        const token = tokens[state.index]
        if (token === undefined || token === ')' || token === ',') {
          throw new Error('WKT 解析失败：括号内缺少坐标')
        }
        // WKT 的一个坐标是空格分隔的数字序列（通常是 x y，也允许 Z/M 多一维），
        // 逗号才是坐标之间的分隔符。这里把一个坐标收成一个 tuple。
        const tuple = []
        while (tokens[state.index] !== undefined && tokens[state.index] !== ',' && tokens[state.index] !== ')' && tokens[state.index] !== '(') {
          const number = Number(tokens[state.index])
          if (!Number.isFinite(number)) throw new Error(`WKT 解析失败：非法数字 ${tokens[state.index]}`)
          tuple.push(number)
          state.index += 1
        }
        if (tuple.length < 2) throw new Error('WKT 解析失败：坐标至少需要 x 和 y')
        group.push(tuple)
      }

      if (tokens[state.index] === ',') {
        state.index += 1
        continue
      }
      expect(')')
      return group
    }
  }

  return { group: parseGroup(), state }
}

function pairOf(value) {
  if (!Array.isArray(value) || value.length < 2) throw new Error('WKT 坐标对不完整')
  const x = Number(value[0])
  const y = Number(value[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('WKT 坐标不是数字')
  return [roundCoordinate(x), roundCoordinate(y)]
}

/**
 * WKT -> GeoJSON geometry。
 *
 * @param {string} wkt
 * @returns {object} GeoJSON geometry
 * @throws {Error} 空 WKT / 不支持的几何类型 / 结构不完整
 */
function wktToGeometry(wkt) {
  const text = String(wkt || '').trim()
  if (!text) throw new Error('WKT 为空')

  // 兼容带 SRID 前缀的导出（EPSG:0/3857 都只当作普通平面坐标）。
  const withoutSrid = text.replace(/^SRID\s*=\s*\d+\s*;\s*/i, '')
  const tokens = tokenizeWkt(withoutSrid)
  let index = 0
  const type = String(tokens[index++] || '').toUpperCase()
  if (!type) throw new Error('WKT 缺少几何类型')

  // 可选的 Z / M / ZM 维度标记：只取前两维。
  if (/^(?:Z|M|ZM)$/.test(tokens[index] || '')) index += 1
  if (String(tokens[index] || '').toUpperCase() === 'EMPTY') {
    index += 1
    if (type === 'POINT') return { type: 'Point', coordinates: [] }
    if (type === 'LINESTRING') return { type: 'LineString', coordinates: [] }
    if (type === 'POLYGON') return { type: 'Polygon', coordinates: [] }
  }

  const parsed = parseWktTree(tokens, { index })
  const group = parsed.group

  if (type === 'POINT') {
    // group 是 [tuple]，例如 [[350, 500]]
    return { type: 'Point', coordinates: pairOf(group[0]) }
  }
  if (type === 'LINESTRING') {
    return {
      type: 'LineString',
      coordinates: group.map((point) => pairOf(point)),
    }
  }
  if (type === 'POLYGON') {
    return {
      type: 'Polygon',
      coordinates: group.map((ring) => closeRing(ring.map((point) => pairOf(point)))),
    }
  }
  if (type === 'MULTIPOINT') {
    // 标准写法是 ((x y), ...)，也有旧实现写成 (x y, ...)。
    // 前者解析成 [[[x,y]], [[x,y]]]，后者是 [[x,y], [x,y]]，统一摊平。
    const points = group.map((point) =>
      Array.isArray(point[0]) ? pairOf(point[0]) : pairOf(point),
    )
    return { type: 'MultiPoint', coordinates: points }
  }
  if (type === 'MULTILINESTRING') {
    return {
      type: 'MultiLineString',
      coordinates: group.map((line) => line.map((point) => pairOf(point))),
    }
  }
  if (type === 'MULTIPOLYGON') {
    return {
      type: 'MultiPolygon',
      coordinates: group.map((polygon) =>
        polygon.map((ring) => closeRing(ring.map((point) => pairOf(point)))),
      ),
    }
  }

  throw new Error(`不支持的 WKT 几何类型：${type}`)
}

/** 只读几何类型前缀，避免为了查类型把整个 WKT 解析一遍。 */
function wktType(wkt) {
  const match = String(wkt || '').trim().match(/^(?:SRID\s*=\s*\d+\s*;\s*)?([A-Za-z]+)/)
  return match ? match[1].toUpperCase() : ''
}

/* ---------------------------------------------------------------------------
 * 包围盒
 * ------------------------------------------------------------------------- */

/** 递归收集坐标对。 */
function collectCoordinates(node, out) {
  if (!Array.isArray(node)) return
  if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
    out.push([node[0], node[1]])
    return
  }
  for (const child of node) collectCoordinates(child, out)
}

/**
 * 几何包围盒 [minX, minY, maxX, maxY]。
 * 空几何返回 null；调用方决定是跳过还是报错。
 */
function geometryBounds(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null
  const points = []
  collectCoordinates(geometry.coordinates, points)
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    const nx = Number(x)
    const ny = Number(y)
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue
    if (nx < minX) minX = nx
    if (ny < minY) minY = ny
    if (nx > maxX) maxX = nx
    if (ny > maxY) maxY = ny
  }
  if (!Number.isFinite(minX)) return null
  return [roundCoordinate(minX), roundCoordinate(minY), roundCoordinate(maxX), roundCoordinate(maxY)]
}

/** WKT 的包围盒；解析失败返回 null。 */
function wktBounds(wkt) {
  try {
    return geometryBounds(wktToGeometry(wkt))
  } catch {
    return null
  }
}

module.exports = {
  geometryToWkt,
  wktToGeometry,
  wktType,
  geometryBounds,
  wktBounds,
  closeRing,
  formatNumber,
}
