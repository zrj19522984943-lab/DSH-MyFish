/**
 * home.js —— 她的屋子：自动建工作区 + 一个专属会话（P3 的核心改造）
 *
 * 为什么改成这样（2026-10-23 用户定案）：
 *   原方案是「观测台里加一个输入框」。用户否掉了，理由是——这是个要发布到 GitHub 的插件，
 *   别人装完不该看到一个黑窗口 + 一个 http://127.0.0.1:xxxx/?token=... 的地址，
 *   也不该被要求「自己建一个 profile」。
 *   正确的形态：插件加载时**自己**在侧栏建一个工作区和一个会话，她住在那里面，
 *   你跟她的所有对话就在那个会话里说。参考 @a9i5k4/dsh-auto-memory 的「记忆中枢」。
 *
 * 三个 API（全部来自宿主，已从 app.asar 核实签名）：
 *   ctx.workspaceRegistry.list() / .create(path, title) / .get(id)
 *     - create 语义：同一个规范路径重复调用返回**已存在**的那条，不新建、不改标题。
 *   ctx.sessionController.create({ workspaceId }) 或 ({ cwd })，二者只能给一个
 *     - 返回 { sessionId }；传 workspaceId 时才会把会话挂进工作区（侧栏才看得见）。
 *   ctx.sessionController.rename({ sessionId, title })
 *     - 需要宿主的 sessionTitle 服务；没有就跳过（不是致命错误）。
 *
 * 幂等（关键，否则每次重启都多一个会话）：
 *   把 {wsId, sessionId} 记在 `~/.dsh-fish/home.json`。
 *   下次加载先验：「这个 sessionId 还在这个工作区的 sessionIds 里吗」——
 *   用户可能把会话归档/删了，那就重建一个，而不是永远指向一个空壳。
 */

import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rootDir, paths, readJson, writeAtomic } from './store.js'
import { recentExchanges, renderCarry } from './talkmem.js'
import { WAKE_TRIGGER } from './wakeconst.js'
import {
  collectRecentTurns,
  fallbackHandoffText,
  FAILED_HANDOFF_TEXT,
  generateHandoff,
  handoffStamp,
  renderHandoff,
  HANDOFF_TIMEOUT_MS,
} from './handoff.js'
import { loadConfig } from './settings.js'

const TITLE_WORKSPACE = '大肥鱼的家'
const TITLE_SESSION = '跟大肥鱼说话'

function homeFile(root) {
  return join(paths(root).root, 'home.json')
}

