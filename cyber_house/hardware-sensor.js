'use strict'

/**
 * hardware-sensor.js —— 物理环境感知：局域网延迟 / 抖动
 *
 * 任务书模块 2：
 *   - 每 5 秒向路由器网关（拿不到网关时用 114.114.114.114）发一次 ping；
 *   - 延迟 > 500ms，或与上一次相比波动 > 300ms，判定为「局域网信号不稳定」；
 *   - 触发后调用 state-engine.injectPhysicalEvent()，由 DSH 的 fish:physical
 *     system prompt 段在下一轮交给小鱼自己决定要不要说话；
 *   - 连续波动不重复注入：冷却 5 分钟。
 *
 * 为什么还要自己写一套系统 ping 兜底：
 *   `ping` 模块内部是 child_process.spawn + 管道。某些受限环境（包括 DSH 的
 *   文件沙箱）会禁止管道，spawn 直接 EPERM。api-router.js 的 runCapture 早就
 *   为同一问题准备了「写临时文件再读」的退路，这里沿用同样的思路：优先用
 *   ping 模块，模块不可用 / 被沙箱拦住时退回系统 ping.exe。
 *
 * 这个模块只负责「探测 + 判定 + 注入」，不直接碰 QQ、不直接拼 prompt。
 * 事件落盘由 state-engine 负责，system prompt 由 fish 插件读取。
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** 任务书指定的注入正文。 */
const NETWORK_EVENT_TEXT = '[物理感知：局域网信号极其不稳定，可能有人走动机箱，或者网卡过载。]'

const DEFAULT_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 2500
/** 网络拥堵阈值（毫秒）。 */
const HIGH_LATENCY_MS = 500
/** 与上一次 ping 的波动阈值（毫秒）。 */
const JITTER_MS = 300
/** 同一类感知的最短注入间隔：5 分钟。 */
const COOLDOWN_MS = 5 * 60 * 1000
/** 拿不到默认网关时的公网探测目标（任务书指定）。 */
const PUBLIC_PROBE_HOST = '114.114.114.114'

let pingModule = null
try {
  // 依赖缺失时不影响小屋启动：probeLatency 会退回系统 ping。
  pingModule = require('ping')
} catch {
  pingModule = null
}

/**
 * 捕获命令输出。ping 失败（退出码非 0）时 stdout 仍然是有用的，
 * 所以这里把 error.stdout 也当成正常结果返回。
 *
 * 受限环境禁止管道（EPERM/EACCES）时退化为「写临时文件再读」。
 */
