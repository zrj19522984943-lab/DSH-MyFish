'use strict'

/**
 * gis/pathfinder.js —— 栅格化 A* 寻路 + 分段三次贝塞尔平滑（纯算法，不读盘、不碰 this）
 *
 * 把 1000 x 1000 的世界切成 50 x 50 个 20 单元见方的栅格：
 *   - 格子中心落在某个房间内、或某个门洞内 -> 可通行
 *   - 格子中心压在家具矩形（x, y, w, h 转成绝对坐标）上 -> 不可通行
 * 8 方向移动，但禁止斜穿墙角：走对角线时其两个正交邻居也必须可通行。
 * 目标在同一个房间且直线无遮挡时不会动用 A*，直接游过去。
 *
 * A* 只给折线锚点；smoothPathWithCubicBezier 把锚点拼成绝对圆滑的
 * 分段三次贝塞尔点阵（任务书模块 1），smoothPathWithFallback 负责防穿模
 * 校验与回退（模块 3）：点阵里任何一个点切角压进家具 / 虚空，就降 smoothness
 * 重试，再不行退回直角折线。
 *
 * 本文件只做几何与路径计算。家具数据从哪里来、路线画在哪里，都不归它管。
 */

const { WORLD_SIZE, ROOMS_BY_NAME, clamp, GRID_CELLS, CELL_SIZE, cellKeyOf } = require('../world')
// GRID_CELLS / CELL_SIZE 原本就在本文件定义；提到 world.js 之后 gis/features.js
// 也能用同一套格子编号（buildWalkGrid 的 featureCells 参数），而不必互相 require。

const A_STAR_DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
]

/**
 * 家具的本地 x, y, w, h 转成世界坐标的障碍矩形。
 * 钳制规则和前端画图完全一致（中心钳进房间内），保证“看得见多宽”和“撞不了”是同一块区域。
 */
function furnitureObstacles(furniture, roomsByName = ROOMS_BY_NAME) {
  const out = []
  const rooms = (furniture && furniture.rooms) || {}

  for (const [roomName, roomFurniture] of Object.entries(rooms)) {
    const base = roomsByName[roomName]
    if (!base) continue
    const items = Array.isArray(roomFurniture && roomFurniture.items) ? roomFurniture.items : []
    for (const item of items) {
      const lx = Number(item.x)
      const ly = Number(item.y)
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue
      const w = Math.max(28, Number(item.w) || 58)
      const h = Math.max(28, Number(item.h) || 48)
      const cx = base.x + clamp(lx, w / 2, Math.max(w / 2, base.w - w / 2))
      const cy = base.y + clamp(ly, h / 2, Math.max(h / 2, base.h - h / 2))
      out.push({ room: roomName, type: String(item.type || item.name || item.id || '家具'), cx, cy, w, h })
    }
  }
  return out
}

/** furniture.doors 是世界绝对坐标 (x, y, w, h)，这里展开成 [x0, y0, x1, y1]。 */
function doorRects(furniture) {
  const doors = furniture && Array.isArray(furniture.doors) ? furniture.doors : []
  const out = []
  for (const door of doors) {
    const x = Number(door.x)
    const y = Number(door.y)
    const w = Number(door.w)
    const h = Number(door.h)
    if (![x, y, w, h].every(Number.isFinite)) continue
    out.push({
      name: String(door.name || door.id || '门'),
      type: String(door.type || 'door'),
      x0: Math.min(x, x + w),
      y0: Math.min(y, y + h),
      x1: Math.max(x, x + w),
      y1: Math.max(y, y + h),
    })
  }
  return out
}

/**
 * 建可通行栅格：passable[j][i] 为 true 表示 (i, j) 格可走。
 * 测的是格子中心点，和任务书的栅格化规则一致。
 *
 * @param {Array} rooms 房间数组
 * @param {Array} obstacles 家具障碍矩形（furnitureObstacles 的输出）
 * @param {Array} doors 门洞矩形（doorRects 的输出）
 * @param {{blocked:Set<string>, passable:Set<string>}|null} [featureCells]
 *   自定义要素（features.json）栅格化的结果：blocked 里的格子被盖住就不可走，
 *   passable 里的格子算作可走区域（在虚空里画的新房间）。两者冲突时 blocked 胜出。
 */
