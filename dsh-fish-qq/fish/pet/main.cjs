/**
 * main.cjs —— dsh-fish 的独立桌宠输入窗口（Electron 进程）。
 *
 * 为什么是独立进程：dsh-fish 跑在 DSH 的 Host 进程里，Host 没有 Electron
 * 主进程权限。这里用 dsh-fish 自己准备（或复用 dsh-pet 已装）的 Electron
 * 起一个很小的窗口，窗口里只有输入框、发送键，以及她说的话的返回框。
 *
 * 它不直接连 DSH 的 HTTP：Host 的 /dsh-fish 路由有登录栅栏，独立进程拿不到
 * 面板 cookie。消息走 dsh-fish 自己状态库里的文件通道（和 dsh-Ycp 的桌宠
 * 思路一致）：窗口把话写进 request.json，Host 侧的 lib/pet/bridge.js 读走，
 * 交给 sayToHer()——和设置页里「跟她说一句话」走的是同一条链路。
 *
 * 参数：
 *   --state-dir <目录>   ~/.dsh-fish/pet
 *   --host-pid <pid>     父进程（DSH Host）pid；父进程没了就自己退出
 *
 * 窗口本身：透明、置顶、无边框、不可缩放；拖动空白处移动，回车/发送键递话；
 * 她说完这一轮后，上方返回框按内容长高显示她的话。
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// 透明窗口在 Windows 上关掉硬件加速更稳（dsh-Ycp 的桌宠同样处理）。
app.disableHardwareAcceleration()

const WIDTH = 440
const BASE_HEIGHT = 76
const REPLY_HEIGHT = 236
const MAX_HEIGHT = 360
const MAX_TEXT = 4000
const ACK_TIMEOUT_MS = 20_000
const TRANSCRIPT_LIMIT = 30

function argOf(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const STATE_DIR = path.resolve(argOf('--state-dir', path.join(__dirname, 'state')))
const HOST_PID = Number(argOf('--host-pid', '0')) || 0
const REQUEST_FILE = path.join(STATE_DIR, 'request.json')
const REPLIES_DIR = path.join(STATE_DIR, 'replies')
const MESSAGES_FILE = path.join(STATE_DIR, 'messages.json')
const WINDOW_FILE = path.join(STATE_DIR, 'window.json')
const BRIDGE_FILE = path.join(STATE_DIR, 'bridge.json')

let win = null
let shown = false
let saveTimer = null
let height = BASE_HEIGHT
let lastSeq = 0
let messageTimer = null

/** 启动期落一份很小的日志：窗口进程崩了的话，Console 可能什么都留不下。 */
function trace(message) {
  try {
    const file = path.join(STATE_DIR, 'pet-boot.log')
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`)
    if (fs.statSync(file).size > 64 * 1024) fs.writeFileSync(file, '', 'utf8')
  } catch { /* 记不下来不影响运行 */ }
}

trace('module start')

// 独立的 userData：不跟 DSH 主窗口/别的 Electron 应用抢单实例锁与缓存。
// setPath 之前目录必须存在（Windows 上不存在会直接 CHECK 崩溃）。
try { fs.mkdirSync(path.join(STATE_DIR, 'electron-data'), { recursive: true }) } catch { /* 由后续写入报错 */ }
try { app.setPath('userData', path.join(STATE_DIR, 'electron-data')) } catch { /* 由后续写入报错 */ }
trace('setPath done')
try { app.setAppUserModelId('dsh.fish.pet') } catch { /* 非 Windows 忽略 */ }
trace('appId done')

function ensureStateDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }) } catch { /* 由后续写入报错 */ }
  try { fs.mkdirSync(REPLIES_DIR, { recursive: true, mode: 0o700 }) } catch { /* 由后续写入报错 */ }
}

/** 一条请求一个回执文件：连续发几条时不会互相覆盖。 */
function replyFile(id) {
  return path.join(REPLIES_DIR, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}.json`)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 她说过的话；文件坏了就当没有，不影响输入。 */
function readMessages() {
  const value = readJson(MESSAGES_FILE)
  return Array.isArray(value) ? value.slice(-TRANSCRIPT_LIMIT) : []
}

function highestSeq(list) {
  return (list ?? []).reduce((max, item) => Math.max(max, Number(item?.seq) || 0), 0)
}

/** 原子写：写同目录临时文件再 rename，Host 不会读到半截 JSON。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

function readBridgeToken() {
  const b = readJson(BRIDGE_FILE)
  return String(b?.token ?? '')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function workAreaFor(x, y, h = height) {
  try {
    return screen.getDisplayMatching({ x, y, width: WIDTH, height: h }).workArea
  } catch {
    return screen.getPrimaryDisplay().workArea
  }
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

function defaultPosition(h = height) {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - WIDTH - 24,
    y: area.y + area.height - h - 24,
  }
}

/** 恢复上次的位置；换过屏幕或位置已经不在任何屏幕里就回右下角。 */
function restorePosition(h = height) {
  const saved = readJson(WINDOW_FILE)
  const b = saved?.bounds
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return defaultPosition(h)
  const area = workAreaFor(Math.round(b.x), Math.round(b.y), h)
  const savedHeight = Number.isFinite(b.height) ? Number(b.height) : BASE_HEIGHT
  // 以窗口底边为锚点：从「只有输入框」长到「有返回框」时，输入框留在原处。
  return {
    x: clamp(Math.round(b.x), area.x, area.x + area.width - WIDTH),
    y: clamp(Math.round(b.y + savedHeight - h), area.y, area.y + area.height - h),
  }
}

/** 改窗口高度，底边不动；调用方负责 saveWindowState。 */
function setHeight(next, { save = true } = {}) {
  const value = clamp(Math.round(Number(next) || BASE_HEIGHT), BASE_HEIGHT, MAX_HEIGHT)
  height = value
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  if (b.height === value) return
  const area = workAreaFor(b.x, b.y, value)
  const bottom = b.y + b.height
  const x = clamp(b.x, area.x, area.x + area.width - WIDTH)
  const y = clamp(bottom - value, area.y, area.y + area.height - value)
  win.setBounds({ x, y, width: WIDTH, height: value })
  if (save) saveWindowState()
}

function windowState(extra = {}) {
  let bounds = null
  try { bounds = win && !win.isDestroyed() ? win.getBounds() : null } catch { bounds = null }
  return {
    pid: process.pid,
    hostPid: HOST_PID,
    ready: Boolean(win && !win.isDestroyed()),
    bounds,
    at: Date.now(),
    ...extra,
  }
}

function saveWindowState(extra = {}) {
  try { writeJsonAtomic(WINDOW_FILE, windowState(extra)) } catch { /* 记不下来不影响说话 */ }
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveWindowState()
  }, 150)
}

