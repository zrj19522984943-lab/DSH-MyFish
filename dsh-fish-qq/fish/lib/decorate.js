/**
 * decorate.js —— fish_decorate_room
 *
 * 赛博小屋的家具在 `<工作区>/cyber_house/cyber_house.sqlite` 的 features 表里
 * （furniture.json 只是兼容镜像）。这个工具给她一双手，让她可以自己添置、
 * 移动、收走房间里的家具。
 *
 * 坐标口径（很重要）：
 *   x / y 是**相对房间左上角的局部坐标**，单位与小屋世界一致（1000×1000 里的像素）。
 *   家具的 x / y 指家具中心，不是左上角。工具会按家具尺寸把中心夹在房间内部，
 *   越界不会报错，而是自动修正——装修是件舒服的事，不该被一个坐标打断。
 *
 * 并发：读—改—写整份家具文档，最后在一个数据库事务里替换 furniture/door 行，
 * Node 单线程同步执行，天然串行；SQLite WAL 负责跨进程可见性。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { resolveWorkspaceRoot } from './workspace.js'

export const DECORATE_TOOL_NAME = 'fish_decorate_room'

export const ROOM_LAYOUT = Object.freeze({
  卧室: { w: 285, h: 260 },
  书房: { w: 220, h: 370 },
  影音角: { w: 265, h: 230 },
  厨房: { w: 245, h: 420 },
  客厅: { w: 365, h: 380 },
  阳台: { w: 180, h: 420 },
})

const ROOM_NAMES = Object.keys(ROOM_LAYOUT)
const MAX_ITEMS_PER_ROOM = 40

function failure(note) {
  return { ok: false, text: '', note }
}

function success(text) {
  return { ok: true, text, note: '' }
}

function furniturePath(workspaceRoot) {
  return join(workspaceRoot, 'cyber_house', 'furniture.json')
}

/**
 * 打开工作区的空间数据库。数据库是唯一事实源；furniture.json 只是兼容镜像。
 * 工作区里还没有 db/ 模块时返回 null，走旧的 JSON 读写路径。
 */
function openStore(workspaceRoot) {
  try {
    const requireModule = createRequire(import.meta.url)
    const dbModule = requireModule(join(workspaceRoot, 'cyber_house', 'db', 'index.js'))
    return dbModule.openDatabase({
      workspaceRoot,
      furnitureFile: furniturePath(workspaceRoot),
      featuresFile: join(workspaceRoot, 'cyber_house', 'features.json'),
      // 独立连接：装修完就关，不影响同一进程里状态引擎持有的连接。
      fresh: true,
    })
  } catch {
    return null
  }
}

function normalizeRoomName(value) {
  const text = String(value ?? '').trim()
  if (ROOM_LAYOUT[text]) return text
  const aliases = {
    living: '客厅',
    livingroom: '客厅',
    study: '书房',
    bedroom: '卧室',
    media: '影音角',
    kitchen: '厨房',
    balcony: '阳台',
  }
  return aliases[text.toLowerCase()] ?? ''
}

function normalizeIcon(value, type) {
  const raw = String(value ?? '').trim()
  if (raw) return [...raw].slice(0, 8).join('')
  if (/地毯|垫/.test(type)) return '🟫'
  if (/沙发|长椅/.test(type)) return '🛋️'
  if (/床/.test(type)) return '🛏️'
  if (/书桌|桌子|餐桌/.test(type)) return '🪑'
  if (/书架|书柜|柜/.test(type)) return '📚'
  if (/电视|屏幕/.test(type)) return '📺'
  if (/音箱|音响/.test(type)) return '🔊'
  if (/冰箱/.test(type)) return '🧊'
  if (/灯/.test(type)) return '💡'
  if (/植物|盆栽|花/.test(type)) return '🪴'
  if (/椅/.test(type)) return '🪑'
  return '📦'
}

function dimensionsFor(type) {
  if (/地毯|垫/.test(type)) return { w: 120, h: 66 }
  if (/沙发|长椅/.test(type)) return { w: 112, h: 58 }
  if (/床/.test(type)) return { w: 120, h: 74 }
  if (/书架|书柜|高柜/.test(type)) return { w: 66, h: 92 }
  if (/冰箱/.test(type)) return { w: 58, h: 86 }
  if (/书桌|桌子|餐桌/.test(type)) return { w: 96, h: 58 }
  if (/电视|屏幕/.test(type)) return { w: 92, h: 54 }
  if (/音箱|音响/.test(type)) return { w: 46, h: 52 }
  if (/灯/.test(type)) return { w: 42, h: 42 }
  if (/植物|盆栽|花/.test(type)) return { w: 52, h: 64 }
  if (/椅/.test(type)) return { w: 64, h: 64 }
  return { w: 64, h: 52 }
}

