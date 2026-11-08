/**
 * rhythm.js —— 她的「心跳触觉」：read_user_rhythm 工具 + 采样调度
 *
 * 为什么要有这个（2026-11-02，赛博感官任务书模块 2）：
 *   原来没有任何途径让她知道「他在电脑前忙不忙」——她只能靠聊天的来去猜。
 *   现在底层脚本（pipeline/update_rhythm.js）每隔几分钟采一次用户空闲时长，
 *   按小时聚合成「09:00-10:00 高频打字」这样一行，写到工作区 sensors/user_rhythm.md。
 *   她想看的时候自己读这段文件，不想看就当它不存在。
 *
 * 两件事在这一个文件里：
 *   1. read_user_rhythm 工具：纯只读，读 sensors/user_rhythm.md + 报更新时间；
 *   2. startRhythmSampler：每 5 分钟 spawn 一次 pipeline/update_rhythm.js。
 *      为什么不老老实实「每 1 小时」跑一次：一个小时只采一个点，是分不出
 *      「高频打字」和「间歇操作」的——任务书要的输出本身就是按小时分档的节奏，
 *      所以采样得比聚合频。聚合结果仍然是小时粒度，与任务书一致。
 *
 * 硬约束：工具侧只用 readFileSync / statSync；调度侧只 spawn 一个只读的采集脚本，
 * 这个插件自己永远不直接监视键盘鼠标（那是采集脚本的事）。
 */

import { readFileSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawn } from 'node:child_process'

import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { resolveWorkspaceRoot } from './workspace.js'

/** 节奏文件相对工作区根的位置。pipeline/update_rhythm.js 与这里必须认同一条路。 */
export const RHYTHM_FILE_REL = join('sensors', 'user_rhythm.md')

/** 原始采样目录相对工作区根的位置（. 开头，工作区里不显眼）。 */
export const RHYTHM_RAW_REL = join('sensors', '.rhythm')

/** 采样间隔：每 5 分钟跑一次采集脚本（小时粒度聚合见文件头注释）。 */
export const SAMPLE_INTERVAL_MS = 5 * 60 * 1000

/** 多久算「数据旧了」：一个小时内没有任何更新就如实说旧。 */
export const RHYTHM_STALE_MS = 60 * 60 * 1000

/**
 * 把毫秒岁数说成人话（与 body.js 同一个口径，两处刻意保持一致）。
 * @param {number} ageMs
 * @returns {string}
 */
function ageText(ageMs) {
  const min = Math.round(ageMs / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr} 小时前`
  return `${Math.round(hr / 24)} 天前`
}

/**
 * 读一次工作节奏（纯函数：读盘只发生在这一处）。
 *
 * @param {string|Function} workspaceRoot 工作区根（可以是 getter）
 * @returns {{ok:boolean, text:string, note:string}}
 */
export function readUserRhythm(workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (!root) return { ok: false, text: '', note: '还没说能看哪儿（工作区根目录没配），节奏文件不知道在哪。' }

  const file = join(root, RHYTHM_FILE_REL)
  let st
  try {
    st = statSync(file)
  } catch {
    return { ok: false, text: '', note: '还没有节奏记录。采集脚本每 5 分钟跑一次，过一会儿再来看。' }
  }
  if (!st.isFile()) return { ok: false, text: '', note: 'sensors/user_rhythm.md 不是普通文件，看不了。' }

  let body = ''
  try {
    body = readFileSync(file, 'utf8').trim()
  } catch (err) {
    return { ok: false, text: '', note: `节奏文件读不了：${String(err?.message ?? err).slice(0, 80)}` }
  }
  if (body === '') return { ok: false, text: '', note: '节奏文件是空的。' }

  const age = Date.now() - st.mtimeMs
  const updated = `（更新于 ${ageText(age)}）`
  const text = age <= RHYTHM_STALE_MS
    ? `${body}\n${updated}`
    : `${body}\n${updated}，有一阵没更新了，可能只到记录的一半`
  return { ok: true, text, note: '' }
}

/**
 * 注册 read_user_rhythm 工具。
 *
 * deps.workspaceRoot：用户工作区的根（设置页那条），可以是 getter。
 */
export function registerRhythm(ctx, deps = {}) {
  return ctx.tools.register(
    defineTool({
      name: 'read_user_rhythm',
      description:
        '看一眼他今天在机器前的节奏：哪几个小时在打字、哪几个小时没操作。' +
        '数据在工作区的 sensors/user_rhythm.md 里，只有按小时聚成的一行；' +
        '文件带着更新时间。只读。',
      parameters: toJsonSchema({}),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '按小时聚合的节奏 + 更新时间' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没读到：${out.note}` }],
      },
      async execute() {
        return readUserRhythm(deps.workspaceRoot)
      },
    }),
  )
}

/**
 * 采集脚本的完整路径。工作区根没配 / 脚本不在 → 空串（调用方如实 warn）。
 * @param {string|Function} workspaceRoot
 * @returns {string}
 */
function rhythmScriptPath(workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (!root) return ''
  const p = join(root, 'pipeline', 'update_rhythm.js')
  return existsSync(p) ? p : ''
}

/**
 * 每 5 分钟 spawn 一次采集脚本。
 *
 * 只 spawn、看 close 日志：脚本的成败不进任何会话，只进日志。
 * spawn 的 node：宿主自己在 Node 里跑时 process.execPath 就是 node；
 * 万一宿主壳不是 node（例如 Electron），退化到 PATH 里的 node。
 *
 * @param {{workspaceRoot?:string|Function, log?:Function}} deps
 * @returns {{dispose():void} | null} 没法开（脚本不存在 / 没配工作区）时返回 null
 */
export function startRhythmSampler(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const workspaceRoot = deps.workspaceRoot

  const runOnce = () => {
    const script = rhythmScriptPath(workspaceRoot)
    if (script === '') {
      log('[dsh-fish] 节奏采样：找不到采集脚本（期望 <工作区>/pipeline/update_rhythm.js），这次跳过')
      return
    }
    const root = resolveWorkspaceRoot(workspaceRoot)
    const exe = /node/i.test(basename(process.execPath)) ? process.execPath : 'node'
    const args = [
      script,
      `--out=${join(root, RHYTHM_FILE_REL)}`,
      `--raw=${join(root, RHYTHM_RAW_REL)}`,
    ]
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      log(`[dsh-fish] 节奏采样：脚本没起来（${error?.message ?? error}）`)
      return
    }
    child.on('error', (error) => log(`[dsh-fish] 节奏采样：脚本运行出错（${error?.message ?? error}）`))
    child.on('close', (code) => {
      if (code !== 0) log(`[dsh-fish] 节奏采样：脚本退出码 ${code}，这次没采成（旧记录仍在）`)
    })
    child.unref?.()
  }

  if (rhythmScriptPath(workspaceRoot) === '') {
    // 启动时先说一声为什么没开；等用户配好工作区，下一次插件重启才接管。
    // 不做周期性的「等脚本出现」——轮询是隐式状态，不如让启动日志讲清楚。
    log('[dsh-fish] 节奏采样没有开：工作区根没配，或 pipeline/update_rhythm.js 不在工作区里')
    return null
  }

  const timer = setInterval(() => { runOnce() }, SAMPLE_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  // 起手先采一次，免得装好之后第一次看节奏要等 5 分钟。
  const first = setTimeout(() => { runOnce() }, 20_000)
  if (typeof first.unref === 'function') first.unref()

  return {
    dispose() {
      clearInterval(timer)
      clearTimeout(first)
    },
  }
}
