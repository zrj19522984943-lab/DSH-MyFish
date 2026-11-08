/**
 * test-checklog-notify.mjs —— 任务完成日志 · 通知核心与文案（任务书 3 + 5，2026-10-28）
 *
 * 验收清单（任务书 3 的三条）：
 *   1. 手动调函数能发出一条 QQ 消息 —— 第二部分用注入的 sendPrivateMsg 断言，
 *      第三部分更进一步：接到**真实**的 OneBot 传输（假 WS），断言真的发出了
 *      `send_private_msg` 那一帧。
 *   2. 超上限后不再发 —— 预置 state 计数到上限，调用 → 不发、reason=daily-limit、
 *      台账记「被限流」、计数不涨。
 *   3. outbox 里能看到这条 —— 成功发送后 outbox 有一条 via='checklog' 的记录。
 *
 * 任务书 5 追加（system 档正式模板 / agent 档共用门禁与发出口）：
 *   - 三行模板的形状（完成 / 失败带原因 / 超时固定那句）；失败原因取自 status 括号
 *   - agent 档的「处境」一句话的形状（任务=…，结果=…，耗时=…）
 *   - 门禁对两档一致（agent 不再被门禁挡，通道分流在 index.js）
 *   - sendChecklogNotice(text) 转发「她说的话」也照常计数、落 outbox（spokenBy=agent）
 *
 * 边界（任务书之间，本测试也要盯住）：
 *   - mode='off' 不发；mode='agent' 不走 notifyTaskFinished（那是 index.js 的通道）
 *   - 成功只在 checklogNotifyOnSuccess 打开时发；失败/超时必发
 *   - 被拒（限流 / 发送失败）**不占额度**、不落 outbox
 *   - 'last' 目标最近是群时回落到主人，且据实记账
 *   - 不接 CheckLogs：本测试不监听任何 turn/end，只直接调通知核心
 *
 * 任务书 7 的七条场景由三个套件分摊（各自在自己最该钉的地方钉）：
 *   ① off 档不发 ………………………… 本测试「边界」段
 *   ② system 成功 + onSuccess=false 不发 … test-checklog-wire.mjs 验收 2
 *   ③ system 失败：发 + outbox +1 ………… 本测试「验收1/3」+ wire 验收 1
 *   ④ 超 dailyLimit：不发、台账「被限流」… 本测试「验收2」
 *   ⑤ agent 档：mock assistant/message → 发她的话 … test-checklog-agent.mjs 验收 1
 *   ⑥ agent 档她没生成文本 → 退回 system 模板 … test-checklog-agent.mjs 兜底段
 *   ⑦ 新进程 + 旧 CheckLogs 文件 → 不发 … test-checklog-wire.mjs「边界（任务书 7 钉死）」
 *   （钉死「只由本进程的 turn/end 点燃、不扫旧目录补发」）
 *
 * 跑法：node test-checklog-notify.mjs（和其它 test-*.mjs 一样是脚本式断言）
 */

// ── 假 WebSocket：让 OneBot 传输真的“连上”并捕获出站帧 ─────────────────────
const wsSent = []
class FakeWS {
  constructor(url) {
    this.url = url
    this.readyState = 0
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 0)
  }
  send(data) {
    let frame
    try {
      frame = JSON.parse(String(data))
    } catch {
      return
    }
    wsSent.push(frame)
    setTimeout(() => {
      this.onmessage?.({ data: JSON.stringify({ echo: frame.echo, status: 'ok', retcode: 0, data: {} }) })
    }, 0)
  }
  close() {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: 'test' })
  }
}
globalThis.WebSocket = FakeWS

const { createOneBotTransport } = await import('./onebot.js')
const { dayKeyOf } = await import('./index.js')
const {
  shouldNotifyChecklog,
  resolveNotifyTarget,
  buildChecklogNotifyText,
  buildChecklogSituationText,
  outcomeOf,
  createChecklogNotifier,
} = await import('./checklog-notify.js')

