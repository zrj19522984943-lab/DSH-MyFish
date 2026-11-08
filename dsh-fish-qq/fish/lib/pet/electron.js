/**
 * electron.js —— 桌宠窗口的运行时：找 Electron、必要时准备一份、把窗口拉起来。
 *
 * 为什么不在 Host 里直接开 BrowserWindow：dsh-fish 是 DSH 插件，跑在 Host
 * 进程里，拿不到 Electron 主进程权限。这里用**独立 Electron 进程**，
 * 和 dsh-Ycp / dsh-pet 的做法一致。
 *
 * Electron 从哪来（按顺序）：
 *   1. 环境变量 DSH_FISH_ELECTRON / DSH_FISH_ELECTRON_PATH / ELECTRON_PATH
 *   2. <状态库>/electron/electron.exe（本插件准备的那份）
 *   3. $DSH_HOME/electron/electron.exe（dsh-pet 装过就直接复用）
 *   4. 都没有 → 从镜像下载一次（默认 npmmirror，144MB 左右），解压到 2
 *
 * 下载只发生在第一次启动、而且是在后台进行；插件启动本身不等它。
 * 全程只用 Node 内置模块，不新增 npm 依赖。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { writeAtomic } from '../store.js'
import { ensurePetDir, petPaths, readJsonFile } from './paths.js'
import { extractZipFile } from './zip.js'

export const DEFAULT_ELECTRON_VERSION = '43.3.0'
export const DEFAULT_MIRROR = 'https://npmmirror.com/mirrors/electron/'
export const GITHUB_MIRROR = 'https://github.com/electron/electron/releases/download/'
export const PET_APP_DIR = fileURLToPath(new URL('../../pet/', import.meta.url))

const READY_TIMEOUT_MS = 20_000
const PROGRESS_STEP = 25 * 1024 * 1024

/** Electron 解压后可执行文件在目录里的相对位置。 */
export function electronRelativePath(platform = process.platform) {
  if (platform === 'win32') return 'electron.exe'
  if (platform === 'darwin') return join('Electron.app', 'Contents', 'MacOS', 'Electron')
  return 'electron'
}

export function electronZipName(version, platform = process.platform, arch = process.arch) {
  return `electron-v${version}-${platform}-${arch}.zip`
}

/**
 * 这个环境该不该开桌宠窗口。
 *
 * 真机踩过的坑（2026-10-26）：DSH 桌面版的 Host 进程**没有**导出
 * `DSH_PROFILE=desktop`。原来的判断只看这个变量，于是日志写「桌宠窗口未启用」，
 * 窗口永远不出现。现在按强弱依次认：
 *   1. 显式 DSH_FISH_PET=0 / 1
 *   2. DSH_PROFILE=desktop，或 DSH_PROFILE_DIR 最后一段是 desktop
 *   3. Host 跑在 Electron 的 Node 模式里（process.versions.electron 有值）
 *   4. Windows / macOS 默认就是桌面；Linux 还要求有 DISPLAY/WAYLAND_DISPLAY
 *
 * web / headless / server profile 显式不启动；确实想开就设 DSH_FISH_PET=1。
 */
export function shouldStartPet({ env = process.env, platform = process.platform, versions = process.versions } = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) return false
  const flag = String(env.DSH_FISH_PET ?? '').trim().toLowerCase()
  if (['0', 'off', 'false', 'no'].includes(flag)) return false
  if (['1', 'on', 'true', 'yes'].includes(flag)) return true

  const profile = String(env.DSH_PROFILE ?? '').trim().toLowerCase()
  if (['web', 'headless', 'server'].includes(profile)) return false
  if (profile === 'desktop') return true
  const profileDir = String(env.DSH_PROFILE_DIR ?? '').replace(/[\\/]+$/, '').toLowerCase()
  if (profileDir.endsWith('desktop')) return true
  if (String(versions?.electron ?? '').trim()) return true

  // Host 环境可能被收得很干净（真机就是），Windows/macOS 上默认按桌面处理。
  if (platform === 'win32' || platform === 'darwin') return true
  return Boolean(String(env.DISPLAY ?? '').trim() || String(env.WAYLAND_DISPLAY ?? '').trim())
}

/**
 * Node 测试进程里绝不能真的去下载 Electron / 弹窗。
 * `node --test` 在隔离模式下会设 NODE_TEST_CONTEXT；不隔离时靠 argv 里的
 * *.test.mjs 认出来。生产环境的 argv 是 DSH 的启动参数，不会命中。
 */
export function isTestProcess({ env = process.env, argv = process.argv } = {}) {
  if (String(env.NODE_TEST_CONTEXT ?? '').trim()) return true
  if (String(env.DSH_FISH_PET_TEST ?? '').trim() === '1') return true
  return (argv ?? []).some((a) => /\.test\.(mjs|cjs|js)$/i.test(String(a)))
}

