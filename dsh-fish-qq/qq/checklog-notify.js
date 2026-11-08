/**
 * checklog-notify.js —— 任务完成日志 · 通知核心与文案（任务书 3 + 5，2026-10-28）
 *
 * 做什么：任务做完了（fish 侧会在 CheckLogs/ 里写一条日志），按设置决定要不要
 * 通知、发给谁、说什么，然后发出一条 QQ 私聊，并记计数 / outbox / 台账。
 *
 * 刻意**不做**的事（任务书之间的边界，别越）：
 *   - 不接触发：本模块不监听任何 turn/end。接线在任务书 4：qq/index.js 的 apply()
 *     里 `ctx.on('checklog/finished', ...)` 接住 fish 侧（日志写成后 emit）的事件
 *     再调本模块。这里只保证「调它就能发」。
 *   - 不投会话：agent 档（`mode='agent'`）要把处境投到她那条会话、让她自己说，
 *     需要 agents 服务 / followup / 会话事件，那套宿主能力在 qq/index.js 里
 *     （`deliverChecklogAgentSituation`）；本文件只提供它要用的纯函数
 *     （`buildChecklogSituationText` / `buildChecklogNotifyText`）与发出口。
 *
 * 两档通道（任务书 5 统一）：
 *   - system 档：`notifyTaskFinished(result)` —— 门禁 → 目标 → 模板 → 发。
 *   - agent 档：index.js 先用 `gateChecklog` 问该不该说 → followup 投处境 →
 *     她那一轮结束，index.js 抽出她写的话（没写就退回模板）交给 `sendChecklogNotice`。
 *     **两档共用同一道门禁、同一个计数段、同一个发出口**，区别只在「谁写这句话」。
 *
 * 为什么是独立文件 + 依赖注入：任务书 3 要求「纯单元可测」。本模块不 import
 * index.js 的任何符号（设置的归一化在 readSettings 里已经做完，dayKeyOf 由
 * 构造方注入），所以测试时不需要起宿主、不需要假 ctx —— 给一份 deps 就能跑。
 *
 * 与既有出站通道的关系：与主动私聊 / subsend 同级 —— 直调 OneBot `send_private_msg`，
 * 不经 replyMode 的 marker/tool 闸门（系统通知不是「回复」，没有写 [QQ] 块这种用法）。
 *
 * 口径（与 subsend / proactive 对齐，改一处别忘了另两处）：
 *   - 失败 / 超时**必发**；成功只在 checklogNotifyOnSuccess 打开时发（成功是本分）。
 *   - 只有真的发出去才计数；被拒（含限流、失败）**不占额度**、不落 outbox。
 *   - 超上限 → 不发，且在台账里记一行「被限流」。
 *   - 被拒不进 outbox：outbox 的语义是「真的发到 QQ 了」，被拒进去了就是假账。
 *   - 系统通知**不算「往来」**：不动 state.proactive.lastActivityAt ——
 *     否则每完成一个任务都把空闲计时清零，主动私聊就永远等不到「她好久没说话」。
 */

// ── 纯函数 ──────────────────────────────────────────────────────────────────

/**
 * 这一次任务完成，该不该发通知。纯函数，便于复现。
 *
 * 判据（按顺序短路，先问「要不要」再问「还有没有额度」）：
 *   1. mode 不是 'system' 也不是 'agent' → 不发（'off' 是关；别的归一化后不存在）
 *      —— system 与 agent **共用这一道门禁**（任务书 5），两档只差「谁写这句话」；
 *   2. 任务成功且 notifyOnSuccess 未开 → 不发（成功是本分，不打断人）；
 *   3. dailyLimit <= 0 → 不发（用户明确说一条都别发）；
 *   4. 跨天作废后 used >= dailyLimit → 不发（超上限）。
 *
 * @returns {{send: boolean, reason: string, used: number}}
 *   `used` 是**跨天作废后**的当日已用条数 —— 调用方据此 +1，
 *   不用自己再算一遍跨天（各算一遍就会漏掉另一处）。
 */
