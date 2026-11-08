/**
 * gistools.test.mjs —— gis_buffer_query / gis_delete_feature 的工具形状与行为
 *
 * 两个工具内部都 createRequire(...).require(<工作区>/cyber_house/state-engine.js)，
 * 所以测试直接用真实工作区（D:\demo\workspace），对会改的两个文件做
 * 备份/恢复（同 cyber_house/.headless/delete-e2e.js 的做法），跑完原样还原：
 *   1. 缓冲查询：以小鱼位置为圆心能圈到要素；半径钳制；只读不改盘面；
 *   2. 删除：按 id 删 / 按名字删 / 多义名字拒绝 / 不存在报错；删完落盘；
 *   3. 注册参数与 FISH_TOOLS 白名单对得上（restrict 取交集，漏一个就解锁失败）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { registerBufferQuery, bufferQueryReport, GIS_BUFFER_QUERY_TOOL_NAME } from '../lib/gisbuffer.js'
import { registerDeleteFeature, deleteFeatureByIdOrName, GIS_DELETE_FEATURE_TOOL_NAME } from '../lib/gisdelete.js'
import { FISH_TOOLS } from '../lib/restrict.js'

const WORKSPACE = fileURLToPath(new URL('../../../', import.meta.url))
const HOUSE = join(WORKSPACE, 'cyber_house')
const FURNITURE = join(HOUSE, 'furniture.json')
const FEATURES = join(HOUSE, 'features.json')
const requireModule = createRequire(import.meta.url)

function openStore() {
  const dbModule = requireModule(join(HOUSE, 'db', 'index.js'))
  return dbModule.openDatabase({ workspaceRoot: WORKSPACE, fresh: true })
}

/**
 * 备份数据库里的家具 + 自定义要素，返回恢复函数。
 * 数据层迁移到 SQLite 后，删除测试会直接改数据库，不能只备份 JSON。
 */
function snapshot() {
  const store = openStore()
  const furniture = structuredClone(store.furnitureDoc())
  const custom = store.listRows({ source: 'custom' }).map((row) => store.rowToFeature(row))
  return () => {
    store.replaceFurniture(furniture)
    for (const row of store.listRows({ source: 'custom' })) store.deleteFeature(row.id)
    if (custom.length > 0) store.upsertFeatures(custom, { source: 'custom' })
    store.close()
  }
}

function readFurniture() {
  return JSON.parse(readFileSync(FURNITURE, 'utf8'))
}

function fakeCtx() {
  const tools = []
  return {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    registered: tools,
  }
}

test('gis_buffer_query：以小鱼位置为圆心圈到要素，且不改盘面', () => {
  const restore = snapshot()
  try {
    const before = readFileSync(FURNITURE, 'utf8')
    const out = bufferQueryReport(WORKSPACE, 200)
    assert.equal(out.ok, true, out.note)
    assert.match(out.text, /200 单位内/)
    // 圈里至少有一件家具或一个门（真实家具布局下 200 半径足够大）
    assert.ok(out.text.length > 20, '名单不能是空的：' + out.text)
    assert.ok(!/小鱼/.test(out.text.split('\n')[0]), '名单里不应包含她自己')
    // 纯只读：文件一个字节都不能动
    assert.equal(readFileSync(FURNITURE, 'utf8'), before)
  } finally {
    restore()
  }
})

test('gis_buffer_query：半径不合法时退回默认 150', () => {
  const restore = snapshot()
  try {
    const out = bufferQueryReport(WORKSPACE, NaN)
    assert.equal(out.ok, true, out.note)
    assert.match(out.text, /150 单位内/)
  } finally {
    restore()
  }
})

test('gis_buffer_query：没家具没自定义要素时只报房间结构', () => {
  const restore = snapshot()
  try {
    // 房间多边形来自 state-engine 的 ROOMS 常量（屋子结构），不是数据库行：
    // 家具 / 门洞清空后圈里仍然会有房间，但绝不该再有家具 / 门 / 自定义要素。
    const store = openStore()
    store.replaceFurniture({ rooms: {}, doors: [] })
    for (const row of store.listRows({ source: 'custom' })) store.deleteFeature(row.id)
    store.close()
    const out = bufferQueryReport(WORKSPACE, 300)
    assert.equal(out.ok, true, out.note)
    assert.match(out.text, /单位内/)
    // 名单里只能剩房间（书房 / 客厅 …）与屋里的 NPC，不能有家具或门。
    // 真实工作区里 NPC 也会被缓冲区圈到（借手/拟南芥），所以不再假设名单只有房间。
    const names = out.text.split('\n').slice(1)
    assert.ok(names.length > 0, '至少能圈到自己所在的房间')
    for (const line of names) {
      const roomNames = ['卧室', '书房', '影音角', '厨房', '客厅', '阳台']
      assert.ok(
        roomNames.some((r) => line.startsWith(r + ' ·')) || line.startsWith('拟南芥') || line.startsWith('借手'),
        '这一行不该是非房间/非 NPC 要素：' + line,
      )
    }
  } finally {
    restore()
  }
})