function candidatePaths({ root, env, platform }) {
  const rel = electronRelativePath(platform)
  const out = []
  const push = (value, source) => {
    const p = String(value ?? '').trim()
    if (p) out.push({ path: p, source })
  }
  push(env.DSH_FISH_ELECTRON, 'env')
  push(env.DSH_FISH_ELECTRON_PATH, 'env')
  push(env.ELECTRON_PATH, 'env')
  if (root) push(join(root, 'electron', rel), 'dsh-fish')
  const dshHome = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  push(join(dshHome, 'electron', rel), 'dsh-pet')
  if (String(env.LOCALAPPDATA ?? '').trim()) push(join(env.LOCALAPPDATA, 'dsh-fish', 'electron', rel), 'localappdata')
  return out
}

/**
 * 找一份可用的 Electron。只查文件，不下载、不启动。
 * @returns {{ok:boolean, path?:string, source?:string, error?:string, tried?:string[]}}
 */
export function detectElectron({ root, env = process.env, platform = process.platform } = {}) {
  const tried = []
  for (const c of candidatePaths({ root, env, platform })) {
    const p = c.path
    tried.push(p)
    try {
      if (!existsSync(p)) continue
      const st = statSync(p)
      if (st.isFile()) return { ok: true, path: p, source: c.source }
      if (st.isDirectory()) {
        const inner = join(p, electronRelativePath(platform))
        if (existsSync(inner) && statSync(inner).isFile()) return { ok: true, path: inner, source: c.source }
      }
    } catch { /* 单条路径坏了就继续找 */ }
  }
  return {
    ok: false,
    error: '没找到 Electron（会尝试自动准备一份；也可以用 DSH_FISH_ELECTRON 指定）',
    tried,
  }
}