function clamp(value, min, max) {
  if (max < min) return (min + max) / 2
  return Math.max(min, Math.min(max, value))
}

function clampIntoRoom(room, size, x, y) {
  const rawX = Number(x)
  const rawY = Number(y)
  const wantedX = Number.isFinite(rawX) ? rawX : room.w * 0.35
  const wantedY = Number.isFinite(rawY) ? rawY : room.h * 0.72
  const minX = size.w / 2
  const maxX = room.w - size.w / 2
  const minY = size.h / 2
  const maxY = room.h - size.h / 2
  const nextX = Math.round(clamp(wantedX, minX, maxX))
  const nextY = Math.round(clamp(wantedY, minY, maxY))
  return {
    x: nextX,
    y: nextY,
    corrected: Number.isFinite(rawX) && Number.isFinite(rawY) &&
      (nextX !== Math.round(rawX) || nextY !== Math.round(rawY)),
  }
}

function normalizeId(value, roomName, type, items) {
  const raw = String(value ?? '').trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
  if (raw) {
    let id = raw.slice(0, 64)
    let suffix = 2
    while (items.some((item) => item.id === id)) id = `${raw.slice(0, 58)}-${suffix++}`
    return id
  }

  const base = `${roomName}-${type.replace(/[^\p{L}\p{N}_-]+/gu, '') || 'item'}`.slice(0, 56)
  let id = base
  let suffix = 2
  while (items.some((item) => item.id === id)) id = `${base}-${suffix++}`
  return id
}

function findItem(room, args) {
  const id = String(args?.furnitureId ?? '').trim()
  if (id) return room.items.find((item) => item.id === id) ?? null
  const type = String(args?.type ?? '').trim()
  if (type) return room.items.find((item) => item.type === type) ?? null
  return null
}

/**
 * 读并补齐家具文件。缺 room / items 时用房间布局兜底。
 * @param {string} file
 */
export function loadFurniture(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (!raw || typeof raw !== 'object') throw new Error('家具文件不是对象')
  if (!raw.rooms || typeof raw.rooms !== 'object') raw.rooms = {}
  for (const name of ROOM_NAMES) {
    const layout = ROOM_LAYOUT[name]
    const room = raw.rooms[name]
    if (!room || typeof room !== 'object') {
      raw.rooms[name] = { w: layout.w, h: layout.h, items: [] }
      continue
    }
    const w = Number(room.w)
    const h = Number(room.h)
    room.w = Number.isFinite(w) && w > 20 ? w : layout.w
    room.h = Number.isFinite(h) && h > 20 ? h : layout.h
    if (!Array.isArray(room.items)) room.items = []
    if (room.items.length > MAX_ITEMS_PER_ROOM) room.items.length = MAX_ITEMS_PER_ROOM
  }
  return raw
}

