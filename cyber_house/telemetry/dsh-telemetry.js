'use strict'

/**
 * telemetry/dsh-telemetry.js —— 赛博小屋的读盘层
 *
 * 这里只做「从磁盘读、解析、汇总」：
 *   - ~/.dsh-fish/home.json          当前房间/活动、会话 id
 *   - ~/.dsh/sessions/...            多帧 zstd 的会话日志 -> 今日轮数 / token / 工具信号
 *   - ~/.dsh/qq-bridge-state.json    QQ 外发 / 入站时间
 *   - ~/.dsh-fish/talk-recent.json   QQ 轮换提要兜底
 *   - <workspace>/sensors/status.md  内存 / 机箱 / 天气
 *   - <workspace>/cyber_house/furniture.json
 *
 * 它不推坐标、不寻路、不维护统计；这些归 state-engine。所有解析出错都走兜底，
 * 不抛异常——小屋看板不能因为一个文件损坏而整个 500。
 *
 * 世界定义（房间、活动画像、时间窗口）来自 ../world.js，避免 gis/ 或主引擎
 * 反向依赖本模块。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const {
  ROOMS,
  ACTIVITY_PROFILES,
  DEFAULT_ACTIVITY,
  ROOM_DEFAULT_STATUS,
  DEFAULT_ACTIVITY_WINDOWS,
  clamp,
} = require('../world')

const ACTIVITY_ALIASES = new Map()

function addAliases(activity, aliases) {
  for (const alias of aliases) {
    ACTIVITY_ALIASES.set(normalizeToken(alias), activity)
  }
}

function normalizeToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\s_\-·—–/\\]+/g, '')
}

addAliases('qq', [
  'qq',
  'q q',
  'chat',
  'chatting',
  'talk',
  'talking',
  'message',
  'messaging',
  '私聊',
  '聊天',
  '聊qq',
  '在聊qq',
  '聊消息',
  '回消息',
  '社交',
])

addAliases('bilibili', [
  'bilibili',
  'bili',
  'b站',
  'bilibili.com',
  '哔哩哔哩',
  'video',
  'videos',
  'watching',
  'watch',
  'media',
  '影音角',
  '影音',
  '看视频',
  '刷视频',
  '刷b站',
  '看番',
  '番剧',
])

addAliases('coding', [
  'coding',
  'code',
  'dev',
  'develop',
  'developing',
  'work',
  'working',
  'debug',
  'debugging',
  'write',
  'writing',
  '代码',
  '写代码',
  '编程',
  '开发',
  '工作',
  '写东西',
])

addAliases('sleeping', [
  'sleep',
  'sleeping',
  'rest',
  'resting',
  'nap',
  'tired',
  '睡觉',
  '睡',
  '休息',
  '午休',
  '困',
  '躺',
])

addAliases('cooking', [
  'cook',
  'cooking',
  'eat',
  'eating',
  'food',
  'kitchen',
  '做饭',
  '吃饭',
  '吃',
  '厨房',
  '下厨',
])

addAliases('idle', [
  'idle',
  'chill',
  'relax',
  'relaxing',
  'bored',
  '发呆',
  '摸鱼',
  '放空',
  '看天',
  '阳台',
  '闲着',
  '空闲',
])

const ROOM_ALIASES = new Map()
for (const room of ROOMS) {
  ROOM_ALIASES.set(normalizeToken(room.name), room.name)
}
ROOM_ALIASES.set('livingroom', '客厅')
ROOM_ALIASES.set('living', '客厅')
ROOM_ALIASES.set('study', '书房')
ROOM_ALIASES.set('bedroom', '卧室')
ROOM_ALIASES.set('media', '影音角')
ROOM_ALIASES.set('mediacorner', '影音角')
ROOM_ALIASES.set('kitchen', '厨房')
ROOM_ALIASES.set('balcony', '阳台')

/** 这些词出现在 status 里时，用来推断房间。 */
const STATUS_RULES = [
  { activity: 'bilibili', re: /(?:b\s*站|bilibili|哔哩|看视频|刷视频|影音|番剧|追番)/i },
  { activity: 'qq', re: /(?:qq|扣扣|私聊|聊天|聊消息|回消息|消息里)/i },
  { activity: 'coding', re: /(?:代码|编程|开发|debug|写程序|工作|写东西)/i },
  { activity: 'sleeping', re: /(?:睡觉|睡了|午休|休息|躺|困|做梦)/i },
  { activity: 'cooking', re: /(?:做饭|下厨|厨房|吃饭|吃点什么|煮)/i },
  { activity: 'idle', re: /(?:发呆|摸鱼|放空|看天|阳台|闲着|空闲)/i },
]

