/**
 * decorate.test.mjs —— fish_decorate_room 的坐标夹取、增删改与工具形状
 *
 * 这个工具唯一会改用户工作区里的文件，所以测试只盯四件事：
 *   1. 越界坐标会被夹回房间内（家具中心不飘到虚空）；
 *   2. add / move / remove 都会真的写回 furniture.json；
 *   3. 房间名 / action 不合法时不动文件；
 *   4. 注册参数与 FISH_TOOLS 白名单对得上。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerDecorate, decorateRoom, DECORATE_TOOL_NAME } from '../lib/decorate.js'
import { FISH_TOOLS, HER_TOOLS } from '../lib/restrict.js'

const SOURCE = new URL('../../../cyber_house/furniture.json', import.meta.url)

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-decorate-'))
  mkdirSync(join(root, 'cyber_house'), { recursive: true })
  copyFileSync(SOURCE, join(root, 'cyber_house', 'furniture.json'))
  return root
}

function readFurniture(root) {
  return JSON.parse(readFileSync(join(root, 'cyber_house', 'furniture.json'), 'utf8'))
}

test('add：越界坐标自动夹回房间内，并写回文件', () => {
  const root = makeRoot()
  try {
    const result = decorateRoom(root, {
      roomName: '客厅',
      action: 'add',
      type: '地毯',
      icon: '🟫',
      x: 9999,
      y: -20,
    })
    assert.equal(result.ok, true)
    assert.match(result.text, /^\[已布置：/)
    assert.match(result.text, /越界已自动修正/)

    const room = readFurniture(root).rooms['客厅']
    const rug = room.items.find((item) => item.type === '地毯')
    assert.ok(rug, '地毯应写进客厅')
    assert.ok(rug.x >= rug.w / 2 && rug.x <= room.w - rug.w / 2)
    assert.ok(rug.y >= rug.h / 2 && rug.y <= room.h - rug.h / 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('move / remove：按 id 移动和收走', () => {
  const root = makeRoot()
  try {
    const added = decorateRoom(root, { roomName: '书房', action: 'add', type: '小凳子', x: 20, y: 20 })
    assert.equal(added.ok, true)
    const id = readFurniture(root).rooms['书房'].items.find((item) => item.type === '小凳子').id

    const moved = decorateRoom(root, { roomName: '书房', action: 'move', furnitureId: id, x: 10, y: 10 })
    assert.equal(moved.ok, true)
    const afterMove = readFurniture(root).rooms['书房'].items.find((item) => item.id === id)
    assert.ok(afterMove.x >= 0 && afterMove.y >= 0)

    const removed = decorateRoom(root, { roomName: '书房', action: 'remove', furnitureId: id })
    assert.equal(removed.ok, true)
    assert.equal(readFurniture(root).rooms['书房'].items.some((item) => item.id === id), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('非法房间 / action 不动文件', () => {
  const root = makeRoot()
  try {
    const before = readFileSync(join(root, 'cyber_house', 'furniture.json'), 'utf8')
    assert.equal(decorateRoom(root, { roomName: '不存在', action: 'add', type: '椅子' }).ok, false)
    assert.equal(decorateRoom(root, { roomName: '客厅', action: 'paint', type: '椅子' }).ok, false)
    assert.equal(readFileSync(join(root, 'cyber_house', 'furniture.json'), 'utf8'), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('注册形状与白名单', () => {
  let definition = null
  const ctx = { tools: { register(def) { definition = def; return () => {} } } }
  const root = makeRoot()
  try {
    registerDecorate(ctx, { workspaceRoot: root })
    assert.equal(definition.name, DECORATE_TOOL_NAME)
    assert.deepEqual(definition.parameters.required, ['roomName', 'action'])
    assert.deepEqual(definition.parameters.properties.action.enum, ['add', 'move', 'remove'])
    assert.ok(FISH_TOOLS.includes(DECORATE_TOOL_NAME))
    assert.ok(HER_TOOLS.includes(DECORATE_TOOL_NAME))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
