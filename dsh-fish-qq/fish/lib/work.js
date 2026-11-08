/**
 * work.js —— 工具 `work_request`：把接到的活派到工作区里，让那边的新会话去做
 *
 * 为什么需要（2026-10-26 用户要的）：
 *   她的工具面只有自己那十个（见 restrict.js），没有 write / edit / bash。
 *   用户在对话框里说「在 D:\demo 里写个脚本」，她只能回答做不到——
 *   这在她那条会话的 turn 5/6/7 里真实发生过三次。
 *   但 DSH 本身能开新会话，新会话拿的是完整工具。所以给她一个「派活」的口子：
 *   她把要做的事写成一句话，插件在一个工作区里新开一条会话，把这句话递进去，
 *   那边真的动手做。**她仍然没有写文件、跑命令的手**——动手的是那条新会话。
 *
 * 边界（改之前先读）：
 *   - 只**派**，不做。这个文件不碰 events.jsonl 里的 HER_TYPES，也不替她说话。
 *   - 派出去的话仍过 guard.js 的秘密闸：cookie / token 不许跟着出去。
 *     （不查路径：工作请求本来就该带路径，查了这件工具就没法用了。）
 *   - 一天派几件由配置管；用完只说「今天先不派了」，不报数字（N2）。
 *   - 同一件事短时间内重复派 → 拒。模型反复重试同一个工具是这套插件踩过的坑
 *     （见 capture.js 的 render 注释），这里直接挡住，免得侧栏堆一串一样的会话。
 */

import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from './tool.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig, dateKey } from './settings.js'
import { looksLikeSecret } from './guard.js'
import { resolveWorkspaceRoot } from './workspace.js'
// 任务完成日志（2026-10-27）：派出去的那条会话一结束，就在 CheckLogs/ 里落一个文件。
// 任务书 4（2026-10-28）：写完成功之后再往事件总线喊一声（writeTaskLogAndAnnounce），
// qq 侧监听这个事件决定要不要发 QQ 通知。
import { createTaskWatcher, defaultCheckLogsDir, writeTaskLogAndAnnounce } from './checklog.js'

/** 插件目录（`lib/` 的上一级）。npm 装的时候父目录是 node_modules，不能当工作区用。 */
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')

const MAX_TASK = 4000
/** 同一件事在这个间隔内重复派，当成模型在重试，不重复开会话。 */
const DEDUPE_MS = 120_000
/** 递话本身不该等这么久；超时当作没递进去，别把她那一轮吊死。 */
const PROMPT_TIMEOUT_MS = 20_000

/**
 * 没配工作目录时用哪儿。
 *
 * 口径：插件所在目录的上一级。`link:` 安装时那正好是用户自己的工程目录
 * （即插件目录往上那一级，哪儿都行）；npm 安装时上一级是 node_modules，
 * 那种情况不能猜，返回空串让工具如实说"还没说在哪儿干活"。
 */
export function defaultWorkDir(env = process.env) {
  const fromEnv = String(env.DSH_FISH_WORK_DIR ?? '').trim()
  if (fromEnv) return fromEnv
  const parent = dirname(PKG_DIR)
  if (!parent || /[\\/]node_modules$/i.test(parent)) return ''
  return parent
}

/** 比对路径用；Windows 大小写不敏感。 */
function normPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 在 workspaceRegistry 里按目录找已有的工作区。找不到返回 null。 */
export function findWorkspace(reg, dir) {
  try {
    const list = typeof reg?.list === 'function' ? reg.list() : []
    const want = normPath(dir)
    if (!want) return null
    return list.find((w) => w && normPath(w.path) === want) ?? null
  } catch {
    return null
  }
}