function objectValue(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return undefined

  for (const key of keys) {
    if (value[key] != null && value[key] !== '') return value[key]
  }

  for (const nestedKey of ['state', 'current', 'activityState', 'fish']) {
    const nested = value[nestedKey]
    if (nested && typeof nested === 'object') {
      const found = objectValue(nested, keys, depth + 1)
      if (found != null && found !== '') return found
    }
  }

  return undefined
}

function toText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (typeof value === 'object') {
    const nested = objectValue(value, ['type', 'name', 'id', 'key', 'label', 'title', 'value'])
    return nested == null ? '' : toText(nested)
  }

  return ''
}

function resolveActivity(value) {
  const text = toText(value)
  if (!text) return null

  const token = normalizeToken(text)
  const byAlias = ACTIVITY_ALIASES.get(token)
  if (byAlias) return { activity: byAlias, ...ACTIVITY_PROFILES[byAlias] }

  // 允许 "在刷B站"、"正在聊QQ" 这类自然语言。
  for (const rule of STATUS_RULES) {
    if (rule.re.test(text)) {
      return { activity: rule.activity, ...ACTIVITY_PROFILES[rule.activity] }
    }
  }

  return null
}

function resolveRoom(value) {
  const text = toText(value)
  if (!text) return null

  const byAlias = ROOM_ALIASES.get(normalizeToken(text))
  if (byAlias) return byAlias

  for (const room of ROOMS) {
    if (text.includes(room.name)) return room.name
  }

  return null
}

/**
 * 把 home.json 的内容归一化成 { room, status }。
 * 解析不出来时回退到 idle，不抛异常——小屋要一直活着。
 */
function resolveHomeState(raw) {
  if (!raw || typeof raw !== 'object') {
    return { room: DEFAULT_ACTIVITY.room, status: DEFAULT_ACTIVITY.status }
  }

  const roomValue = objectValue(raw, ['room', 'targetRoom', 'currentRoom'])
  const activityValue = objectValue(raw, [
    'activity',
    'currentActivity',
    'mode',
    'action',
    'app',
    'doing',
  ])
  const statusValue = objectValue(raw, ['status', 'detail', 'description', 'label', 'summary'])

  const directRoom = resolveRoom(roomValue) || resolveRoom(statusValue)
  const activityMatch = resolveActivity(activityValue) || resolveActivity(statusValue)
  const match = activityMatch || (directRoom ? {
    activity: null,
    room: directRoom,
    status: ROOM_DEFAULT_STATUS[directRoom] || directRoom,
  } : DEFAULT_ACTIVITY)

  const rawStatus = toText(statusValue)
  const statusMatch = resolveActivity(rawStatus)
  const statusIsControlToken =
    !rawStatus ||
    Boolean(ACTIVITY_ALIASES.get(normalizeToken(rawStatus))) ||
    Boolean(ROOM_ALIASES.get(normalizeToken(rawStatus)))

  let status = match.status
  if (rawStatus && !statusIsControlToken) {
    // activity 与 status 明显指向不同房间时，以 activity 为准，避免返回矛盾数据。
    status = statusMatch && statusMatch.room !== match.room ? match.status : rawStatus
  }

  return { room: directRoom || match.room, status }
}

function readHomeStateFile(file) {
  if (!file) return { state: DEFAULT_ACTIVITY, error: null }

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { state: resolveHomeState(raw), error: null }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { state: DEFAULT_ACTIVITY, error: null }
    }
    return {
      state: DEFAULT_ACTIVITY,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function defaultDshRoot() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
}

function defaultFishRoot() {
  return process.env.DSH_FISH_HOME
    ? path.resolve(process.env.DSH_FISH_HOME)
    : path.join(os.homedir(), '.dsh-fish')
}

