'use strict'

/**
 * gis/npcs.js —— 屋里的两个 NPC：拟南芥与借手
 *
 * 任务书 2：
 *   - 两个 NPC 在屋里随机溜达（简单随机游走 + 碰撞检查，不穿家具 / 墙）；
 *   - 每隔 5–10 分钟从 npc_dialogue.json 抽一段对白，写进数据库 events 表；
 *   - 对白同时变成 NPC 头顶的气泡，网页上能看见。
 *
 * 本模块只做数据与纯移动逻辑，不碰 state-engine 的 this，也不直接写数据库。
 */

const fs = require('node:fs')
const { ROOMS, ROOMS_BY_NAME, clamp, roundCoordinate } = require('../world')
const { segmentBlocked } = require('./pathfinder')

const NPC_STEP = 22
const NPC_WANDER_MIN_MS = 4000
const NPC_WANDER_MAX_MS = 12000

/** 两个 NPC 的初始位置（都落在各自房间的空白处，不压家具）。 */
const NPC_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'npc-arabidopsis',
    name: '拟南芥',
    emoji: '🌱',
    color: '#8fe388',
    room: '书房',
    x: 540,
    y: 90,
  }),
  Object.freeze({
    id: 'npc-jieshou',
    name: '借手',
    emoji: '🐱',
    color: '#ffb35c',
    room: '客厅',
    x: 620,
    y: 590,
  }),
])

const FALLBACK_DIALOGUES = Object.freeze([
  Object.freeze({
    id: 'fallback-lazy',
    lines: Object.freeze([
      Object.freeze({ speaker: '拟南芥', text: '小鱼今天又偷懒了。' }),
      Object.freeze({ speaker: '借手', text: '主人，要不我去把她的网线拔了？' }),
    ]),
  }),
])

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return clamp(n, min, max)
}

/**
 * 读 npc_dialogue.json 并归一化。文件缺失 / 坏掉时用内置的一段对白，
 * 屋子不会因为一个配置写坏而整个起不来。
 */
function loadNpcDialogueConfig(file) {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    raw = null
  }
  const source = raw && typeof raw === 'object' ? raw : {}
  const list = Array.isArray(source.dialogues) ? source.dialogues : []
  const dialogues = []
  for (const item of list) {
    if (!item || !Array.isArray(item.lines)) continue
    const lines = item.lines
      .filter((line) => line && typeof line.text === 'string' && line.text.trim())
      .map((line) => ({
        speaker: String(line.speaker || '拟南芥').slice(0, 20),
        text: String(line.text).replace(/\s+/g, ' ').trim().slice(0, 200),
      }))
    if (lines.length > 0) {
      dialogues.push({ id: String(item.id || `dialogue-${dialogues.length + 1}`), lines })
    }
  }
  return {
    minIntervalMinutes: clampNumber(source.minIntervalMinutes, 0.01, 1440, 5),
    maxIntervalMinutes: clampNumber(source.maxIntervalMinutes, 0.01, 1440, 10),
    bubbleMs: clampNumber(source.bubbleMs, 1000, 120000, 12000),
    dialogues: dialogues.length > 0 ? dialogues : FALLBACK_DIALOGUES.map((item) => ({
      id: item.id,
      lines: item.lines.map((line) => ({ ...line })),
    })),
  }
}

/** 两段对白之间随机间隔。 */
function dialogueDelayMs(config, random = Math.random) {
  const min = Math.max(0, Number(config.minIntervalMinutes) || 5) * 60_000
  const max = Math.max(min, (Number(config.maxIntervalMinutes) || 10) * 60_000)
  return min + Math.floor(random() * (max - min + 1))
}

/** 随机挑一段，尽量不连抽同一段。 */
function pickDialogue(dialogues, random = Math.random, lastId = '') {
  const list = Array.isArray(dialogues) ? dialogues.filter((item) => item && item.lines && item.lines.length > 0) : []
  if (list.length === 0) return null
  const candidates = list.length > 1 ? list.filter((item) => item.id !== lastId) : list
  const pool = candidates.length > 0 ? candidates : list
  return pool[Math.floor(random() * pool.length) % pool.length]
}