function buildWalkGrid(rooms, obstacles, doors, featureCells = null) {
  const passable = Array.from({ length: GRID_CELLS }, () => new Array(GRID_CELLS).fill(false))
  const cellCenterX = (i) => i * CELL_SIZE + CELL_SIZE / 2
  const cellCenterY = (j) => j * CELL_SIZE + CELL_SIZE / 2
  const insideAnyRoom = (px, py) => rooms.some(
    (room) => px >= room.x && px <= room.x + room.w && py >= room.y && py <= room.y + room.h,
  )
  const insideAnyDoor = (px, py) => doors.some(
    (door) => px >= door.x0 && px <= door.x1 && py >= door.y0 && py <= door.y1,
  )
  const hitFurniture = (px, py) => obstacles.some(
    (item) => px >= item.cx - item.w / 2 && px <= item.cx + item.w / 2
      && py >= item.cy - item.h / 2 && py <= item.cy + item.h / 2,
  )
  const hitFeature = featureCells && featureCells.blocked instanceof Set
    ? (px, py) => featureCells.blocked.has(cellKeyOf(px, py))
    : null
  const insideFeatureRoom = featureCells && featureCells.passable instanceof Set
    ? (px, py) => featureCells.passable.has(cellKeyOf(px, py))
    : null

  for (let j = 0; j < GRID_CELLS; j += 1) {
    for (let i = 0; i < GRID_CELLS; i += 1) {
      const px = cellCenterX(i)
      const py = cellCenterY(j)
      const blockedByFurniture = hitFurniture(px, py)
      const blockedByFeature = hitFeature ? hitFeature(px, py) : false
      const walkableArea = insideAnyRoom(px, py)
        || insideAnyDoor(px, py)
        || (insideFeatureRoom ? insideFeatureRoom(px, py) : false)
      passable[j][i] = !blockedByFurniture && !blockedByFeature && walkableArea
    }
  }
  return passable
}

/** 起点/终点可能落在不可通行格（或虚空）里：找最近的通行格。 */
function nearestPassableCell(passable, i, j) {
  const ci = clamp(Math.floor(i), 0, GRID_CELLS - 1)
  const cj = clamp(Math.floor(j), 0, GRID_CELLS - 1)
  if (passable[cj][ci]) return { i: ci, j: cj }

  let best = null
  let bestDistance = Infinity
  for (let jj = 0; jj < GRID_CELLS; jj += 1) {
    for (let ii = 0; ii < GRID_CELLS; ii += 1) {
      if (!passable[jj][ii]) continue
      const distance = (ii - ci) * (ii - ci) + (jj - cj) * (jj - cj)
      if (distance < bestDistance) {
        bestDistance = distance
        best = { i: ii, j: jj }
      }
    }
  }
  return best
}

function isPassablePoint(passable, x, y) {
  const i = Math.floor(x / CELL_SIZE)
  const j = Math.floor(y / CELL_SIZE)
  return i >= 0 && j >= 0 && i < GRID_CELLS && j < GRID_CELLS && Boolean(passable[j][i])
}

/** 起点到终点的直线是否被任何不可通行格切断。 */
function segmentBlocked(passable, ax, ay, bx, by) {
  const distance = Math.hypot(bx - ax, by - ay)
  const steps = Math.max(1, Math.ceil(distance / (CELL_SIZE / 2)))
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    if (!isPassablePoint(passable, ax + (bx - ax) * t, ay + (by - ay) * t)) return true
  }
  return false
}

/**
 * A* 本体。网格只有 2500 格，用 Map + 线性取最小 f 就足够快。
 * 返回途径格数组 [{i, j}, ...]，找不到路时返回 null。
 */
