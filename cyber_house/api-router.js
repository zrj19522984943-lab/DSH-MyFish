'use strict'

/**
 * api-router.js
 *
 * 赛博小屋（MVP）后端：
 *   GET  /api/fish-home/state        -> 坐标、房间、真实活动、今日停留/轮数/Token、环境传感器
 *   GET  /api/fish-home/geojson      -> 同一份小屋数据的 GeoJSON（RFC 7946）矢量导出，供 QGIS 加载
 *   POST /api/fish-home/knock        -> 从网页向小鱼的 DSH 会话敲一下门
 *   POST /api/fish-home/destination  -> 网页"规划路线"：指定终点坐标，A* 算出导航途径点
 *   GET  /api/fish-home/features     -> 数据库里的自定义 GeoJSON 要素（FeatureCollection）
 *   POST /api/fish-home/features     -> 保存一个新要素到 SQLite（wall/furniture 计入 A* 障碍栅格）
 *   DELETE /api/fish-home/features/:id -> 从 SQLite 删除一个要素（自定义要素或家具），刷新 A* 栅格
 *   POST /api/fish-home/analyze-buffer -> 空间缓冲区分析：Turf 生成圆缓冲面并检索相交要素
 *   GET  /api/fish-home/hardware/battery -> 后端记着的手机电量
 *   POST /api/fish-home/hardware/battery -> 手机插拔 / 每分钟电量（插拔才注入物理感知）
 *   GET  /home.html            -> 单文件看板（Canvas 版）
 *   GET  /home_leaflet.html    -> 单文件看板（Leaflet Web GIS 版）
 *   GET  /                     -> 同上（Canvas 版）
 *
 * 可以直接运行：
 *   node cyber_house/api-router.js
 *
 * 也可以把 createApiRouter(engine) 返回的函数挂到已有的 http server 上。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createStateEngine } = require('./state-engine')
const { createHardwareSensor } = require('./hardware-sensor')
const { analyzeBuffer } = require('./gis/analyze')
const { loadCampusGeoJSON } = require('./campus')
const { normalizeImportFeatures } = require('./gis/features')
const { normalizeMapLevel, isValidMapLevel } = require('./db/map-level')
const multer = require('multer')

const API_PATH = '/api/fish-home/state'
const KNOCK_PATH = '/api/fish-home/knock'
const GEOJSON_PATH = '/api/fish-home/geojson'
const DESTINATION_PATH = '/api/fish-home/destination'
const FEATURES_PATH = '/api/fish-home/features'
const ANALYZE_BUFFER_PATH = '/api/fish-home/analyze-buffer'
const CAMPUS_GEOJSON_PATH = '/api/fish-home/campus-geojson'
const ENVIRONMENT_PATH = '/api/fish-home/environment'
const BATTERY_PATH = '/api/fish-home/hardware/battery'
/** POST /api/fish-home/upload-shp —— 网页直传 SHP（zip）解析入库。 */
const UPLOAD_SHP_PATH = '/api/fish-home/upload-shp'
/** POST /api/fish-home/import-qgis —— QGIS 导出的 GeoJSON 直接入库（任务书 1）。 */
const IMPORT_QGIS_PATH = '/api/fish-home/import-qgis'
/** QGIS 导入请求体上限：整图导出可以很大，16MB 足够覆盖并防止内存滥用。 */
const MAX_IMPORT_BODY_BYTES = 16 * 1024 * 1024
/** zip 本体上限：校园级 SHP 一般几 MB，留足余量但不许把内存撑爆。 */
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024
/** DELETE /api/fish-home/features/:id 的前缀，:id 是要素 id。 */
const FEATURES_ID_PREFIX = '/api/fish-home/features/'
/** 单个自定义要素的体积上限：GeoJSON 顶点可以很密，但不能让它把接口撑爆。 */
const MAX_FEATURE_BODY_BYTES = 256 * 1024
/** 一次最多接收的要素个数（FeatureCollection 批量提交时）。 */
const MAX_FEATURES_PER_REQUEST = 100
const DEFAULT_PORT = 8787
const HOME_FILE = path.join(__dirname, 'home.html')
const HOME_LEAFLET_FILE = path.join(__dirname, 'home_leaflet.html')
const MAX_KNOCK_CHARS = 500
const MAX_KNOCK_BODY_BYTES = 16 * 1024
const BROWSER_COOKIE_DAYS = 30
const DSH_URL_CACHE_FILE = path.join(__dirname, '.dsh-web-url.json')
const DSH_URL_CACHE_TTL_MS = 60 * 1000
const DSH_PROBE_TIMEOUT_MS = 800
const DSH_PROBE_CONCURRENCY = 8
const DSH_KNOWN_PORTS = [16992, 20470, 3080]
const DSH_AUTH_SIGNATURE = /dsh web authentication required/i

/* ---------------------------------------------------------------------------
 * 物理感知 2：Type-C 手机电量（任务书模块 3）
 *
 * 手机网页用 navigator.getBattery() 监听充电状态：
 *   - 插上 -> POST { action:'plug_in', level:0.85 }
 *   - 拔下 -> POST { action:'unplug', level:0.85 }
 *   - 插着时每分钟 -> POST { action:'update', level:0.86 }
 *
 * 后端把最新值放在内存 phoneBattery 里，并同步落盘
 * cyber_house/phone_battery.json。为什么要落盘：fish 插件的 system prompt 在
 * 另一个进程里，它每轮要同步读到「手机现在插着、电量多少」，不能反过来请求
 * /state（会推进小鱼）。plug_in / unplug 才注入事件，update 只静默覆盖数值。
 * ------------------------------------------------------------------------- */

const PHONE_BATTERY_FILE = 'phone_battery.json'
/** 落盘电量超过这么久就只当历史参考，不拿它给插拔去重（避免旧状态挡住真实插上）。 */
const PHONE_BATTERY_HYDRATE_FRESH_MS = 10 * 60 * 1000

/** 后端内存里的最新手机电量。 */
const phoneBattery = {
  level: null,
  percent: null,
  charging: false,
  plugged: false,
  updatedAt: null,
  updatedAtMs: 0,
  source: 'battery-status-api',
}
let phoneBatteryHydrated = false

function phoneBatteryWorkspaceRoot(engine) {
  const root = engine && typeof engine.workspaceRoot === 'string' ? engine.workspaceRoot.trim() : ''
  return root ? path.resolve(root) : path.resolve(__dirname, '..')
}

function phoneBatteryFile(engine) {
  return path.join(phoneBatteryWorkspaceRoot(engine), 'cyber_house', PHONE_BATTERY_FILE)
}

function phoneBatterySnapshot() {
  return {
    level: phoneBattery.level,
    percent: phoneBattery.percent,
    charging: phoneBattery.charging,
    plugged: phoneBattery.plugged,
    updatedAt: phoneBattery.updatedAt,
    updatedAtMs: phoneBattery.updatedAtMs,
    source: phoneBattery.source,
  }
}

/** 0–1（兼容 0–100）-> 0–1；非法返回 null。 */
function normalizeBatteryLevel(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (value === null || value === undefined || value === '') return null
  let level = Number(value)
  if (!Number.isFinite(level)) return null
  if (level > 1 && level <= 100) level /= 100
  if (level < 0 || level > 1) return null
  return Math.round(level * 1000) / 1000
}

/** 服务重启后把上次落盘的电量读回内存（插拔去重不会因为重启而重复）。 */
function hydratePhoneBattery(engine) {
  if (phoneBatteryHydrated) return phoneBatterySnapshot()
  phoneBatteryHydrated = true

  const raw = readJsonFile(phoneBatteryFile(engine))
  if (!raw || typeof raw !== 'object') return phoneBatterySnapshot()

  const level = normalizeBatteryLevel(raw.level)
  if (level !== null) {
    phoneBattery.level = level
    phoneBattery.percent = Math.round(level * 100)
  }
  const updatedAtMs = Number(raw.updatedAtMs) || 0
  // 只信任最近的落盘状态：太久以前的「插着」不能挡住下一次真实插上。
  const fresh = updatedAtMs > 0 && Date.now() - updatedAtMs <= PHONE_BATTERY_HYDRATE_FRESH_MS
  phoneBattery.charging = fresh && raw.charging === true
  phoneBattery.plugged = fresh && raw.plugged === true
  phoneBattery.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null
  phoneBattery.updatedAtMs = updatedAtMs
  phoneBattery.source = typeof raw.source === 'string' ? raw.source.slice(0, 80) : 'battery-status-api'
  return phoneBatterySnapshot()
}