export function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function fetchText(url, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(url, { signal, redirect: 'follow', headers: { 'user-agent': 'dsh-fish-pet' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

async function downloadTo(url, file, { fetchImpl = fetch, signal, log } = {}) {
  if (signal?.aborted) throw abortError()
  const res = await fetchImpl(url, { signal, redirect: 'follow', headers: { 'user-agent': 'dsh-fish-pet' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body) throw new Error('响应没有可读的 body')

  const total = Number(res.headers.get('content-length') ?? 0) || 0
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.part`
  let done = 0
  let nextLog = PROGRESS_STEP

  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      done += chunk.length
      if (done >= nextLog) {
        const mb = Math.round(done / 1048576)
        log?.(`[dsh-fish] 正在下载 Electron：${mb}MB${total ? ` / ${Math.round(total / 1048576)}MB` : ''}`)
        nextLog += PROGRESS_STEP
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmp, { mode: 0o600 }))
    await fs.rename(tmp, file)
    return { bytes: done, total }
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

function abortError() {
  const err = new Error('桌宠窗口启动已取消')
  err.name = 'AbortError'
  return err
}

function mirrorFor(base) {
  const b = String(base ?? '').trim()
  if (!b) return null
  const kind = /github\.com/i.test(b) ? 'github' : 'mirror'
  return { base: b.replace(/\/+$/, ''), kind }
}

function mirrorList(env) {
  const custom = String(env.DSH_FISH_ELECTRON_MIRROR ?? '').trim()
  if (custom) return [mirrorFor(custom)].filter(Boolean)
  return [mirrorFor(DEFAULT_MIRROR), mirrorFor(GITHUB_MIRROR)].filter(Boolean)
}

function versionPart(mirror, version) {
  return mirror.kind === 'github' ? `v${version}` : version
}

async function writeStatusFile(root, value) {
  const p = petPaths(root)
  try {
    await ensurePetDir(root)
    await writeAtomic(p.electronStatus, JSON.stringify({ ...value, at: new Date().toISOString() }, null, 2), 0o600)
  } catch { /* 状态写不进去不影响下载 */ }
}

/**
 * 准备 Electron：已存在就返回；否则下载 + 校验 + 解压到 <root>/electron。
 * 首次约 144MB（ZIP），解压后约 330MB。
 *
 * @returns {Promise<{ok:boolean, path?:string, source?:string, version?:string, error?:string}>}
 */
export async function ensureElectron({ root, env = process.env, log = () => {}, fetchImpl = fetch, signal } = {}) {
  const found = detectElectron({ root, env })
  if (found.ok) return found
  if (signal?.aborted) throw abortError()

  const version = String(env.DSH_FISH_ELECTRON_VERSION ?? '').trim() || DEFAULT_ELECTRON_VERSION
  const platform = process.platform
  const arch = process.arch
  const zipName = electronZipName(version, platform, arch)
  const rel = electronRelativePath(platform)
  const pet = petPaths(root)
  const electronDir = join(root, 'electron')
  const exePath = join(electronDir, rel)
  const zipPath = join(pet.dir, `electron-v${version}-${platform}-${arch}.zip`)

  await ensurePetDir(root)
  await writeStatusFile(root, { ok: false, state: 'preparing', version, platform, arch })

  if (!existsSync(PET_APP_DIR)) {
    return { ok: false, error: `桌宠窗口目录不见了：${PET_APP_DIR}` }
  }

  const errors = []
  for (const mirror of mirrorList(env)) {
    if (signal?.aborted) throw abortError()
    const base = `${mirror.base}/${versionPart(mirror, version)}`
    const zipUrl = `${base}/${zipName}`
    try {
      log(`[dsh-fish] 准备 Electron ${version}（${platform}-${arch}）← ${mirror.kind}`)
      const sums = await fetchText(`${base}/SHASUMS256.txt`, { fetchImpl, signal })
      const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(` ${zipName}`) || l.trim().endsWith(`*${zipName}`))
      if (!line) throw new Error('SHASUMS256.txt 里没有这个包')
      const expected = line.trim().split(/\s+/)[0].toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('SHASUMS256.txt 格式不对')

      let reused = false
      if (existsSync(zipPath)) {
        const got = await sha256File(zipPath)
        if (got === expected) reused = true
        else await fs.rm(zipPath, { force: true })
      }
      if (!reused) {
        await downloadTo(zipUrl, zipPath, { fetchImpl, signal, log })
        const got = await sha256File(zipPath)
        if (got !== expected) {
          await fs.rm(zipPath, { force: true })
          throw new Error('下载包 SHA256 校验不通过')
        }
      } else {
        log('[dsh-fish] 复用上次下载好的 Electron 包')
      }

      const tmpDir = join(root, `electron.new-${process.pid}-${Date.now()}`)
      await fs.rm(tmpDir, { recursive: true, force: true })
      log('[dsh-fish] 解压 Electron…')
      await extractZipFile(zipPath, tmpDir, { log })
      const tmpExe = join(tmpDir, rel)
      if (!existsSync(tmpExe)) throw new Error(`解压后找不到 ${rel}`)
      if (platform !== 'win32') await fs.chmod(tmpExe, 0o755).catch(() => {})

      await fs.rm(electronDir, { recursive: true, force: true }).catch(() => {})
      await fs.rename(tmpDir, electronDir)
      await fs.rm(zipPath, { force: true }).catch(() => {})
      if (!existsSync(exePath)) throw new Error(`Electron 目录里没有 ${rel}`)

      await writeStatusFile(root, { ok: true, state: 'ready', version, platform, arch, source: mirror.kind, path: exePath })
      log(`[dsh-fish] Electron 就绪：${exePath}`)
      return { ok: true, path: exePath, source: mirror.kind, version }
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      const message = String(err?.message ?? err).slice(0, 200)
      errors.push(`${mirror.kind}: ${message}`)
      log(`[dsh-fish] Electron 准备失败（${mirror.kind}）：${message}`)
    }
  }

  const error = errors.join(' | ').slice(0, 500) || '没有可用的 Electron 下载源'
  await writeStatusFile(root, { ok: false, state: 'failed', version, platform, arch, error })
  return { ok: false, error }
}

function isAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err?.code !== 'ESRCH'
  }
}

function killPid(pid) {
  try { process.kill(Number(pid)) } catch { /* 已经退了 */ }
}

async function waitDead(pid, ms = 2500) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 120))
  }
  return !isAlive(pid)
}

async function writeWindowStatus(root, value) {
  const p = petPaths(root)
  try {
    await ensurePetDir(root)
    await writeAtomic(p.status, JSON.stringify({ ...value, at: new Date().toISOString() }, null, 2), 0o600)
  } catch { /* ignore */ }
}

/**
 * 拉起桌宠窗口进程。返回一个带 dispose/status 的句柄；禁用或准备失败时
 * 返回 running:false，不抛。
 *
 * @param {{root:string, log?:Function, env?:object, signal?:AbortSignal}} options
 */
export async function startPetWindow({ root, log = () => {}, env = process.env, signal } = {}) {
  const enabled = shouldStartPet({ env })
  if (!enabled) return { enabled: false, running: false, dispose() {}, status: () => ({ enabled: false, running: false }) }

  const pet = petPaths(root)
  await ensurePetDir(root)

  let electron = detectElectron({ root, env })
  if (!electron.ok) {
    try {
      electron = await ensureElectron({ root, env, log, signal })
    } catch (err) {
      if (err?.name === 'AbortError') return { enabled: true, running: false, dispose() {}, status: () => ({ enabled: true, running: false }) }
      electron = { ok: false, error: String(err?.message ?? err) }
    }
  }
  if (!electron.ok) {
    log(`[dsh-fish] 桌宠窗口没起来：${electron.error}`)
    await writeWindowStatus(root, { enabled: true, running: false, error: electron.error })
    return { enabled: true, running: false, error: electron.error, dispose() {}, status: () => ({ enabled: true, running: false, error: electron.error }) }
  }
  if (signal?.aborted) return { enabled: true, running: false, dispose() {}, status: () => ({ enabled: true, running: false }) }

  // 同一只窗口已经在了：上一次插件启动留下的、或者另一个 Host 留下的。
  // 每次都先关掉再重开：窗口是独立 Electron 进程，插件热重载不会换掉它已经
  // 加载的 HTML/JS；复用会让新界面（比如返回框）看起来像没生效。
  const prior = await readJsonFile(pet.window, null)
  if (prior?.ready && isAlive(prior.pid)) {
    log(`[dsh-fish] 发现已有的桌宠窗口（pid ${prior.pid}），先关掉再按当前代码重开`)
    killPid(prior.pid)
    await waitDead(prior.pid)
  }

  const childEnv = { ...env }
  // 终端/宿主里若带着 ELECTRON_RUN_AS_NODE，Electron 会以纯 Node 模式启动，
  // main.cjs 里的 require('electron') 直接拿不到 app。必须删键，不能设空串。
  delete childEnv.ELECTRON_RUN_AS_NODE
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE
  // 不要把 Electron/输入法的调试日志写到插件安装目录里；窗口自己的启动日志
  // 由 main.cjs 写到 pet-boot.log。
  delete childEnv.ELECTRON_ENABLE_LOGGING
  delete childEnv.ELECTRON_ENABLE_STACK_DUMPING
  childEnv.DSH_FISH_PET = '1'

  let child = null
  try {
    // Windows / 受限会话里 Chromium 的沙箱 brokerage 可能直接 CHECK 崩溃
    // （platform_channel.cc: 拒绝访问）。这个窗口只加载本地 HTML，没有远程内容，
    // 渲染进程仍然 contextIsolation + nodeIntegration:false；Windows 上默认关掉
    // Chromium 的 OS 沙箱换取“能启动”。其他平台默认保留；可用
    // DSH_FISH_PET_SANDBOX=1 强制保留、=0 强制关闭。
    const sandboxFlag = String(env.DSH_FISH_PET_SANDBOX ?? '').trim()
    const noSandbox = sandboxFlag === '0' || (sandboxFlag !== '1' && process.platform === 'win32')
    const launchArgs = []
    if (noSandbox) launchArgs.push('--no-sandbox')
    launchArgs.push(PET_APP_DIR, '--state-dir', pet.dir, '--host-pid', String(process.pid))
    child = spawn(electron.path, launchArgs, {
      cwd: pet.dir,
      env: childEnv,
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (err) {
    const error = `spawn 失败：${String(err?.message ?? err)}`
    log(`[dsh-fish] ${error}`)
    await writeWindowStatus(root, { enabled: true, running: false, error })
    return { enabled: true, running: false, error, dispose() {}, status: () => ({ enabled: true, running: false, error }) }
  }

  let exited = false
  let exitInfo = null
  child.on('error', (err) => {
    log(`[dsh-fish] 桌宠进程错误：${String(err?.message ?? err)}`)
  })
  child.on('exit', (code, sig) => {
    exited = true
    exitInfo = { code, signal: sig }
    log(`[dsh-fish] 桌宠窗口退出（code=${String(code)}, signal=${String(sig)}）`)
    writeWindowStatus(root, { enabled: true, running: false, pid: child?.pid, exit: exitInfo }).catch(() => {})
  })

  await writeWindowStatus(root, { enabled: true, running: true, pid: child.pid, electron: electron.path, source: electron.source })

  // 等窗口自己报 ready；等不到也不算启动失败（窗口可能已经在屏幕上，只是写得慢）。
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited) break
    const state = await readJsonFile(pet.window, null)
    if (state?.ready && Number(state.pid) === Number(child.pid)) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (exited) log(`[dsh-fish] 桌宠窗口启动后马上退出了（看 ${pet.dir} 下的 pet-boot.log）`)

  let disposed = false
  return {
    enabled: true,
    running: !exited,
    pid: child.pid,
    electron: electron.path,
    source: electron.source,
    dispose() {
      if (disposed) return
      disposed = true
      try { child.kill() } catch { /* ignore */ }
    },
    status() {
      return {
        enabled: true,
        running: !disposed && !exited && isAlive(child.pid),
        pid: child.pid,
        electron: electron.path,
        source: electron.source,
        exit: exitInfo,
      }
    },
  }
}