export function shouldNotifyChecklog({
  mode = 'off',
  notifyOnSuccess = false,
  ok = false,
  dailyLimit = 5,
  dayKey = '',
  todayKey = '',
  usedCount = 0,
} = {}) {
  if (mode !== 'system' && mode !== 'agent') return { send: false, reason: 'mode-off', used: 0 }
  // ok 缺省按**失败**处理（fail-safe：信息不全时宁可多说一句，也别把坏事吞掉）
  if (ok === true && notifyOnSuccess !== true) return { send: false, reason: 'success-muted', used: 0 }
  const limit = Math.max(0, Math.round(Number(dailyLimit) || 0))
  if (limit <= 0) return { send: false, reason: 'limit-zero', used: 0 }
  // 跨天：昨天的计数不算数
  const used = dayKey === todayKey ? Math.max(0, Math.round(Number(usedCount) || 0)) : 0
  if (used >= limit) return { send: false, reason: 'daily-limit', used }
  return { send: true, reason: 'ok', used }
}

/**
 * 把 checklogNotifyTarget 解析成**要发给谁**。纯函数。
 *
 * - 'owner'：主人（ownerQQ）。主人没配 → 谁都发不了（fail-closed，返回空目标）。
 * - 'last'：最近一次有往来的人。只有**私聊**目的地能走 send_private_msg；
 *   最近是群（或还没有任何目的地）→ **回落到主人**：宁可换个收件人，
 *   也不能把「这件事该让她知道」整个吞掉。回落在返回值里标出来，调用方据实记账。
 *
 * @returns {{targetQQ: string, via: 'owner' | 'last' | 'last-fallback-owner' | 'no-target', fallback?: boolean}}
 *   targetQQ 为空 = 没人可发，调用方应安静退出并记一行。
 */
export function resolveNotifyTarget({ target = 'owner', ownerQQ = '', lastDestination = null } = {}) {
  const owner = String(ownerQQ ?? '').trim()
  if (target === 'last') {
    const last = lastDestination && typeof lastDestination === 'object' ? lastDestination : null
    // 最近目的地里的 userId 都是入站消息自带的 QQ 号（数字串），只认数字形状
    if (last?.kind === 'private' && /^\d+$/.test(String(last.userId ?? '').trim())) {
      return { targetQQ: String(last.userId).trim(), via: 'last' }
    }
    if (owner !== '') return { targetQQ: owner, via: 'last-fallback-owner', fallback: true }
    return { targetQQ: '', via: 'no-target' }
  }
  return owner !== '' ? { targetQQ: owner, via: 'owner' } : { targetQQ: '', via: 'no-target' }
}