/** 测试用：清空内存态，并允许下一次 hydrate 重新读盘。 */
function resetPhoneBattery() {
  phoneBattery.level = null
  phoneBattery.percent = null
  phoneBattery.charging = false
  phoneBattery.plugged = false
  phoneBattery.updatedAt = null
  phoneBattery.updatedAtMs = 0
  phoneBattery.source = 'battery-status-api'
  phoneBatteryHydrated = false
}

function persistPhoneBattery(engine) {
  const file = phoneBatteryFile(engine)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(phoneBatterySnapshot(), null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    console.warn(`[cyber-house] 手机电量落盘失败：${error?.message || error}`)
  }
}

/** 插上 / 拔下时注入；返回注入正文（没注入则返回空串）。 */
function injectPhoneBatteryEvent(engine, action, level) {
  const percent = Math.round(Number(level) * 100)
  const verb = action === 'plug_in' ? '插上了' : '拔下了'
  const text = `[物理感知：主人的手机${verb}电脑，当前电量 ${percent}%。]`
  if (!engine || typeof engine.injectPhysicalEvent !== 'function') {
    console.warn('[cyber-house] 手机电量事件没注入：engine 没有 injectPhysicalEvent')
    return ''
  }
  try {
    engine.injectPhysicalEvent(text, {
      kind: 'battery',
      action,
      level,
      percent,
    })
    return text
  } catch (error) {
    console.warn(`[cyber-house] 手机电量事件注入失败：${error?.message || error}`)
    return ''
  }
}

function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  // DELETE 给网页删除要素用；PATCH 给动态属性表保存属性用；
  // 预检请求靠 Methods + Max-Age 一次性通过。
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  res.setHeader('Access-Control-Max-Age', '86400')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}

function sendJson(res, statusCode, payload, method = 'GET') {
  const body = JSON.stringify(payload)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.end(method === 'HEAD' ? undefined : body)
}

function sendHtml(res, statusCode, body, method = 'GET') {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.end(method === 'HEAD' ? undefined : body)
}

function sendPlainText(res, statusCode, body, method = 'GET') {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(method === 'HEAD' ? undefined : body)
}

/**
 * 静态图片：只在 cyber_house/assets/ 目录内取图（Q 版精灵图等）。
 * 只认常见图片扩展名，杜绝路径穿越和拿这个口子读别的文件。
 */
const ASSETS_DIR = path.join(__dirname, 'assets')
const ASSET_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
})

function sendAsset(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    sendPlainText(res, 405, 'Method Not Allowed', req.method)
    return
  }

  let relativePath
  try {
    relativePath = decodeURIComponent(pathname.replace(/^\/assets\//, ''))
  } catch {
    sendPlainText(res, 400, 'Bad Request', req.method)
    return
  }

  const filePath = path.resolve(ASSETS_DIR, relativePath)
  const rootPath = path.resolve(ASSETS_DIR) + path.sep
  const mime = ASSET_MIME[path.extname(filePath).toLowerCase()]
  if (!mime || !filePath.startsWith(rootPath)) {
    sendPlainText(res, 404, 'Not Found', req.method)
    return
  }

  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    sendPlainText(res, 404, 'Not Found', req.method)
    return
  }
  if (!stat.isFile()) {
    sendPlainText(res, 404, 'Not Found', req.method)
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Type', mime)
  res.setHeader('Content-Length', stat.size)
  res.setHeader('Cache-Control', 'public, max-age=60')
  res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(filePath))
}

function defaultDshRoot() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
}

function defaultFishRoot() {
  return process.env.DSH_FISH_HOME
    ? path.resolve(process.env.DSH_FISH_HOME)
    : path.join(os.homedir(), '.dsh-fish')
}

function httpError(statusCode, message, detail) {
  const error = new Error(message)
  error.statusCode = statusCode
  if (detail !== undefined) error.detail = detail
  return error
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function readBrowserSecret() {
  const file = path.join(defaultDshRoot(), '.credentials.yaml')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    throw httpError(502, '读不到 DSH 凭据文件，无法唤醒小鱼会话')
  }

  const marker = 'client-connection/browser-session:'
  const start = text.indexOf(marker)
  if (start < 0) throw httpError(502, 'DSH 凭据里没有 browser-session 记录')
  const block = text.slice(start, start + 1200)
  const match = block.match(/secret:\s*["']?([A-Za-z0-9_-]+)["']?/)
  if (!match) throw httpError(502, 'DSH browser-session 缺少 secret')

  const secret = Buffer.from(match[1], 'base64url')
  if (secret.length !== 32) throw httpError(502, 'DSH browser-session secret 长度不正确')
  return secret
}

/** 生成与 dsh-client-connection 相同的 v1 浏览器 cookie。 */
function createBrowserCookie(dshUrl) {
  const secret = readBrowserSecret()
  const authority = new URL(dshUrl).host
  const name = 'dsh-auth-' + base64Url(crypto.createHash('sha256').update(authority).digest())
  const now = Date.now()
  const payload = {
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + BROWSER_COOKIE_DAYS * 24 * 60 * 60 * 1000,
  }
  const body = base64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = base64Url(crypto.createHmac('sha256', secret).update(body).digest())
  return `${name}=v1.${body}.${signature}`
}

/* ---------------------------------------------------------------------------
 * DSH 地址解析
 *
 * DSH Web 的监听端口来自 `dsh web --port`（缺省 3080）或桌面版宿主的 `--port 0`
 * （由操作系统分配的临时端口，每次启动都可能变），所以不能写死端口。解析顺序：
 *   1. FISH_HOME_DSH_URL / DSH_WEB_URL（显式配置，优先）
 *   2. 上次成功解析的缓存（cyber_house/.dsh-web-url.json，经探测校验）
 *   3. 自动发现：
 *      a. DSH 配置里写死的 webServer 端口（$DSH_HOME/settings.json、桌面 profile
 *         的 cordis 配置等，详见 readDshConfigPorts）
 *      b. 常见端口 + 本机 node/electron/DSH 宿主进程监听的端口（桌面版宿主的
 *         映像名可能是 "DeepSeek Harness.exe"，进程名匹配见 isDshLikeProcessName）
 *      c. 再兜底扫一遍其余本机监听端口——反正候选最终都由 DSH 未认证时的固定
 *         401 文案（"dsh web authentication required"）认定，不怕误伤
 * 探测成功的地址写回缓存；RPC 连接失败时会强制重新发现并重试一次。
 * ------------------------------------------------------------------------- */

let resolvedDshBase = null
let resolvingDshBase = null

function normalizeDshUrl(raw) {
  if (!raw) return null
  try {
    const value = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
    return new URL(value)
  } catch {
    return null
  }
}

function envDshUrl() {
  return normalizeDshUrl(process.env.FISH_HOME_DSH_URL || process.env.DSH_WEB_URL || '')
}

function readDshUrlCache() {
  const cached = readJsonFile(DSH_URL_CACHE_FILE)
  return cached && typeof cached.url === 'string' ? normalizeDshUrl(cached.url) : null
}

function writeDshUrlCache(url) {
  try {
    fs.writeFileSync(
      DSH_URL_CACHE_FILE,
      `${JSON.stringify({ url: url.origin, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    )
  } catch {
    // 缓存写不进去不影响主流程。
  }
}

/** 探测一个地址是否真的是 DSH Web：未带 cookie 时它会以固定文案回 401。 */
async function probeDshBase(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DSH_PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(new URL('/', url), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    })
    const text = (await response.text()).slice(0, 4096)
    if (response.status === 401 && DSH_AUTH_SIGNATURE.test(text)) return true
    const contentType = response.headers.get('content-type') || ''
    if (response.status === 200 && /text\/html/i.test(contentType) && /__DSH_BOOT__|dsh/i.test(text)) {
      return true
    }
    return false
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 捕获命令输出；受限环境禁止管道时退化为「写临时文件再读」。 */
function runCapture(command, args, timeoutMs = 4000) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  } catch (error) {
    if (!error || (error.code !== 'EPERM' && error.code !== 'EACCES')) throw error
    const tmp = path.join(
      os.tmpdir(),
      `cyber-house-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    )
    const fd = fs.openSync(tmp, 'w')
    try {
      execFileSync(command, args, { stdio: ['ignore', fd, 'ignore'], timeout: timeoutMs, windowsHide: true })
    } finally {
      fs.closeSync(fd)
    }
    try {
      return fs.readFileSync(tmp, 'utf8')
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // 临时文件清理失败无妨。
      }
    }
  }
}

/**
 * 判断进程映像名是否可能是 DSH 自己。
 *
 * node / electron / dsh 之外，桌面版宿主是 Electron 改名运行的（映像名形如
 * "DeepSeek Harness.exe"），按名字前缀匹配会漏掉它，所以名字里带 dsh / harness
 * 的也一并算进来。这只是候选筛选，最终仍然由 401 签名文案认定，不怕误伤。
 */
function isDshLikeProcessName(name) {
  const lower = String(name).toLowerCase()
  if (/^(?:node|electron|dsh)/.test(lower)) return true
  return /(?:^|[^a-z0-9])(?:dsh|harness)(?:[^a-z0-9]|$)/.test(lower)
}

/** 本机 node/electron/DSH 宿主进程的 pid 集合；拿不到时返回 null（不过滤）。 */
function listDshLikePids() {
  try {
    if (process.platform === 'win32') {
      const output = runCapture('tasklist', ['/fo', 'csv', '/nh'])
      const pids = new Set()
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^"([^"]+)","(\d+)"/)
        if (match && isDshLikeProcessName(match[1])) pids.add(Number(match[2]))
      }
      return pids
    }
    const output = runCapture('ps', ['-eo', 'pid=,comm='])
    const pids = new Set()
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (match && isDshLikeProcessName(match[2])) pids.add(Number(match[1]))
    }
    return pids
  } catch {
    return null
  }
}