/** 她的屋子目录：工作区指向这里（不是 ~/.dsh-fish 根，那里面有 events.jsonl）。 */
export async function ensureHomeDir(root = rootDir()) {
  const dir = join(paths(root).root, 'home')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function readRegistry(ctx) {
  try { return ctx.get?.('workspaceRegistry') ?? null } catch { return null }
}

function pathKey(p) {
  // Windows 大小写不敏感；其余平台保持原样。只用于比对，不用于文件访问。
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 找到或创建工作区。**先查后建**：宿主 create 本身是幂等的，但明查一遍能拿到
 * 已存在的 title / id，避免依赖实现细节。
 */
export async function ensureWorkspace(ctx, { root = rootDir(), title = TITLE_WORKSPACE } = {}) {
  const dir = await ensureHomeDir(root)
  const reg = readRegistry(ctx)
  if (!reg?.create) return { ok: false, why: '宿主没有 workspaceRegistry 服务', dir }

  let ws = null
  try {
    const list = typeof reg.list === 'function' ? reg.list() : []
    ws = list.find((w) => w && w.path && pathKey(w.path) === pathKey(dir)) ?? null
  } catch { /* list 不可用就直接 create */ }

  const existed = Boolean(ws)

  // 老档改名：早期版本把工作区叫「鱼」，现在统一叫「大肥鱼的家」。
  // 宿主真正的改名入口在**实体**上：registry.list()/get() 返回的 Workspace 有 setTitle(title)；
  // registry 自己**没有** update/rename（2026-10-25 从 app.asar 核实）。
  // 早先那版调 reg.update/reg.rename，两个都不存在、又被 catch 吞掉，所以标题一直是「鱼」。
  // 改不动的仍然保持原名——她那间屋子还能住，只是侧栏名不对。
  let renamed = false
  if (ws && title && String(ws.title ?? '') !== title) {
    try {
      if (typeof ws.setTitle === 'function') {
        await ws.setTitle(title)
        renamed = true
      } else if (typeof reg.rename === 'function') {
        await reg.rename(ws.id ?? ws.workspaceId, title)
        renamed = true
      }
    } catch { renamed = false }
  }

  if (!ws) {
    try {
      ws = await reg.create(dir, title)
    } catch (err) {
      return { ok: false, why: `建工作区失败：${String(err?.message ?? err).slice(0, 120)}`, dir }
    }
  }

  const wsId = String(ws?.id ?? ws?.workspaceId ?? '')
  if (!wsId) return { ok: false, why: '宿主返回的工作区没有 id', dir }
  return { ok: true, wsId, dir, created: !existed, renamed }
}

/**
 * 找到或创建那个对话会话。
 *
 * 判定「还活着」的口径：home.json 里记的 sessionId 仍在这个工作区的
 * sessionIds 里，且不在 archivedSessionIds 里。任一不满足就重建。
 */
export async function ensureTalkSession(ctx, { root = rootDir(), wsId, title = TITLE_SESSION, preset = '', log } = {}) {
  const sc = ctx.sessionController
  if (!sc?.create) return { ok: false, why: '宿主没有 sessionController 服务' }
  if (!wsId) return { ok: false, why: '没有工作区 id' }

  const reg = readRegistry(ctx)
  const saved = await readJson(homeFile(root), null)

  // ---- 先看上次那个会话还在不在 ----
  if (saved?.sessionId) {
    let alive = false
    try {
      const ws = reg?.get?.(wsId)
      const archived = Array.isArray(reg?.archivedSessionIds) ? reg.archivedSessionIds : []
      alive = Boolean(ws && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(saved.sessionId))
        && !archived.includes(saved.sessionId)
    } catch { alive = false }
    if (alive) {
      // 老档改名：早期版本叫「跟她说话」，现在统一叫「跟大肥鱼说话」。
      // 改名失败不影响使用（侧栏照旧显示旧标题），所以只试一次、不抛。
      if (title && saved.title !== title) {
        try {
          if (typeof sc.rename === 'function') await sc.rename({ sessionId: saved.sessionId, title })
          await writeAtomic(homeFile(root), JSON.stringify({ ...saved, title }, null, 2))
        } catch { /* 改不了就保持原名 */ }
      }
      return { ok: true, sessionId: saved.sessionId, reused: true }
    }
  }

  // ---- 建一个新的 ----
  // 指定受限 preset：`fish-home` 只挂她的工具 + 看图 + 身份文件，
  // 没有 shell、没有 write/edit、没有联网、没有技能。见 profile 的
  // cordis.patch.yml 里 preset-fish-home 那一行。
  // preset 不被接受（老宿主 / 没装）时回落默认组合，但**必须让调用方知道**，
  // 否则她会在「全套工具」下悄悄长大 —— 这是自检里「她的工具面」要报的。
  let created
  let presetUsed = ''
  const wantPreset = String(preset ?? '').trim()
  if (wantPreset) {
    try {
      created = await sc.create({ workspaceId: wsId, agentPreset: wantPreset })
      presetUsed = wantPreset
    } catch (err) {
      const why = String(err?.message ?? err).slice(0, 160)
      log?.(`受限 preset「${wantPreset}」没被接受（${why}），这次用默认组合建会话`)
      created = null
    }
  }
  try {
    if (!created) created = await sc.create({ workspaceId: wsId })
    const sessionId = String(created?.sessionId ?? created?.id ?? '')
    if (!sessionId) return { ok: false, why: '宿主建了会话但没给 id' }
    if (typeof sc.rename === 'function') {
      // 命名失败不影响功能：侧栏会显示默认标题，但会话本身是好的
      await sc.rename({ sessionId, title }).catch(() => {})
    }
    await writeAtomic(homeFile(root), JSON.stringify({ wsId, sessionId, title, preset: presetUsed, createdAt: new Date().toISOString() }, null, 2))
    return { ok: true, sessionId, reused: false, preset: presetUsed }
  } catch (err) {
    return { ok: false, why: `建会话失败：${String(err?.message ?? err).slice(0, 160)}` }
  }
}

/**
 * 一次做完全部：屋子目录 → 工作区 → 会话。
 * 任何一步失败都返回 ok:false + 人话原因，**不抛**——启动链路上抛异常会带走插件树。
 */
/**
 * 叫醒一间空白屋子。
 *
 * 为什么需要：宿主的侧栏可见性规则是
 *   `if (session.blank && session.id !== current) return false`
 * ——空白会话只在它是「当前主视图会话」时才显示。插件用 API 建出来的会话
 * 不会被设成当前会话，于是它一直藏在列表外面：用户点完重置看到的是「没有新会话」，
 * 重启也一样。让它跑一轮（blank 在开跑/成功后清掉）才是唯一能落地显示的办法。
 *
 * 代价：只在她确实空白时叫一次，复用会话里有内容就什么都不做。
 */
export async function wakeIfBlank(ctx, { sessionId, log, freshOnly = false } = {}) {
  if (!sessionId) return { woke: false, why: '没有会话 id' }
  const sc = ctx?.get?.('sessionController') ?? ctx?.sessionController
  if (!sc) return { woke: false, why: '宿主没有 sessionController 服务' }

  let blank = false
  try {
    const l = typeof sc.list === 'function' ? await sc.list({}) : null
    const items = l?.items ?? l?.value?.items ?? []
    const row = items.find((x) => String(x?.sessionId ?? x?.id ?? '') === String(sessionId))
    if (row === undefined) {
      // 查不到这一行：新建的会话按空白处理，复用的按有内容处理——
      // 宁可漏唤醒，也不要每次启动都让她说话。
      blank = freshOnly === true
    } else if (typeof row.blank === 'boolean') {
      blank = row.blank
    } else {
      // 宿主没给 blank 字段：只有刚建出来的一定是空的，复用的不碰
      blank = freshOnly === true
    }
  } catch (err) {
    log?.(`查会话状态失败（${String(err?.message ?? err).slice(0, 100)}），这次不唤醒`)
    return { woke: false, why: '查不到会话状态' }
  }
  if (!blank) return { woke: false, why: '' }
  if (typeof sc.prompt !== 'function') return { woke: false, why: '宿主没有 sessionController.prompt' }

  // 不能 await：这一轮要等模型跑完，屋子建好不该被它拖住。
  // ⚠️ 宿主签名是 prompt(options, signal)，signal 必填。漏了会报
  // "Cannot read properties of undefined (reading 'throwIfAborted')"，
  // 被下面的 catch 吞掉→日志里一句"新屋子唤醒失败"，用户只看到侧栏没有新会话。
  // 2026-10-26 与 work.js 的派活一起发现（say.js / scheduler.js 一直是传的）。
  const ac = new AbortController()
  const kill = setTimeout(() => ac.abort(), 20_000)
  kill.unref?.()
  void sc
    .prompt({
      requestId: `wake-fresh-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: WAKE_TRIGGER }],
    }, ac.signal)
    .catch((err) => log?.(`新屋子唤醒失败：${String(err?.message ?? err).slice(0, 140)}`))
    .finally(() => clearTimeout(kill))
  log?.('新屋子还是空的，叫了她一声（要等她这一轮动起来，侧栏才会显示）')
  return { woke: true, why: '' }
}

export async function bootstrapHome(ctx, { root = rootDir(), log, preset = '' } = {}) {
  // 启动先把上一次遗留的「提要生成中」占位清掉：
  // 进程如果是在摘要跑到一半时崩的，home.json 里会永远留着 handoffPending:true，
  // 下一条消息（包括 QQ 的闸门）就会白等一轮。这里清掉，并记下原因。
  try {
    const saved = (await readJson(homeFile(root), null)) ?? {}
    if (saved?.handoffPending === true) {
      await writeAtomic(
        homeFile(root),
        JSON.stringify({ ...saved, handoffPending: false, handoffError: '进程重启，交接中断' }, null, 2),
      )
      log?.('上次的交接提要被进程重启打断，占位已清掉')
    }
  } catch { /* 清不掉也不影响启动：等待方有超时兜底 */ }

  const ws = await ensureWorkspace(ctx, { root })
  if (!ws.ok) return { ok: false, why: ws.why, wsId: '', sessionId: '' }

  const ses = await ensureTalkSession(ctx, { root, wsId: ws.wsId, preset, log })
  if (!ses.ok) return { ok: false, why: ses.why, wsId: ws.wsId, sessionId: '' }

  // 唤醒**不放在这里**：talkSessionId 在屋子缺失时也会调 bootstrapHome，
  // 那样每次「第一次说话」都会多叫一次，她一轮被点两次火。只在明确的两个入口叫：
  // index.js 的启动、observe.js 的 POST /reset。
  log?.(`屋子就绪 · 工作区 ${ws.wsId} · 会话 ${ses.sessionId}${ses.reused ? '（复用）' : '（新建）'}${ses.preset ? ` · preset ${ses.preset}` : ''}`)
  return { ok: true, why: '', wsId: ws.wsId, sessionId: ses.sessionId, dir: ws.dir, reused: ses.reused, preset: ses.preset ?? '' }
}

/** 供观测台显示「她住在哪」 */
export async function homeStatus(root = rootDir()) {
  const saved = await readJson(homeFile(root), null)
  return {
    dir: join(paths(root).root, 'home'),
    wsId: saved?.wsId ?? '',
    sessionId: saved?.sessionId ?? '',
    createdAt: saved?.createdAt ?? null,
    turns: Number(saved?.turns ?? 0),
    rotatedAt: saved?.rotatedAt ?? null,
    preset: String(saved?.preset ?? ''),
  }
}

/**
 * 拿一个**挂在屋子里**的会话 id。拿不到就返回空串。
 *
 * 为什么不退而求其次用 `sc.create({ sessionId, cwd })` 现建一个：
 * 那种会话没有工作区归属，宿主侧栏会把它塞进「未分组」。2026-10-24 用户
 * 在 GUI 里看到一串 20 小时前的陌生对话，全是开发期用测试 home 跑出来的残留
 * ——她可以少醒一次，但不能在用户侧栏里堆别人的（她的）垃圾。
 *
 * 顺序：先按记下来的 wsId 复用；失效了就重建一次屋子再复用；还不行就交白卷，
 * 由调用方决定怎么说。**永不抛。**
 */
export async function talkSessionId(ctx, { root = rootDir(), log } = {}) {
  try {
    // 惰性 import，避免 home ↔ settings 的静态循环
    let preset = ''
    try {
      const { loadConfig } = await import('./settings.js')
      preset = String((await loadConfig(root))?.config?.tools?.preset ?? '')
    } catch { preset = '' }
    const { wsId } = await homeStatus(root)
    const first = await ensureTalkSession(ctx, { root, wsId, preset, log })
    if (first.ok) return first.sessionId

    const again = await bootstrapHome(ctx, { root, preset, log })
    if (again.ok) return again.sessionId
    log?.(`屋子没接上：${again.why}`)
    return ''
  } catch (err) {
    log?.(`屋子没接上：${String(err?.message ?? err).slice(0, 120)}`)
    return ''
  }
}

// ---------------------------------------------------------------------------
// 会话轮换（2026-10-23 加）
//
// 为什么必须换：一个侧栏会话聊到几百轮，上下文迟早撑爆——那时候不是"变慢"，
// 是每一轮都在为几十万字的历史付费，最后直接失败。换会话是唯一的解法。
//
// 换会话的两个代价，这个文件负责兜住：
//   1. 上一段的「我们说到哪」没了 → 用 talkmem 的原话搬运续上（不是摘要）。
//   2. 旧会话不能凭空消失 → 改名留档，它还在侧栏里，翻得回去。
// ---------------------------------------------------------------------------

/** 记一轮对话。任何失败都不影响对话本身，所以永不抛。 */
export async function bumpTurns(root = rootDir(), delta = 1) {
  try {
    const saved = (await readJson(homeFile(root), null)) ?? {}
    const turns = Math.max(0, Number(saved.turns ?? 0) + Number(delta || 0))
    await writeAtomic(homeFile(root), JSON.stringify({ ...saved, turns }, null, 2))
    return turns
  } catch {
    return 0
  }
}

/**
 * 换一个新会话：旧的改名留档，新的接管，原话搬过去。
 *
 * `handoff`（可选）是 30 轮压缩出来的《近期剧情提要》正文；它和 `carry`
 * （最近 4 轮原话）一起写进 home.json：
 *   - handoff 走系统提示段（fish:handoff，identity.js），是「系统级前缀」；
 *   - carry   留在身份文档末尾，是原话续接，提要失败时的唯一兜底。
 *
 * @returns {Promise<{ok:boolean, sessionId:string, old?:string, why?:string}>}
 */
export async function rotateTalkSession(
  ctx,
  { root = rootDir(), wsId, title = TITLE_SESSION, stamp, handoff = '', handoffSource = '', handoffPending = false } = {},
) {
  const sc = ctx.sessionController
  if (!sc?.create) return { ok: false, sessionId: '', why: '宿主没有会话服务' }

  const saved = (await readJson(homeFile(root), null)) ?? {}
  const wid = String(wsId ?? saved.wsId ?? '')
  if (!wid) return { ok: false, sessionId: '', why: '没有工作区 id' }

  const old = String(saved.sessionId ?? '')
  const when = stamp ?? new Date().toISOString().slice(0, 10)

  // 1) 旧会话改名留档。失败不影响后面（改不了名也还是那条会话）。
  if (old && typeof sc.rename === 'function') {
    await sc.rename({ sessionId: old, title: `${title}·${when} 之前` }).catch(() => {})
  }

  // 2) 建新的
  let sessionId = ''
  try {
    const created = await sc.create({ workspaceId: wid })
    sessionId = String(created?.sessionId ?? created?.id ?? '')
  } catch (err) {
    return { ok: false, sessionId: '', why: `建会话失败：${String(err?.message ?? err).slice(0, 160)}` }
  }
  if (!sessionId) return { ok: false, sessionId: '', why: '宿主建了会话但没给 id' }
  if (typeof sc.rename === 'function') await sc.rename({ sessionId, title }).catch(() => {})

  // 3) 原话搬运 + 提要
  const carry = renderCarry(await recentExchanges(root))
  try {
    await writeAtomic(
      homeFile(root),
      JSON.stringify(
        {
          wsId: wid,
          sessionId,
          createdAt: new Date().toISOString(),
          turns: 0,
          rotatedFrom: old,
          rotatedAt: new Date().toISOString(),
          carry,
          // 提要正文（未加外壳）；identity.js 用 activeHandoffBlock() 渲染成系统段。
          handoff: String(handoff ?? '').trim(),
          handoffSource: String(handoffSource ?? '').trim(),
          // 提要还在生成时先占位：下一条消息会等它（waitHandoffReady / qq 侧的
          // 轮询），这样新房间的第一轮一定带着提要，而不是「先换过去、提要晚到」。
          handoffPending: handoffPending === true,
        },
        null,
        2,
      ),
    )
  } catch {
    /* 记不下来也只影响下次换会话时的续接，不影响这次对话 */
  }
  return { ok: true, sessionId, old }
}

/**
 * 换会话后还要贴多久的「上次说到这」。
 * 太短：她还没来得及接上就没了；太长：那段话变成新的固定人设。
 * 三天或 8 轮，谁先到算谁。
 */
export const CARRY_DAYS = 3
export const CARRY_TURNS = 8

export async function activeCarry(root = rootDir(), now = Date.now()) {
  const saved = (await readJson(homeFile(root), null)) ?? {}
  const text = String(saved.carry ?? '').trim()
  if (!text) return ''
  const at = Date.parse(saved.rotatedAt ?? '')
  if (!Number.isFinite(at)) return ''
  if (Number(saved.turns ?? 0) >= CARRY_TURNS) return ''
  if (now - at > CARRY_DAYS * 86_400_000) return ''
  return text
}

/**
 * 轮换后那条《近期剧情提要》（未加外壳），过期了返回空串。
 *
 * 有效期与 carry 同一把尺：8 轮或 3 天，谁先到算谁。
 * 为什么不能一直贴：提要描述的是「刚搬完家」这个时刻，贴久了就变成新的固定人设。
 */
export async function activeHandoff(root = rootDir(), now = Date.now()) {
  const saved = (await readJson(homeFile(root), null)) ?? {}
  const text = String(saved.handoff ?? '').trim()
  if (!text) return ''
  const at = Date.parse(saved.rotatedAt ?? '')
  if (!Number.isFinite(at)) return ''
  if (Number(saved.turns ?? 0) >= CARRY_TURNS) return ''
  if (now - at > CARRY_DAYS * 86_400_000) return ''
  return text
}

/**
 * 给 system prompt 用的那一段（带 [系统：…] 外壳）。
 *
 * 它挂在 fish:handoff 段上（identity.js），每轮组装提示词时求值：
 * 换会话后新房间的前几轮都有它，过期自动消失。
 */
export async function activeHandoffBlock(root = rootDir(), now = Date.now()) {
  return renderHandoff(await activeHandoff(root, now))
}

/**
 * 同上的**同步**版本，给 system prompt 段用。
 *
 * 为什么必须同步：宿主的 `systemPrompt.section({ text })` 是同步求值
 * （见 identity.js 顶部的说明），返回 Promise 会被当成正文。home.json 只有
 * 几百字节，一次 readFileSync 的成本远小于让提要晚一轮生效。
 * 永不抛：读不到/坏了就返回空串（等于这一段不存在）。
 */
export function activeHandoffBlockSync(root = rootDir(), now = Date.now()) {
  try {
    const saved = JSON.parse(readFileSync(homeFile(root), 'utf8'))
    const text = String(saved?.handoff ?? '').trim()
    if (!text) return ''
    const at = Date.parse(saved?.rotatedAt ?? '')
    if (!Number.isFinite(at)) return ''
    if (Number(saved.turns ?? 0) >= CARRY_TURNS) return ''
    if (now - at > CARRY_DAYS * 86_400_000) return ''
    return renderHandoff(text)
  } catch {
    return ''
  }
}

/** 把这次的提要落一份可读副本（`<状态库>/home/handoff.md`），校验与排查用。 */
async function writeHandoffDoc(root, { text, source, turns, old, sessionId }) {
  if (!text) return ''
  const file = join(paths(root).root, 'home', 'handoff.md')
  const body = [
    '# 会话交接提要',
    '',
    `- 时间：${handoffStamp()}`,
    `- 轮换：${old || '（无）'} → ${sessionId || '（无）'}`,
    `- 压缩了多少轮：${turns ?? '?'}`,
    `- 来源：${source || 'unknown'}`,
    '',
    renderHandoff(text),
    '',
  ].join('\n')
  try {
    await writeAtomic(file, body)
    return file
  } catch {
    return ''
  }
}

// 同一个状态库同时只允许一次轮换：QQ 轮与 say 轮可能在同一拍上触发。
const rotating = new Set()

/**
 * 把提要写进 home.json 并放掉 `handoffPending` 占位。**幂等**，可被看门狗和主流程各调一次。
 *
 * 只在「home.json 还指着这次换出来的会话」时写：期间又换过一次的话，
 * 这条旧提要就是上上个房间的事，写进去会把新提要盖掉。
 */
async function finalizeHandoff(root, sessionId, { text, source, why }) {
  try {
    const saved = (await readJson(homeFile(root), null)) ?? {}
    if (String(saved.sessionId ?? '') !== String(sessionId ?? '')) return false
    await writeAtomic(
      homeFile(root),
      JSON.stringify(
        {
          ...saved,
          handoff: String(text ?? '').trim(),
          handoffSource: String(source ?? '').trim(),
          handoffPending: false,
          handoffError: String(why ?? '').slice(0, 200),
        },
        null,
        2,
      ),
    )
    return true
  } catch {
    return false
  }
}

/**
 * `handoffPending` 超过这么久就当成陈旧占位（进程崩溃 / 摘要卡死），不再等、并顺手清掉。
 * 正常路径上摘要 10 秒内一定结束（maybeRotate 有硬超时 + 看门狗），30 秒足够。
 */
// @doc fish.handoff
export const HANDOFF_PENDING_MAX_MS = 30_000

/**
 * 把 home.json 里陈旧的 `handoffPending` 清掉（同步读、异步写，永不抛）。
 * 为什么要在读的时候清：QQ 桥接和 say.js 是两条独立的等待链，谁先看到谁清，
 * 免得「一边放弃等待、另一边还在等」。
 */
async function clearStaleHandoff(root, saved) {
  if (!saved?.handoffPending) return
  try {
    await writeAtomic(
      homeFile(root),
      JSON.stringify({ ...saved, handoffPending: false, handoffError: '陈旧占位，已强制放行' }, null, 2),
    )
  } catch { /* 写不进去也不影响本次放行 */ }
}

/**
 * 等交接提要做好（或确认等不到）。
 *
 * 谁要等：换房之后第一条进新会话的消息。等到之后再 prompt，她的 system prompt
 * 里就已经有 `fish:handoff` 段了。
 *
 * 硬规则（2026-11-03）：
 *   - 最多等 12 秒（摘要在 10 秒内一定有结果，或者被看门狗强制放掉）；
 *   - 超过 30 秒的占位视为陈旧：**立即放行，并把它写回 false**；
 *   - 永不抛，任何异常都按「不等」处理。
 *
 * @returns {Promise<boolean>} true = 可以继续（有提要 / 不需要 / 等超时）
 */
// @doc fish.handoff
export async function waitHandoffReady(root = rootDir(), { sessionId = '', timeoutMs = 12_000, pollMs = 200 } = {}) {
  const file = homeFile(root)
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  for (;;) {
    let saved = null
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return true // 读不到 home.json：没有占位可等
    }
    if (!saved?.handoffPending) return true
    if (sessionId && String(saved.sessionId ?? '') !== String(sessionId)) return true
    const at = Date.parse(saved.rotatedAt ?? '')
    if (Number.isFinite(at) && Date.now() - at > HANDOFF_PENDING_MAX_MS) {
      await clearStaleHandoff(root, saved)
      return true
    }
    if (Date.now() >= deadline) return true // 到点就放行：绝不拿她的回复去等摘要
    // 不 unref：这个定时器是等待链唯一的句柄，unref 会让事件循环空转结束、
    // 等待中的 Promise 永远等不到 resolve（与本文件里 waitTurnEnd 的坑同一个）。
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, Number(pollMs) || 200)))
  }
}

/**
 * 「满了就换」的唯一入口（2026-11-02）。
 *
 * 为什么要有这个函数、而不是在两个调用点各写一遍：原来的轮换写在 say.js 里，
 * 只有「设置页 / 桌宠输入」那条链路会调它；QQ 桥接直接 agent.followup，
 * 于是**在 QQ 里聊一百轮，turns 永远是 0，永远不会换**。现在：
 *   - say.js 每轮 bump 一次然后调它；
 *   - rotation.js 在 QQ 轮结束时 bump 一次然后调它；
 *   - 计数、判定、摘要、轮换、刷新身份，全部收在这一个函数里
 *     （新会话的「叫醒」默认关，见下面第 4 步的说明）。
 *
 * 顺序是刻意的：**先换房、再摘要**，中间用 `handoffPending` 占位。
 *   - 换房是毫秒级的，所以下一句 QQ 消息立刻路由到新会话；
 *   - 新会话的第一条消息会 `waitHandoffReady()` 等提要落盘（上限 12 秒），
 *     所以「换得快」和「第一轮就带着提要」不冲突。
 *
 * 摘要失败不算失败：放掉占位、退回 talkmem 的最近 4 轮原话（carry），轮换照做。
 *
 * @returns {Promise<{rotated:boolean, reason?:string, sessionId?:string, old?:string,
 *   turns?:number, after?:number, handoff?:boolean, handoffSource?:string, handoffWhy?:string}>}
 */
// @doc fish.handoff
export async function maybeRotate(ctx, { root = rootDir(), title = TITLE_SESSION, log, wake = false, wakeDelayMs = 6_000 } = {}) {
  const sc = ctx?.sessionController
  if (!sc?.create) return { rotated: false, reason: 'no-session-service' }
  if (rotating.has(root)) return { rotated: false, reason: 'busy' }

  rotating.add(root)
  try {
    let config = {}
    try { config = (await loadConfig(root)).config ?? {} } catch { config = {} }
    const after = Number(config?.chat?.rotateAfter ?? 0)
    if (!(after > 0)) return { rotated: false, reason: 'off', after: 0 }

    const saved = (await readJson(homeFile(root), null)) ?? {}
    const turns = Number(saved.turns ?? 0)
    if (turns < after) return { rotated: false, reason: 'below', turns, after }

    // ---- 1) 先换房（毫秒级）----
    // 为什么先换再摘要：摘要要几秒到几十秒（取决于打工模型）。如果等摘要才换，
    // 这期间的 QQ 消息还落在旧房间，「第 4 句」就不是新房间说的了。
    // 现在的做法：立刻换房 + 在 home.json 写 `handoffPending: true` 占位；
    // 下一条消息进新会话之前会等提要（waitHandoffReady / qq 侧轮询），
    // 所以「新房间的第一轮一定带着提要」和「换房不慢」两件事同时成立。
    const wantsHandoff = config?.chat?.handoff?.enabled !== false
    const rot = await rotateTalkSession(ctx, {
      root,
      wsId: saved.wsId,
      title,
      handoff: '',
      handoffSource: '',
      handoffPending: wantsHandoff,
    })
    if (!rot.ok) {
      log?.(`[dsh-fish] 换会话失败：${rot.why ?? 'unknown'}`)
      return { rotated: false, reason: 'failed', why: rot.why, turns, after }
    }

    // ---- 2) 生成提要 ----
    // 硬规则（2026-11-03，任务书）：摘要最多 10 秒；失败/超时/空一律用最近 4 轮
    // 原话兜底；**无论如何** handoffPending 都要被放掉。所以这里有三层保险：
    //   ① generateHandoff 自己 10 秒硬超时（handoff.js）；
    //   ② 外面再套一层 10.5 秒的 Promise.race，防止上游 await 卡住；
    //   ③ 一个 14 秒的看门狗定时器——哪怕本函数被别的东西堵住，它也会把占位写成 false。
    let handoff = ''
    let handoffSource = ''
    let handoffWhy = ''
    if (wantsHandoff) {
      let turnsForFallback = []
      try {
        turnsForFallback = await collectRecentTurns(root, config?.chat?.handoff?.turns ?? 30)
      } catch { turnsForFallback = [] }

      const fallback = () => fallbackHandoffText(turnsForFallback, config?.chat?.handoff?.maxChars)

      const watchdog = setTimeout(() => {
        // 只在「占位还挂着、而且还是这次换出来的会话」时兜底写。
        // 这样它跟主流程抢写也不会覆盖已经落盘的真提要；finalizeHandoff 本身也幂等。
        void (async () => {
          try {
            const cur = JSON.parse(readFileSync(homeFile(root), 'utf8'))
            if (String(cur?.sessionId ?? '') !== String(rot.sessionId)) return
            if (cur?.handoffPending !== true) return
            await finalizeHandoff(root, rot.sessionId, {
              text: fallback(),
              source: 'fallback:timeout',
              why: `看门狗强制放行（摘要超过 ${Math.round(HANDOFF_TIMEOUT_MS / 1000)} 秒）`,
            })
          } catch { /* 看门狗自己失败也不许影响任何东西 */ }
        })()
      }, HANDOFF_TIMEOUT_MS + 4_000)
      watchdog.unref?.()

      try {
        const summary = await Promise.race([
          generateHandoff(root, {
            ctx,
            log,
            turns: config?.chat?.handoff?.turns,
            maxChars: config?.chat?.handoff?.maxChars,
            timeoutMs: HANDOFF_TIMEOUT_MS,
          }),
          new Promise((resolve) => {
            const t = setTimeout(
              () => resolve({ ok: false, text: '', why: `硬超时（${Math.round(HANDOFF_TIMEOUT_MS / 1000)} 秒）` }),
              HANDOFF_TIMEOUT_MS + 500,
            )
            t.unref?.()
          }),
        ])
        if (summary?.ok) {
          handoff = summary.text
          handoffSource = summary.source ? String(summary.source) : `model:${summary.model ?? '?'}`
        } else {
          handoffWhy = summary?.why ?? 'unknown'
        }
      } catch (err) {
        handoffWhy = String(err?.message ?? err).slice(0, 160)
      } finally {
        // 兜底：模型没给（或超时/报错）→ 最近 4 轮原话。哪怕一条原话都没有，
        // fallbackHandoffText 也会明说「记忆交接失败」——绝不让提要空着。
        if (!handoff) {
          handoff = fallback()
          handoffSource = handoff === FAILED_HANDOFF_TEXT ? 'fallback:failed' : 'fallback:recent'
        }
        // 顺序：先留可读副本，**最后**才放掉占位。
        // 放掉占位 = 让等待方立刻去组装提示词，所以它必须是最后一步；
        // 反过来的话，测试与真机都可能看到「pending 已经 false，但 handoff.md 还没写」。
        await writeHandoffDoc(root, { text: handoff, source: handoffSource, turns, old: rot.old, sessionId: rot.sessionId })
        // 换过一次就不要再覆盖：用户可能已经又聊满了。
        await finalizeHandoff(root, rot.sessionId, { text: handoff, source: handoffSource, why: handoffWhy })
        // 看门狗放在最后清：上面任何一次写盘卡住，它仍然会兜底放行。
        clearTimeout(watchdog)
      }
      if (handoffWhy) log?.(`[dsh-fish] 交接提要没生成（${handoffWhy}），用最近 4 轮原话兜底`)
    }

    // ---- 3) 身份文档重写：新会话组装提示词时读到带 handoff 的版本 ----
    // 惰性 import：selfdoc ↔ home 是双向引用（selfdoc 读 activeCarry），静态 import 会成环。
    try {
      const { refreshSelfDoc } = await import('./selfdoc.js')
      await refreshSelfDoc(root, { log })
    } catch { /* 身份文档写不出来只影响这一轮的提要，不影响会话本身 */ }

    log?.(
      `[dsh-fish] 会话轮换：${rot.old || '（无）'} → ${rot.sessionId}（聊满 ${turns} 轮；` +
        `提要=${handoff ? handoffSource : `无，退回原话${handoffWhy ? `（${handoffWhy}）` : ''}`}）`,
    )

    // ---- 4) 新房间不是空壳（可选，默认关）----
    // 宿主只在「空白且是当前会话」时显示会话；刚建出来的新会话在侧栏里是隐形的，
    // 所以有人会想叫一声让她先开口。但这一步**默认关**（2026-11-02 定）：
    //   - 她刚换房时 QQ 对话往往还在继续；这一轮「叫醒」会占住会话，
    //     紧接着到达的 QQ 消息会被 steer 进这一轮 → 桥接按「不是 QQ 起的轮」
    //     把回复丢掉（qq/index.js 的 fromQQ 在 turn/start 快照）。
    //   - 提要已经是系统级提示了，不需要再用一轮模型调用去「告诉她」。
    // 下一条真实消息会自然把新房间带进侧栏。要开就由调用方显式传 wake:true。
    if (wake && typeof sc.list === 'function') {
      const t = setTimeout(() => {
        wakeIfBlank(ctx, { sessionId: rot.sessionId, log, freshOnly: true }).catch(() => {})
      }, Math.max(0, Number(wakeDelayMs) || 0))
      t.unref?.()
    }

    return {
      rotated: true,
      sessionId: rot.sessionId,
      old: rot.old,
      turns,
      after,
      handoff: Boolean(handoff),
      handoffSource: handoff ? handoffSource : '',
      handoffWhy,
    }
  } finally {
    rotating.delete(root)
  }
}

