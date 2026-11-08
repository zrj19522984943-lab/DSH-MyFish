/**
 * bridge.js —— 桌宠窗口 ↔ dsh-fish 宿主的文件通道。
 *
 * 窗口是独立 Electron 进程，拿不到面板登录 cookie，所以不走 HTTP。
 * 窗口把一句话原子写进 pet/request.json；这里读走、删掉，然后交给
 * **sayToHer()**——和设置页里「跟她说一句话」完全同一条链路：
 *
 *   guard.js（重塑人格类输入根本不递）
 *     → sessionController.prompt（她屋子里的当前会话）
 *     → 正常的一轮成长流程
 *
 * 这里不写事件、不改状态、不替她说话；连 seen: 标记都由 say.js 自己落。
 * 唯一的额外动作是回执：窗口需要知道「递进去了没有」。
 */
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { writeAtomic } from '../store.js'
import { HER_TYPES } from '../schema.js'
import { looksLikeRewriting } from '../guard.js'
import { sayToHer } from '../say.js'
import { ensurePetDir, petPaths, readJsonFile } from './paths.js'

export const MAX_PET_TEXT = 4000
export const MAX_TRANSCRIPT = 40
const SPOKEN_TYPES = new Set(HER_TYPES)

/**
 * 桌宠输入的第一道检查。与 say.js 保持一致：
 * 空话不递、超长不递、试图重塑人格的话根本不递（不是递进去再劝）。
 *
 * @returns {{ok:true,text:string}|{ok:false,note:string}}
 */
export function normalizePetText(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, note: '你什么都没说。' }
  if (text.length > MAX_PET_TEXT) return { ok: false, note: '太长了，分几次说。' }
  if (looksLikeRewriting(text).hit) return { ok: false, note: '这句我没递给她。' }
  return { ok: true, text }
}