/**
 * 本机监听的 TCP 端口（{ port, pid } 列表，默认按进程过滤到 node/electron/DSH 宿主）。
 *
 * @param {boolean} [keepAll] - 跳过进程名过滤，返回所有本机监听端口（兜底扫描用）。
 */
function listDshListeningPorts(keepAll = false) {
  const entries = []
  const dshPids = keepAll ? null : listDshLikePids()
  const keep = (pid) => dshPids === null || dshPids.size === 0 || dshPids.has(pid)
  try {
    if (process.platform === 'win32') {
      const output = runCapture('netstat', ['-ano'])
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
        if (!match) continue
        if (!/^(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\])$/.test(match[1])) continue
        const pid = Number(match[3])
        if (keep(pid)) entries.push({ port: Number(match[2]), pid })
      }
    } else {
      const output = runCapture('ss', ['-ltnp'])
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s*LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)/)
        if (!match) continue
        if (!/^(?:127\.0\.0\.1|0\.0\.0\.0|\*|\[::1?\]|\[::\])$/.test(match[1])) continue
        const pidMatch = line.match(/pid=(\d+)/)
        const pid = pidMatch ? Number(pidMatch[1]) : undefined
        if (pid === undefined || keep(pid)) entries.push({ port: Number(match[2]), pid })
      }
    }
  } catch {
    // netstat/ss 不可用时退化为已知端口列表。
  }
  return entries
}

/**
 * 从 DSH 的启动/配置文件里读 webServer 端口（作为发现候选，最终仍由 probeDshBase 校验）。
 *
 * 桌面版宿主用 `--port 0` 启动（端口由操作系统临时分配，不落盘），这台机器上这些
 * 文件通常都不存在；但把端口钉在配置里的部署（例如 `dsh web --port N` 的固定端口
 * 场景）读一下就能直接命中，省得慢慢扫端口。
 */
function readDshConfigPorts() {
  const ports = []

  const add = (value) => {
    const port = Number(value)
    if (Number.isInteger(port) && port > 0 && port <= 65535 && !ports.includes(port)) {
      ports.push(port)
    }
  }

  // $DSH_HOME 下的 settings 文档：webServer.port（兼容平铺的 port 写法）
  for (const name of ['settings.json', 'settings.local.json']) {
    const doc = readJsonFile(path.join(defaultDshRoot(), name))
    if (doc && typeof doc === 'object') {
      if (doc.webServer && typeof doc.webServer === 'object') add(doc.webServer.port)
      add(doc.port)
    }
  }

  // 桌面 profile 的配置文件（yaml）：webServer 段落里的 port。兼容两种写法——
  // `webServer:` 直接作键，或 loader 条目 `- id: webServer ... config: { port: N }`。
  // 不引入 yaml 解析器，只做小范围定向匹配；命中后照样会被探测校验，不怕误配。
  const home = defaultDshRoot()
  for (const file of [
    path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    path.join(home, 'profiles', 'desktop', 'cordis.yml'),
    path.join(home, 'profiles', 'desktop', 'settings.yaml'),
  ]) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const match = text.match(/webServer[\s\S]{0,400}?port\s*:\s*(\d+)/)
    if (match) add(match[1])
  }

  return ports
}

/** 按顺序探一批端口，返回最先通过 DSH 签名校验的地址。 */
async function probePorts(ports) {
  for (let offset = 0; offset < ports.length; offset += DSH_PROBE_CONCURRENCY) {
    const batch = ports.slice(offset, offset + DSH_PROBE_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (port) => {
        const url = new URL(`http://127.0.0.1:${port}`)
        return (await probeDshBase(url)) ? url : null
      }),
    )
    const hit = results.find(Boolean)
    if (hit) return hit
  }
  return null
}

async function discoverDshBase() {
  const selfPort = normalizePort(process.env.FISH_HOME_PORT ?? DEFAULT_PORT)
  const candidates = new Set(DSH_KNOWN_PORTS)
  for (const port of readDshConfigPorts()) candidates.add(port)
  for (const entry of listDshListeningPorts()) candidates.add(entry.port)
  candidates.delete(selfPort)

  // 已知端口优先，其余按端口号排序并设上限，避免在没有 DSH 时扫太久。
  const extra = [...candidates].filter((port) => !DSH_KNOWN_PORTS.includes(port)).sort((a, b) => a - b)
  const ports = [...DSH_KNOWN_PORTS, ...extra].slice(0, 80)
  const hit = await probePorts(ports)
  if (hit) return hit

  // 兜底：即使放宽了进程名匹配，仍可能遇到名字完全不像的宿主（或拿不到进程列表）。
  // 把其余本机监听端口也扫一遍——找到后照样要靠 401 签名文案认定，不会误认。
  const scanned = new Set(ports)
  const others = []
  for (const entry of listDshListeningPorts(true)) {
    if (!scanned.has(entry.port) && entry.port !== selfPort) others.push(entry.port)
  }
  others.sort((a, b) => a - b)
  return probePorts(others.slice(0, 80))
}

async function resolveDshBaseUrl(force = false) {
  if (!force && resolvedDshBase && Date.now() - resolvedDshBase.checkedAt < DSH_URL_CACHE_TTL_MS) {
    return resolvedDshBase.url
  }
  if (resolvingDshBase) return resolvingDshBase

  resolvingDshBase = (async () => {
    try {
      const fromEnv = envDshUrl()
      if (fromEnv) {
        if (await probeDshBase(fromEnv)) {
          resolvedDshBase = { url: fromEnv, checkedAt: Date.now() }
          return fromEnv
        }
        console.warn(
          `[cyber-house] FISH_HOME_DSH_URL 指向的地址不可达：${fromEnv.origin}，改为自动发现`,
        )
      }

      const cached = readDshUrlCache()
      if (cached && (await probeDshBase(cached))) {
        resolvedDshBase = { url: cached, checkedAt: Date.now() }
        return cached
      }

      const found = await discoverDshBase()
      if (found) {
        writeDshUrlCache(found)
        resolvedDshBase = { url: found, checkedAt: Date.now() }
        console.log(`[cyber-house] 已发现 DSH Web：${found.origin}`)
        return found
      }

      throw httpError(
        502,
        '找不到正在运行的 DSH Web 服务：请确认 `dsh web` 或 DSH 桌面版已启动，或设置 FISH_HOME_DSH_URL',
        { kind: 'discovery' },
      )
    } finally {
      resolvingDshBase = null
    }
  })()

  return resolvingDshBase
}

function describeFetchFailure(error, url) {
  const cause = error && error.cause
  const code = (cause && (cause.code || cause.errno)) || ''
  const reason = error && error.message ? error.message : String(error)
  return `无法连接 DSH（${url.origin}）：${reason}${code ? ` [${code}]` : ''}`
}

/**
 * 调 DSH 的 Remote RPC。使用与浏览器相同的签名 cookie，
 * 走 /api/session/prompt 让宿主自己 resume + followup/steer 目标会话。
 *
 * 失败时抛出的错误带 detail：{ url, kind, httpStatus?, rpcCode?, body? }，
 * handleKnock 会把它原样透传给前端。
 */