function findGridPath(passable, start, goal) {
  if (!passable[start.j] || !passable[start.j][start.i]) return null
  if (!passable[goal.j] || !passable[goal.j][goal.i]) return null

  const cellKey = (i, j) => j * GRID_CELLS + i
  const heuristic = (i, j) => Math.hypot(goal.i - i, goal.j - j)

  const open = new Map()
  const gScore = new Map()
  const cameFrom = new Map()
  const startKey = cellKey(start.i, start.j)
  gScore.set(startKey, 0)
  open.set(startKey, { i: start.i, j: start.j, f: heuristic(start.i, start.j) })

  while (open.size > 0) {
    let currentKey = null
    let current = null
    for (const [key, node] of open) {
      if (current === null || node.f < current.f) {
        currentKey = key
        current = node
      }
    }
    open.delete(currentKey)
    const g = gScore.get(currentKey)

    if (current.i === goal.i && current.j === goal.j) {
      const cells = []
      let key = currentKey
      while (key !== undefined) {
        cells.push({ i: key % GRID_CELLS, j: Math.floor(key / GRID_CELLS) })
        key = cameFrom.get(key)
      }
      cells.reverse()
      return cells
    }

    for (const [di, dj, cost] of A_STAR_DIRS) {
      const ni = current.i + di
      const nj = current.j + dj
      if (ni < 0 || nj < 0 || ni >= GRID_CELLS || nj >= GRID_CELLS) continue
      if (!passable[nj][ni]) continue
      if (cost > 1 && (!passable[current.j][ni] || !passable[nj][current.i])) continue

      const neighborKey = cellKey(ni, nj)
      const tentative = g + cost
      if (tentative < (gScore.get(neighborKey) ?? Infinity)) {
        gScore.set(neighborKey, tentative)
        cameFrom.set(neighborKey, currentKey)
        open.set(neighborKey, { i: ni, j: nj, f: tentative + heuristic(ni, nj) })
      }
    }
  }

  return null
}

/** 把栅格途径点压成"只在拐弯处保留节点"的折线。 */
function simplifyWaypoints(points) {
  if (points.length <= 2) return points.slice()
  const out = [points[0]]
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index - 1]
    const cur = points[index]
    const next = points[index + 1]
    if (
      Math.sign(next.x - cur.x) !== Math.sign(cur.x - prev.x)
      || Math.sign(next.y - cur.y) !== Math.sign(cur.y - prev.y)
    ) {
      out.push(cur)
    }
  }
  out.push(points[points.length - 1])
  return out
}

/**
 * 规划从 (fromX, fromY) 到 (toX, toY) 的路线。
 *
 * 这是原来 FishHomeStateEngine._planRoute 的核心逻辑，原样搬到这里：
 * - 直线不被任何障碍切断时返回 null，保持原来直线游动的行为；
 * - 被切断时跑 A*，返回"拐弯才保留节点"的途径点数组；
 * - 终点只有落在通行格内才使用精确坐标（用户点到家具上时只到最近的可走格）。
 *
 * 第 8 个参数是可选的：主引擎会把按家具签名缓存好的 `passable` 传进来，
 * 避免每 2 秒重新栅格化一次；单独调用时可以省略，函数会自己建栅格。
 *
 * @param {object} furniture furniture.json 内容
 * @param {Array} rooms 房间数组
 * @param {object} roomsByName 房间名 -> 房间（含中心）
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @param {{ passable?: boolean[][] }} [options]
 * @returns {Array<{x:number,y:number}>|null}
 */
function planRoute(furniture, rooms, roomsByName, fromX, fromY, toX, toY, options = {}) {
  const passable = options.passable || buildWalkGrid(
    rooms,
    furnitureObstacles(furniture, roomsByName),
    doorRects(furniture),
  )
  if (!segmentBlocked(passable, fromX, fromY, toX, toY)) return null

  const start = nearestPassableCell(passable, fromX / CELL_SIZE, fromY / CELL_SIZE)
  const goal = nearestPassableCell(passable, toX / CELL_SIZE, toY / CELL_SIZE)
  if (!start || !goal) return null

  const cells = findGridPath(passable, start, goal)
  if (!cells || cells.length === 0) return null

  const points = cells.map((cell) => ({
    x: cell.i * CELL_SIZE + CELL_SIZE / 2,
    y: cell.j * CELL_SIZE + CELL_SIZE / 2,
  }))
  if (isPassablePoint(passable, toX, toY)) {
    points[points.length - 1] = { x: toX, y: toY }
  }
  return simplifyWaypoints(points)
}

// ---------------------------------------------------------------------
// 分段三次贝塞尔平滑（任务书「60帧丝滑移动引擎」模块 1 + 模块 3）
// ---------------------------------------------------------------------

/** 每相邻两个锚点之间采样多少次（任务书要求 10-20 次，14 段足够密又不至于爆炸）。 */
// @doc house.motion
const BEZIER_SAMPLES = 14