function defaultHomeFile() {
  if (process.env.FISH_HOME_JSON) {
    return path.resolve(process.env.FISH_HOME_JSON)
  }

  return path.join(defaultFishRoot(), 'home.json')
}

function defaultWorkspaceRoot() {
  if (process.env.DSH_WORKSPACE) return path.resolve(process.env.DSH_WORKSPACE)
  // 本文件在 cyber_house/telemetry/，向上一级是 cyber_house，再上一级才是工作区根。
  return path.resolve(__dirname, '..', '..')
}

function chassisProfile(status) {
  const text = String(status || '')
  if (/高负载|过载|重载|满载|过热|发烫|烫|危险/.test(text)) {
    return { level: 'high', percent: 88 }
  }
  if (/空闲|低负载|轻载|低|闲/.test(text)) {
    return { level: 'low', percent: 22 }
  }
  if (/中负载|一般|正常|平稳|中/.test(text)) {
    return { level: 'normal', percent: 55 }
  }
  return { level: 'unknown', percent: 0 }
}

function defaultFurnitureFile(workspaceRoot = defaultWorkspaceRoot()) {
  return path.join(workspaceRoot, 'cyber_house', 'furniture.json')
}

/**
 * @deprecated 数据层已迁移到 db/index.js（SQLite features 表）。
 * 这个读函数只保留给旧工具 / 迁移脚本；服务运行时不再调用它。
 *
 * 读 cyber_house/furniture.json。
 * 结构损坏时回空地图，不让看板因为一件家具而整个 500。
 */
function readFurnitureFile(file) {
  const empty = { version: 1, rooms: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || !raw.rooms || typeof raw.rooms !== 'object') {
      return empty
    }
    return raw
  } catch {
    return empty
  }
}

/**
 * 写 cyber_house/furniture.json：更新 version/updatedAt 后整体落盘。
 *
 * 字段口径与 fish/lib/decorate.js 的 saveFurniture 一致（version 兜底成 2、
 * updatedAt 打时间戳），这样"从网页删一件家具"和"她在 QQ 里收走一件家具"
 * 在盘面上是同一种东西。
 */
function writeFurnitureFile(file, data) {
  const payload = data && typeof data === 'object' ? data : { rooms: {} }
  payload.version = Number(payload.version) || 2
  payload.updatedAt = new Date().toISOString()
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return payload
}

/**
 * 读 cyber_house/features.json（网页上用 leaflet.draw 画进来的自定义要素）。
 * 文件不存在 / 损坏时回一个空的 FeatureCollection——第一次 POST 时会自动创建。
 */

function defaultFeaturesFile(workspaceRoot = defaultWorkspaceRoot()) {
  return path.join(workspaceRoot, 'cyber_house', 'features.json')
}

/** @deprecated 见 readFurnitureFile；运行时以 SQLite 为准。 */
function readFeaturesFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.features)) {
      return { type: 'FeatureCollection', features: [] }
    }
    return raw
  } catch {
    return { type: 'FeatureCollection', features: [] }
  }
}

