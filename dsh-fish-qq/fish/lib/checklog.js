/**
 * checklog.js —— 派出去的任务做完了，就在 CheckLogs/ 里留一个文件（2026-10-27）
 *
 * 用户要的：每次派任务后，任务完成时在 `CheckLogs/` 里生成一个日志文件。
 *   位置跟着**插件目录**走（`dsh-fish-qq/CheckLogs/`），不跟着工作区走——
 *   这样即使派活去的是别的目录，日志也还在包旁边，一眼能找到。
 *   想放到别处就设环境变量 `DSH_FISH_CHECKLOGS_DIR`。
 *
 * 口径（都与用户确认过）：
 *   - 一个任务一个文件；只记任务、时间、成功/失败，**不抄她的回复正文**。
 *   - 「完成」= 派出去的那条会话结束一轮（宿主 `session/event` 的 `turn/end`）。
 *     一轮结束就是那次请求做完了；她要是接着被追问，那是下一轮、另一个回合。
 *   - 失败 / 中止 / 出错 / 超时**也记**——日志的意义就是事后能看出哪次没做成。
 *
 * 为什么不在派活的那一刻就写：那时候什么都不知道，写出来的只是「派了」，
 * 用户要看的是「做完了没有」。
 *
 * 边界：监听的是**本进程**的事件。DSH 在任务跑完之前重启、或插件被停用，
 * 这一次就没有日志——这是这套机制诚实的边界，不假装补写。
 *
 * 任务书 4（2026-10-28）——写完 .md 之后顺手喊一声：
 * 日志写成后往宿主事件总线 emit 一条 `checklog/finished`，载荷就是这条日志的
 * 字段（`buildTaskResult`）。qq 侧（dsh-qq-bridge）监听这个事件，按它的设置
 * 决定要不要发 QQ 通知。
 *   - **只有写成功才 emit**：日志是事实，通知只是事实的衍生物——写不出来时
 *     喊一声等于让 qq 去通知一件没留下痕迹的事。
 *   - fish **不 import qq**（破坏装配顺序与独立安装）：两边只约定事件名与载荷
 *     契约。没人监听时 emit 落空，跟不喊一样。
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 等一轮结束最多等这么久；再久就当它卡住了，记一条超时。 */
// @doc fish.checklog
export const TASK_LOG_TIMEOUT_MS = 2 * 60 * 60 * 1000

/** 插件根（`lib/` 的上两级就是包目录：fish/lib → fish → 包根）。 */
const LIB_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * CheckLogs 目录：环境变量优先，否则 `<包根>/CheckLogs`。
 * 合并包里包根就是 dsh-fish-qq/；单独装 dsh-fish 时是 dsh-fish/。
 */
export function defaultCheckLogsDir(env = process.env) {
  const fromEnv = String(env.DSH_FISH_CHECKLOGS_DIR ?? '').trim()
  if (fromEnv) return fromEnv
  return join(LIB_DIR, '..', '..', 'CheckLogs')
}

/** 一轮是怎么结束的 → 日志里那一行「结果」。宿主 TurnEndReason 的 kind。 */
export function describeTurnEnd(kind) {
  switch (kind) {
    case 'completed': return { status: '成功', ok: true, note: '' }
    case 'max-tokens': return { status: '失败（输出太长被截断）', ok: false, note: 'max-tokens' }
    case 'aborted': return { status: '中止（被取消）', ok: false, note: 'aborted' }
    case 'interrupted': return { status: '中断（被取消）', ok: false, note: 'interrupted' }
    case 'blocked': return { status: '失败（被拦下）', ok: false, note: 'blocked' }
    case 'error': return { status: '失败（出错）', ok: false, note: 'error' }
    case 'forked': return { status: '结束（分叉）', ok: false, note: 'forked' }
    case 'timeout': return { status: '超时（没等到这一轮结束）', ok: false, note: 'timeout' }
    default:
      return { status: `结束（${String(kind ?? 'unknown')}）`, ok: false, note: String(kind ?? 'unknown') }
  }
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 本地时间 `2026-10-27 23:12:01`。日志是给人看的，用本地时间。 */
export function formatTime(ms) {
  const d = new Date(Number(ms) || 0)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 文件名用的紧凑时间 `20261027-231201`。 */
function stamp(ms) {
  const d = new Date(Number(ms) || 0)
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

/** 耗时说人话。 */
export function humanDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0))
  const s = Math.round(total / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m} 分 ${rs} 秒` : `${m} 分`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`
}