/**
 * 把 A* 的折线锚点 [P0, P1, ..., Pn] 拼成分段三次贝塞尔曲线。
 *
 * 核心原理：以每个拐点两侧邻居的弦方向（局部切向量）生成控制点，
 * 每相邻两个锚点 (Start, End) 之间放一条三次贝塞尔
 *   B(t) = (1-t)³·Start + 3(1-t)²t·CP1 + 3(1-t)t²·CP2 + t³·End
 * 首尾锚点直接保留（端点不平滑），中间锚点处曲线切线连续，
 * 于是整条曲线绝对圆滑、又只经过 A* 认为可走的位置附近。
 * 相比一条高次贝塞尔，分段不会发生龙格现象、也不会在远端失控穿墙。
 *
 * @param {Array<{x:number,y:number}>} points 锚点（A* 的拐点 + 起点 + 终点）
 * @param {number} [smoothness=0.2] 控制点沿切向量的收缩比例，0 < s < 0.5；
 *   越大越圆润（也越容易切角），越小越贴着折线
 * @returns {Array<{x:number,y:number}>} 极其密集的圆滑坐标数组
 */
// @doc house.motion
function smoothPathWithCubicBezier(points, smoothness = 0.2) {
  if (!Array.isArray(points)) return []
  if (points.length < 2) return points.slice()

  const anchors = points
    .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (anchors.length < 2) return points.slice()

  const ratio = Math.min(0.45, Math.max(0, Number(smoothness) || 0))
  if (ratio <= 0) return anchors

  /**
   * 锚点 i 处的切向量：中间拐点取两侧邻居的弦（局部切线）；
   * 首尾没有两侧邻居，就取唯一那条邻边——离开起点 / 进入终点时
   * 曲线先沿着直线方向，不会一上来就横着甩出去。
   */
  const tangent = (i) => {
    const cur = anchors[i]
    if (i <= 0) {
      const next = anchors[1]
      return { x: next.x - cur.x, y: next.y - cur.y }
    }
    if (i >= anchors.length - 1) {
      const prev = anchors[anchors.length - 2]
      return { x: cur.x - prev.x, y: cur.y - prev.y }
    }
    const prev = anchors[i - 1]
    const next = anchors[i + 1]
    return { x: next.x - prev.x, y: next.y - prev.y }
  }

  const dense = [anchors[0]]
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const start = anchors[i]
    const end = anchors[i + 1]
    // CP1 靠近 Start（沿 Start 处切向量伸出），CP2 靠近 End（沿 End 处切向量收回）
    const tangentStart = tangent(i)
    const tangentEnd = tangent(i + 1)
    const cp1 = {
      x: start.x + tangentStart.x * ratio,
      y: start.y + tangentStart.y * ratio,
    }
    const cp2 = {
      x: end.x - tangentEnd.x * ratio,
      y: end.y - tangentEnd.y * ratio,
    }

    // 跳过 t=0：上一段的 t=1 就是本段起点，避免锚点重复出现两次
    for (let sample = 1; sample <= BEZIER_SAMPLES; sample += 1) {
      const t = sample / BEZIER_SAMPLES
      const u = 1 - t
      const a = u * u * u
      const b = 3 * u * u * t
      const c = 3 * u * t * t
      const d = t * t * t
      dense.push({
        x: a * start.x + b * cp1.x + c * cp2.x + d * end.x,
        y: a * start.y + b * cp1.y + c * cp2.y + d * end.y,
      })
    }
  }
  return dense
}

/**
 * 判断贝塞尔点阵上有没有任何一个点"切角穿墙"（任务书模块 3 的安全校验）。
 *
 * 判据两层，都比较便宜：
 *   1. 该点所在的 A* 栅格必须可通行——A* 栅格是"可走区域"的唯一权威，
 *      它同时编码了房间、门洞、家具格与网页画的自建墙 / 自建房间；
 *      落进虚空、墙缝或被封住的格子的插值点都会在这里现形；
 *   2. 精确点不能压在任何家具矩形上——栅格只按格心判定，角落伸进
 *      可通行格的家具（最小 28×28，格宽 20）需要点级再判一次。
 *
 * 第一个锚点（小鱼脚下）不参与校验：它是既成事实，不是曲线造成的。
 *
 * @param {Array<{x:number,y:number}>} dense 平滑后的密集点阵
 * @param {boolean[][]} passable buildWalkGrid 的可通行栅格
 * @param {Array} obstacles furnitureObstacles 的输出（cx / cy / w / h）
 * @returns {boolean} true 表示整条曲线都没穿模
 */
