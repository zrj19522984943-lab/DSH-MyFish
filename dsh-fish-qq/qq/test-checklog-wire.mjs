/**
 * test-checklog-wire.mjs —— 任务完成日志 · 接线（任务书 4，2026-10-28）
 *
 * 任务书 3 造了「调它就能发」的通知核心；本测试验**接线**：
 *   - fish 侧写成日志之后 emit 'checklog/finished'（载荷 = 日志字段）；
 *   - qq 侧在 apply() 里 ctx.on('checklog/finished')，交给 notifyTaskFinished；
 *   - 两边只通过事件握手，fish 不 import qq（本测试从 qq 这一侧 import
 *     ../fish/lib/work.js 只是为了开动「派活」那一端，是测试代码，不是产品代码）。
 *
 * 验收清单（任务书 4 的三条）：
 *   1. 派**必然失败**的任务 → QQ 收到通知：端到端——apply 后用同一 ctx 派活，
 *      turn/end(error) → CheckLogs 写成 → send_private_msg 真的发出去。
 *   2. 派**成功**的任务 → 默认不发；把 checklogNotifyOnSuccess 打开后发。
 *   3. 停用插件再派活 → 没有通知：把 ctx.on 注册的监听摘掉（宿主销毁 ctx 时
 *      就是这么干的）→ 日志还在写，但通知不再有人接。
 *
 * 另外盯一条地基：mode 默认 'off'，喂什么结果都一条不发。
 *
 * 跑法：node test-checklog-wire.mjs（与 test-checklog-notify.mjs 同一套假 WS 手法）
 */

// ── 假 WebSocket：让 OneBot 传输真的「连上」并捕获出站帧 ─────────────────────
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

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { apply } = await import('./index.js')
// 开动「派活」那一端（fish），与本测试的 qq 装共用同一个 ctx —— 等于合并包的装配。
const { dispatchWork } = await import('../fish/lib/work.js')

// ── 断言器 ────────────────────────────────────────────────────────────────
let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond, timeoutMs = 3000) {
  for (let i = 0; i < timeoutMs / 20; i++) {
    if (await cond()) return true
    await sleep(20)
  }
  return false
}

/** 已发出的 send_private_msg 帧（get_login_info 等杂帧不计）。 */
const sendFrames = () => wsSent.filter((f) => f.action === 'send_private_msg')

// ── 假宿主：多事件名、可摘监听、可喂事件 —— 尽量贴近合并包里那个 ctx ──────────
function makeCtx() {
  const handlers = {}
  const offs = []
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {} },
    // 0.2.0 形态：settings 服务没有 register/get
    settings: {},
    agents: {
      get: () => undefined,
      roots: () => [],
      resume: async () => { throw new Error('wire: no agent factory') },
    },
    // 派活那一端（fish work_request）开的会话固定叫 session-task
    sessionController: {
      create: async () => ({ sessionId: 'session-task' }),
      rename: async () => {},
      prompt: async () => {},
    },
    tools: { register: (def) => registered.push(def) },
    on: (name, fn) => {
      ;(handlers[name] ??= []).push(fn)
      const rec = { name, off: () => { handlers[name] = (handlers[name] || []).filter((f) => f !== fn) } }
      offs.push(rec)
      return rec.off
    },
    emit: (name, ...args) => {
      for (const fn of [...(handlers[name] || [])]) fn(...args)
    },
    // 真实 Cordis 的 effect 会**立刻执行** fn —— 传输的 start() 就靠它。
    effect: (fn) => {
      const out = fn()
      if (typeof out === 'function') offs.push({ name: 'effect', off: out })
      return out
    },
    get: (name) => {
      if (name === 'workspaceRegistry') {
        return { list: () => [], create: async () => ({ id: 'ws-test' }) }
      }
      return undefined
    },
    inject: (_deps, cb) => cb(ctx),
    webServer: { register: () => () => {} },
  }
  return { ctx, handlers, offs, registered }
}

/**
 * 起一个 qq-bridge 实例。返回 ctx 时期的能力 + 一个 status()（走
 * qq_bridge_status 工具，与排障时的路径一致）。
 */
async function boot(config) {
  const c = makeCtx()
  apply(c.ctx, config)
  const statusTool = c.registered.find((t) => t?.name === 'qq_bridge_status')
  const status = async () => {
    const out = await statusTool.execute({})
    return JSON.parse(out)
  }
  return { ...c, status }
}

/** 喂一条「fish 刚写完日志」的事件（直接调注册的监听，等于 ctx.emit 派发）。 */
function feedChecklogFinished(handlers, result) {
  for (const fn of [...(handlers['checklog/finished'] || [])]) fn(result)
}