/** 解析窗口写下的请求；坏 JSON / 缺字段一律当没收到。 */
export function parsePetRequest(raw) {
  try {
    const value = JSON.parse(String(raw ?? '').replace(/^\uFEFF/, ''))
    if (!value || typeof value !== 'object') return null
    if (typeof value.id !== 'string' || !value.id) return null
    if (typeof value.text !== 'string') return null
    return { id: value.id, text: value.text, token: String(value.token ?? '') }
  } catch {
    return null
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

/** 回执文件名只允许 id 里出现过的安全字符，避免窗口 id 被拿来拼路径。 */
function replyFile(dir, id) {
  return join(dir, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}.json`)
}

/**
 * 起一个文件通道。start() 会生成一次性 token；窗口每次发话都要带上它，
 * 这样重启后旧窗口/旧请求不会误投。
 *
 * @param {object} options
 * @param {object} options.ctx DSH 插件 ctx（sayToHer 需要 sessionController）
 * @param {string} options.root 状态库根目录
 * @param {Function} [options.log]
 * @param {number} [options.intervalMs]
 * @param {number} [options.ackTimeoutMs]
 * @param {Function} [options.say] 测试可替换，默认 sayToHer
 */
export function createPetBridge({
  ctx,
  root,
  log = () => {},
  intervalMs = 700,
  ackTimeoutMs = 15_000,
  say = sayToHer,
} = {}) {
  const p = petPaths(root)
  let timer = null
  let disposed = false
  let reading = false
  let busy = false
  let token = ''
  const queue = []

  async function reply(value) {
    try {
      await writeAtomic(
        replyFile(p.repliesDir, value.id),
        JSON.stringify({ ...value, at: Date.now() }, null, 2),
        0o600,
      )
    } catch (err) {
      log(`[dsh-fish] 桌宠回执写不进去：${String(err?.message ?? err).slice(0, 120)}`)
    }
  }

  async function readTranscript() {
    const value = await readJsonFile(p.messages, [])
    return Array.isArray(value) ? value : []
  }

  /**
   * 把这一轮她新说出口的话追加到 messages.json，窗口轮询它显示。
   * 优先用 result.assistant（她在会话里正常回的 assistant 文本）；
   * 没有 assistant 时才退回 HER_TYPES（她用 growth_commit 留下的那几类）。
   * 日记、留给人的信、系统 meta 都不进这里。
   * 她这一轮没说话时留一条 note，让窗口显示「她这次没说话」而不是空白。
   */
  async function appendHerMessages(jobId, result) {
    const said = Array.isArray(result?.said) ? result.said : []
    const assistant = Array.isArray(result?.assistant)
      ? result.assistant.map((text) => String(text ?? '').trim()).filter(Boolean)
      : []
    const entries = []
    if (assistant.length) {
      // 她在会话里正常回的话优先：growth_commit 只是她的写法之一，
      // 大多数时候她直接说话，不会留下 HER_TYPES 事件。
      for (const text of assistant) {
        entries.push({ kind: 'her', type: 'assistant', text: text.slice(0, 4000) })
      }
    } else {
      for (const item of said) {
        const type = String(item?.type ?? '')
        const text = String(item?.text ?? '').trim()
        if (!text || !SPOKEN_TYPES.has(type)) continue
        entries.push({ kind: 'her', type, text: text.slice(0, 4000) })
      }
    }
    if (!entries.length && result?.ok) entries.push({ kind: 'note', text: '她这次没说话。' })
    if (!entries.length) return

    const current = await readTranscript()
    let seq = current.reduce((max, item) => Math.max(max, Number(item?.seq) || 0), 0)
    const at = new Date().toISOString()
    for (const entry of entries) {
      seq += 1
      entry.seq = seq
      entry.id = jobId
      entry.at = at
    }
    const next = [...current, ...entries].slice(-MAX_TRANSCRIPT)
    await writeAtomic(p.messages, JSON.stringify(next, null, 2), 0o600)
  }

  async function run(job) {
    let settled = false
    const timerAck = setTimeout(() => {
      if (settled) return
      settled = true
      void reply({ id: job.id, ok: false, note: '她那边没应声' })
    }, ackTimeoutMs)

    try {
      const result = await say(ctx, job.text, {
        root,
        log,
        // say.js 在 prompt 真正排进会话后回调；这之前被 guard 拦下的话不会走到这里。
        onSent: () => {
          if (settled) return
          settled = true
          clearTimeout(timerAck)
          void reply({ id: job.id, ok: true, note: '说给她了' })
          log(`[dsh-fish] 桌宠递话已入队（${job.text.length} 字）`)
        },
      })
      if (!settled) {
        settled = true
        clearTimeout(timerAck)
        if (result?.ok) void reply({ id: job.id, ok: true, note: '说给她了' })
        else void reply({ id: job.id, ok: false, note: result?.note || '没递出去' })
      }
      // 她这一轮说的话写进 messages.json；窗口那边会把它显示在返回框里。
      // 回执只说明「递进去没有」，她的话走另一份文件，不用等模型想完才回执。
      if (result?.ok) {
        await appendHerMessages(job.id, result).catch((err) => {
          log(`[dsh-fish] 桌宠返回框写入失败：${String(err?.message ?? err).slice(0, 160)}`)
        })
      }
      log(`[dsh-fish] 桌宠递话结束（${job.text.length} 字，${result?.ok ? 'ok' : 'no'}）`)
    } catch (err) {
      if (!settled) {
        settled = true
        clearTimeout(timerAck)
        void reply({ id: job.id, ok: false, note: `没送到：${String(err?.message ?? err).slice(0, 120)}` })
      }
      log(`[dsh-fish] 桌宠递话失败：${String(err?.message ?? err).slice(0, 160)}`)
    } finally {
      clearTimeout(timerAck)
    }
  }

  function pump() {
    if (busy || disposed) return
    const job = queue.shift()
    if (!job) return
    busy = true
    run(job).finally(() => {
      busy = false
      pump()
    })
  }

  async function tick() {
    if (disposed || reading) return
    reading = true
    try {
      const raw = await readText(p.request)
      if (raw === null) return
      // 先删再处理：同一个请求不会因为异常被重复投递。
      await fs.rm(p.request, { force: true }).catch(() => {})

      const req = parsePetRequest(raw)
      if (!req) {
        log('[dsh-fish] 桌宠请求不是合法 JSON，丢掉')
        return
      }
      if (!token || req.token !== token) {
        await reply({ id: req.id, ok: false, note: '窗口凭证过期，重启 DSH 后再试。' })
        return
      }
      const checked = normalizePetText(req.text)
      if (!checked.ok) {
        await reply({ id: req.id, ok: false, note: checked.note })
        log(`[dsh-fish] 桌宠输入未递出：${checked.note}`)
        return
      }

      // 正在跟她说话时又来一句：先回执「排上了」，不让人在窗口前干等。
      if (busy || queue.length > 0) {
        queue.push({ id: req.id, text: checked.text })
        await reply({ id: req.id, ok: true, queued: true, note: '排上了，她一会儿看' })
        return
      }

      queue.push({ id: req.id, text: checked.text })
      pump()
    } catch (err) {
      log(`[dsh-fish] 桌宠通道读取出错：${String(err?.message ?? err).slice(0, 160)}`)
    } finally {
      reading = false
    }
  }

  async function start() {
    if (timer) return
    await ensurePetDir(root)
    // 上一次 Host 留下的半截请求不回放：宁可丢一条，也不把几分钟前的话
    // 在重启后突然塞进她的当前对话。回执目录也一起清，避免旧 id 撞上。
    await fs.rm(p.request, { force: true }).catch(() => {})
    await fs.rm(p.repliesDir, { recursive: true, force: true }).catch(() => {})
    await ensurePetDir(root)
    token = randomUUID()
    await writeAtomic(
      p.bridge,
      JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      0o600,
    )
    timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    log(`[dsh-fish] 桌宠文件通道就绪：${p.dir}`)
  }

  function stop() {
    disposed = true
    if (timer) clearInterval(timer)
    timer = null
    token = ''
    queue.length = 0
  }

  function status() {
    return {
      dir: p.dir,
      token: Boolean(token),
      busy,
      queued: queue.length,
      running: Boolean(timer),
    }
  }

  return { start, stop, status }
}