async function dshRpc(method, args, options = {}) {
  const base = await resolveDshBaseUrl(options.forceResolve === true)
  const url = new URL(`/api/${method}`, base)
  const cookie = createBrowserCookie(base)
  const timeoutMs = options.timeoutMs || 15000

  console.log(`[cyber-house] RPC ${method} -> ${url.href}`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  let text
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: cookie,
        Origin: base.origin,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method,
        payload: { args },
      }),
      signal: controller.signal,
    })
    text = await response.text()
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw httpError(504, `DSH ${method} 超时（${timeoutMs}ms）`, {
        url: url.href,
        kind: 'timeout',
      })
    }
    throw httpError(502, describeFetchFailure(error, url), {
      url: url.href,
      kind: 'connection',
      reason: (error && error.cause && (error.cause.code || error.cause.errno)) || error?.message || String(error),
    })
  } finally {
    clearTimeout(timer)
  }

  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    // 非 JSON 响应（例如代理错误页）按正文片段透传。
  }

  if (response.status === 401) {
    throw httpError(
      502,
      'DSH 拒绝了浏览器凭据（HTTP 401）：请检查 ~/.dsh/.credentials.yaml 里的 browser-session',
      { url: url.href, httpStatus: 401, kind: 'auth', body: text.slice(0, 500) },
    )
  }
  if (!response.ok) {
    throw httpError(502, `DSH ${method} 失败：HTTP ${response.status} ${response.statusText}`.trim(), {
      url: url.href,
      httpStatus: response.status,
      kind: 'http',
      body: text.slice(0, 500),
    })
  }
  if (!payload || payload.type !== 'server-response') {
    throw httpError(502, `DSH ${method} 返回了无法识别的响应`, {
      url: url.href,
      httpStatus: response.status,
      kind: 'protocol',
      body: text.slice(0, 500),
    })
  }
  if (!payload.result || payload.result.ok !== true) {
    const remote = payload.result && payload.result.error
    const prefix = remote && remote.code ? `${remote.code}：` : ''
    throw httpError(502, `DSH ${method} 失败：${prefix}${(remote && remote.message) || '未知错误'}`, {
      url: url.href,
      httpStatus: response.status,
      kind: 'remote',
      rpcCode: remote && remote.code,
      remoteDetails: remote && remote.details,
    })
  }
  return payload.result.value
}

function readFishSessionId() {
  const homeFile = process.env.FISH_HOME_JSON
    ? path.resolve(process.env.FISH_HOME_JSON)
    : path.join(defaultFishRoot(), 'home.json')
  const home = readJsonFile(homeFile)
  const sessionId = home && typeof home.sessionId === 'string' ? home.sessionId.trim() : ''
  if (!sessionId) throw httpError(502, '读不到小鱼的当前会话 id')
  return sessionId
}

function buildKnockText(message) {
  return [
    `[系统：拟南芥在赛博小屋的网页上敲了敲门，对你说：“${message}”]`,
    '（这是网页敲门。他现在在 QQ 那边等你；回他一句，用 qq_bridge_send 发回 QQ。',
    '如果第一次返回“本轮不是 QQ 发起的”，在同一个 turn 里再调用一次就会发出去。）',
  ].join('\n')
}

async function deliverKnock(message, engine) {
  const sessionId = readFishSessionId()
  const text = buildKnockText(message)
  const request = {
    requestId: crypto.randomUUID(),
    sessionId,
    mode: 'steer',
    content: [{ type: 'text', text }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
  }

  let result
  try {
    result = await dshRpc('session/prompt', { request }, { timeoutMs: 20000 })
  } catch (error) {
    if (error?.detail?.kind === 'connection') {
      // 宿主重启后换了端口：强制重新发现再重试一次。
      // requestId 保持不变，DSH 按 requestId 去重，第一次若已送达也不会重复投递。
      console.warn('[cyber-house] 敲门连接失败，重新发现 DSH 地址后重试一次')
      result = await dshRpc('session/prompt', { request }, { timeoutMs: 20000, forceResolve: true })
    } else {
      throw error
    }
  }

  if (!result || result.accepted !== true) {
    throw httpError(502, 'DSH 没有接受这次敲门', { kind: 'not-accepted', value: result ?? null })
  }

  if (engine && typeof engine.registerKnock === 'function') {
    engine.registerKnock(message)
  }
  console.log(`[cyber-house] 敲门已送达 session=${sessionId}`)
  return { sessionId }
}

function readJsonBody(req, maxBytes = MAX_KNOCK_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []

    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        fail(httpError(413, '敲门内容太长了'))
        req.resume()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (settled) return
      settled = true
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'))
      }
    })

    req.on('error', (error) => fail(httpError(400, error.message || '读取请求体失败')))
  })
}

async function handleKnock(req, res, engine) {
  try {
    const body = await readJsonBody(req)
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message) throw httpError(400, '先写一句要跟她说的话')
    if ([...message].length > MAX_KNOCK_CHARS) {
      throw httpError(400, `敲门内容最多 ${MAX_KNOCK_CHARS} 个字`)
    }

    await deliverKnock(message, engine)
    sendJson(res, 200, { ok: true })
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502
    const detail = error?.detail
    if (status >= 500) {
      const extra = detail !== undefined ? ` ${JSON.stringify(detail)}` : ''
      console.warn(`[cyber-house] 敲门失败：${error?.message || error}${extra}`)
      if (!error?.statusCode && error?.stack) console.warn(error.stack)
    }
    if (!res.headersSent) {
      sendJson(res, status, {
        ok: false,
        error: error?.message || '敲门失败',
        ...(detail !== undefined ? { detail } : {}),
      })
    }
  }
}

/**
 * 网页"规划路线"：把终点坐标交给 state-engine 的 A* 寻路，
 * 返回途径点数组，前端立刻就能画出导航虚线。
 */
async function handleDestination(req, res, engine) {
  try {
    const body = await readJsonBody(req)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw httpError(400, '请求体需要是 JSON 对象，例如 {"x": 510, "y": 225}')
    }
    if (!engine || typeof engine.setDestination !== 'function') {
      throw httpError(501, 'state-engine 未提供 setDestination')
    }

    // 先处理清除：清请求不带坐标，不能被下面的 x/y 校验拦下。
    if (body.clear === true) {
      if (typeof engine.clearDestination !== 'function') {
        throw httpError(501, 'state-engine 未提供 clearDestination')
      }
      engine.clearDestination()
      console.log('[cyber-house] 导航线已清除，回到自然活动目标')
      sendJson(res, 200, { ok: true, data: { ok: true, cleared: true } })
      return
    }

    // 校园模式：前端传真实经纬度（高德点击是 GCJ02），后端反算成虚拟坐标。
    if (body.lng !== undefined || body.lat !== undefined) {
      const lng = Number(body.lng)
      const lat = Number(body.lat)
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        throw httpError(400, 'lng 和 lat 都得是有效经纬度')
      }
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw httpError(400, '经纬度超出合理范围')
      }
      const coordinateSystem = body.coordSystem === 'gcj02' ? 'gcj02' : 'wgs84'
      if (typeof engine.setGeoDestination !== 'function') {
        throw httpError(501, 'state-engine 未提供 setGeoDestination')
      }
      const result = engine.setGeoDestination(lng, lat, coordinateSystem)
      if (!result || result.ok !== true) {
        throw httpError(400, (result && result.error) || '终点无效，规划不出路线')
      }
      console.log(`[cyber-house] 校园路线已规划：(${lng}, ${lat}) ${coordinateSystem} -> 虚拟 (${result.virtual?.x}, ${result.virtual?.y})`)
      sendJson(res, 200, { ok: true, data: result })
      return
    }

    const x = Number(body.x)
    const y = Number(body.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw httpError(400, 'x 和 y 都得是 0-1000 的数字')
    }
    if (x < -1000 || x > 2000 || y < -1000 || y > 2000) {
      throw httpError(400, '坐标超出小屋世界的合理范围')
    }

    const result = engine.setDestination(x, y)
    if (!result || result.ok !== true) {
      throw httpError(400, (result && result.error) || '终点无效，规划不出路线')
    }

    console.log(`[cyber-house] 路线已规划：(${x}, ${y}) 途径点 ${result.route ? result.route.length : 0} 个`)
    sendJson(res, 200, { ok: true, data: result })
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502
    const detail = error?.detail
    if (status >= 500) {
      const extra = detail !== undefined ? ` ${JSON.stringify(detail)}` : ''
      console.warn(`[cyber-house] 规划路线失败：${error?.message || error}${extra}`)
      if (!error?.statusCode && error?.stack) console.warn(error.stack)
    }
    if (!res.headersSent) {
      sendJson(res, status, {
        ok: false,
        error: error?.message || '规划路线失败',
        ...(detail !== undefined ? { detail } : {}),
      })
    }
  }
}

/**
 * 校园模式：切换小鱼当前所在空间（只影响展示 / 交互上下文，不影响 A* 与 QQ）。
 */
