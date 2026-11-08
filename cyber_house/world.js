'use strict'

/**
 * world.js —— 赛博小屋的共享世界定义
 *
 * 这里只放**纯数据与纯数学**：
 *   - 1000 x 1000 的世界尺寸、6 个房间、房间中心；
 *   - 活动画像 / 房间默认状态 / 房间到活动的映射；
 *   - 活动推断的时间窗口默认值；
 *   - clamp / roundCoordinate 两个无副作用的小工具。
 *
 * 为什么单独抽一层：GIS（pathfinder / topology）、telemetry 和主引擎都要用同一套
 * 房间坐标。如果让 gis/ 去 require telemetry/，或者反过来，模块边界就乱了。
 * 把“世界是什么”放在这里，三边都只依赖它，谁都不依赖谁。
 *
 * 本文件不读盘、不联网、不持有状态。
 */

const WORLD_SIZE = 1000

/**
 * 6 个房间的位置同时供后端推演和前端绘制使用。
 * 坐标是 1000 x 1000 世界坐标，不是屏幕像素。
 */
const ROOMS = Object.freeze([
  { name: '卧室', x: 55, y: 50, w: 285, h: 260, color: '#9b8cff' },
  { name: '书房', x: 400, y: 40, w: 220, h: 370, color: '#4cc9f0' },
  { name: '影音角', x: 680, y: 70, w: 265, h: 230, color: '#ff7694' },
  { name: '厨房', x: 55, y: 440, w: 245, h: 420, color: '#f5c451' },
  { name: '客厅', x: 350, y: 500, w: 365, h: 380, color: '#47d7a0' },
  { name: '阳台', x: 765, y: 440, w: 180, h: 420, color: '#b8e35d' },
])

const ROOMS_BY_NAME = Object.freeze(
  Object.fromEntries(
    ROOMS.map((room) => [
      room.name,
      Object.freeze({
        ...room,
        cx: room.x + room.w / 2,
        cy: room.y + room.h / 2,
      }),
    ]),
  ),
)

const ACTIVITY_PROFILES = Object.freeze({
  qq: Object.freeze({ room: '客厅', status: '聊 QQ' }),
  bilibili: Object.freeze({ room: '影音角', status: '刷 B 站' }),
  coding: Object.freeze({ room: '书房', status: '写代码' }),
  sleeping: Object.freeze({ room: '卧室', status: '休息' }),
  cooking: Object.freeze({ room: '厨房', status: '做饭' }),
  idle: Object.freeze({ room: '阳台', status: '待机' }),
})

const DEFAULT_ACTIVITY = ACTIVITY_PROFILES.idle

const ROOM_DEFAULT_STATUS = Object.freeze({
  客厅: ACTIVITY_PROFILES.qq.status,
  书房: ACTIVITY_PROFILES.coding.status,
  卧室: ACTIVITY_PROFILES.sleeping.status,
  影音角: ACTIVITY_PROFILES.bilibili.status,
  厨房: ACTIVITY_PROFILES.cooking.status,
  阳台: ACTIVITY_PROFILES.idle.status,
})

const ROOM_TO_ACTIVITY = Object.freeze({
  客厅: 'qq',
  书房: 'coding',
  卧室: 'sleeping',
  影音角: 'bilibili',
  厨房: 'cooking',
  阳台: 'idle',
})

/**
 * 活动推断的时间窗口默认值。
 *
 * 放在 world 而不是 telemetry：它是“这个屋子怎么理解活动”的领域参数，
 * state-engine 也把它原样导出给设置/测试；telemetry 只负责按它读档。
 */
const DEFAULT_ACTIVITY_WINDOWS = Object.freeze({
  workPendingMs: 30 * 60 * 1000,
  workRecentMs: 10 * 60 * 1000,
  longTaskIdleMs: 5 * 60 * 1000,
  biliRecentMs: 8 * 60 * 1000,
  qqRecentMs: 5 * 60 * 1000,
  qqPendingMs: 3 * 60 * 1000,
})

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function roundCoordinate(value) {
  return Math.round(value * 10) / 10
}

/**
 * 寻路栅格：把 1000 × 1000 的世界切成 50 × 50 个 20 单元见方的格子。
 * 定义放这里（而不是 gis/pathfinder.js），因为 gis/pathfinder 与 gis/features
 * 都要用同一套格子编号规则，而它俩不能互相 require——否则就是循环依赖。
 */
const GRID_CELLS = 50
const CELL_SIZE = WORLD_SIZE / GRID_CELLS

/** 世界坐标 -> 「i,j」格子键（i 列 / j 行，同一套规则全项目共享）。 */
function cellKeyOf(px, py) {
  const i = clamp(Math.floor(px / CELL_SIZE), 0, GRID_CELLS - 1)
  const j = clamp(Math.floor(py / CELL_SIZE), 0, GRID_CELLS - 1)
  return `${i},${j}`
}

module.exports = {
  WORLD_SIZE,
  ROOMS,
  ROOMS_BY_NAME,
  ACTIVITY_PROFILES,
  DEFAULT_ACTIVITY,
  ROOM_DEFAULT_STATUS,
  ROOM_TO_ACTIVITY,
  DEFAULT_ACTIVITY_WINDOWS,
  clamp,
  roundCoordinate,
  GRID_CELLS,
  CELL_SIZE,
  cellKeyOf,
}