/** 写 features.json：只在要素数组非空时落盘，写完同步更新 updatedAt。 */
function writeFeaturesFile(file, features) {
  const collection = {
    type: 'FeatureCollection',
    name: '赛博小屋·自定义要素',
    'crs': { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
    updatedAt: new Date().toISOString(),
    features,
  }
  fs.writeFileSync(file, JSON.stringify(collection, null, 2) + '\n', 'utf8')
  return collection
}

/**
 * 读工作区里的 sensors/status.md。
 *
 * 采集脚本写的是类似：
 *   [内存占用:63%] [机箱状态:高负载] [天气:毛毛雨 15°C]
 *
 * 文件缺失或字段缺失时不抛错，只把对应字段留成 null。
 */
function readSystemHealth(workspaceRoot = defaultWorkspaceRoot()) {
  const file = path.join(workspaceRoot, 'sensors', 'status.md')
  let text = ''
  let updatedAt = null

  try {
    const stat = fs.statSync(file)
    text = fs.readFileSync(file, 'utf8').trim()
    updatedAt = new Date(stat.mtimeMs).toISOString()
  } catch {
    return {
      memoryPercent: null,
      memoryLevel: 'unknown',
      chassisStatus: null,
      chassisLevel: 'unknown',
      chassisPercent: 0,
      weather: null,
      weatherTempC: null,
      updatedAt: null,
    }
  }

  const memoryMatch = text.match(/内存占用\s*[:：]\s*(\d{1,3})\s*%/i)
  const chassisMatch = text.match(/机箱状态\s*[:：]\s*([^\]\n]+)/i)
  const weatherMatch = text.match(/天气\s*[:：]\s*([^\]\n]+)/i)
  const memoryValue = memoryMatch ? Number(memoryMatch[1]) : null
  const memoryPercent = Number.isFinite(memoryValue)
    ? clamp(Math.round(memoryValue), 0, 100)
    : null
  const chassisStatus = chassisMatch ? chassisMatch[1].trim() : null
  const weather = weatherMatch ? weatherMatch[1].trim() : null
  const tempMatch = weather ? weather.match(/(-?\d+(?:\.\d+)?)\s*°?\s*C/i) : null
  const chassis = chassisProfile(chassisStatus)

  return {
    memoryPercent,
    memoryLevel: memoryPercent == null
      ? 'unknown'
      : memoryPercent >= 85
        ? 'high'
        : memoryPercent >= 65
          ? 'warn'
          : 'normal',
    chassisStatus,
    chassisLevel: chassis.level,
    chassisPercent: chassis.percent,
    weather,
    weatherTempC: tempMatch ? Number(tempMatch[1]) : null,
    updatedAt,
  }
}

const STRONG_CODING_TOOLS = new Set([
  'work_request',
  'workflow',
  'subagent',
  'subagent_fork',
  'pwsh',
  'write',
  'edit',
  'load_workspace_dependencies',
  'skill',
])

const SESSION_ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function startOfLocalDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function walkFiles(root, visit, depth = 0) {
  if (depth > 5) return
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullPath, visit, depth + 1)
    } else if (entry.isFile()) {
      visit(fullPath)
    }
  }
}

function readSessionText(file) {
  const buffer = fs.readFileSync(file)
  if (buffer.length < 4 || buffer.compare(SESSION_ZSTD_MAGIC, 0, 4, 0, 4) !== 0) {
    return buffer.toString('utf8')
  }

  // DSH 的会话日志是「多帧拼接的 zstd」，逐帧解压后再拼成 JSONL。
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(SESSION_ZSTD_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }

  const chunks = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(from, to)))
    } catch {
      // 会话正在写入时，最后一帧可能不完整；下一轮再读。
    }
  }

  if (chunks.length === 0) return ''
  return Buffer.concat(chunks).toString('utf8')
}