/** 日志正文。纯函数，便于测试。 */
export function renderTaskLog({ task, title, sessionId, startedAt, endedAt, status, note } = {}) {
  const rows = [
    `- 结果：${String(status ?? '结束')}${note ? `（${note}）` : ''}`,
    `- 任务：${String(task ?? '').replace(/\s+/g, ' ').trim() || '（没写）'}`,
  ]
  if (title) rows.push(`- 会话：${String(title)}`)
  if (sessionId) rows.push(`- 会话编号：${String(sessionId)}`)
  rows.push(`- 派发时间：${formatTime(startedAt)}`)
  rows.push(`- 结束时间：${formatTime(endedAt)}`)
  rows.push(`- 耗时：${humanDuration(Number(endedAt) - Number(startedAt))}`)
  return [
    '# 任务完成日志',
    '',
    ...rows,
    '',
    '<!-- 由 dsh-fish 自动写入：一个任务一个文件。不抄她的回复正文。 -->',
    '',
  ].join('\n')
}

/**
 * 写一个任务日志文件。返回文件路径。**永不抛**（日志写不出来不能带崩派活）。
 *
 * @returns {Promise<string>} 写成功返回路径，失败返回空串
 */
export async function writeTaskLog({ dir, task, title, sessionId, startedAt, endedAt, status, note, now = Date.now() } = {}) {
  const base = String(dir || defaultCheckLogsDir()).trim()
  if (!base) return ''
  try {
    await mkdir(base, { recursive: true })
    const hash = createHash('sha1').update(String(task ?? '')).digest('hex').slice(0, 8)
    let file = join(base, `${stamp(endedAt ?? now)}-${hash}.md`)
    // 同一秒、同一个任务（理论上不可能）也别互相覆盖。
    if (existsSync(file)) file = join(base, `${stamp(endedAt ?? now)}-${hash}-${Math.random().toString(36).slice(2, 6)}.md`)
    await writeFile(file, renderTaskLog({ task, title, sessionId, startedAt, endedAt, status, note }), 'utf8')
    return file
  } catch {
    return ''
  }
}

/**
 * 共享事件名：任务日志写成之后，往宿主事件总线上喊的那一声（任务书 4）。
 *
 * 刻意**只在 fish 这边导出常量、qq 那边写字面量**：两个子包都要能单独安装，
 * 为一个事件名 import 对方，就把「独立安装」这件事弄没了。字符串就那么长，
 * 两边各写一遍，配 `grep` 也能互相查到。
 */
export const CHECKLOG_FINISHED_EVENT = 'checklog/finished'

/**
 * 把一次任务结束汇成「通知结果」。纯函数，便于测试。
 *
 * 全是**既有计算的搬运**，不在这里新算任何东西：
 *   - `ok` 用 `describeTurnEnd` 已经算好的那一个（缺省按失败——
 *     信息不全时宁可让 qq 侧多说一句，也别把坏事吞掉，与那边同一个 fail-safe）；
 *   - `reason` 是宿主 `turn/end` 的 `reason.kind`（watcher 原样透传）；
 *   - `status` 是 `describeTurnEnd` 的中文状态（写日志用的那一个，qq 侧模板据它说原因）；
 *   - 两个时间就是写日志用的那两个数，`elapsedMs` 是两者之差。
 *
 * 契约与 qq 侧 `notifyTaskFinished` 对齐（见 qq/checklog-notify.js 的文件头）。
 */
// @doc fish.checklog
export function buildTaskResult({ kind, ok, task, title, sessionId, startedAt, endedAt, status, file } = {}) {
  const start = Number(startedAt) || 0
  const end = Number(endedAt) || 0
  return {
    ok: ok === true,
    reason: String(kind ?? ''),
    task: String(task ?? ''),
    sessionTitle: String(title ?? ''),
    sessionId: String(sessionId ?? ''),
    status: String(status ?? ''),
    startedAt: start,
    endedAt: end,
    elapsedMs: Math.max(0, end - start),
    /** 日志落在哪：通知里指一下，主人想看详情能直接打开。 */
    file: String(file ?? ''),
  }
}