function smoothPathIsSafe(dense, passable, obstacles) {
  if (!Array.isArray(dense) || !Array.isArray(passable)) return true
  const list = Array.isArray(obstacles) ? obstacles : []
  for (let index = 1; index < dense.length; index += 1) {
    const point = dense[index]
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
    if (!isPassablePoint(passable, point.x, point.y)) return false
    const hitFurniture = list.some((item) => (
      point.x >= item.cx - item.w / 2
      && point.x <= item.cx + item.w / 2
      && point.y >= item.cy - item.h / 2
      && point.y <= item.cy + item.h / 2
    ))
    if (hitFurniture) return false
  }
  return true
}

/**
 * 带安全回退的平滑：先用默认 smoothness（0.2）生成贝塞尔点阵并校验；
 * 校验不过（切角穿墙）就把 smoothness 降到 0.1 再来一次；
 * 再不过就彻底退回 A* 的直角折线——宁可直角急转，也不要穿模卡进沙发。
 *
 * @returns {{points: Array<{x:number,y:number}>, smoothness: number}}
 *   smoothness = 0 表示这次走的是直角折线兜底
 */
// @doc house.motion
function smoothPathWithFallback(anchors, passable, obstacles, smoothness = 0.2) {
  if (!Array.isArray(anchors) || anchors.length < 2) {
    return { points: Array.isArray(anchors) ? anchors.slice() : [], smoothness: 0 }
  }

  const primary = smoothPathWithCubicBezier(anchors, smoothness)
  if (smoothPathIsSafe(primary, passable, obstacles)) {
    return { points: primary, smoothness }
  }

  const lowered = Math.min(smoothness, 0.1)
  const retry = smoothPathWithCubicBezier(anchors, lowered)
  if (smoothPathIsSafe(retry, passable, obstacles)) {
    return { points: retry, smoothness: lowered }
  }

  return { points: anchors.slice(), smoothness: 0 }
}

/**
 * 一步到位的"平滑寻路"：栅格 + A* + 折线简化，再接分段贝塞尔 + 安全校验。
 *
 * 返回内容：
 *   - waypoints：A* 的直角折线锚点（直线可达时为 null，含义与 planRoute 一致）；
 *   - anchors：真正喂给贝塞尔的锚点（= 脚下位置 + waypoints）；
 *   - smoothPath：{ points, smoothness } —— 前端 60 帧引擎直接消费的密集点阵。
 *
 * @param {object} furniture
 * @param {Array} rooms
 * @param {object} roomsByName
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @param {{passable?:boolean[][], obstacles?:Array, doors?:Array, smoothness?:number}} [options]
 *   可以把主引擎缓存好的 passable / obstacles 传进来，避免重复栅格化
 * @returns {{waypoints: Array|null, anchors: Array, smoothPath: {points: Array, smoothness: number}}}
 */
// @doc house.motion
function planSmoothRoute(furniture, rooms, roomsByName, fromX, fromY, toX, toY, options = {}) {
  const obstacles = options.obstacles || furnitureObstacles(furniture, roomsByName)
  const doors = options.doors || doorRects(furniture)
  const passable = options.passable || buildWalkGrid(rooms, obstacles, doors)

  const waypoints = planRoute(furniture, rooms, roomsByName, fromX, fromY, toX, toY, { passable })
  const anchors = [{ x: fromX, y: fromY }].concat(waypoints || [{ x: toX, y: toY }])
  const smoothPath = smoothPathWithFallback(anchors, passable, obstacles, options.smoothness)

  return { waypoints, anchors, smoothPath }
}

module.exports = {
  GRID_CELLS,
  CELL_SIZE,
  BEZIER_SAMPLES,
  furnitureObstacles,
  doorRects,
  buildWalkGrid,
  nearestPassableCell,
  isPassablePoint,
  segmentBlocked,
  findGridPath,
  simplifyWaypoints,
  planRoute,
  smoothPathWithCubicBezier,
  smoothPathIsSafe,
  smoothPathWithFallback,
  planSmoothRoute,
}