async function handleEnvironment(req, res, engine) {
  try {
    if (!engine || typeof engine.setEnvironment !== 'function') {
      throw httpError(501, 'state-engine 未提供 setEnvironment')
    }
    const body = await readJsonBody(req)
    const environment = body && body.environment === 'campus' ? 'campus' : 'home'
    const teleport = body && body.teleport === true
    const result = engine.setEnvironment(environment, { teleport })
    console.log(`[cyber-house] 空间切换：${environment}${teleport ? '（传送）' : ''}`)
    sendJson(res, 200, { ok: true, data: result })
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, error: error?.message || '切换空间失败' })
    }
  }
}

/**
 * 手机电量接口：
 *   GET  /api/fish-home/hardware/battery -> 看后端当前记着的电量
 *   POST /api/fish-home/hardware/battery -> { action, level, charging? }
 *
 * plug_in / unplug 才注入物理感知；update 静默覆盖内存与落盘文件。
 * 重复的 plug_in / unplug 会被去重（例如手机刷新页面时 charging 仍是 true）。
 */
async function handlePhoneBattery(req, res, engine) {
  try {
    hydratePhoneBattery(engine)

    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, { ok: true, data: { battery: phoneBatterySnapshot() } }, req.method)
      return
    }

    const body = await readJsonBody(req, 4 * 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw httpError(400, '请求体需要是 JSON 对象，例如 {"action":"plug_in","level":0.85}')
    }

    const action = String(body.action || '').trim()
    if (action !== 'plug_in' && action !== 'unplug' && action !== 'update') {
      throw httpError(400, 'action 只能是 plug_in / unplug / update')
    }

    const level = normalizeBatteryLevel(body.level)
    if (level === null) {
      throw httpError(400, 'level 必须是 0–1 之间的小数（也兼容 0–100 的百分数）')
    }

    const charging = typeof body.charging === 'boolean' ? body.charging : null
    const wasPlugged = phoneBattery.plugged

    phoneBattery.level = level
    phoneBattery.percent = Math.round(level * 100)
    phoneBattery.updatedAt = new Date().toISOString()
    phoneBattery.updatedAtMs = Date.now()
    phoneBattery.source = typeof body.source === 'string' && body.source.trim()
      ? body.source.trim().slice(0, 80)
      : 'battery-status-api'

    let injected = false
    if (action === 'plug_in') {
      phoneBattery.plugged = true
      phoneBattery.charging = true
      if (!wasPlugged) injected = Boolean(injectPhoneBatteryEvent(engine, action, level))
    } else if (action === 'unplug') {
      phoneBattery.plugged = false
      phoneBattery.charging = false
      if (wasPlugged) injected = Boolean(injectPhoneBatteryEvent(engine, action, level))
    } else {
      // update：只覆盖数值，不注入。充电状态以手机上报的为准；
      // 这样服务重启、内存丢了，下一次 update 也能把「还插着」补回来。
      if (charging !== null) {
        phoneBattery.charging = charging
        phoneBattery.plugged = charging
      }
    }

    persistPhoneBattery(engine)

    // update 每分钟一次，不写日志刷屏；插拔是真正的物理事件，值得留一行。
    if (action !== 'update') {
      console.log(
        `[cyber-house] 手机电量：${action === 'plug_in' ? '插上' : '拔下'}，`
        + `${phoneBattery.percent}%${injected ? '，已注入物理感知' : '（重复状态，不重复注入）'}`,
      )
    }

    sendJson(res, 200, {
      ok: true,
      data: {
        action,
        injected,
        battery: phoneBatterySnapshot(),
      },
    })
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502
    if (status >= 500) console.warn(`[cyber-house] 手机电量接口失败：${error?.message || error}`)
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, error: error?.message || '手机电量接口失败' })
    }
  }
}

/**
 * 校园 SHP / GeoJSON：前端高德底图用 GCJ02 叠加，默认给 WGS84。
 * 数据库里 shp_edits 表存着网页上改过的外部要素属性，按要素 id 叠在
 * 文件属性之上返回（文件本身只读）。
 */
async function handleCampusGeoJSON(req, res, engine) {
  try {
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      url = null
    }
    const coordinateSystem = url?.searchParams.get('coordSystem') === 'gcj02' ? 'gcj02' : 'wgs84'
    // 动态属性表：网页上对外部 SHP 要素做过的修改，从 shp_edits 表取出来合并。
    let overrides = null
    if (engine && engine.db && typeof engine.db.getShpEdits === 'function') {
      try {
        overrides = engine.db.getShpEdits()
      } catch (error) {
        console.warn(`[cyber-house] 读取 SHP 覆盖表失败，先返回原始文件属性：${error?.message || error}`)
      }
    }
    const collection = await loadCampusGeoJSON({ coordinateSystem, overrides })
    sendJson(res, 200, collection, req.method)
  } catch (error) {
    console.warn(`[cyber-house] 校园数据读取失败：${error?.message || error}`)
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: '校园数据读取失败' }, req.method)
    }
  }
}

/**
 * 网页"绘制要素"：接收一个标准 GeoJSON Feature（或 FeatureCollection），
 * 校验后写进 cyber_house.sqlite 的 features 表，并立刻作废 A* 寻路栅格缓存。
 *
 * 前端画完图形弹表单填 properties，例如：
 *   { "type": "Feature", "properties": { "type": "wall", "name": "隔断" },
 *     "geometry": { "type": "LineString", "coordinates": [[x,y], ...] } }
 *
 * type=wall / furniture 的几何体会被栅格化进 A* 障碍物，
 * 下一轮 getState 直接带着新栅格运行；返回送存后的完整 FeatureCollection。
 */
async function handleFeatures(req, res, engine) {  try {
    if (!engine || typeof engine.addFeature !== 'function') {
      throw httpError(501, 'state-engine 未提供 addFeature')
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const collection = typeof engine.getCustomFeatures === 'function'
        ? engine.getCustomFeatures()
        : { type: 'FeatureCollection', features: [] }
      sendJson(res, 200, collection, req.method)
      return
    }

    const body = await readJsonBody(req, MAX_FEATURE_BODY_BYTES)
    if (!body || typeof body !== 'object') {
      throw httpError(400, '请求体需要是 GeoJSON Feature 对象，或包含 features 数组的 FeatureCollection')
    }

    // 支持单个 Feature，也支持一个 FeatureCollection（一次画好几个）。
    let incoming
    if (Array.isArray(body.features)) {
      incoming = body.features
    } else if (body.type === 'Feature') {
      incoming = [body]
    } else {
      throw httpError(400, '请求体需要是 GeoJSON Feature 对象，或包含 features 数组的 FeatureCollection')
    }
    if (incoming.length === 0) throw httpError(400, '没有收到任何要素')
    if (incoming.length > MAX_FEATURES_PER_REQUEST) {
      throw httpError(400, `一次性最多保存 ${MAX_FEATURES_PER_REQUEST} 个要素`)
    }

    const collection = engine.addFeatures(incoming)
    sendJson(res, 200, { ok: true, data: collection })
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502
    const detail = error?.detail
    if (status >= 500) {
      const extra = detail !== undefined ? ` ${JSON.stringify(detail)}` : ''
      console.warn(`[cyber-house] 保存要素失败：${error?.message || error}${extra}`)
      if (!error?.statusCode && error?.stack) console.warn(error.stack)
    }
    if (!res.headersSent) {
      sendJson(res, status, {
        ok: false,
        error: error?.message || '保存要素失败',
        ...(detail !== undefined ? { detail } : {}),
      })
    }
  }
}

/**
 * 网页"缓冲区分析"：POST 一个圆心 {x, y} 与半径 {radius}，
 * 后端用 Turf 生成缓冲面，在整屋 GeoJSON 里检索相交的要素。
 *
 * 候选集合就是 getHouseGeoJSON() 的全部要素（房间 / 家具 / 门洞 / 小鱼 /
 * 当前路线 / 自定义要素），网页前端画半透明发光圆并弹出圈到的要素名单。
 * 默认排除小鱼自己和当前路线——它们不是"周围的东西"。
 */
async function handleAnalyzeBuffer(req, res, engine) {
  try {
    const body = await readJsonBody(req)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw httpError(400, '请求体需要是 JSON 对象，例如 {"x": 640, "y": 500, "radius": 200}')
    }
    const x = Number(body.x)
    const y = Number(body.y)
    const radius = Number(body.radius)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw httpError(400, 'x 和 y 都得是 0-1000 的数字')
    }
    if (!Number.isFinite(radius) || radius <= 0) {
      throw httpError(400, 'radius 必须是正数（建议 5-500）')
    }

    if (!engine || typeof engine.getHouseGeoJSON !== 'function') {
      throw httpError(501, 'state-engine 未提供 getHouseGeoJSON')
    }

    // 排除表：默认剔除小鱼 / 路线；调用方可以显式覆盖。
    let excludeKinds = ['fish', 'route']
    if (Array.isArray(body.excludeKinds)) {
      excludeKinds = body.excludeKinds.map((k) => String(k)).filter(Boolean).slice(0, 10)
    }

    const allFeatures = engine.getHouseGeoJSON().features || []
    const result = analyzeBuffer([x, y], radius, allFeatures, { excludeKinds })
    sendJson(res, 200, { ok: true, data: result })
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502
    if (status >= 500) console.warn(`[cyber-house] 缓冲区分析失败：${error?.message || error}`)
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, error: error?.message || '缓冲区分析失败' })
    }
  }
}