/**
 * 窗口轮询 messages.json：她说完一轮后 Host 把话写进去。
 * 只把 seq 比上次大的新消息发给渲染进程；历史由 pet:history 单独取。
 */
function startMessagePoll() {
  if (messageTimer) return
  messageTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return
    const all = readMessages()
    if (!all.length) return
    const max = highestSeq(all)
    // messages.json 被清空/重建时 seq 会从头开始：认出来并把游标归零。
    if (max < lastSeq) lastSeq = 0
    const fresh = all.filter((m) => Number(m?.seq) > lastSeq)
    if (!fresh.length) return
    lastSeq = max
    if (height < REPLY_HEIGHT) setHeight(REPLY_HEIGHT)
    try { win.webContents.send('pet:her', fresh) } catch { /* 页面还没就绪，历史里还能拿到 */ }
  }, 500)
  if (typeof messageTimer.unref === 'function') messageTimer.unref()
}

async function waitForReply(id) {
  const file = replyFile(id)
  const deadline = Date.now() + ACK_TIMEOUT_MS
  while (Date.now() < deadline) {
    const reply = readJson(file)
    if (reply && String(reply.id) === String(id)) {
      try { fs.rmSync(file, { force: true }) } catch { /* 下一轮覆盖 */ }
      return reply
    }
    await delay(100)
  }
  return { ok: false, note: '她那边没应声' }
}

/**
 * 把一句话写进请求文件，等 Host 侧 bridge 回执。
 * 回执只说明「递进去了没有」；她这一轮说的话由 bridge 写进 messages.json，
 * 窗口轮询后显示在上面的返回框里。
 */