// ── 断言器 ────────────────────────────────────────────────────────────────
let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 固定「现在」：12:00 本地时间，怎么换时区都是这一天；
// dayKeyOf 与 index.js 是同一条规则（从那注入，不在这里重写）。
const NOW = new Date('2026-10-28T12:00:00').getTime()
const TODAY = dayKeyOf(NOW)
const YESTERDAY = '2026-10-27'

/** 一条失败任务的结果（契约对齐 fish 侧 buildTaskResult ）。 */
const failedTask = {
  ok: false,
  reason: 'error',
  task: '在 workspace 里写一个 hello.py',
  sessionTitle: '工作·hello.py',
  sessionId: 'session-task-1',
  status: '失败（出错）',
  startedAt: NOW - 90_000,
  endedAt: NOW,
  elapsedMs: 90_000,
}
const successTask = { ...failedTask, ok: true, reason: 'completed', status: '成功' }
const timeoutTask = { ...failedTask, reason: 'timeout', status: '超时（没等到这一轮结束）' }

// ══════════════════════════════════════════════════════════════════════════
// 第一部分：纯函数
// ══════════════════════════════════════════════════════════════════════════
{
  const g = (patch) => shouldNotifyChecklog({ todayKey: TODAY, ...patch })

  check('门禁：mode=off → 不发', g({ mode: 'off', ok: false }).send === false)
  check('门禁：mode=off 的 reason 点名 mode-off', g({ mode: 'off', ok: false }).reason === 'mode-off')
  // 任务书 5：agent 与 system 共用同一道门禁（频率闸同任务书 3），通道分流在 index.js
  check('门禁：mode=agent + 失败 → 照样必发（门禁不挑通道）', g({ mode: 'agent', ok: false }).send === true)
  check('门禁：mode=agent + 成功 + 没开 onSuccess → 不发', g({ mode: 'agent', ok: true, notifyOnSuccess: false }).reason === 'success-muted')
  check('门禁：mode=agent + 到上限 → 不发', g({ mode: 'agent', ok: false, dailyLimit: 5, dayKey: TODAY, usedCount: 5 }).reason === 'daily-limit')
  check('门禁：system + 失败 → 必发', g({ mode: 'system', ok: false }).send === true)
  check('门禁：system + 超时(reason=timeout) → 必发', g({ mode: 'system', ok: false, reason: 'timeout' }).send === true)
  check('门禁：system + 成功 + 没开 onSuccess → 不发', g({ mode: 'system', ok: true, notifyOnSuccess: false }).reason === 'success-muted')
  check('门禁：system + 成功 + 开了 onSuccess → 发', g({ mode: 'system', ok: true, notifyOnSuccess: true }).send === true)
  check('门禁：limit=0 → 一条都不发', g({ mode: 'system', ok: false, dailyLimit: 0 }).reason === 'limit-zero')
  check('门禁：到上限 → 不发', g({ mode: 'system', ok: false, dailyLimit: 5, dayKey: TODAY, usedCount: 5 }).reason === 'daily-limit')
  check('门禁：到上限时 used 带回（调用方不用自己数）', g({ mode: 'system', ok: false, dailyLimit: 5, dayKey: TODAY, usedCount: 5 }).used === 5)
  check('门禁：跨天把昨天计数作废', g({ mode: 'system', ok: false, dailyLimit: 2, dayKey: YESTERDAY, usedCount: 99 }).send === true)
  check('门禁：跨天后 used 从 0 起', g({ mode: 'system', ok: false, dailyLimit: 2, dayKey: YESTERDAY, usedCount: 99 }).used === 0)
  check('门禁：ok 缺省按失败处理（fail-safe）', g({ mode: 'system' }).send === true)

  const t = (patch) => resolveNotifyTarget({ ownerQQ: '10001', ...patch })
  check('目标：默认 owner', t({}).via === 'owner' && t({}).targetQQ === '10001')
  check('目标：last + 私聊目的地 → 发给那个人', t({ target: 'last', lastDestination: { kind: 'private', userId: '20002' } }).targetQQ === '20002')
  check('目标：last + 最近是群 → 回落主人', t({ target: 'last', lastDestination: { kind: 'group', groupId: '90001' } }).via === 'last-fallback-owner')
  check('目标：last + 还没有目的地 → 回落主人', t({ target: 'last', lastDestination: null }).targetQQ === '10001')
  check('目标：回落带 fallback 标记（据实记账）', t({ target: 'last', lastDestination: null }).fallback === true)
  check('目标：last + 私聊目的地 userId 不是数字 → 回落主人', t({ target: 'last', lastDestination: { kind: 'private', userId: 'abc' } }).targetQQ === '10001')
  check('目标：owner 没配 → 没人可发', t({ ownerQQ: '' }).targetQQ === '' && t({ ownerQQ: '' }).via === 'no-target')
  check('目标：last + 群 + 没配主人 → 没人可发', t({ target: 'last', ownerQQ: '', lastDestination: { kind: 'group', groupId: '90001' } }).targetQQ === '')

  // ── system 档正式模板（任务书 5）：三行，中文、口语、纯文本 ──
  check('模板：失败 = [任务通知] 标题 失败了：原因（耗时）。', buildChecklogNotifyText(failedTask) === '[任务通知] 工作·hello.py 失败了：出错（耗时 1 分 30 秒）。', buildChecklogNotifyText(failedTask))
  check('模板：成功 = 完成了（耗时）。', buildChecklogNotifyText(successTask) === '[任务通知] 工作·hello.py 完成了（耗时 1 分 30 秒）。', buildChecklogNotifyText(successTask))
  check('模板：超时 = 超时了（等了两小时还没结束）。', buildChecklogNotifyText(timeoutTask) === '[任务通知] 工作·hello.py 超时了（等了两小时还没结束）。', buildChecklogNotifyText(timeoutTask))
  check('模板：失败原因取自 status 括号里那一句', buildChecklogNotifyText({ ...failedTask, status: '失败（输出太长被截断）' }) === '[任务通知] 工作·hello.py 失败了：输出太长被截断（耗时 1 分 30 秒）。')
  check('模板：status 缺失时兜底「未知原因」', buildChecklogNotifyText({ ...failedTask, status: '' }) === '[任务通知] 工作·hello.py 失败了：未知原因（耗时 1 分 30 秒）。')
  check('模板：耗时也认 elapsedMs', buildChecklogNotifyText({ ok: false, elapsedMs: 45_000 }).includes('耗时 45 秒'))
  check('模板：标题缺失时退到任务名', buildChecklogNotifyText({ ...failedTask, sessionTitle: '' }) === '[任务通知] 在 workspace 里写一个 hello.py 失败了：出错（耗时 1 分 30 秒）。')
  check('模板：任务名空白且无标题时兜底「未命名任务」', buildChecklogNotifyText({ ok: true, task: '   ' }) === '[任务通知] 未命名任务 完成了（耗时 <1 秒）。')
  check('模板：任务名里的换行被压成空格（QQ 不渲染换行）', !buildChecklogNotifyText({ ok: true, task: '第一行\n第二行' }).includes('\n第一行'))

  // ── agent 档处境（任务书 5）：一句话，她据此跟主人说 ──
  const s1 = buildChecklogSituationText(failedTask)
  check('处境：以「活儿有结果了」开头', s1.startsWith('你刚派出去的活儿有结果了：'), s1)
  check('处境：带任务、结果、耗时三格', s1.includes('任务=在 workspace 里写一个 hello.py') && s1.includes('结果=失败了：出错') && s1.includes('耗时=1 分 30 秒'), s1)
  check('处境：收尾让她用一句话说', s1.endsWith('用一句话跟主人说一声。'), s1)
  check('处境：成功 / 超时也只换结果那一格', buildChecklogSituationText(successTask).includes('结果=完成了') && buildChecklogSituationText(timeoutTask).includes('结果=超时了'))
  check('处境：任务名封顶 200 字，不把她上下文淹了', buildChecklogSituationText({ ...failedTask, task: 'x'.repeat(500) }).length < 260, String(buildChecklogSituationText({ ...failedTask, task: 'x'.repeat(500) }).length))
  check('处境与模板：结果/耗时同一份说法（两通道不吵架）', outcomeOf(failedTask) === '失败了：出错' && outcomeOf(successTask) === '完成了')
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：单元（注入假宿主）—— 三条验收都在这里
// ══════════════════════════════════════════════════════════════════════════

/** 造假宿主：所有副作用都收进数组，断言直接看数组。
 *  ⚠️ createChecklogNotifier 在构造时就把 deps 解构走了 —— 事后改 deps 的属性
 *     不生效（闭包拿的是构造时的引用）。要在跑的时候换 send/连通性，
 *     就从这里造的时候传进来。 */
function makeHost({ settings = {}, state: statePatch = {}, sendImpl, transportOpen } = {}) {
  const sent = []
  const logs = []
  const outbox = []
  const saved = { count: 0 }
  const state = {
    lastDestination: null,
    checklogNotify: { dayKey: '', count: 0, lastAt: 0 },
    ...statePatch,
  }
  const deps = {
    readSettings: () => ({
      checklogNotifyMode: 'system',
      checklogNotifyOnSuccess: false,
      checklogNotifyDailyLimit: 5,
      checklogNotifyTarget: 'owner',
      ownerQQ: '10001',
      selfId: '',
      stripMarkdown: true,
      replyMaxChars: 1500,
      ...settings,
    }),
    state,
    saveState: () => {
      saved.count += 1
    },
    pushLog: (e) => logs.push(e),
    recordOutbox: (e) => outbox.push(e),
    sendPrivateMsg:
      sendImpl ??
      (async (userId, segments) => {
        sent.push({ userId, segments })
      }),
    isTransportOpen: transportOpen ?? (() => true),
    dayKeyOf,
    now: () => NOW,
    stripMarkdown: (s) => String(s).replace(/[*_`#]/g, ''),
  }
  const notifier = createChecklogNotifier(deps)
  return { notifier, deps, sent, logs, outbox, saved, state }
}

{
  // ── 验收 1：手动调函数能发出一条 QQ 消息 ──────────────────────────────
  const h = makeHost()
  const r = await h.notifier.notifyTaskFinished(failedTask)
  check('验收1：返回 ok:true（失败任务必发）', r.ok === true && r.sent === 1, JSON.stringify(r))
  check('验收1：sendPrivateMsg 被调了一次', h.sent.length === 1, JSON.stringify(h.sent.map((s) => s.userId)))
  check('验收1：发给主人', h.sent[0].userId === '10001', String(h.sent[0].userId))
  check('验收1：消息体是 OneBot 消息段', JSON.stringify(h.sent[0].segments) === JSON.stringify([{ type: 'text', data: { text: r.text } }]))
  check('验收1：正文是 system 模板那一句', r.text === '[任务通知] 工作·hello.py 失败了：出错（耗时 1 分 30 秒）。', r.text)
  check('验收1：outbox 里 spokenBy=template（知道这条是谁写的）', h.outbox.some((e) => e.spokenBy === 'template'))

  check('计数：发成功后 +1', h.state.checklogNotify.count === 1 && r.todayCount === 1, JSON.stringify(h.state.checklogNotify))
  check('计数：dayKey 记到今天', h.state.checklogNotify.dayKey === TODAY, h.state.checklogNotify.dayKey)
  check('计数：lastAt 记下来了', h.state.checklogNotify.lastAt === NOW, String(h.state.checklogNotify.lastAt))
  check('计数：saveState 被调（落盘）', h.saved.count === 1, String(h.saved.count))

  // ── 验收 2：超上限后不再发 ─────────────────────────────────────────────
  const h2 = makeHost({ state: { checklogNotify: { dayKey: TODAY, count: 5, lastAt: NOW } } })
  const r2 = await h2.notifier.notifyTaskFinished(failedTask)
  check('验收2：到上限 → 不发', r2.ok === false && r2.dropped === true && r2.reason === 'daily-limit', JSON.stringify(r2))
  check('验收2：sendPrivateMsg 一次都没调', h2.sent.length === 0)
  check('验收2：台账记了「被限流」', h2.logs.some((e) => e.kind === 'checklog' && e.action === 'rate-limited'), JSON.stringify(h2.logs))
  check('验收2：限流台账带 used / limit（排查用）', (() => {
    const e = h2.logs.find((x) => x.action === 'rate-limited')
    return e?.used === 5 && e?.limit === 5
  })())
  check('验收2：被限流不占额度（计数没涨）', h2.state.checklogNotify.count === 5, String(h2.state.checklogNotify.count))

  // ── 验收 3：outbox 里能看到这条 ────────────────────────────────────────
  check('验收3：outbox 恰好一条', h.outbox.length === 1, JSON.stringify(h.outbox.length))
  const ob = h.outbox[0]
  check('验收3：via=checklog（知道是哪条通道发的）', ob.via === 'checklog', JSON.stringify(ob))
  check('验收3：目的地是主人的私聊', ob.to?.kind === 'private' && ob.to?.userId === '10001', JSON.stringify(ob.to))
  check('验收3：正文与发出去的一致', ob.text === r.text)
  check('验收3：带了 sessionId（对得上是哪个任务）', ob.sessionId === 'session-task-1', String(ob.sessionId))
  check('验收3：带了任务结束原因', ob.endReason === 'error', String(ob.endReason))
  check('验收3：发送也记了一行台账', h.logs.some((e) => e.kind === 'checklog' && e.action === 'sent' && e.todayCount === 1), JSON.stringify(h.logs))

  // ── 边界：开关 / 成功口径 ───────────────────────────────────────────────
  const off = makeHost({ settings: { checklogNotifyMode: 'off' } })
  const rOff = await off.notifier.notifyTaskFinished(failedTask)
  check('边界：mode=off → 不发', rOff.ok === false && rOff.reason === 'mode-off' && off.sent.length === 0, JSON.stringify(rOff))
  check('边界：mode=off → outbox / 台账都不写', off.outbox.length === 0 && off.logs.length === 0)

  const agent = makeHost({ settings: { checklogNotifyMode: 'agent' } })
  const rAgent = await agent.notifier.notifyTaskFinished(failedTask)
  // 任务书 5：agent 档是 index.js 的通道（投会话让她说），不经过 notifyTaskFinished
  check('边界：mode=agent → 本函数不发（通道分流在 index.js）', rAgent.reason === 'mode-agent' && agent.sent.length === 0, JSON.stringify(rAgent))

  // ── 任务书 5：agent 档的转发出口（index.js 抽出她的话后调这里）──
  const fwd = makeHost({ settings: { checklogNotifyMode: 'agent' } })
  const rFwd = await fwd.notifier.sendChecklogNotice(failedTask, '主人，那个 hello.py 没写成，跑的时候报错了。')
  check('转发：她说的话原样发出去（不是模板）', rFwd.ok === true && rFwd.text === '主人，那个 hello.py 没写成，跑的时候报错了。', JSON.stringify(rFwd))
  check('转发：也计数（与 system 同一个额度池）', fwd.state.checklogNotify.count === 1 && rFwd.todayCount === 1, JSON.stringify(fwd.state.checklogNotify))
  check('转发：outbox spokenBy=agent', fwd.outbox.some((e) => e.spokenBy === 'agent' && e.text === rFwd.text))
  check('转发：空文本 → 退回模板（兜底在 index.js，这里只认空串）', (await fwd.notifier.sendChecklogNotice(failedTask, '   ')).text.startsWith('[任务通知]'))
  check('转发：空文本也写成模板，不静默', (await fwd.notifier.sendChecklogNotice(failedTask, '')).ok === true)

  const muted = makeHost() // 默认 onSuccess=false
  const rMuted = await muted.notifier.notifyTaskFinished(successTask)
  check('边界：任务成功 + onSuccess 关 → 不发（成功是本分）', rMuted.reason === 'success-muted' && muted.sent.length === 0, JSON.stringify(rMuted))

  const loud = makeHost({ settings: { checklogNotifyOnSuccess: true } })
  const rLoud = await loud.notifier.notifyTaskFinished(successTask)
  check('边界：任务成功 + onSuccess 开 → 发', rLoud.ok === true && rLoud.text === '[任务通知] 工作·hello.py 完成了（耗时 1 分 30 秒）。', JSON.stringify(rLoud))

  const zero = makeHost({ settings: { checklogNotifyDailyLimit: 0 } })
  const rZero = await zero.notifier.notifyTaskFinished(failedTask)
  check('边界：dailyLimit=0 = 用户说一条都别发', rZero.reason === 'limit-zero' && zero.sent.length === 0)

  // ── 边界：跨天 / 失败不占额度 ───────────────────────────────────────────
  const cross = makeHost({ state: { checklogNotify: { dayKey: YESTERDAY, count: 99, lastAt: NOW } } })
  const rCross = await cross.notifier.notifyTaskFinished(failedTask)
  check('边界：跨天后从 1 开始计数（昨天的 99 条作废）', rCross.ok === true && rCross.todayCount === 1 && cross.state.checklogNotify.count === 1, JSON.stringify(rCross))

  const boom = makeHost({ sendImpl: async () => { throw new Error('OneBot action failed: retcode=10003') } })
  const rBoom = await boom.notifier.notifyTaskFinished(failedTask)
  check('边界：发送失败 → 不抛、reason=send-failed', rBoom.ok === false && rBoom.reason === 'send-failed' && typeof rBoom.error === 'string', JSON.stringify(rBoom))
  check('边界：发送失败不占额度', boom.state.checklogNotify.count === 0, String(boom.state.checklogNotify.count))
  check('边界：发送失败不落 outbox', boom.outbox.length === 0)
  check('边界：发送失败记了台账', boom.logs.some((e) => e.action === 'send-failed'), JSON.stringify(boom.logs))

  // ── 边界：目标解析 ──────────────────────────────────────────────────────
  const noOwner = makeHost({ settings: { ownerQQ: '' } })
  const rNoOwner = await noOwner.notifier.notifyTaskFinished(failedTask)
  check('边界：没配主人 → 不发 + reason=no-target', rNoOwner.reason === 'no-target' && noOwner.sent.length === 0, JSON.stringify(rNoOwner))
  check('边界：no-target 记了台账（配置问题值得留痕）', noOwner.logs.some((e) => e.action === 'no-target'))

  const lastPrivate = makeHost({
    settings: { checklogNotifyTarget: 'last' },
    state: { lastDestination: { kind: 'private', userId: '20002' } },
  })
  const rLast = await lastPrivate.notifier.notifyTaskFinished(failedTask)
  check('边界：target=last + 最近是私聊 → 发给那个人', rLast.ok === true && lastPrivate.sent[0].userId === '20002', JSON.stringify(rLast))

  const lastGroup = makeHost({
    settings: { checklogNotifyTarget: 'last' },
    state: { lastDestination: { kind: 'group', groupId: '90001' } },
  })
  const rLastG = await lastGroup.notifier.notifyTaskFinished(failedTask)
  check('边界：target=last + 最近是群 → 回落主人', rLastG.ok === true && lastGroup.sent[0].userId === '10001', JSON.stringify(rLastG))
  check('边界：回落在台账里标出来（据实，不偷偷换人）', lastGroup.logs.some((e) => e.action === 'sent' && e.fallback === true), JSON.stringify(lastGroup.logs))

  const selfHit = makeHost({ settings: { selfId: '10001' } })
  const rSelf = await selfHit.notifier.notifyTaskFinished(failedTask)
  check('边界：目标是自己 → 不发（防自环）', rSelf.reason === 'self-target' && selfHit.sent.length === 0, JSON.stringify(rSelf))

  const offline = makeHost({ transportOpen: () => false })
  const rOff2 = await offline.notifier.notifyTaskFinished(failedTask)
  check('边界：传输没连 → 不发 + reason=not-connected', rOff2.reason === 'not-connected' && offline.sent.length === 0, JSON.stringify(rOff2))

  // ── 边界：超长截断（系统通知没有改短重发的机会） ───────────────────────
  // replyMaxChars 有下限 100（与主动私聊同口径，防垃圾设置），所以用 100 触发。
  // 模板的主语是会话标题，标题拉到 200 字才够触发截断。
  const tiny = makeHost({ settings: { replyMaxChars: 100 } })
  const rTiny = await tiny.notifier.notifyTaskFinished({ ...failedTask, sessionTitle: `工作·${'一'.repeat(200)}` })
  check('边界：超长截断而不是丢弃', rTiny.ok === true && [...rTiny.text].length <= 100, JSON.stringify([...rTiny.text].length))
  check('边界：截断后以 … 结尾', rTiny.text.endsWith('…'), rTiny.text.slice(0, 40))

  // ── 边界：构造校验 ────────────────────────────────────────────────────
  let threw = ''
  try {
    createChecklogNotifier({ readSettings: () => ({}), state: { checklogNotify: { dayKey: '', count: 0, lastAt: 0 } } })
  } catch (error) {
    threw = String(error?.message ?? error)
  }
  check('边界：缺依赖 → 构造时大喊', threw.includes('缺少必需依赖'), threw)
  check('边界：报错列出缺的是哪些', threw.includes('saveState') && threw.includes('sendPrivateMsg') && threw.includes('dayKeyOf'), threw)

  // ── 边界：宿主 state 里没有 checklogNotify 段也能跑（兜底） ────────────
  const bare = makeHost()
  bare.deps.state.checklogNotify = undefined
  const rBare = await bare.notifier.notifyTaskFinished(failedTask)
  check('边界：state 段缺失时兜底计数（不炸）', rBare.ok === true && bare.state.checklogNotify.count === 1, JSON.stringify(bare.state.checklogNotify))
}

// ══════════════════════════════════════════════════════════════════════════
// 第三部分：真实 OneBot 传输（假 WS）—— 断言真的发出了那一帧
// ══════════════════════════════════════════════════════════════════════════
{
  const transport = createOneBotTransport({
    getUrl: () => 'ws://127.0.0.1:3999',
    getToken: () => '',
    onEvent: () => {},
    logger: { info() {}, warn() {} },
    heartbeatTimeoutMs: 60_000,
  })
  transport.start()

  const sentFrames = () => wsSent.filter((f) => f.action === 'send_private_msg')
  const waitOpen = async () => {
    for (let i = 0; i < 100; i++) {
      if (transport.isOpen()) return true
      await sleep(20)
    }
    return false
  }
  check('集成：假 OneBot 连接已建立', await waitOpen())

  const h = makeHost({
    // 与生产同一条路：sendPrivateMsg = transport.call('send_private_msg', ...)
    sendImpl: (userId, segments) =>
      transport.call('send_private_msg', { user_id: userId, message: segments }),
    transportOpen: () => transport.isOpen(),
  })

  // 验收 1（真帧）
  const r = await h.notifier.notifyTaskFinished(failedTask)
  check('验收1：真的发出了 send_private_msg 帧', sentFrames().length === 1, JSON.stringify(wsSent.map((f) => f.action)))
  const frame = sentFrames()[0]
  check('验收1：帧的 user_id 是主人', String(frame?.params?.user_id) === '10001', String(frame?.params?.user_id))
  check('验收1：帧的 message 是文本段且正文一致', frame?.params?.message?.[0]?.data?.text === r.text, JSON.stringify(frame?.params?.message))
  check('验收1：通信回包为 ok（帧有 echo）', typeof frame?.echo === 'string' && frame.echo !== '')

  // 验收 2（真帧）：顶到上限后不再发
  h.state.checklogNotify = { dayKey: TODAY, count: h.deps.readSettings().checklogNotifyDailyLimit, lastAt: NOW }
  const r2 = await h.notifier.notifyTaskFinished(failedTask)
  check('验收2：超上限 → 没有第二帧', sentFrames().length === 1 && r2.reason === 'daily-limit', JSON.stringify(r2))

  // 发送失败路径也走真传输：不连就发 → reason=not-connected
  // （先把计数从上限挪开，否则 daily-limit 会先于连通性判定生效）
  h.state.checklogNotify = { dayKey: TODAY, count: 1, lastAt: NOW }
  transport.dispose()
  const rDown = await h.notifier.notifyTaskFinished(failedTask)
  check('集成：传输断开 → not-connected（不是 send-failed）', rDown.reason === 'not-connected' && sentFrames().length === 1, JSON.stringify(rDown))
}

console.log('')
if (failed === 0) console.log('ALL PASS')
else console.log(`${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