/**
 * 网页"删除要素"：DELETE /api/fish-home/features/:id
 *
 * id 在统一要素表里找（不再分文件和来源）：
 *   - 网页画的要素（id 形如 feat-mw2z5xl7-98volj）
 *   - 家具（id 形如 bedroom-bed / 客厅-沙发）
 *   - 门洞（一般不从网页删）
 *
 * 删掉后立刻作废 A* 栅格缓存：被家具 / 墙挡住的格子下一轮就恢复可通行。
 */
async function handleDeleteFeature(req, res, engine, featureId) {
  try {
    if (!engine || typeof engine.removeFeatureById !== 'function') {
      throw httpError(501, 'state-engine 未提供 removeFeatureById')
    }
    if (!featureId) throw httpError(400, 'DELETE 路径里缺少要素 id，例如 /api/fish-home/features/feat-xxxx')

    const result = engine.removeFeatureById(featureId)
    if (!result || result.ok !== true) {
      throw httpError(404, (result && result.error) || `没有找到 id 为 ${featureId} 的要素`)
    }
    console.log(`[cyber-house] 要素已删除：${featureId}（${result.source}）A* 栅格缓存已作废`)
    sendJson(res, 200, { ok: true, data: result })
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502
    if (status >= 500) console.warn(`[cyber-house] 删除要素失败：${error?.message || error}`)
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, error: error?.message || '删除要素失败' })
    }
  }
}

/**
 * 网页"保存属性"：PATCH /api/fish-home/features/:id/properties
 *
 * 动态属性表（外部要素无缝兼容）的保存入口。body 是一个
 * { key: newValue } 的修改包，后端：
 *   - 校验 key（不能是 id / _ 前缀系统字段；name/type/room 走统一列）；
 *   - shp- 前缀的外部 SHP 要素：合并进文件属性，整条写进 shp_edits 覆盖包；
 *   - 屋内要素：合进 features 表的 properties 列，name/type/room 落专门列。
 *
 * 几何不动，A* 栅格按数据库 revision 下一轮自然重建。
 */
async function handlePatchFeatureProperties(req, res, engine, featureId) {
  try {
    if (!engine || typeof engine.updateFeatureProperties !== 'function') {
      throw httpError(501, 'state-engine 未提供 updateFeatureProperties')
    }
    if (!featureId) throw httpError(400, 'PATCH 路径里缺少要素 id，例如 /api/fish-home/features/feat-xxxx/properties')

    const body = await readJsonBody(req, MAX_FEATURE_BODY_BYTES)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw httpError(400, '请求体需要是 JSON 对象，例如 {"name":"新名字","HEIGHT":30}')
    }

    const result = await engine.updateFeatureProperties(featureId, body)
    console.log(`[cyber-house] 属性已保存：${featureId}（${result.source}）`)
    sendJson(res, 200, { ok: true, data: { id: String(featureId), source: result.source, feature: result.feature } })
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502
    if (status >= 500) console.warn(`[cyber-house] 保存属性失败：${error?.message || error}`)
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, error: error?.message || '保存属性失败' })
    }
  }
}

/* ---------------------------------------------------------------------------
 * 网页直传 SHP（POST /api/fish-home/upload-shp）
 *
 * 前端把 zip 用 FormData 的 file 字段发上来；这里用 multer 内存存储接住
 * （不落临时文件），交给 shp/upload-import 解析成世界坐标要素，
 * 再整体 upsert 进 features 表（source='uploaded_shp'）。
 * ------------------------------------------------------------------------- */

const uploadShpMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8, parts: 16 },
}).single('file')

/** 跑一次 multipart 解析，把 multer 的错误翻译成 HTTP 错误。 */
function readUploadedZip(req, res) {
  return new Promise((resolve, reject) => {
    uploadShpMiddleware(req, res, (error) => {
      if (!error) {
        resolve(req.file || null)
        return
      }
      if (error.code === 'LIMIT_FILE_SIZE') {
        reject(httpError(413, `zip 太大了（上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`))
        return
      }
      if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        reject(httpError(400, '一次只收一个 zip（form 字段名用 file）'))
        return
      }
      reject(httpError(400, '上传数据解析失败：' + ((error && error.message) || error)))
    })
  })
}

/**
 * multipart 里的文件名默认被当成 latin1 解，中文会变乱码。
 * 这里还原一次；如果本来就是合法 UTF-8（还原后出现替换符），保留原样。
 */
function decodeUploadFileName(name) {
  const raw = String(name || '')
  if (!raw) return ''
  try {
    const restored = Buffer.from(raw, 'latin1').toString('utf8')
    return restored.includes('\uFFFD') ? raw : restored
  } catch {
    return raw
  }
}

async function handleUploadShp(req, res, engine) {
  try {
    if (!engine || !engine.db || typeof engine.db.importShpFeatures !== 'function') {
      throw httpError(501, 'state-engine 没有提供 SHP 入库能力')
    }
    const file = await readUploadedZip(req, res)
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw httpError(400, '没收到文件：请用 multipart/form-data，字段名 file，内容是 .zip')
    }

    const { parseShpZip } = require('./shp/upload-import')
    const fileName = decodeUploadFileName(file.originalname)
    const parsed = await parseShpZip(file.buffer, { fileName })

    // 任务书 1：网页在某一层级下上传 SHP 时可以带 map_level 表单字段，
    // 让这批要素落到当前图层（比如 village），而不是默认的赛博小屋。
    // readUploadedZip 跑完 multipart 解析后，文本字段都落在 req.body 上。
    const requestedLevel = req.body && typeof req.body.map_level === 'string' ? req.body.map_level.trim() : ''
    if (requestedLevel) {
      if (!isValidMapLevel(requestedLevel)) {
        throw httpError(
          400,
          `map_level「${requestedLevel}」不合法：只能用小写字母、数字、下划线、连字符（1–40 字）`,
        )
      }
      const level = normalizeMapLevel(requestedLevel)
      for (const feature of parsed.features) {
        if (feature && typeof feature === 'object') feature.mapLevel = level
      }
    }

    const rows = engine.db.importShpFeatures(parsed.features)

    console.log(
      `[cyber-house] 成功解析 ${parsed.features.length} 个要素（${fileName} → uploaded_shp，` +
      `坐标 ${parsed.transform && parsed.transform.mode}，层级 ${requestedLevel ? normalizeMapLevel(requestedLevel) : 'cyber_house（默认）'}）`,
    )

    sendJson(res, 200, {
      ok: true,
      data: {
        ok: true,
        uploaded: rows.length,
        source: 'uploaded_shp',
        fileName,
        files: parsed.files,
        notes: parsed.notes,
        transform: parsed.transform,
        mapLevels: (engine.db && typeof engine.db.listMapLevels === 'function' ? engine.db.listMapLevels() : []),
        ids: rows.map((row) => row.id).slice(0, 500),
      },
    })
  } catch (error) {
    const status = Number.isInteger(error && error.statusCode) ? error.statusCode : 400
    if (status >= 500) console.warn(`[cyber-house] SHP 上传失败：${(error && error.message) || error}`)
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, error: (error && error.message) || 'SHP 上传失败' })
    }
  }
}

/** DELETE /api/fish-home/upload-shp —— 清空网页直传的 SHP（换一份数据前先清场）。 */
async function handleClearUploadShp(req, res, engine) {
  try {
    if (!engine || !engine.db || typeof engine.db.clearUploadedFeatures !== 'function') {
      throw httpError(501, 'state-engine 没有提供 SHP 清理能力')
    }
    const removed = engine.db.clearUploadedFeatures()
    console.log(`[cyber-house] 已清空上传 SHP：${removed} 个要素`)
    sendJson(res, 200, { ok: true, data: { ok: true, removed } })
  } catch (error) {
    const status = Number.isInteger(error && error.statusCode) ? error.statusCode : 500
    if (!res.headersSent) sendJson(res, status, { ok: false, error: (error && error.message) || '清空失败' })
  }
}