/**
 * 写任务日志，**写成了再**往事件总线上喊一声（任务书 4）。
 *
 * 为什么「先写后喊」、且只有写成才喊：
 *   - 日志是**事实**，通知是事实的衍生物。写失败时还 emit，等于让 qq 侧去
 *     通知一件并没有留下痕迹的事——主人收到「任务失败了」，CheckLogs 里却对不上。
 *   - qq 侧的限流计数只在真的发出去时 +1，emit 本身不花额度；但「该不该 emit」
 *     的判据就是「日志写没写成」，这一层在这里卡死，调用方没法绕。
 *
 * @param {object} ctx 宿主 ctx，用它的 `emit`；没有 `emit` 的宿主上就只写日志。
 * @returns {Promise<{file: string, announced: boolean, result: object|null}>}
 *   `file` 为空串 = 日志没写成（必然 `announced=false`）；
 *   `announced` = 事件真的发出去了（没人监听也算发出去）。
 */
// @doc fish.checklog
export async function writeTaskLogAndAnnounce(ctx, {
  dir, task, title, sessionId, startedAt, endedAt, status, note, ok, kind, now = Date.now, log,
} = {}) {
  const file = await writeTaskLog({ dir, task, title, sessionId, startedAt, endedAt, status, note, now })
  if (!file) return { file: '', announced: false, result: null }
  const result = buildTaskResult({ kind, ok, task, title, sessionId, startedAt, endedAt, status, file })
  let announced = false
  if (typeof ctx?.emit === 'function') {
    try {
      ctx.emit(CHECKLOG_FINISHED_EVENT, result)
      announced = true
    } catch (err) {
      log?.('[dsh-fish] 任务完成事件没发出去', err?.message ?? err)
    }
  }
  return { file, announced, result }
}

/**
 * 盯着一条会话，等到它这一轮结束。
 *
 * 用宿主事件（`session/event` 的 `turn/end`）而不是轮询 agent.status：
 * 事件带着 `reason.kind`，能分清「做完了」和「被取消了」。
 * 拿不到事件总线（老宿主 / 单测）时返回 null，调用方按「没有日志」处理，不报错。
 *
 * @param {object} ctx 插件上下文
 * @param {object} opts { sessionId, onDone, timeoutMs, log }
 * @returns {{cleanup:Function, done:boolean}|null}
 */
// @doc fish.checklog
export function createTaskWatcher(ctx, { sessionId, onDone, timeoutMs = TASK_LOG_TIMEOUT_MS, log } = {}) {
  const id = String(sessionId ?? '').trim()
  if (!id || typeof ctx?.on !== 'function') return null
  let done = false
  let timer = null
  let off = null

  const cleanup = () => {
    if (timer) clearTimeout(timer)
    timer = null
    try { off?.() } catch { /* 注销失败不影响任何事 */ }
    off = null
  }

  const finish = (kind) => {
    if (done) return
    done = true
    cleanup()
    try {
      Promise.resolve(onDone?.({ kind, ...describeTurnEnd(kind) })).catch((err) => {
        log?.('任务完成日志写入失败', err?.message ?? err)
      })
    } catch (err) {
      log?.('任务完成回调失败', err?.message ?? err)
    }
  }

  try {
    off = ctx.on('session/event', (session, event) => {
      const sid = session?.header?.id ?? session?.id
      if (sid !== id) return
      if (event?.type === 'turn/end') finish(event?.data?.reason?.kind ?? 'unknown')
    })
  } catch (err) {
    log?.('任务日志监听没挂上', err?.message ?? err)
    return null
  }

  // 超时兜底：她那条会话要是卡住不动，也得留下一条「超时」而不是永远没有文件。
  const wait = Number(timeoutMs)
  const ms = Number.isFinite(wait) && wait > 0 ? wait : TASK_LOG_TIMEOUT_MS
  timer = setTimeout(() => finish('timeout'), Math.max(10, ms))
  timer.unref?.()

  return {
    cleanup,
    get done() { return done },
  }
}