function roomAt(x, y, rooms = ROOMS) {
  for (const room of rooms) {
    if (x >= room.x && x <= room.x + room.w && y >= room.y && y <= room.y + room.h) return room.name
  }
  return null
}

/** 在房间里随机取一个可直达的点；找不到就返回 null。 */
function pickWanderTarget(npc, passable, rooms = ROOMS, random = Math.random) {
  const room = rooms.find((item) => item.name === npc.room) || rooms[0]
  if (!room) return null
  const margin = 36
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const x = room.x + margin + random() * Math.max(1, room.w - margin * 2)
    const y = room.y + margin + random() * Math.max(1, room.h - margin * 2)
    if (Math.hypot(x - npc.x, y - npc.y) < 20) continue
    if (segmentBlocked(passable, npc.x, npc.y, x, y)) continue
    return { x: roundCoordinate(x), y: roundCoordinate(y) }
  }
  return null
}

/**
 * 推进一步 NPC。返回是否真的移动了。
 * NPC 只在当前房间内散步；目标必须与当前位置直线可通（家具 / 墙都算障碍）。
 */
function advanceNpc(npc, passable, now, random = Math.random, rooms = ROOMS) {
  if (!npc || !passable) return false
  if (npc.target && now >= npc.nextWanderAt) {
    npc.target = null
  }
  if (!npc.target && now >= npc.nextWanderAt) {
    npc.target = pickWanderTarget(npc, passable, rooms, random)
    npc.nextWanderAt = now + NPC_WANDER_MIN_MS + random() * (NPC_WANDER_MAX_MS - NPC_WANDER_MIN_MS)
    if (!npc.target) return false
  }
  if (!npc.target) return false

  // 家具 / 新画的墙可能把原来的直线切断：放弃这个目标，等下一次再选。
  if (segmentBlocked(passable, npc.x, npc.y, npc.target.x, npc.target.y)) {
    npc.target = null
    npc.nextWanderAt = now + 2000
    return false
  }

  const dx = npc.target.x - npc.x
  const dy = npc.target.y - npc.y
  const distance = Math.hypot(dx, dy)
  if (distance <= NPC_STEP) {
    npc.x = npc.target.x
    npc.y = npc.target.y
    npc.target = null
    npc.nextWanderAt = now + NPC_WANDER_MIN_MS + random() * (NPC_WANDER_MAX_MS - NPC_WANDER_MIN_MS)
  } else {
    npc.x = roundCoordinate(npc.x + (dx / distance) * NPC_STEP)
    npc.y = roundCoordinate(npc.y + (dy / distance) * NPC_STEP)
  }
  npc.room = roomAt(npc.x, npc.y, rooms) || npc.room
  return true
}

/** 前端 / 状态接口需要的 NPC 快照（去掉内部路线字段）。 */
function npcSnapshot(npc, now) {
  const bubble = npc.bubble && npc.bubble.expiresAt > now ? { ...npc.bubble } : null
  return {
    id: npc.id,
    name: npc.name,
    emoji: npc.emoji,
    color: npc.color,
    room: npc.room,
    x: roundCoordinate(npc.x),
    y: roundCoordinate(npc.y),
    bubble,
  }
}

function createNpcs(now, random = Math.random) {
  return NPC_DEFINITIONS.map((definition) => ({
    ...definition,
    target: null,
    nextWanderAt: now + 2000 + random() * 5000,
    bubble: null,
  }))
}

module.exports = {
  NPC_STEP,
  NPC_WANDER_MIN_MS,
  NPC_WANDER_MAX_MS,
  NPC_DEFINITIONS,
  loadNpcDialogueConfig,
  dialogueDelayMs,
  pickDialogue,
  pickWanderTarget,
  advanceNpc,
  npcSnapshot,
  createNpcs,
  roomAt,
}