/** 喂一条 turn/end（同一个 ctx 上 qq 的监听与 fish watcher 的监听都会收到）。 */
function fireTurnEnd(handlers, sessionId, kind) {
  for (const fn of [...(handlers['session/event'] || [])]) {
    fn({ id: sessionId }, { type: 'turn/end', data: { reason: { kind } } })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 地基：mode 默认 'off' —— 喂失败结果也一条不发
// ══════════════════════════════════════════════════════════════════════════
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-wire-off-'))
  const b = await boot({
    debugTools: true,
    statePath: join(dir, 'state.json'),
    onebotUrl: 'ws://127.0.0.1:3999',
    // 故意不配 checklogNotifyMode / ownerQQ 之外的东西
    ownerQQ: '10001',
    napcatInstallDir: join(dir, 'napcat-absent'),
  })
  try {
    check('注册：apply 挂上了 checklog/finished 监听', (b.handlers['checklog/finished'] || []).length === 1)
    check('传输：假 OneBot 已连上', await waitFor(async () => (await b.status()).transport.state === 'open'))
    const before = sendFrames().length
    feedChecklogFinished(b.handlers, {
      ok: false,
      reason: 'error',
      task: '在 workspace 里写一个 hello.py',
      sessionTitle: '工作·hello.py',
      sessionId: 'session-x',
      startedAt: Date.now() - 90_000,
      endedAt: Date.now(),
      elapsedMs: 90_000,
    })
    await sleep(80)
    check('地基：默认 mode=off，失败结果也一条不发', sendFrames().length === before, JSON.stringify({ before, now: sendFrames().length }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 验收 1（端到端）：派必然失败的任务 → QQ 收到通知
// ══════════════════════════════════════════════════════════════════════════
const WORK_ROOT_A = mkdtempSync(join(tmpdir(), 'dsh-fish-wire-a-'))
const LOGS = mkdtempSync(join(tmpdir(), 'dsh-fish-wire-logs-'))
// 这一节要派 4 件活（失败 / 成功 / 成功+开关 / 停用后再派），把 fish 的每日上限抬高，
// 免得第 4 件被「今天先不派了」挡掉（那条挡的是模型重试，不是这里要验的东西）。
writeFileSync(join(WORK_ROOT_A, 'config.json'), `${JSON.stringify({ work: { perDay: 10 } }, null, 2)}\n`)
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-wire-a-'))
  const settingsPath = join(dir, 'qq-bridge-settings.json')
  const b = await boot({
    debugTools: true,
    statePath: join(dir, 'state.json'),
    onebotUrl: 'ws://127.0.0.1:3999',
    ownerQQ: '10001',
    checklogNotifyMode: 'system',
    checklogNotifyOnSuccess: false,
    checklogNotifyDailyLimit: 5,
    checklogNotifyTarget: 'owner',
    napcatInstallDir: join(dir, 'napcat-absent'),
  })
  const statePath = (await b.status()).statePath
  try {
    check('接线：checklog/finished 监听只有一个（apply 一次挂一个）', (b.handlers['checklog/finished'] || []).length === 1)

    // 用**同一个 ctx** 派活 —— 复刻合并包里 fish 与 qq 共用一个 ctx 的装配
    const r = await dispatchWork(b.ctx, '在 workspace 里写一个 hello.py', {
      root: WORK_ROOT_A,
      dir: WORK_ROOT_A,
      log: () => {},
      checkLogsDir: LOGS,
    })
    check('验收1：活派出去了', r.ok === true, JSON.stringify(r))

    const framesBefore = sendFrames().length
    fireTurnEnd(b.handlers, 'session-task', 'error') // 必然失败的那一轮
    const gotFrame = await waitFor(() => sendFrames().length === framesBefore + 1)
    check('验收1：QQ 收到通知（真的发出了 send_private_msg 帧）', gotFrame)
    await waitFor(() => readdirSync(LOGS).length === 1)
    check('验收1：CheckLogs 里日志也写成了', readdirSync(LOGS).length === 1)

    const frame = sendFrames()[sendFrames().length - 1]
    check('验收1：发给主人', String(frame?.params?.user_id) === '10001', String(frame?.params?.user_id))
    const text = frame?.params?.message?.[0]?.data?.text ?? ''
    check('验收1：正文是 system 模板（[任务通知] … 失败了）', text.startsWith('[任务通知]') && text.includes('失败了') && text.startsWith('[任务通知] 工作·'), JSON.stringify(text))

    // 计数与台账（落盘才叫真的发了）
    const st = JSON.parse(readFileSync(statePath, 'utf8'))
    check('验收1：state.checklogNotify 计数到 1', st.checklogNotify?.count === 1, JSON.stringify(st.checklogNotify))
    check('验收1：outbox 里有一条 via=checklog', Array.isArray(st.outbox) && st.outbox.some((o) => o.via === 'checklog'))
    const ob = (st.outbox || []).find((o) => o.via === 'checklog')
    check('验收1：outbox 记了目的地与 sessionId', ob?.to?.userId === '10001' && ob?.sessionId === 'session-task', JSON.stringify(ob?.to))
    check('验收1：台账记了「sent」', Array.isArray(st.log) && st.log.some((l) => l.kind === 'checklog' && l.action === 'sent'))

    // ── 验收 2：派成功的任务 → 默认不发 ────────────────────────────────
    await dispatchWork(b.ctx, '跑通构建并生成报告', {
      root: WORK_ROOT_A,
      dir: WORK_ROOT_A,
      log: () => {},
      checkLogsDir: LOGS,
    })
    const framesBefore2 = sendFrames().length
    fireTurnEnd(b.handlers, 'session-task', 'completed')
    await sleep(120)
    check('验收2：任务成功 + onSuccess 关 → 不发', sendFrames().length === framesBefore2, JSON.stringify(sendFrames().length - framesBefore2))
    await waitFor(() => readdirSync(LOGS).length === 2)
    check('验收2：成功的日志照写', readdirSync(LOGS).length === 2)

    // 打开 checklogNotifyOnSuccess：走设置文件那条路（0.2.0 的真实路径），写完就生效
    writeFileSync(settingsPath, `${JSON.stringify({ version: 1, values: { checklogNotifyOnSuccess: true } }, null, 2)}\n`)
    const sFlip = (await b.status()).settings
    check('验收2：设置文件写进去、读出来已生效', sFlip.checklogNotifyOnSuccess === true, JSON.stringify(sFlip.checklogNotifyOnSuccess))

    await dispatchWork(b.ctx, '发布到测试环境', {
      root: WORK_ROOT_A,
      dir: WORK_ROOT_A,
      log: () => {},
      checkLogsDir: LOGS,
    })
    const framesBefore3 = sendFrames().length
    fireTurnEnd(b.handlers, 'session-task', 'completed')
    const gotFrame3 = await waitFor(() => sendFrames().length === framesBefore3 + 1)
    check('验收2：开 checklogNotifyOnSuccess 后，成功任务也发', gotFrame3)
    const frame3 = sendFrames()[sendFrames().length - 1]
    check('验收2：正文是 system 模板（… 完成了）', (frame3?.params?.message?.[0]?.data?.text ?? '').includes('完成了'), (frame3?.params?.message?.[0]?.data?.text ?? '').slice(0, 60))
    const st3 = JSON.parse(readFileSync(statePath, 'utf8'))
    check('验收2：成功发送也计数', st3.checklogNotify?.count === 2, JSON.stringify(st3.checklogNotify))

    // ── 验收 3：停用插件再派活 → 没有通知 ─────────────────────────────
    // 宿主销毁 ctx 时会把 ctx.on 注册的监听一并摘掉——这里照着做：
    for (const rec of b.offs.filter((x) => x.name === 'checklog/finished')) rec.off()
    check('验收3：摘掉后没有 checklog/finished 监听了', (b.handlers['checklog/finished'] || []).length === 0)

    await dispatchWork(b.ctx, '再跑一次恶意的活', {
      root: WORK_ROOT_A,
      dir: WORK_ROOT_A,
      log: () => {},
      checkLogsDir: LOGS,
    })
    const framesBefore4 = sendFrames().length
    fireTurnEnd(b.handlers, 'session-task', 'error')
    await waitFor(() => readdirSync(LOGS).length === 4)
    await sleep(120)
    check('验收3：停用后日志照写（fish 那半还在）', readdirSync(LOGS).length === 4)
    check('验收3：没有通知（一个帧都没多）', sendFrames().length === framesBefore4, JSON.stringify(sendFrames().length - framesBefore4))
    const st4 = JSON.parse(readFileSync(statePath, 'utf8'))
    check('验收3：计数也没涨', st4.checklogNotify?.count === 2, JSON.stringify(st4.checklogNotify))

    // 监听还在的时候喂事件仍然会发（同一实例、设置没变）
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK_ROOT_A, { recursive: true, force: true })
    rmSync(LOGS, { recursive: true, force: true })
    try { rmSync(settingsPath, { recursive: true, force: true }) } catch { /* 不存在就算了 */ }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 边界（任务书 7 钉死）：新进程 + 旧 CheckLogs 文件 → 不补发
// 通知只由**本进程**的 turn/end 点燃（fish watcher 写完成日志 → emit checklog/finished）。
// CheckLogs/ 里躺着上一次进程留下的 .md，新进程起来不会去扫、不会补发——
// 哪天有人手痒加了「启动时扫目录补发未读日志」，这里会 FAIL。
// ══════════════════════════════════════════════════════════════════════════
const WORK_ROOT_R = mkdtempSync(join(tmpdir(), 'dsh-fish-wire-restart-work-'))
const LOGS_OLD = mkdtempSync(join(tmpdir(), 'dsh-fish-wire-restart-logs-'))
writeFileSync(join(WORK_ROOT_R, 'config.json'), `${JSON.stringify({ work: { perDay: 10 } }, null, 2)}\n`)
// 「上一次进程」留下的：昨天就写在那儿的失败日志
writeFileSync(
  join(LOGS_OLD, '20261027-120000-deadbeef.md'),
  ['# 任务失败', '', '- 任务：在 workspace 里写一个 hello.py', '- 结果：失败了（出错）', '', '（上一次进程留下的旧日志，新进程不该拿它说事）', ''].join('\n'),
)
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-wire-restart-'))
  const b = await boot({
    debugTools: true,
    statePath: join(dir, 'state.json'),
    onebotUrl: 'ws://127.0.0.1:3999',
    ownerQQ: '10001',
    checklogNotifyMode: 'system',
    napcatInstallDir: join(dir, 'napcat-absent'),
  })
  const statePath = (await b.status()).statePath
  const waitForState = async (pred, timeoutMs = 3000) => {
    for (let i = 0; i < timeoutMs / 20; i++) {
      try {
        if (pred(JSON.parse(readFileSync(statePath, 'utf8')))) return true
      } catch {
        // 落盘可能还在路上
      }
      await sleep(20)
    }
    return false
  }
  try {
    check('传输：假 OneBot 已连上', await waitFor(async () => (await b.status()).transport.state === 'open'))

    // ── 这一段才是钉死的那一条：旧文件 + 新进程，什么也不做 ──────────────
    const before = sendFrames().length
    await sleep(150) // 远超任何「启动时同步扫目录」需要的时间：要补发早该发了
    check(
      '边界：旧 CheckLogs 文件不会触发通知（新进程不做补发）',
      sendFrames().length === before,
      JSON.stringify({ before, now: sendFrames().length, oldLogs: readdirSync(LOGS_OLD).length }),
    )
    const st0 = await b.status()
    check(
      '边界：计数没动、台账里没有 checklog',
      st0.checklogNotify?.todayCount === 0 && !(st0.recentLog || []).some((l) => l.kind === 'checklog'),
      JSON.stringify({ count: st0.checklogNotify?.todayCount, checklogLogs: (st0.recentLog || []).filter((l) => l.kind === 'checklog').length }),
    )

    // ── 然后证明上面是「边界」而不是「通道坏了」：同一个进程，活真的来了 ──
    // （同一批旧文件还在旁边躺着，新日志写在它们旁边）
    const r = await dispatchWork(b.ctx, '在 workspace 里写一个 hello.py', {
      root: WORK_ROOT_R,
      dir: WORK_ROOT_R,
      log: () => {},
      checkLogsDir: LOGS_OLD,
    })
    check('边界：本进程的活照派', r.ok === true, JSON.stringify(r))
    const framesBefore = sendFrames().length
    fireTurnEnd(b.handlers, 'session-task', 'error')
    const got = await waitFor(() => sendFrames().length === framesBefore + 1)
    check('边界：本进程的 turn/end 来了 → 照发不误', got)
    await waitFor(() => readdirSync(LOGS_OLD).length === 2)
    check('边界：新日志写在旧文件旁边（旧那条还原样在）', readdirSync(LOGS_OLD).length === 2, JSON.stringify(readdirSync(LOGS_OLD)))
    const ok = await waitForState((s) => s?.checklogNotify?.count === 1)
    check('边界：这一条是新的，计数 +1', ok, JSON.stringify(!ok ? null : 'ok'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK_ROOT_R, { recursive: true, force: true })
    rmSync(LOGS_OLD, { recursive: true, force: true })
  }
}

console.log('')
if (failed === 0) console.log('ALL PASS')
else console.log(`${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