/** 耗时说人话：「3 分 12 秒」/「45 秒」/「<1 秒」（任务书 5 模板的口径）。 */
function formatElapsed(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '<1 秒'
  if (n < 1000) return '<1 秒'
  if (n < 60_000) return `${Math.round(n / 100) / 10} 秒`
  const m = Math.floor(n / 60_000)
  const s = Math.round((n % 60_000) / 1000)
  return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`
}

/** 把任务正文压成一行再封顶：处境要投进她的上下文，4000 字的任务名会把她淹了。 */
function oneLineTask(r, cap = 200) {
  const t = String(r?.task ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return '（没写任务名）'
  if (t.length <= cap) return t
  return `${t.slice(0, cap - 1)}…`
}

/**
 * 通知的主语：优先会话标题（fish 侧 workTitle，「工作·写hello.py」那种），
 * 没有就拿任务名顶上，再没有就叫「未命名任务」。
 */
function subjectOf(r) {
  const title = String(r?.sessionTitle ?? '').trim()
  if (title) return title
  const task = String(r?.task ?? '').replace(/\s+/g, ' ').trim()
  return task || '未命名任务'
}

/**
 * 失败时「原因」那一格：取 fish 侧 `describeTurnEnd` 中文状态**括号里那一句**
 * （`失败（出错）` → `出错`；`中止（被取消）` → `被取消`）。
 * status 是 fish 写日志时就算好的字段（不重复计算），缺了一档兜底「未知原因」。
 */
function failCauseText(r) {
  const status = String(r?.status ?? '')
  const hit = /（([^（）]+)）/.exec(status)
  if (hit?.[1]) return hit[1]
  return '未知原因'
}

/** 结果的一句话：完成了 / 超时了 / 失败了：<原因>。模板与处境共用同一份说法。 */
export function outcomeOf(r) {
  if (r?.ok === true) return '完成了'
  if (String(r?.reason ?? '') === 'timeout') return '超时了'
  return `失败了：${failCauseText(r)}`
}

/** 耗时：elapsedMs 优先，缺了用 endedAt-startedAt 现算。 */
function durationOf(r) {
  const ms = Number(r?.elapsedMs) || (Number(r?.endedAt) - Number(r?.startedAt)) || 0
  return formatElapsed(ms)
}

/**
 * system 档的正式模板（任务书 5）。三行，中文、口语、纯文本：
 *
 *   [任务通知] 工作·写hello.py 完成了（耗时 3 分 12 秒）。
 *   [任务通知] 工作·写hello.py 失败了：出错（耗时 3 分 12 秒）。
 *   [任务通知] 工作·写hello.py 超时了（等了两小时还没结束）。
 *
 * 「两小时」与 fish 侧 `TASK_LOG_TIMEOUT_MS` 对齐（那是 watcher 记「超时」的宽限），
 * 模板里按人话说死，不在运行时算（说「7200000 毫秒」没人看得懂）。
 *
 * `result` 契约与 fish 侧 `buildTaskResult` 对齐：
 * { ok, reason, task, sessionTitle, sessionId, status, startedAt, endedAt, elapsedMs, file }
 * （`status` = describeTurnEnd 的中文状态，失败原因从它的括号里取；全是既有字段。）
 */
export function buildChecklogNotifyText(result = {}) {
  const r = result ?? {}
  const subject = subjectOf(r)
  if (r.ok === true) return `[任务通知] ${subject} 完成了（耗时 ${durationOf(r)}）。`
  if (String(r.reason ?? '') === 'timeout') return `[任务通知] ${subject} 超时了（等了两小时还没结束）。`
  return `[任务通知] ${subject} 失败了：${failCauseText(r)}（耗时 ${durationOf(r)}）。`
}

/**
 * agent 档投给她的「处境」（任务书 5）。一句话，让她知道发生了什么、要做什么：
 *
 *   你刚派出去的活儿有结果了：任务=写个 hello.py，结果=失败了：出错，耗时=1分30秒。
 *   用一句话跟主人说一声。
 *
 * 结果与耗时与 system 模板**同一份说法**（outcomeOf / durationOf），两条通道不吵架。
 */
export function buildChecklogSituationText(result = {}) {
  const r = result ?? {}
  return `你刚派出去的活儿有结果了：任务=${oneLineTask(r)}，结果=${outcomeOf(r)}，耗时=${durationOf(r)}。用一句话跟主人说一声。`
}

// ── 工厂：把宿主能力注进来，返回两档通道共用的发出口 ─────────────────────────

/**
 * 造一个 notifier。接线（谁来调、什么时候调）在任务书 4；agent 档投会话那部分
 * 在 qq/index.js（任务书 5），但**发出口在这里**——两档共用同一个。
 *
 * @param {object} deps
 * @param {() => object} deps.readSettings
 *   已归一化的生效设置（任务书 1 的 readSettings()：mode/target/limit 等都已过归一化）。
 * @param {object} deps.state
 *   宿主的 state 对象：读 `state.lastDestination`，读写 `state.checklogNotify`。
 * @param {() => void} deps.saveState 计数变了之后落盘。
 * @param {(entry: object) => void} deps.pushLog 唤醒台账（记限流 / 无目标 / 发送结果）。
 * @param {(entry: object) => void} deps.recordOutbox 「真的发到 QQ 了」的出站台账。
 * @param {(userId: string, segments: object[]) => Promise<void>} deps.sendPrivateMsg
 *   发送动作，**抛错 = 发送失败**。生产实现：
 *   `(userId, segments) => transport.call('send_private_msg', { user_id: userId, message: segments })`
 * @param {(ts: number) => string} deps.dayKeyOf
 *   本地日期键（'YYYY-MM-DD'）。**注入而非在本文件重写** —— 与 index.js /
 *   dsh-fish 的 dayKeyOf 必须始终是同一条规则，各写一遍迟早分叉。
 * @param {() => number} [deps.now] 时间注入（测试用），默认 Date.now。
 * @param {() => boolean} [deps.isTransportOpen] 传输是否在线，默认 () => true。
 * @param {(s: string) => string} [deps.stripMarkdown] 去 Markdown，默认原样返回。
 * @returns {{
 *   gateChecklog: (result: object) => object,
 *   sendChecklogNotice: (result: object, text?: string) => Promise<object>,
 *   notifyTaskFinished: (result: object) => Promise<object>,
 * }}
 */
export function createChecklogNotifier(deps) {
  const {
    readSettings,
    state,
    saveState,
    pushLog,
    recordOutbox,
    sendPrivateMsg,
    dayKeyOf,
    now = Date.now,
    isTransportOpen = () => true,
    stripMarkdown = (s) => s,
  } = deps ?? {}

  // 缺依赖就在**构造时**大喊，不要等到半夜发通知时才 undefined
  const required = { readSettings, saveState, pushLog, recordOutbox, sendPrivateMsg, dayKeyOf }
  const absent = Object.entries(required)
    .filter(([, v]) => typeof v !== 'function')
    .map(([k]) => k)
  if (!state || typeof state !== 'object') absent.push('state')
  if (absent.length > 0) {
    throw new Error(`createChecklogNotifier: 缺少必需依赖：${absent.join(', ')}（逐项说明见文件头注释）`)
  }

  /** 算这一次的门禁，并把「该发但被限流」记进台账（其余安静退路不记，免得刷屏）。 */
  function gateChecklog(result = {}) {
    const s = readSettings() ?? {}
    const ns = state.checklogNotify ?? { dayKey: '', count: 0, lastAt: 0 }
    const gate = shouldNotifyChecklog({
      mode: s.checklogNotifyMode,
      notifyOnSuccess: s.checklogNotifyOnSuccess,
      ok: result?.ok === true,
      dailyLimit: s.checklogNotifyDailyLimit,
      dayKey: ns.dayKey,
      todayKey: dayKeyOf(now()),
      usedCount: ns.count,
    })
    if (!gate.send && gate.reason === 'daily-limit') {
      pushLog({
        kind: 'checklog',
        action: 'rate-limited',
        used: gate.used,
        limit: Math.max(0, Math.round(Number(s.checklogNotifyDailyLimit) || 0)),
      })
    }
    return gate
  }

  /**
   * **发出口**（两档共用）：门禁 → 目标 → 正文 → 发 → 计数 / outbox / 台账。
   *
   * agent 档从 `assistant/message` 抽出她写的话后调这里（`text` = 她的话）；
   * system 档不传 `text`，自己套模板。两档的限流与记账因此是同一套。
   *
   * @param {object} result fish 侧的结果（用于门禁与台账）
   * @param {string} [text] 要发的正文；不传 = 用 system 模板现拼
   * @returns {Promise<object>}
   *   发成功：`{ ok: true, sent: 1, to, text, todayCount }`
   *   没发（各有原因，**全部不抛错**）：`{ ok: false, dropped: true, reason, ... }`
   *   —— `dropped` 与 subsend 同口径：没占额度、不落 outbox。
   */
  async function sendChecklogNotice(result = {}, text) {
    const s = readSettings() ?? {}
    const at = now()
    const today = dayKeyOf(at)

    const gate = gateChecklog(result)
    if (!gate.send) return { ok: false, dropped: true, reason: gate.reason, used: gate.used }

    const resolved = resolveNotifyTarget({
      target: s.checklogNotifyTarget,
      ownerQQ: s.ownerQQ,
      lastDestination: state.lastDestination,
    })
    if (resolved.targetQQ === '') {
      // 配了通知却没人可发 = 配置问题，值得留一条以便排查
      pushLog({ kind: 'checklog', action: 'no-target', reason: resolved.via })
      return { ok: false, dropped: true, reason: 'no-target', via: resolved.via }
    }
    // 防自环（与 subsend / file* 同一道闸门）
    const selfId = String(s.selfId ?? '').trim()
    if (selfId !== '' && resolved.targetQQ === selfId) {
      return { ok: false, dropped: true, reason: 'self-target' }
    }
    if (!isTransportOpen()) {
      pushLog({ kind: 'checklog', action: 'not-connected' })
      return { ok: false, dropped: true, reason: 'not-connected' }
    }

    // 正文：agent 档转发她写的话，不然套 system 模板。系统通知没有「改短重发」的机会 →
    // 超长**截断**而非丢弃（与主动私聊同口径：宁可少半句，也不是一个字都没有）。
    let body = String(text ?? '').trim() !== '' ? String(text) : buildChecklogNotifyText(result)
    if (s.stripMarkdown !== false) body = stripMarkdown(body)
    body = String(body ?? '').trim()
    if (body === '') return { ok: false, dropped: true, reason: 'empty' }
    const limit = Math.max(100, Number(s.replyMaxChars ?? 1500))
    const chars = [...body]
    if (chars.length > limit) body = `${chars.slice(0, limit - 1).join('')}…`

    try {
      await sendPrivateMsg(resolved.targetQQ, [{ type: 'text', data: { text: body } }])
    } catch (error) {
      const reason = String(error?.message ?? error)
      pushLog({ kind: 'checklog', action: 'send-failed', to: `private:${resolved.targetQQ}`, error: reason })
      return { ok: false, dropped: true, reason: 'send-failed', error: reason }
    }

    // 只有真的发出去才计数 + 落 outbox（与 subsend 同口径）
    const todayCount = gate.used + 1
    state.checklogNotify = { dayKey: today, count: todayCount, lastAt: at }
    saveState()
    recordOutbox({
      sessionId: String(result?.sessionId ?? ''),
      via: 'checklog',
      action: 'notify',
      endReason: String(result?.reason ?? (result?.ok === true ? 'completed' : 'failed')),
      to: { kind: 'private', userId: resolved.targetQQ },
      text: body,
      // 转发她说的话 vs 插件模板：台账里标出来，事后查「这条是谁写的」不用猜
      spokenBy: text && String(text).trim() !== '' ? 'agent' : 'template',
    })
    pushLog({
      kind: 'checklog',
      action: 'sent',
      to: `private:${resolved.targetQQ}`,
      fallback: resolved.fallback === true,
      todayCount,
      spokenBy: text && String(text).trim() !== '' ? 'agent' : 'template',
    })
    return {
      ok: true,
      sent: 1,
      dropped: false,
      to: { kind: 'private', userId: resolved.targetQQ },
      text: body,
      todayCount,
    }
  }

  /**
   * system 档完整流程（任务书 3）：任务日志写完 → 接线调这个 → 按设置发模板。
   *
   * agent 档**不走这里**：它由 qq/index.js 的 `deliverChecklogAgentSituation`
   * 投会话、抽她说的话、最后调 `sendChecklogNotice` 发出。
   *
   * @returns {Promise<object>}
   *   发成功：`{ ok: true, sent: 1, to, text, todayCount }`
   *   没发（各有原因，**全部不抛错**）：`{ ok: false, dropped: true, reason, ... }`
   */
  async function notifyTaskFinished(result = {}) {
    const mode = readSettings()?.checklogNotifyMode
    // agent 档是另一条通道（index.js 接管）；off / 坏值 = 什么都不说
    if (mode !== 'system') {
      return { ok: false, dropped: true, reason: mode === 'agent' ? 'mode-agent' : 'mode-off', used: 0 }
    }
    return sendChecklogNotice(result)
  }

  return { gateChecklog, sendChecklogNotice, notifyTaskFinished }
}