function parseSessionEvents(file) {
  return readSessionText(file)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

function emptyUsage() {
  return {
    turns: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

function addUsage(target, usage) {
  const input = Number(usage.inputTokens) || 0
  const output = Number(usage.outputTokens) || 0
  const cacheRead = Number(usage.cacheReadTokens) || 0
  const cacheWrite = Number(usage.cacheWriteTokens) || 0
  const total = Number(usage.totalTokens) || input + output + cacheRead + cacheWrite

  target.tokens += total
  target.inputTokens += input
  target.outputTokens += output
  target.cacheReadTokens += cacheRead
  target.cacheWriteTokens += cacheWrite
}

function isStrongCodingTool(name) {
  return STRONG_CODING_TOOLS.has(name) || String(name || '').startsWith('office_')
}

function isBiliTool(name) {
  return name === 'bili_look' || name === 'bili_watch'
}

function isQQSendTool(name) {
  return name === 'qq_bridge_send' ||
    name === 'qq_bridge_send_multi' ||
    name === 'qq_bridge_reply' ||
    name === 'qq_bridge_subsend'
}

/**
 * 解析单个会话文件里的「今天」摘要。
 *
 * 只看今天的事件，避免把昨天/更早的轮数和 token 混进今日数据。
 */
function summarizeSession(events, todayStart) {
  const summary = {
    turns: 0,
    usage: emptyUsage(),
    lastEventAt: 0,
    lastEventType: '',
    activeTurn: null,
    openTools: new Map(),
    lastBiliAt: 0,
    lastQQToolAt: 0,
    lastWorkRequestAt: 0,
    pendingWorkRequestAt: 0,
    pendingStrongToolAt: 0,
  }

  for (const event of events) {
    const time = Number(event && event.time)
    if (!Number.isFinite(time) || time < todayStart) continue

    const type = event.type
    const data = event.data || {}

    summary.lastEventAt = Math.max(summary.lastEventAt, time)
    summary.lastEventType = type

    if (type === 'turn/start') {
      summary.activeTurn = {
        turn: data.turn,
        startedAt: time,
        lastEventAt: time,
        strongToolAt: 0,
      }
      continue
    }

    if (type === 'turn/end') {
      summary.turns += 1
      summary.activeTurn = null
      continue
    }

    if (type === 'tool/call') {
      const name = String(data.name || '')
      const callId = String(data.callId || '')
      if (callId) summary.openTools.set(callId, { name, time })

      if (name && summary.activeTurn) {
        summary.activeTurn.lastEventAt = time
        if (isStrongCodingTool(name)) {
          summary.activeTurn.strongToolAt = Math.max(summary.activeTurn.strongToolAt, time)
        }
      }

      if (isBiliTool(name)) summary.lastBiliAt = Math.max(summary.lastBiliAt, time)
      if (isQQSendTool(name)) summary.lastQQToolAt = Math.max(summary.lastQQToolAt, time)
      if (name === 'work_request') summary.lastWorkRequestAt = Math.max(summary.lastWorkRequestAt, time)
      continue
    }

    if (type === 'tool/result') {
      const callId = String(data.toolCallId || '')
      if (callId) summary.openTools.delete(callId)
      continue
    }

    if (type === 'assistant/message') {
      if (data.usage) addUsage(summary.usage, data.usage)
      if (summary.activeTurn) summary.activeTurn.lastEventAt = time
    }
  }

  for (const call of summary.openTools.values()) {
    if (call.name === 'work_request') {
      summary.pendingWorkRequestAt = Math.max(summary.pendingWorkRequestAt, call.time)
    }
    if (isStrongCodingTool(call.name)) {
      summary.pendingStrongToolAt = Math.max(summary.pendingStrongToolAt, call.time)
    }
  }

  return summary
}

function inferActivity(nowMs, signals, windows) {
  const age = (time) => (time > 0 ? nowMs - time : Number.POSITIVE_INFINITY)

  // 1. work_request 派发中，或已经派发出去的活儿还在近期窗口里。
  if (signals.pendingWorkRequestAt && age(signals.pendingWorkRequestAt) <= windows.workPendingMs) {
    return 'coding'
  }
  if (signals.lastWorkRequestAt && age(signals.lastWorkRequestAt) <= windows.workRecentMs) {
    return 'coding'
  }

  // 长任务：当前 turn 还没结束，且近期有真正的动手工具在跑。
  if (signals.pendingStrongToolAt && age(signals.pendingStrongToolAt) <= windows.workPendingMs) {
    return 'coding'
  }
  const active = signals.activeTurn
  if (active && active.strongToolAt &&
      nowMs - Math.max(active.lastEventAt || 0, active.strongToolAt) <= windows.longTaskIdleMs) {
    return 'coding'
  }

  // 2. 最近看过 B 站。
  if (signals.lastBiliAt && age(signals.lastBiliAt) <= windows.biliRecentMs) {
    return 'bilibili'
  }

  // 3. 刚发过 QQ，或者最后一条入站还没被回。
  if (signals.lastQQAt && age(signals.lastQQAt) <= windows.qqRecentMs) {
    return 'qq'
  }
  if (signals.pendingReply && age(signals.lastInboundAt) <= windows.qqPendingMs) {
    return 'qq'
  }

  return null
}

class FishTelemetry {
  constructor(options = {}) {
    const dshRoot = options.dshRoot ? path.resolve(options.dshRoot) : defaultDshRoot()
    const fishRoot = options.fishRoot ? path.resolve(options.fishRoot) : defaultFishRoot()

    this.homeFile = options.homeFile === undefined ? defaultHomeFile() : options.homeFile
    this.sessionsRoot = options.sessionsRoot || path.join(dshRoot, 'sessions')
    this.qqStateFile = options.qqStateFile || path.join(dshRoot, 'qq-bridge-state.json')
    this.talkRecentFile = options.talkRecentFile || path.join(fishRoot, 'talk-recent.json')
    this.windows = { ...DEFAULT_ACTIVITY_WINDOWS, ...(options.activityWindows || {}) }

    this.sessionCache = new Map()
    this.cacheDayKey = ''
    this.location = null
    this.locationAttemptAt = 0
  }

  _locateSession(sessionId, nowMs) {
    if (!sessionId) return null
    if (this.location && this.location.sessionId === sessionId && isFile(this.location.file)) {
      return this.location
    }
    if (this.location && this.location.sessionId === sessionId && !isFile(this.location.file)) {
      this.location = null
    }
    if (this.location && this.location.sessionId !== sessionId) {
      this.location = null
    }
    if (!this.location && nowMs - this.locationAttemptAt < 5000) {
      return null
    }
    this.locationAttemptAt = nowMs

    let found = null
    walkFiles(this.sessionsRoot, (file) => {
      if (found) return
      if (path.basename(file) !== 'session.v4.jsonl.zstd') return
      if (path.basename(path.dirname(file)) !== sessionId) return
      found = {
        sessionId,
        file,
        dir: path.dirname(path.dirname(file)),
      }
    })

    this.location = found
    return found
  }

  _todaySessionFiles(location, todayStart) {
    if (!location) return []

    let entries
    try {
      entries = fs.readdirSync(location.dir, { withFileTypes: true })
    } catch {
      return []
    }

    const files = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
      const file = path.join(location.dir, entry.name, 'session.v4.jsonl.zstd')
      try {
        const stat = fs.statSync(file)
        if (!stat.isFile()) continue
        if (stat.mtimeMs >= todayStart || file === location.file) {
          files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size })
        }
      } catch {
        // 会话目录可能刚建但文件还没落盘。
      }
    }

    return files.sort((a, b) => a.mtimeMs - b.mtimeMs)
  }

  _sessionSummary(file, mtimeMs, size, dayKey, todayStart) {
    if (this.cacheDayKey !== dayKey) {
      this.sessionCache.clear()
      this.cacheDayKey = dayKey
    }

    const cached = this.sessionCache.get(file)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size && cached.dayKey === dayKey) {
      return cached.summary
    }

    let summary
    try {
      summary = summarizeSession(parseSessionEvents(file), todayStart)
    } catch {
      summary = summarizeSession([], todayStart)
    }

    this.sessionCache.set(file, { mtimeMs, size, dayKey, summary })
    return summary
  }

  _readQQState(todayStart) {
    const raw = readJsonFile(this.qqStateFile)
    let lastOutboundAt = 0
    let lastInboundAt = 0

    if (raw) {
      const outbox = Array.isArray(raw.outbox) ? raw.outbox : []
      for (const item of outbox) {
        const at = Number(item && item.at)
        if (Number.isFinite(at) && at >= todayStart) {
          lastOutboundAt = Math.max(lastOutboundAt, at)
        }
      }

      const log = Array.isArray(raw.log) ? raw.log : []
      for (const item of log) {
        const at = Number(item && item.at)
        const wokeHer = !item || !item.decision || item.decision === 'wake'
        if (item && item.kind === 'inbound' && wokeHer && Number.isFinite(at) && at >= todayStart) {
          lastInboundAt = Math.max(lastInboundAt, at)
        }
      }
    }

    // talk-recent.json 是 QQ 桥接的轮换提要来源，作为没有 outbox 时的兜底。
    if (!lastInboundAt && !lastOutboundAt) {
      const recent = readJsonFile(this.talkRecentFile)
      const list = recent && Array.isArray(recent.list) ? recent.list : []
      for (const item of list) {
        const at = Date.parse(item && item.at)
        if (Number.isFinite(at) && at >= todayStart) {
          lastInboundAt = Math.max(lastInboundAt, at)
        }
      }
    }

    return { lastOutboundAt, lastInboundAt }
  }

  read(nowMs = Date.now()) {
    const todayStart = startOfLocalDay(nowMs)
    const dayKey = localDayKey(nowMs)
    const home = readJsonFile(this.homeFile)
    const sessionId = home && home.sessionId ? String(home.sessionId) : ''
    const location = this._locateSession(sessionId, nowMs)
    const files = this._todaySessionFiles(location, todayStart)

    const usage = emptyUsage()
    let lastEventAt = 0
    let lastEventType = ''
    let lastBiliAt = 0
    let lastQQToolAt = 0
    let lastWorkRequestAt = 0
    let pendingWorkRequestAt = 0
    let pendingStrongToolAt = 0
    let activeTurn = null
    let sessionFiles = 0

    for (const item of files) {
      const summary = this._sessionSummary(item.file, item.mtimeMs, item.size, dayKey, todayStart)
      sessionFiles += 1
      usage.turns += summary.turns
      usage.tokens += summary.usage.tokens
      usage.inputTokens += summary.usage.inputTokens
      usage.outputTokens += summary.usage.outputTokens
      usage.cacheReadTokens += summary.usage.cacheReadTokens
      usage.cacheWriteTokens += summary.usage.cacheWriteTokens

      if (summary.lastEventAt > lastEventAt) {
        lastEventAt = summary.lastEventAt
        lastEventType = summary.lastEventType
      }
      lastBiliAt = Math.max(lastBiliAt, summary.lastBiliAt)
      lastQQToolAt = Math.max(lastQQToolAt, summary.lastQQToolAt)
      lastWorkRequestAt = Math.max(lastWorkRequestAt, summary.lastWorkRequestAt)
      pendingWorkRequestAt = Math.max(pendingWorkRequestAt, summary.pendingWorkRequestAt)
      pendingStrongToolAt = Math.max(pendingStrongToolAt, summary.pendingStrongToolAt)
      if (summary.activeTurn &&
          (!activeTurn || summary.activeTurn.lastEventAt > activeTurn.lastEventAt)) {
        activeTurn = summary.activeTurn
      }
    }

    const qq = this._readQQState(todayStart)
    const lastOutboundAt = Math.max(qq.lastOutboundAt, lastQQToolAt)
    const lastQQAt = Math.max(lastOutboundAt, qq.lastInboundAt, lastQQToolAt)
    const pendingReply = qq.lastInboundAt > lastOutboundAt &&
      nowMs - qq.lastInboundAt <= this.windows.qqPendingMs

    if (sessionFiles === 0 && usage.turns === 0 && home) {
      const created = Date.parse(home.createdAt || '')
      const homeTurns = Number(home.turns) || 0
      if (homeTurns > 0 && (!Number.isFinite(created) || created >= todayStart)) {
        usage.turns = homeTurns
      }
    }

    const signals = {
      lastBiliAt,
      lastQQToolAt,
      lastOutboundAt,
      lastInboundAt: qq.lastInboundAt,
      pendingReply,
      lastQQAt,
      lastWorkRequestAt,
      pendingWorkRequestAt,
      pendingStrongToolAt,
      activeTurn,
      lastEventAt,
      lastEventType,
    }
    const activity = inferActivity(nowMs, signals, this.windows)
    const profile = activity ? ACTIVITY_PROFILES[activity] : null
    let status = profile ? profile.status : null
    if (activity === 'qq' && pendingReply) status = '回消息'

    return {
      home,
      sessionId,
      sessionFiles,
      todayUsage: usage,
      activity,
      room: profile ? profile.room : null,
      status,
      signals,
    }
  }
}

function localDayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

module.exports = {
  FishTelemetry,
  readSystemHealth,
  readHomeStateFile,
  readJsonFile,
  walkFiles,
  parseSessionEvents,
  readSessionText,
  summarizeSession,
  inferActivity,
  emptyUsage,
  localDayKey,
  startOfLocalDay,
  resolveHomeState,
  resolveActivity,
  resolveRoom,
  defaultDshRoot,
  defaultFishRoot,
  defaultHomeFile,
  defaultWorkspaceRoot,
  defaultFurnitureFile,
  readFurnitureFile,
  writeFurnitureFile,
  defaultFeaturesFile,
  readFeaturesFile,
  writeFeaturesFile,
  DEFAULT_ACTIVITY_WINDOWS,
}