function capture(command, args, timeoutMs = 4000) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    })
  } catch (error) {
    // ping 不通时退出码非 0，但 stdout 里的 TTL / time 仍然有用。
    if (error && error.stdout) {
      return Buffer.isBuffer(error.stdout) ? error.stdout.toString('utf8') : String(error.stdout)
    }
    if (!error || (error.code !== 'EPERM' && error.code !== 'EACCES')) {
      if (error && typeof error.stdout === 'string') return error.stdout
      throw error
    }

    const tmp = path.join(
      os.tmpdir(),
      `cyber-house-ping-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    )
    const fd = fs.openSync(tmp, 'w')
    try {
      execFileSync(command, args, {
        stdio: ['ignore', fd, 'ignore'],
        timeout: timeoutMs,
        windowsHide: true,
      })
    } catch (inner) {
      // ping 不通时退出码非 0 是正常现象，输出已经写进临时文件。
      if (!inner || (inner.code !== 'EPERM' && inner.code !== 'EACCES')) {
        // 其它错误也尽量读一次临时文件；读不到再交给 catch 返回空串。
      }
    } finally {
      fs.closeSync(fd)
    }
    try {
      return fs.readFileSync(tmp, 'utf8')
    } catch {
      return ''
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
 * 找本机 IPv4 默认网关。
 *
 * Windows 用 `route print -4`，Linux 用 `ip route`，macOS 用 `route -n get default`。
 * 输出里的地址都是 ASCII，不受系统语言影响；拿不到就返回空串。
 */
function detectDefaultGateway(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const output = capture('route', ['print', '-4'], 4000)
      // 可能有多条默认路由（VPN / 虚拟网卡）：取 metric 最小的那条。
      const matches = [...output.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)/gm)]
      if (matches.length > 0) {
        matches.sort((a, b) => Number(a[3]) - Number(b[3]))
        return matches[0][1]
      }
      return ''
    }
    if (platform === 'darwin') {
      const output = capture('route', ['-n', 'get', 'default'], 4000)
      const match = output.match(/gateway:\s*(\d+\.\d+\.\d+\.\d+)/i)
      if (match) return match[1]
      return ''
    }
    const output = capture('ip', ['route', 'show', 'default'], 4000)
    const match = output.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/i)
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

/** 按平台拼系统 ping 参数（强制 IPv4，单包，带超时）。 */
function systemPingArgs(host, timeoutMs) {
  if (process.platform === 'win32') {
    return ['-4', '-n', '1', '-w', String(Math.max(100, Math.round(timeoutMs))), host]
  }
  if (process.platform === 'darwin') {
    // macOS 的 -W 是毫秒。
    return ['-4', '-c', '1', '-W', String(Math.max(100, Math.round(timeoutMs))), host]
  }
  // Linux 的 -W 是秒。
  return ['-4', '-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host]
}

/**
 * 从系统 ping 输出里解析 RTT（毫秒）。
 *
 * 不依赖界面语言：成功回包一定带 TTL（ASCII），时间数字后面一定带 ms。
 * 中文 Windows 的「时间=23ms」被按 UTF-8 解码成乱码也没关系，数字和 ms 还在。
 *
 * @param {string|Buffer} output
 * @returns {number|null}
 */
function parsePingOutput(output) {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output || '')
  if (!/ttl[=\s]*\d+/i.test(text)) return null
  const match = text.match(/(?:[=<]\s*)(\d+(?:\.\d+)?)\s*ms/i)
  if (!match) return null
  const value = Number.parseFloat(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * 用系统 ping 探测一次，返回 RTT（毫秒）；不通 / 解析不出时间时返回 null。
 */
function probeWithSystemPing(host, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let output
  try {
    output = capture('ping', systemPingArgs(host, timeoutMs), timeoutMs + 1500)
  } catch {
    return null
  }
  return parsePingOutput(output)
}

/**
 * 用 `ping` npm 模块探测一次。
 *
 * 返回：
 *   - 数字：RTT（毫秒）
 *   - null：模块正常工作，但目标没回包
 *   - undefined：模块不可用 / 出错，调用方应退回系统 ping
 */
async function probeWithPingModule(host, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!pingModule || !pingModule.promise || typeof pingModule.promise.probe !== 'function') {
    return undefined
  }
  try {
    const result = await pingModule.promise.probe(host, {
      timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
      min_reply: 1,
      numeric: true,
      v6: false,
    })
    if (!result || result.alive !== true) return null
    const value = Number.parseFloat(String(result.time))
    // 模块说通了但时间解析不出来：交给系统 ping 再解析一次。
    return Number.isFinite(value) ? value : undefined
  } catch {
    // 沙箱禁止管道 / ping 不存在时走到这里。
    return undefined
  }
}

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function nonNegative(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

/** 给 ping 模块加一层硬超时，避免它卡住整个 5 秒节拍。 */
function raceTimeout(promise, timeoutMs) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 探测一次局域网延迟（毫秒）。
 * @param {string} host
 * @param {number} [timeoutMs]
 * @returns {Promise<number|null>}
 */
async function probeLatency(host, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const viaModule = await raceTimeout(probeWithPingModule(host, timeoutMs), timeoutMs + 500)
  if (viaModule !== undefined) return viaModule
  return probeWithSystemPing(host, timeoutMs)
}

/**
 * 创建网络感知器。
 *
 * @param {{
 *   engine?: object,               // 需要 injectPhysicalEvent(text, meta)
 *   host?: string,                 // 探测目标；缺省网关 > FISH_HOME_PING_HOST > 114.114.114.114
 *   intervalMs?: number,           // 默认 5000
 *   timeoutMs?: number,            // 单次 ping 超时，默认 2500
 *   highLatencyMs?: number,        // 默认 500
 *   jitterMs?: number,             // 默认 300
 *   cooldownMs?: number,           // 默认 5 分钟
 *   probe?: (host:string, timeoutMs:number)=>Promise<number|null>, // 测试注入
 *   now?: ()=>number,              // 测试注入时钟
 *   log?: (...args:any[])=>void,
 *   warn?: (...args:any[])=>void,
 * }} [options]
 */
function createHardwareSensor(options = {}) {
  const engine = options.engine || null
  const now = typeof options.now === 'function' ? options.now : Date.now
  const probe = typeof options.probe === 'function' ? options.probe : probeLatency
  const intervalMs = positive(options.intervalMs, DEFAULT_INTERVAL_MS)
  const timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const highLatencyMs = positive(options.highLatencyMs, HIGH_LATENCY_MS)
  const jitterMs = positive(options.jitterMs, JITTER_MS)
  const cooldownMs = nonNegative(options.cooldownMs, COOLDOWN_MS)
  const log = typeof options.log === 'function' ? options.log : console.log
  const warn = typeof options.warn === 'function' ? options.warn : console.warn
  const host = String(
    options.host
      || process.env.FISH_HOME_PING_HOST
      || detectDefaultGateway()
      || PUBLIC_PROBE_HOST,
  ).trim() || PUBLIC_PROBE_HOST

  let timer = null
  let running = false
  let previousLatency = null
  let lastLatency = null
  let lastSampleAt = 0
  let lastInjectedAt = 0
  let samples = 0
  let failures = 0
  let lastError = ''

  function inject(text, meta) {
    if (!engine || typeof engine.injectPhysicalEvent !== 'function') {
      warn('[cyber-house] 网络事件没注入：engine 没有 injectPhysicalEvent')
      return false
    }
    try {
      engine.injectPhysicalEvent(text, meta)
      return true
    } catch (error) {
      lastError = String((error && error.message) || error)
      warn(`[cyber-house] 网络事件注入失败：${lastError}`)
      return false
    }
  }

  /**
   * 处理一个延迟样本。纯函数式判定，便于测试直接喂 500 / 900 / 120 之类的数。
   *
   * @param {number|null|undefined} latency 毫秒；null 表示这次没回包
   * @param {number} [at] 样本时间
   * @returns {{injected:boolean, reason:string, latency?:number|null, delta?:number|null, cooldownLeft?:number}}
   */
  function handleSample(latency, at = now()) {
    const atMs = Number.isFinite(Number(at)) ? Number(at) : now()
    samples += 1
    lastSampleAt = atMs

    const rtt = Number(latency)
    if (latency === null || latency === undefined || !Number.isFinite(rtt) || rtt < 0) {
      failures += 1
      if (failures === 1 || failures % 60 === 0) {
        warn(`[cyber-house] 网络探测没回包（${host}），连续 ${failures} 次`)
      }
      return { injected: false, reason: 'no-sample', latency: null }
    }

    failures = 0
    const previous = previousLatency
    const delta = previous === null ? null : Math.abs(rtt - previous)
    previousLatency = rtt
    lastLatency = rtt

    const highLatency = rtt > highLatencyMs
    const jitter = delta !== null && delta > jitterMs
    if (!highLatency && !jitter) {
      return { injected: false, reason: 'stable', latency: rtt, delta }
    }

    const cooldownLeft = cooldownMs - (atMs - lastInjectedAt)
    if (lastInjectedAt > 0 && cooldownLeft > 0) {
      return { injected: false, reason: 'cooldown', latency: rtt, delta, cooldownLeft }
    }

    const trigger = highLatency ? 'high-latency' : 'jitter'
    const injected = inject(NETWORK_EVENT_TEXT, {
      kind: 'network',
      trigger,
      latency: rtt,
      previousLatency: previous,
      delta,
      host,
      at: atMs,
    })
    if (injected) {
      lastInjectedAt = atMs
      log(
        `[cyber-house] 局域网感知触发（${trigger}）：`
        + `${previous === null ? '—' : Math.round(previous)}ms -> ${Math.round(rtt)}ms`
        + `（Δ${delta === null ? '—' : Math.round(delta)}ms），已注入，冷却 ${Math.round(cooldownMs / 60000)} 分钟`,
      )
    }
    return { injected, reason: trigger, latency: rtt, delta }
  }

  function schedule(delayMs) {
    if (!running) return
    timer = setTimeout(() => {
      void runOnce()
    }, delayMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  async function runOnce() {
    let latency = null
    try {
      latency = await probe(host, timeoutMs)
    } catch (error) {
      lastError = String((error && error.message) || error)
      latency = null
    }
    if (!running) return { injected: false, reason: 'stopped' }
    const result = handleSample(latency, now())
    schedule(intervalMs)
    return result
  }

  function start() {
    if (running) return api
    running = true
    log(
      `[cyber-house] 网络感知已启动：每 ${Math.round(intervalMs / 1000)}s ping ${host}`
      + `（>${highLatencyMs}ms 或波动 >${jitterMs}ms 触发，冷却 ${Math.round(cooldownMs / 60000)} 分钟）`,
    )
    schedule(0)
    return api
  }

  function stop() {
    running = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    return api
  }

  /** 单次探测（不启动定时器），测试 / 手动诊断用。 */
  async function tick() {
    let latency = null
    try {
      latency = await probe(host, timeoutMs)
    } catch (error) {
      lastError = String((error && error.message) || error)
      latency = null
    }
    return handleSample(latency, now())
  }

  function status() {
    return {
      running,
      host,
      intervalMs,
      timeoutMs,
      thresholds: { highLatencyMs, jitterMs },
      cooldownMs,
      samples,
      failures,
      lastLatency,
      lastSampleAt: lastSampleAt || null,
      lastInjectedAt: lastInjectedAt || null,
      lastError: lastError || null,
    }
  }

  const api = { start, stop, tick, handleSample, status, config: { host, intervalMs, timeoutMs, highLatencyMs, jitterMs, cooldownMs } }
  return api
}

module.exports = {
  NETWORK_EVENT_TEXT,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  HIGH_LATENCY_MS,
  JITTER_MS,
  COOLDOWN_MS,
  PUBLIC_PROBE_HOST,
  createHardwareSensor,
  detectDefaultGateway,
  probeLatency,
  probeWithPingModule,
  probeWithSystemPing,
  parsePingOutput,
  systemPingArgs,
}