async function submitText(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, note: '你什么都没说。' }
  if (text.length > MAX_TEXT) return { ok: false, note: '太长了，分几次说。' }

  const token = readBridgeToken()
  if (!token) return { ok: false, note: '她那边还没准备好，等一会儿再试。' }

  const id = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`
  try {
    ensureStateDir()
    writeJsonAtomic(REQUEST_FILE, { id, text, token, at: Date.now() })
  } catch (err) {
    return { ok: false, note: `递不出去：${String(err?.message ?? err).slice(0, 80)}` }
  }
  return waitForReply(id)
}

function showWindow() {
  if (!win || win.isDestroyed()) return
  win.showInactive()
  saveWindowState({ ready: true })
}

function createWindow() {
  trace('createWindow enter')
  const history = readMessages()
  lastSeq = highestSeq(history)
  height = history.length ? REPLY_HEIGHT : BASE_HEIGHT
  const pos = restorePosition(height)
  trace(`restorePosition ${JSON.stringify(pos)} height=${height}`)
  win = new BrowserWindow({
    width: WIDTH,
    height: height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    show: false,
    title: '大肥鱼',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: process.env.DSH_FISH_PET_DEV === '1',
    },
  })

  win.setMenu(null)
  trace('menu null')
  win.setAlwaysOnTop(true, 'floating')
  trace('alwaysOnTop')
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch { /* 平台不支持 */ }
  trace('visibleOnAllWorkspaces')
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!String(url).startsWith('file://')) event.preventDefault()
  })
  trace('webContents hooks')
  win.webContents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame) console.error('[dsh-fish-pet] 页面加载失败', code, description, url)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[dsh-fish-pet] 渲染进程退出', details?.reason ?? '')
  })

  win.loadFile(path.join(__dirname, 'index.html'))
  trace('loadFile called')

  const reveal = () => {
    if (!win || win.isDestroyed() || shown) return
    shown = true
    win.setBounds({ x: pos.x, y: pos.y, width: WIDTH, height })
    showWindow()
    if (process.env.DSH_FISH_PET_CAPTURE) {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage()
          fs.writeFileSync(process.env.DSH_FISH_PET_CAPTURE, image.toPNG())
          console.log('[dsh-fish-pet] 已截图', process.env.DSH_FISH_PET_CAPTURE)
        } catch (err) {
          console.error('[dsh-fish-pet] 截图失败', String(err?.message ?? err))
        }
      }, 900)
    }
  }
  win.once('ready-to-show', reveal)
  win.webContents.once('did-finish-load', reveal)
  // ready-to-show 在个别透明窗口上不触发：给一个兜底，不让窗口永远藏着。
  setTimeout(reveal, 2000)

  win.on('move', scheduleSave)
  win.on('moved', scheduleSave)
  win.on('close', () => {
    // close 时窗口还没销毁，这时才拿得到最后的 bounds。
    saveWindowState({ ready: false })
  })
  win.on('closed', () => {
    win = null
    app.quit()
  })

  console.log('[dsh-fish-pet] ready', JSON.stringify({ width: WIDTH, height, state: STATE_DIR }))
  startMessagePoll()
}

/**
 * 父进程（DSH Host）没了就自己收尾，避免 DSH 退出后桌面上留一个没人管的窗口。
 * 用 signal 0 只探活，不发信号。
 */
function watchHost() {
  if (!HOST_PID || HOST_PID === process.pid) return
  const timer = setInterval(() => {
    try {
      process.kill(HOST_PID, 0)
    } catch (err) {
      if (err && err.code === 'ESRCH') {
        try { app.quit() } catch { /* 已经在退 */ }
      }
    }
  }, 2000)
  if (typeof timer.unref === 'function') timer.unref()
}

ipcMain.handle('pet:send', async (_event, text) => {
  try {
    return await submitText(text)
  } catch (err) {
    return { ok: false, note: `递不出去：${String(err?.message ?? err).slice(0, 80)}` }
  }
})

ipcMain.handle('pet:history', () => {
  const messages = readMessages()
  if (messages.length && height < REPLY_HEIGHT) setHeight(REPLY_HEIGHT)
  return { messages, height }
})

ipcMain.on('pet:resize', (_event, value) => {
  setHeight(Number(value))
})

ipcMain.on('pet:ready', () => { showWindow() })

if (!app.requestSingleInstanceLock()) {
  // 已经有一只窗口了（同一个 userData 目录）：不要再开第二只。
  trace('no single-instance lock, quit')
  app.quit()
} else {
  trace('got single-instance lock')
  app.on('second-instance', () => { showWindow() })
  app.on('window-all-closed', () => { app.quit() })
  app.whenReady().then(() => {
    trace('app ready')
    ensureStateDir()
    watchHost()
    createWindow()
    trace('createWindow returned')
  }).catch((err) => {
    trace(`whenReady failed: ${String(err?.stack ?? err)}`)
    console.error('[dsh-fish-pet] 启动失败', String(err?.stack ?? err))
    app.quit()
  })
}