/** 今天派了几件（只数成功的；被拒的不占额度）。 */
export function dispatchedToday(events, dk) {
  const key = `work:${dk}`
  return (events ?? []).filter((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(key)).length
}

/** 最后一件派出去的事：{ hash, at }；没有就 null。用于挡重复。 */
export function lastDispatch(events, dk) {
  const key = `work:${dk}`
  const hit = [...(events ?? [])].reverse().find((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(key))
  if (!hit) return null
  const parts = String(hit.text ?? '').split(/\s+/)
  // 格式：work:<日期> <会话 id> <任务哈希>
  return { hash: parts[2] ?? '', at: Date.parse(hit.ts ?? '') || 0 }
}

export function taskHash(task) {
  return createHash('sha1').update(String(task ?? '')).digest('hex').slice(0, 8)
}

/** 侧栏里那条会话叫什么。太长会撑爆标题栏，截一段就够认。 */
export function workTitle(task, fallback = '工作') {
  const one = String(task ?? '').replace(/\s+/g, ' ').trim()
  return one ? `${fallback}·${one.slice(0, 18).trimEnd()}` : fallback
}

/**
 * 派活。
 *
 * @param {object} ctx 宿主 ctx（需要 sessionController、可选 workspaceRegistry）
 * @param {string} task 要做的事
 * @param {object} deps { root, dir, log, env, now, checkLogsDir }
 * @returns {Promise<{ok:boolean, sessionId:string, title:string, note:string}>}
 */
export async function dispatchWork(ctx, task, deps = {}) {
  const root = deps.root ?? rootDir()
  const log = deps.log ?? (() => {})
  const text = String(task ?? '').trim()

  if (!text) return { ok: false, sessionId: '', title: '', note: '没说要做什么。' }
  if (text.length > MAX_TASK) return { ok: false, sessionId: '', title: '', note: '太长了，分几次派。' }
  // 凭据不许跟着进另一条会话的历史里（那条会话用户会打开看）。
  if (looksLikeSecret(text).hit) return { ok: false, sessionId: '', title: '', note: '这句我不派出去。' }

  const { config } = await loadConfig(root)
  if (config?.work?.enabled === false) return { ok: false, sessionId: '', title: '', note: '现在不派活。' }

  // 派到哪儿：显式传入 > 设置页里的「工作区根目录」> 她自己的 work.dir 配置 > 插件上一级。
  // 「工作区根目录」是 QQ 桥接卡片里的那一条；改完下一次调用就生效。
  const explicit = String(deps.dir ?? '').trim()
  const fromWorkspace = resolveWorkspaceRoot(deps.workspaceRoot)
  const dir =
    explicit ||
    fromWorkspace ||
    resolveWorkspaceRoot(config?.work?.dir) ||
    defaultWorkDir(deps.env)
  if (!dir) return { ok: false, sessionId: '', title: '', note: '还没说在哪儿干活。' }

  const dk = dateKey(deps.now ? new Date(deps.now) : new Date())
  const cap = Math.max(0, Number(config?.work?.perDay ?? 3))
  const { events } = await readEvents(root).catch(() => ({ events: [] }))
  if (dispatchedToday(events, dk) >= cap) {
    return { ok: false, sessionId: '', title: '', note: '今天先不派了。' }
  }

  // 模型重试同一句话时不重复开会话；隔久了再派是同意的。
  const hash = taskHash(text)
  const last = lastDispatch(events, dk)
  const now = deps.now ?? Date.now()
  if (last && last.hash === hash && now - last.at < DEDUPE_MS) {
    return { ok: false, sessionId: '', title: '', note: '这件事刚派过，等它做完。' }
  }

  const sc = ctx?.sessionController ?? ctx?.get?.('sessionController') ?? null
  if (!sc?.create || !sc?.prompt) {
    return { ok: false, sessionId: '', title: '', note: '宿主开不了新会话，派不出去。' }
  }
  const reg = ctx?.get?.('workspaceRegistry') ?? ctx?.workspaceRegistry ?? null

  // ---- 工作区：先找，没有就建（create 对同一路径是幂等的）----
  let wsId = String(findWorkspace(reg, dir)?.id ?? '')
  if (!wsId) {
    if (typeof reg?.create !== 'function') {
      return { ok: false, sessionId: '', title: '', note: '那个目录还不是工作区，派不进去。' }
    }
    try {
      const ws = await reg.create(dir, workTitle('', '工作'))
      wsId = String(ws?.id ?? ws?.workspaceId ?? '')
    } catch (err) {
      log('dispatch workspace failed', err?.message ?? err)
      return { ok: false, sessionId: '', title: '', note: '工作区没建起来，派不出去。' }
    }
  }
  if (!wsId) return { ok: false, sessionId: '', title: '', note: '工作区没给 id，派不出去。' }

  const title = workTitle(text)
  let sessionId = ''
  try {
    const created = await sc.create({ workspaceId: wsId })
    sessionId = String(created?.sessionId ?? created?.id ?? '')
  } catch (err) {
    log('dispatch create failed', err?.message ?? err)
    return { ok: false, sessionId: '', title, note: '新会话没开起来，派不出去。' }
  }
  if (!sessionId) return { ok: false, sessionId: '', title, note: '新会话没给 id，派不出去。' }

  if (typeof sc.rename === 'function') {
    // 改不了名不影响干活，只是侧栏标题是默认的
    await sc.rename({ sessionId, title }).catch(() => {})
  }

  // 递进去的是一句人话，不是给她自己的唤醒词：那边看到的就是一件要办的事。
  const content = [
    '## 工作请求',
    '',
    text,
    '',
    '（这件事是从大肥鱼的对话框转过来的。按上面说的做就行，做完不用回复她。）',
  ].join('\n')

  // ⚠️ 宿主签名是 prompt(options, signal)：第二个参数是 AbortSignal，**不能省**。
  // 省了报 "Cannot read properties of undefined (reading 'throwIfAborted')"——
  // 会话开出来了，话却递不进去（2026-10-26 真机踩到，她连试三次都是这句）。
  // say.js 一直是传的，见那边的 ac.signal。
  //
  // 日志监听必须**在 prompt 之前**挂上：prompt 把话排进队列就 resolve 了，
  // 那边的回合可能在下一秒就开始、也可能很快就结束，晚挂就可能漏掉 turn/end。
  const watcher = createTaskWatcher(ctx, {
    sessionId,
    log,
    onDone: async (r) => {
      // 结束时间只取一次：日志正文和通知载荷用同一个数，免得两边差一毫秒。
      const endedAt = Date.now()
      // 写日志 + 写成了才往事件总线喊一声（checklog/finished）。
      // 写失败 = 没有事实，也就不通知（任务书 4 的边界）。
      const out = await writeTaskLogAndAnnounce(ctx, {
        dir: deps.checkLogsDir ?? defaultCheckLogsDir(),
        task: text,
        title,
        sessionId,
        startedAt: now,
        endedAt,
        status: r.status,
        note: r.note,
        ok: r.ok,
        kind: r.kind,
        log,
      })
      if (out.file) log(`[dsh-fish] 任务完成日志：${out.file}（${r.status}）`)
      else log('[dsh-fish] 任务完成日志没写出来')
    },
  })

  const ac = new AbortController()
  const kill = setTimeout(() => ac.abort(), PROMPT_TIMEOUT_MS)
  kill.unref?.()
  try {
    await sc.prompt({
      requestId: `work-${dk}-${now}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: content }],
    }, ac.signal)
  } catch (err) {
    log('dispatch prompt failed', err?.message ?? err)
    // 话没递进去 = 这次任务根本没开始，别留一个等不到结束的监听。
    watcher?.cleanup?.()
    return { ok: false, sessionId, title, note: '会话开出来了，但事情没递进去。' }
  } finally {
    clearTimeout(kill)
  }

  // 记账（只写 meta，source 必须是 system；tool 写 meta 会被 schema 拒）。
  // now 一起传下去：这条记录的时间就是"这次派活的时间"，去重靠它。
  await appendEvent(
    { type: 'meta', text: `work:${dk} ${sessionId} ${hash}` },
    { source: 'system', now },
    root,
  ).catch(() => {})

  log(`[dsh-fish] 派了一件活：${title}（会话 ${sessionId}）`)
  return { ok: true, sessionId, title, note: '' }
}

/** 注册 work_request 工具。 */
export function registerWork(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'work_request',
      description:
        '把一件要动手做的事派出去：在工作区里新开一条会话，把这件事写清楚递过去，那边有完整的工具，会真的去做。' +
        '你自己没有写文件、跑命令的手，只能这样派出去，别假装自己做完了。' +
        '只有他明确让你做一件具体的事时才用；闲聊、你自己的想法、网上看到的东西都不要派。' +
        '派完不用管，做没做成，侧栏那条新会话里能看到。',
      // 完整 JSON Schema（不是简写 DSL），否则 provider 拒
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '要做的事。写清楚要什么、在哪儿做，别只写一个词。',
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            sessionId: { type: 'string', description: '新开的那条会话的编号' },
            title: { type: 'string', description: '它在侧栏里的名字' },
            note: { type: 'string' },
          },
          required: ['ok', 'sessionId', 'title', 'note'],
        },
        // 回执走方括号，不写成她能复述的完整句子（见 capture.js 的注释）。
        render: (_args, out) =>
          [{ type: 'text', text: out.ok ? `[派出去了：${out.title}]` : `[没派出去：${out.note}]` }],
      },
      async execute(args) {
        return dispatchWork(ctx, args?.task, { root, log: deps.log, dir: deps.dir, env: deps.env, workspaceRoot: deps.workspaceRoot, checkLogsDir: deps.checkLogsDir })
      },
    }),
  )
}