test('gis_delete_feature：按 id 删家具并落盘', () => {
  const restore = snapshot()
  try {
    const out = deleteFeatureByIdOrName(WORKSPACE, 'living-sofa')
    assert.equal(out.ok, true, out.note)
    assert.match(out.text, /已收走/)
    assert.match(out.text, /A\* 寻路栅格已经刷新/)
    const rooms = readFurniture().rooms
    assert.ok(!rooms['客厅'].items.some((i) => i.id === 'living-sofa'), '沙发应从盘面消失')
  } finally {
    restore()
  }
})

test('gis_delete_feature：按名字删（“把沙发删了”）', () => {
  const restore = snapshot()
  try {
    const out = deleteFeatureByIdOrName(WORKSPACE, '沙发')
    assert.equal(out.ok, true, out.note)
    assert.match(out.text, /已收走：沙发/)
    assert.match(out.text, /按名字找到的/)
    const rooms = readFurniture().rooms
    assert.ok(!rooms['客厅'].items.some((i) => /沙发/.test(i.type)))
  } finally {
    restore()
  }
})

test('gis_delete_feature：删网页画的自定义要素（features.json）', () => {
  const restore = snapshot()
  try {
    const store = openStore()
    store.upsertFeature({
      type: 'Feature',
      id: 'feat-test123',
      properties: { type: 'wall', name: '挡路墙' },
      geometry: { type: 'Polygon', coordinates: [[[700, 620], [770, 620], [770, 700], [700, 700]]] },
    }, { source: 'custom' })
    store.close()
    const byName = deleteFeatureByIdOrName(WORKSPACE, '挡路墙')
    assert.equal(byName.ok, true, byName.note)
    assert.match(byName.text, /已收走：挡路墙/)
    // 删掉的是这一个要素：真实工作区里可能还有别的 custom 要素，
    // features.json 不一定会整个消失；检查镜像里不再有「挡路墙」即可。
    const mirror = existsSync(FEATURES) ? JSON.parse(readFileSync(FEATURES, 'utf8')) : { features: [] }
    assert.ok(
      !(mirror.features ?? []).some((f) => f?.properties?.name === '挡路墙'),
      'features.json 里不应再留下挡路墙',
    )
  } finally {
    restore()
  }
})

test('gis_delete_feature：名字歧义时拒绝并列出候选', () => {
  const restore = snapshot()
  try {
    const out = deleteFeatureByIdOrName(WORKSPACE, '灯') // 台灯和落地灯都叫「灯」
    assert.equal(out.ok, false)
    assert.match(out.note, /不止一个/)
    assert.match(out.note, /灯/)
    // 一个都没删
    const rooms = readFurniture().rooms
    assert.equal(rooms['卧室'].items.filter((i) => /灯/.test(i.type)).length, 1)
    assert.equal(rooms['客厅'].items.filter((i) => /灯/.test(i.type)).length, 1)
  } finally {
    restore()
  }
})

test('gis_delete_feature：不存在的东西报错而不乱删', () => {
  const restore = snapshot()
  try {
    const out = deleteFeatureByIdOrName(WORKSPACE, '不存在的飞船')
    assert.equal(out.ok, false)
    assert.match(out.note, /没有叫/)
    const out2 = deleteFeatureByIdOrName(WORKSPACE, '')
    assert.equal(out2.ok, false)
    assert.match(out2.note, /得告诉我删哪个/)
    // 厨房还在原样
    assert.ok(readFurniture().rooms['厨房'].items.length > 0)
  } finally {
    restore()
  }
})

test('两个工具都能注册，且都在 FISH_TOOLS 白名单里', () => {
  const ctx = fakeCtx()
  const d1 = registerBufferQuery(ctx, { workspaceRoot: () => WORKSPACE })
  const d2 = registerDeleteFeature(ctx, { workspaceRoot: () => WORKSPACE })
  assert.equal(typeof d1, 'function')
  assert.equal(typeof d2, 'function')

  const names = ctx.registered.map((t) => t.name)
  assert.ok(names.includes(GIS_BUFFER_QUERY_TOOL_NAME))
  assert.ok(names.includes(GIS_DELETE_FEATURE_TOOL_NAME))

  const buffer = ctx.registered.find((t) => t.name === GIS_BUFFER_QUERY_TOOL_NAME)
  const del = ctx.registered.find((t) => t.name === GIS_DELETE_FEATURE_TOOL_NAME)
  assert.equal(buffer.parameters.type, 'object')
  assert.ok(buffer.parameters.properties && 'radius' in buffer.parameters.properties)
  assert.equal(del.parameters.type, 'object')
  assert.ok(del.parameters.properties && 'id' in del.parameters.properties)
  assert.ok(del.parameters.required && del.parameters.required.includes('id'), 'id 应必填')

  // restrict 的 allow 是取交集的：FISH_TOOLS 里没有的名字，动态解锁也放不出来
  assert.ok(FISH_TOOLS.includes(GIS_BUFFER_QUERY_TOOL_NAME), 'gis_buffer_query 必须在 FISH_TOOLS 里')
  assert.ok(FISH_TOOLS.includes(GIS_DELETE_FEATURE_TOOL_NAME), 'gis_delete_feature 必须在 FISH_TOOLS 里')
})