/**
 * POST /api/fish-home/import-qgis —— QGIS GeoJSON 直导入（任务书 1）
 *
 * 接收标准 GeoJSON（FeatureCollection 或单个 Feature）：
 *   - properties 里如果塞着长 JSON 串（props_json / properties_json / props），
 *     会先 JSON.parse 展开再取字段；
 *   - 强制提取每个要素的 properties.map_level，没有就按请求体的默认 / 赛博小屋；
 *   - wall / furniture / room 类型保留原语义（参与 A* 障碍栅格），
 *     其它任意 GIS 字段类型一律按 shp_feature 只展示，不挡路；
 *   - Multi* / GeometryCollection 拆成单部分几何；同 id 重新导入按覆盖走。
 *
 * 请求体顶层也可以带一个 map_level，作为整批要素的缺省层级：
 *
 *   { "map_level": "village", "type": "FeatureCollection", "features": [...] }
 *
 * 成功响应：
 *
 *   { "ok": true, "data": { "ok": true, "imported": 12, "mapLevels": [...],
 *       "ids": [...], "errors": [], "totalInputs": 10, "levelCounts": {...} } }
 */
async function handleImportQgis(req, res, engine) {
  try {
    if (!engine || typeof engine.importGeoJsonFeatures !== 'function') {
      throw httpError(501, 'state-engine 未提供 QGIS 导入能力')
    }

    const body = await readJsonBody(req, MAX_IMPORT_BODY_BYTES)
    if (!body || typeof body !== 'object') {
      throw httpError(400, '请求体需要是标准 GeoJSON FeatureCollection（或单个 Feature）')
    }

    // 请求级默认层级：body.map_level（整图属于同一层级时很常见）。
    const requestedLevel = typeof body.map_level === 'string' ? body.map_level.trim() : ''
    if (requestedLevel && !isValidMapLevel(requestedLevel)) {
      throw httpError(
        400,
        `map_level「${requestedLevel}」不合法：只能用小写字母、数字、下划线、连字符（1–40 字），例如 village / forest`,
      )
    }

    // normalizeImportFeatures 逐条规范化 + 收集单条错误，整批不会因为一条全废。
    const normalized = normalizeImportFeatures(body, { mapLevel: requestedLevel })
    const rows = engine.importGeoJsonFeatures(normalized.features)

    // 按层级统计这一批导入的分布，方便确认没有漏网到 cyber_house。
    const levelCounts = {}
    for (const row of rows) {
      const level = String((row && row.mapLevel) || '')
      levelCounts[level] = (levelCounts[level] || 0) + 1
    }
    const summary = Object.entries(levelCounts)
      .map(([level, count]) => `${level}:${count}`)
      .join(' ')

    console.log(
      `[cyber-house] QGIS 导入：${rows.length} 个要素（共 ${normalized.totalInputs} 个输入，${summary}）` +
      (normalized.errors.length ? `，跳过 ${normalized.errors.length} 条` : ''),
    )

    sendJson(res, 200, {
      ok: true,
      data: {
        ok: true,
        imported: rows.length,
        totalInputs: normalized.totalInputs,
        ids: rows.map((row) => row.id).slice(0, 500),
        errors: normalized.errors,
        levelCounts,
        mapLevels: engine.db && typeof engine.db.listMapLevels === 'function' ? engine.db.listMapLevels() : [],
      },
    })
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400
    if (status >= 500) console.warn(`[cyber-house] QGIS 导入失败：${(error && error.message) || error}`)
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, error: (error && error.message) || 'QGIS 导入失败' })
    }
  }
}

/**
 * 创建 API 路由函数。返回 true 表示这个请求已经被处理。
 *
 * @param {ReturnType<typeof createStateEngine>} [engine]
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => boolean}
 */
// @doc house.api.state
function createApiRouter(engine = createStateEngine()) {
  return function apiRouter(req, res) {
    let pathname
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      return false
    }

    const normalizedPath = pathname.replace(/\/+$/, '') || '/'
    const isFeaturesIdDelete =
      req.method === 'DELETE' && normalizedPath.startsWith(FEATURES_ID_PREFIX) && normalizedPath.length > FEATURES_ID_PREFIX.length
    // PATCH /api/fish-home/features/:id/properties —— 动态属性表保存属性。
    const isFeaturesIdProperties =
      req.method === 'PATCH' &&
      normalizedPath.startsWith(FEATURES_ID_PREFIX) &&
      normalizedPath.endsWith('/properties') &&
      normalizedPath.length > FEATURES_ID_PREFIX.length + '/properties'.length
    if (
      normalizedPath !== API_PATH &&
      normalizedPath !== KNOCK_PATH &&
      normalizedPath !== GEOJSON_PATH &&
      normalizedPath !== DESTINATION_PATH &&
      normalizedPath !== FEATURES_PATH &&
      normalizedPath !== ANALYZE_BUFFER_PATH &&
      normalizedPath !== CAMPUS_GEOJSON_PATH &&
      normalizedPath !== ENVIRONMENT_PATH &&
      normalizedPath !== BATTERY_PATH &&
      normalizedPath !== UPLOAD_SHP_PATH &&
      normalizedPath !== IMPORT_QGIS_PATH &&
      !isFeaturesIdDelete &&
      !isFeaturesIdProperties
    ) {
      return false
    }

    applyCorsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Content-Length', '0')
      res.end()
      return true
    }

    if (normalizedPath === KNOCK_PATH) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS')
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
        return true
      }

      void handleKnock(req, res, engine)
      return true
    }

    if (normalizedPath === DESTINATION_PATH) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS')
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
        return true
      }

      void handleDestination(req, res, engine)
      return true
    }

    if (normalizedPath === CAMPUS_GEOJSON_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD, OPTIONS')
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
        return true
      }
      void handleCampusGeoJSON(req, res, engine)
      return true
    }

    if (normalizedPath === ENVIRONMENT_PATH) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS')
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
        return true
      }
      void handleEnvironment(req, res, engine)
      return true
    }

    if (normalizedPath === BATTERY_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, HEAD, POST, OPTIONS')
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
        return true
      }
      void handlePhoneBattery(req, res, engine)
      return true
    }

    // POST /api/fish-home/upload-shp —— 网页直传 SHP（zip）解析入库。
    // DELETE 同一个地址 = 清空本次上传的全部要素。
    if (normalizedPath === UPLOAD_SHP_PATH) {
      if (req.method === 'POST') {
        void handleUploadShp(req, res, engine)
        return true
      }
      if (req.method === 'DELETE') {
        void handleClearUploadShp(req, res, engine)
        return true
      }
      res.setHeader('Allow', 'POST, DELETE, OPTIONS')
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
      return true
    }

    // POST /api/fish-home/import-qgis —— QGIS 导出的 GeoJSON 直接入库（任务书 1）。
    if (normalizedPath === IMPORT_QGIS_PATH) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS')
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
        return true
      }
      void handleImportQgis(req, res, engine)
      return true
    }

    if (normalizedPath === FEATURES_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, HEAD, POST, DELETE, OPTIONS')
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
        return true
      }

      void handleFeatures(req, res, engine)
      return true
    }

    // DELETE /api/fish-home/features/:id —— 删除单个要素（自定义要素或家具）。
    if (isFeaturesIdDelete) {
      // decodeURIComponent：家具 id 是中文（如「客厅-沙发」），路径里走百分号编码。
      let featureId = ''
      try {
        featureId = decodeURIComponent(normalizedPath.slice(FEATURES_ID_PREFIX.length))
      } catch {
        featureId = normalizedPath.slice(FEATURES_ID_PREFIX.length)
      }
      void handleDeleteFeature(req, res, engine, featureId)
      return true
    }

    // PATCH /api/fish-home/features/:id/properties —— 动态属性表保存属性。
    if (isFeaturesIdProperties) {
      let featureId = ''
      try {
        featureId = decodeURIComponent(
          normalizedPath.slice(FEATURES_ID_PREFIX.length, normalizedPath.length - '/properties'.length),
        )
      } catch {
        featureId = normalizedPath.slice(FEATURES_ID_PREFIX.length, normalizedPath.length - '/properties'.length)
      }
      void handlePatchFeatureProperties(req, res, engine, featureId)
      return true
    }

    if (normalizedPath === ANALYZE_BUFFER_PATH) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS')
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
        return true
      }

      void handleAnalyzeBuffer(req, res, engine)
      return true
    }

    if (normalizedPath === GEOJSON_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD, OPTIONS')
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, req.method)
        return true
      }

      if (typeof engine.getHouseGeoJSON !== 'function') {
        sendJson(res, 501, {
          ok: false,
          error: 'GeoJSON 导出不可用：state-engine 未提供 getHouseGeoJSON',
        }, req.method)
        return true
      }

      try {
        sendJson(res, 200, engine.getHouseGeoJSON(), req.method)
      } catch (error) {
        sendJson(
          res,
          500,
          {
            ok: false,
            error: 'Internal Server Error',
            detail: error instanceof Error ? error.message : String(error),
          },
          req.method,
        )
      }
      return true
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD, OPTIONS')
      sendJson(
        res,
        405,
        { ok: false, error: 'Method Not Allowed' },
        req.method === 'HEAD' ? 'HEAD' : 'GET',
      )
      return true
    }

    try {
      // 任务书 1「前端多图渲染」：轮询带上 ?map_level=village 时，
      // 先把引擎切到这一层——getState() 返回的就只有 village 的要素，
      // A* 障碍栅格也只由 village 的墙 / 家具构成。参数缺省 = 当前层不变。
      let requestUrl = null
      try {
        requestUrl = new URL(req.url || '/', 'http://localhost')
      } catch {
        requestUrl = null
      }
      const mapLevelParam = requestUrl ? (requestUrl.searchParams.get('map_level') || '').trim() : ''
      if (mapLevelParam && engine && typeof engine.setMapLevel === 'function') {
        engine.setMapLevel(mapLevelParam)
      }

      const data = engine.getState()
      sendJson(res, 200, { ok: true, data }, req.method)
    } catch (error) {
      sendJson(
        res,
        500,
        {
          ok: false,
          error: 'Internal Server Error',
          detail: error instanceof Error ? error.message : String(error),
        },
        req.method,
      )
    }

    return true
  }
}

