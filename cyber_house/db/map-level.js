'use strict'

/**
 * db/map-level.js —— 多层级地图底座（任务书 1）的层级名规范
 *
 * 一个极小的公共模块：db/index.js（features.map_level 列）、gis/features.js
 * （QGIS 导入时的 map_level 提取）、api-router.js（?map_level= 查询参数）、
 * state-engine.js（当前层级）四方共用同一把尺，杜绝 'Village ' 和 'village'
 * 被当成两张图。放在 db/ 下只是因为它最贴近 schema，本身不依赖任何模块，
 * 也不会引入 db <-> gis 的循环依赖。
 */

/** 默认地图层级：赛博小屋。旧数据、缺省值、网页首次打开都在这一层。 */
const DEFAULT_MAP_LEVEL = 'cyber_house'
/** map_level 的合法字符（小写字母 / 数字 / 下划线 / 连字符），长度 1–40。 */
const MAP_LEVEL_PATTERN = /^[a-z0-9_-]{1,40}$/

/**
 * 规范化地图层级名：去空格、转小写；不合法（空 / 含中文或空格 / 超长）时
 * 退回默认层。所有入库与查询参数都先过这一道。
 */
function normalizeMapLevel(value) {
  const text = String(value || '').trim().toLowerCase()
  return MAP_LEVEL_PATTERN.test(text) ? text : DEFAULT_MAP_LEVEL
}

/** 判断层级名是否合法（导入时用来给用户报错，而不是静默吞成默认层）。 */
function isValidMapLevel(value) {
  return MAP_LEVEL_PATTERN.test(String(value || '').trim().toLowerCase())
}

module.exports = {
  DEFAULT_MAP_LEVEL,
  MAP_LEVEL_PATTERN,
  normalizeMapLevel,
  isValidMapLevel,
}