function saveFurniture(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  data.version = Number(data.version) || 1
  data.updatedAt = new Date().toISOString()
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/**
 * 纯函数版本的装修操作，方便测试；不碰 ctx。
 *
 * @param {object} data 已读入的 furniture 数据
 * @param {object} args 工具参数
 * @returns {{ok:boolean,text:string,note:string}}
 */
export function applyDecoration(data, args = {}) {
  const roomName = normalizeRoomName(args.roomName)
  if (!roomName) {
    return failure(`没有叫“${String(args.roomName ?? '').trim() || '空'}”的房间。可选：${ROOM_NAMES.join('、')}`)
  }

  const room = data.rooms?.[roomName]
  if (!room || typeof room !== 'object') {
    return failure(`${roomName}的数据不完整。`)
  }
  if (!Array.isArray(room.items)) room.items = []

  const action = String(args.action ?? '').trim().toLowerCase()
  if (!['add', 'move', 'remove'].includes(action)) {
    return failure('action 只能是 add、move 或 remove。')
  }

  if (action === 'add') {
    const type = String(args.type ?? '').trim().slice(0, 24)
    if (!type) return failure('要加家具的话，得告诉我 type（家具名）。')
    if (room.items.length >= MAX_ITEMS_PER_ROOM) {
      return failure(`${roomName}已经摆了 ${MAX_ITEMS_PER_ROOM} 件家具，先收走一件吧。`)
    }

    const icon = normalizeIcon(args.icon, type)
    const size = dimensionsFor(type)
    const pos = clampIntoRoom(room, size, args.x, args.y)
    const id = normalizeId(args.furnitureId, roomName, type, room.items)
    const item = { id, type, icon, x: pos.x, y: pos.y, w: size.w, h: size.h }
    room.items.push(item)

    return success(
      `[已布置：${roomName}添了${type}${icon}，位置 (${pos.x}, ${pos.y})` +
      `${pos.corrected ? '，越界已自动修正到房间内' : ''}。id: ${id}]`,
    )
  }

  const item = findItem(room, args)
  if (!item) {
    return failure(`在${roomName}里没找到那件家具。`)
  }

  if (action === 'move') {
    const size = { w: Number(item.w) || 58, h: Number(item.h) || 48 }
    const pos = clampIntoRoom(room, size, args.x ?? item.x, args.y ?? item.y)
    item.x = pos.x
    item.y = pos.y
    return success(
      `[已布置：${roomName}的${item.type}${item.icon}移到了 (${pos.x}, ${pos.y})` +
      `${pos.corrected ? '，越界已自动修正到房间内' : ''}。id: ${item.id}]`,
    )
  }

  const index = room.items.indexOf(item)
  room.items.splice(index, 1)
  return success(`[已布置：从${roomName}收走了${item.type}${item.icon}。id: ${item.id}]`)
}

/**
 * 在 SQLite 空间数据库里执行一次装修。
 *
 * 数据库是唯一事实源：读出完整的家具文档 -> 纯函数改文档 -> 一个事务写回，
 * 同时导出 furniture.json 兼容镜像（旧工具仍能读）。数据库模块不存在时退回
 * 原来的 JSON 读写路径，保证老工作区还能用。
 *
 * @param {string} workspaceRoot
 * @param {object} args
 */
export function decorateRoom(workspaceRoot, args = {}) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (!root) return failure('还不知道工作区在哪，没法去翻小屋数据库。')

  const store = openStore(root)
  if (store) {
    try {
      let data
      try {
        data = store.furnitureDoc()
      } catch (err) {
        return failure(`空间数据库打不开：${String(err?.message ?? err).slice(0, 120)}`)
      }

      const result = applyDecoration(data, args)
      if (!result.ok) return result

      try {
        store.replaceFurniture(data)
      } catch (err) {
        return failure(`家具写不进空间数据库：${String(err?.message ?? err).slice(0, 120)}`)
      }
      return result
    } finally {
      store.close()
    }
  }

  // —— 兼容旧工作区：没有 cyber_house/db/index.js 时仍按 JSON 读写 ——
  const file = furniturePath(root)
  if (!existsSync(file)) return failure(`没有找到 ${file}。`)

  let data
  try {
    data = loadFurniture(file)
  } catch (err) {
    return failure(`家具文件打不开：${String(err?.message ?? err).slice(0, 120)}`)
  }

  const result = applyDecoration(data, args)
  if (!result.ok) return result

  try {
    saveFurniture(file, data)
  } catch (err) {
    return failure(`家具文件写不进去：${String(err?.message ?? err).slice(0, 120)}`)
  }
  return result
}

export function registerDecorate(ctx, deps = {}) {
  return ctx.tools.register(
    defineTool({
      name: DECORATE_TOOL_NAME,
      description:
        '在赛博小屋的房间里添置、移动或收走家具。' +
        'roomName 是六个房间之一（卧室、书房、影音角、厨房、客厅、阳台）。' +
        'action=add 需要 type（家具名，比如地毯、书架、摇椅），icon 可选，不给会自己配一个；' +
        'action=move 用 furnitureId 指定，或者用 type 找第一件；action=remove 同理。' +
        'x、y 是相对房间左上角的局部坐标（家具中心），越界会自动收进房间，不会丢到虚空里。' +
        '布置完记得告诉对方你添了什么。',
      parameters: toJsonSchema({
        roomName: {
          type: 'string',
          required: true,
          description: '房间名：卧室、书房、影音角、厨房、客厅、阳台',
        },
        action: {
          type: 'string',
          required: true,
          enum: ['add', 'move', 'remove'],
          description: 'add=添置，move=移动，remove=收走',
        },
        furnitureId: {
          type: 'string',
          description: '家具 id；add 时可选，move/remove 时优先用它定位',
        },
        type: {
          type: 'string',
          description: '家具名，比如沙发、书桌、床、地毯、书架、摇椅',
        },
        icon: {
          type: 'string',
          description: '一个 Emoji，比如 🛋️、🪑、🛏️、🟫',
        },
        x: {
          type: 'number',
          description: '相对房间左侧的局部 x（家具中心）',
        },
        y: {
          type: 'number',
          description: '相对房间顶部的局部 y（家具中心）',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '布置结果' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没布置：${out.note}` }],
      },
      async execute(args) {
        return decorateRoom(deps.workspaceRoot, args)
      },
    }),
  )
}