function readHomeHtml() {
  return fs.readFileSync(HOME_FILE, 'utf8')
}

function readHomeLeafletHtml() {
  return fs.readFileSync(HOME_LEAFLET_FILE, 'utf8')
}

/**
 * 创建一个完整的本地 http server：API + home.html + 健康检查。
 *
 * @param {{ engine?: ReturnType<typeof createStateEngine> }} [options]
 */
function createServer(options = {}) {
  const engine = options.engine || createStateEngine()
  // 服务重启后接着用上次落盘的电量：手机页面刷新时重复的 plug_in 不会再注入。
  hydratePhoneBattery(engine)
  const apiRouter = createApiRouter(engine)

  const server = http.createServer((req, res) => {
    if (apiRouter(req, res)) return

    let pathname
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      sendPlainText(res, 400, 'Bad Request', req.method)
      return
    }

    const normalizedPath = pathname.replace(/\/+$/, '') || '/'

    if (normalizedPath === '/health' || normalizedPath === '/api/fish-home/health') {
      // storage 是自检信息：SQLite 驱动、SpatiaLite 是否启用、各类要素计数。
      // hardware 是物理感知自检：手机电量内存态 + 网络探测最近一次样本。
      sendJson(res, 200, {
        ok: true,
        service: 'cyber-house',
        storage: engine && engine.db ? engine.db.info() : null,
        hardware: {
          phoneBattery: phoneBatterySnapshot(),
          network: server.hardwareSensor ? server.hardwareSensor.status() : null,
        },
      }, req.method)
      return
    }

    if (normalizedPath === '/' || normalizedPath === '/home.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD')
        sendPlainText(res, 405, 'Method Not Allowed', req.method)
        return
      }

      try {
        sendHtml(res, 200, readHomeHtml(), req.method)
      } catch {
        sendPlainText(res, 500, 'home.html not found', req.method)
      }
      return
    }

    if (normalizedPath === '/home_leaflet.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD')
        sendPlainText(res, 405, 'Method Not Allowed', req.method)
        return
      }

      try {
        sendHtml(res, 200, readHomeLeafletHtml(), req.method)
      } catch {
        sendPlainText(res, 500, 'home_leaflet.html not found', req.method)
      }
      return
    }

    if (normalizedPath === '/favicon.ico') {
      res.statusCode = 204
      res.end()
      return
    }

    if (pathname.startsWith('/assets/')) {
      sendAsset(req, res, pathname)
      return
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' }, req.method)
  })

  server.engine = engine
  return server
}

function normalizePort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT
}

/**
 * 本机所有可对外的 IPv4 地址（family === 'IPv4' && !internal）。
 *
 * 任务书模块 1 的自动发现就靠它：不用再手动 ipconfig 翻 IP。
 * 私有网段（192.168 / 10. / 172.16-31）排前面，169.254 链路本地排最后，
 * 这样第一行通常就是手机能连的那个地址。
 *
 * @returns {Array<{name:string, address:string}>}
 */
function listLanIpv4Addresses() {
  const seen = new Set()
  const list = []
  let interfaces = {}
  try {
    interfaces = os.networkInterfaces()
  } catch {
    return list
  }

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) continue
      const address = String(entry.address || '').trim()
      if (!address || seen.has(address)) continue
      seen.add(address)
      list.push({ name, address })
    }
  }

  const rank = (ip) => {
    if (ip.startsWith('192.168.')) return 0
    if (ip.startsWith('10.')) return 1
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
    if (ip.startsWith('169.254.')) return 4
    return 3
  }
  list.sort((a, b) => rank(a.address) - rank(b.address) || a.address.localeCompare(b.address))
  return list
}

/**
 * 启动服务。默认监听 0.0.0.0：任务书要求手机能在局域网里打开赛博小屋
 * （Type-C 电量感知需要手机页面在场）。只想本机用时设 FISH_HOME_HOST=127.0.0.1。
 */
function startServer(options = {}) {
  const port = normalizePort(options.port ?? process.env.FISH_HOME_PORT ?? DEFAULT_PORT)
  const host = options.host ?? process.env.FISH_HOME_HOST ?? '0.0.0.0'
  const server = createServer(options)

  // 网络感知：每 5 秒 ping 网关。可以 hardwareSensor:false 关掉，
  // 或传 { intervalMs, highLatencyMs, jitterMs, cooldownMs, host } 覆盖参数。
  const sensor = options.hardwareSensor === false
    ? null
    : createHardwareSensor({
        engine: server.engine,
        ...(options.hardwareSensor && typeof options.hardwareSensor === 'object' ? options.hardwareSensor : {}),
      })
  server.hardwareSensor = sensor
  server.on('close', () => {
    if (sensor) sensor.stop()
  })

  server.listen(port, host, () => {
    const address = server.address()
    const actualPort = address && typeof address === 'object' ? address.port : port
    const listeningAll = host === '0.0.0.0' || host === '::'
    const displayHost = listeningAll ? '127.0.0.1' : host
    console.log(`[cyber-house] API   http://${displayHost}:${actualPort}/api/fish-home/state`)
    console.log(`[cyber-house] GIS   http://${displayHost}:${actualPort}/api/fish-home/geojson`)
    console.log(`[cyber-house] 看板  http://${displayHost}:${actualPort}/home.html`)
    console.log(`[cyber-house] GIS   http://${displayHost}:${actualPort}/home_leaflet.html`)

    // 任务书模块 1：启动时直接打印手机能访问的局域网 IP，不用再翻 ipconfig。
    if (listeningAll) {
      const lan = listLanIpv4Addresses()
      if (lan.length > 0) {
        for (const item of lan) {
          console.log(`[cyber-house] 局域网访问: http://${item.address}:${actualPort}`)
        }
        console.log(`[cyber-house] 手机看板  http://${lan[0].address}:${actualPort}/home_leaflet.html`)
      } else {
        console.log('[cyber-house] 局域网访问: 没找到可用的 IPv4 地址（检查一下 WiFi / 网线）')
      }
    } else if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      console.log(`[cyber-house] 局域网访问: http://${host}:${actualPort}`)
    } else {
      console.log('[cyber-house] 提示：当前只监听本机，手机访问不了；设 FISH_HOME_HOST=0.0.0.0 可开放局域网')
    }

    console.log(`[cyber-house] 停止  Ctrl+C`)

    if (sensor) sensor.start()
  })

  return server
}

if (require.main === module) {
  const server = startServer()

  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`[cyber-house] 端口被占用，请设置 FISH_HOME_PORT 换一个端口。`)
    } else {
      console.error('[cyber-house] 启动失败：', error)
    }
    process.exitCode = 1
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

module.exports = {
  API_PATH,
  KNOCK_PATH,
  GEOJSON_PATH,
  FEATURES_PATH,
  CAMPUS_GEOJSON_PATH,
  ENVIRONMENT_PATH,
  BATTERY_PATH,
  DEFAULT_PORT,
  MAX_KNOCK_CHARS,
  createBrowserCookie,
  resolveDshBaseUrl,
  probeDshBase,
  readDshConfigPorts,
  discoverDshBase,
  listDshListeningPorts,
  listLanIpv4Addresses,
  dshRpc,
  deliverKnock,
  createApiRouter,
  createServer,
  startServer,
  // 物理感知：手机电量（测试 / 诊断用）
  phoneBatterySnapshot,
  resetPhoneBattery,
  hydratePhoneBattery,
}
