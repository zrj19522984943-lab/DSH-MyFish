/**
 * test-checklog-agent.mjs —— 任务完成日志 · agent 档（任务书 5，2026-10-28）
 *
 * 任务书 5 的验收：
 *   1. 切 agent 档 → 收到**她说的话**，不是模板：
 *      checklog/finished → 投「处境」给她的会话（followup）→ 她那一轮的
 *      assistant/message → turn/end → 她写的话 send_private_msg 发主人（绕 replyMode）。
 *   2. 切 system 档 → 收到模板（这一档的完整链路在任务书 4 的 wire 测试里，
 *      这里只断言同一件事不会走到 agent 通道——没有 followup）。
 *   3. 切 off → 没消息。
 *   兜底：agent 档她没生成文本 → 退回 system 模板发一条，别静默。
 *
 * 与 test-checklog-wire.mjs 的分工：那边验「fish 写日志 → 事件 → system 通知」
 * 的接线；这边验「事件 → agent 通道 → 她说的话 → 发主人」这一段，所以事件
 * 直接喂（载荷与 fish 侧 buildTaskResult 一致）；只有验收 1 走完整的派活链路。
 *
 * 跑法：node test-checklog-agent.mjs（与其它 test-*.mjs 同一套假 WS 手法）
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
import { join } from 'node:path'

const { apply } = await import('./index.js')
// 只在验收 1 里开动「派活」那一端，复刻合并包里 fish 与 qq 共用一个 ctx 的装配
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
const lastFrameText = () => {
  const f = sendFrames()[sendFrames().length - 1]
  return String(f?.params?.message?.[0]?.data?.text ?? '')
}

// ── 假宿主：agents.get(id) 返回「她那条会话」的假 agent ──────────────────────
const TARGET = 'session-her'
function makeCtxWithAgent() {
  const handlers = {}
  const offs = []
  const registered = []
  const agentState = { injected: [], followups: 0, status: 'idle', rejectWith: null, throwInFollowup: null }
  const fakeAgent = {
    id: TARGET,
    get status() {
      return agentState.status
    },
    ctx: { get: () => undefined, effect: () => () => {} },
    // 真机顺序：注入的 user/message → turn/start（**同步**，就在 followup 里面）
    followup: (msg) => {
      agentState.followups += 1
      agentState.injected.push(String(msg?.content?.[0]?.text ?? ''))
      fireEvent(handlers, TARGET, { type: 'user/message', data: msg })
      fireEvent(handlers, TARGET, { type: 'turn/start', data: { turn: 1 } })
    },
  }
  const ctx = {
    logger: { info() {}, warn: (...a) => console.error('[test-warn]', ...a) },
    settings: {},
    agents: {
      get: (id) => (id === TARGET ? fakeAgent : undefined),
      roots: () => [],
      resume: async () => { throw new Error('agent-test: 不该走 resume') },
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
  return { ctx, handlers, offs, registered, agentState, fakeAgent }
}

async function boot(config) {
  const c = makeCtxWithAgent()
  apply(c.ctx, config)
  const statusTool = c.registered.find((t) => t?.name === 'qq_bridge_status')
  const status = async () => JSON.parse(await statusTool.execute({}))
  return { ...c, status }
}

/** 喂一条「fish 刚写完日志」的事件（直接调注册的监听，等于 ctx.emit 派发）。 */
function feedChecklogFinished(handlers, result) {
  for (const fn of [...(handlers['checklog/finished'] || [])]) fn(result)
}

/** 喂一条会话事件（session/event 的两个参数：session 与 event）。 */
function fireEvent(handlers, sessionId, event) {
  for (const fn of [...(handlers['session/event'] || [])]) fn({ id: sessionId }, event)
}

/** 她说了一句 / 几句（assistant/message 攒进 pendingReply）。 */
function sheSays(handlers, sessionId, text) {
  fireEvent(handlers, sessionId, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })
}

/** 她那一轮结束。 */
function herTurnEnds(handlers, sessionId, kind = 'completed') {
  fireEvent(handlers, sessionId, { type: 'turn/end', data: { reason: { kind } } })
}

/** 一条失败任务的结果（契约对齐 fish 侧 buildTaskResult）。 */
function failedResult() {
  const endedAt = Date.now()
  return {
    ok: false,
    reason: 'error',
    task: '在 workspace 里写一个 hello.py',
    sessionTitle: '工作·hello.py',
    sessionId: 'session-task',
    status: '失败（出错）',
    startedAt: endedAt - 90_000,
    endedAt,
    elapsedMs: 90_000,
    file: 'D:/CheckLogs/20261028-120000-abc12345.md',
  }
}

/** 读落盘的 state（帧可见时发送链可能还没走完，等条件成立再读）。 */
async function readState(statePath, pred = () => true, timeoutMs = 3000) {
  for (let i = 0; i < timeoutMs / 20; i++) {
    try {
      const st = JSON.parse(readFileSync(statePath, 'utf8'))
      if (pred(st)) return st
    } catch {
      // 文件还没写出来：下一轮再试
    }
    await sleep(20)
  }
  return null
}

// ══════════════════════════════════════════════════════════════════════════
// 地基：mode=off → 没消息；system 档 → 不走 agent 通道
// ══════════════════════════════════════════════════════════════════════════
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-agent-off-'))
  const b = await boot({
    debugTools: true,
    statePath: join(dir, 'state.json'),
    onebotUrl: 'ws://127.0.0.1:3999',
    targetSessionId: TARGET,
    ownerQQ: '10001',
    // mode 不配 = 默认 'off'
    napcatInstallDir: join(dir, 'napcat-absent'),
  })
  try {
    check('传输：假 OneBot 已连上', await waitFor(async () => (await b.status()).transport.state === 'open'))
    const before = sendFrames().length
    feedChecklogFinished(b.handlers, failedResult())
    await sleep(120)
    check('地基：mode=off → 一条都不发', sendFrames().length === before, JSON.stringify({ before, now: sendFrames().length }))
    check('地基：mode=off → 没有 followup', b.agentState.followups === 0)

    // system 档也不走 agent 通道（模板路径由 wire 测试验，这里只确认不分流错）
    await writeSettingsFlip(b, dir, { checklogNotifyMode: 'system' })
    feedChecklogFinished(b.handlers, failedResult())
    await waitFor(() => sendFrames().length === before + 1)
    check('分流：system 档 → 没 followup（那条是模板路径）', b.agentState.followups === 0)
    check('分流：system 档 → 收到的是模板', lastFrameText().startsWith('[任务通知]'), lastFrameText().slice(0, 40))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 走设置文件那条路改设置（0.2.0 的真实路径），写完就生效。 */
async function writeSettingsFlip(b, dir, values) {
  const settingsPath = join(dir, 'qq-bridge-settings.json')
  writeFileSync(settingsPath, `${JSON.stringify({ version: 1, values }, null, 2)}\n`)
  return (await b.status()).settings
}

// ══════════════════════════════════════════════════════════════════════════
// 验收 1（端到端）：agent 档 → 收到她说的话，不是模板
// ══════════════════════════════════════════════════════════════════════════
const WORK_ROOT = mkdtempSync(join(tmpdir(), 'dsh-fish-agent-w-'))
const LOGS = mkdtempSync(join(tmpdir(), 'dsh-fish-agent-logs-'))
writeFileSync(join(WORK_ROOT, 'config.json'), `${JSON.stringify({ work: { perDay: 10 } }, null, 2)}\n`)
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-agent-a-'))
  const b = await boot({
    debugTools: true,
    statePath: join(dir, 'state.json'),
    onebotUrl: 'ws://127.0.0.1:3999',
    targetSessionId: TARGET,
    ownerQQ: '10001',
    checklogNotifyMode: 'agent',
    checklogNotifyOnSuccess: false,
    checklogNotifyDailyLimit: 5,
    checklogNotifyTarget: 'owner',
    napcatInstallDir: join(dir, 'napcat-absent'),
  })
  const statePath = (await b.status()).statePath
  try {
    check('接线：checklog/finished 监听只有一个（apply 一次挂一个）', (b.handlers['checklog/finished'] || []).length === 1)

    // 用**同一个 ctx** 派一件必然失败的活 —— 复刻合并包里 fish 与 qq 共用一个 ctx 的装配
    await dispatchWork(b.ctx, '在 workspace 里写一个 hello.py', {
      root: WORK_ROOT,
      dir: WORK_ROOT,
      log: () => {},
      checkLogsDir: LOGS,
    })
    const framesBefore = sendFrames().length
    // 派的那一轮结束（error）→ fish 写日志 → emit checklog/finished → 投「处境」
    for (const fn of [...(b.handlers['session/event'] || [])]) {
      fn({ id: 'session-task' }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    }
    // 写日志是异步的，且「写成了才 emit」：followup 到了 = 日志一定成了
    await waitFor(() => b.agentState.followups === 1)
    check('验收1：CheckLogs 日志写成了', readdirSync(LOGS).length === 1, JSON.stringify(readdirSync(LOGS).length))
    check('验收1：处境投给了她（followup 一次）', b.agentState.followups === 1, String(b.agentState.followups))
    const situation = b.agentState.injected[0]
    check('验收1：处境是她能看懂的一句话', situation.startsWith('你刚派出去的活儿有结果了：') && situation.includes('结果=失败了：出错') && situation.endsWith('用一句话跟主人说一声。'), situation)

    // 她那一轮：说一句话 → 结束 → 她的话发给主人
    sheSays(b.handlers, TARGET, '主人，那个 hello.py 我没写成，跑到一半报错了，晚点我再看看。')
    herTurnEnds(b.handlers, TARGET, 'completed')
    const got = await waitFor(() => sendFrames().length === framesBefore + 1)
    check('验收1：QQ 收到了 send_private_msg 帧', got, JSON.stringify(sendFrames().length - framesBefore))

    const frame = sendFrames()[sendFrames().length - 1]
    check('验收1：发给主人', String(frame?.params?.user_id) === '10001', String(frame?.params?.user_id))
    check('验收1：正文是她说的那句话（不是模板）', lastFrameText() === '主人，那个 hello.py 我没写成，跑到一半报错了，晚点我再看看。', lastFrameText())

    const st = await readState(statePath, (s) => s?.checklogNotify?.count === 1)
    check('验收1：state.json 落盘了', st !== null)
    check('验收1：计数 +1（与 system 档同一个额度池）', st?.checklogNotify?.count === 1, JSON.stringify(st?.checklogNotify))
    check('验收1：outbox via=checklog 且 spokenBy=agent（知道这条是谁写的）', (st?.outbox || []).some((o) => o.via === 'checklog' && o.spokenBy === 'agent' && o.text.includes('跑到一半报错了')), JSON.stringify((st?.outbox || []).find((o) => o.via === 'checklog')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK_ROOT, { recursive: true, force: true })
    rmSync(LOGS, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 验收 3（兜底）：agent 档她没生成文本 → 退回 system 模板，别静默
// ══════════════════════════════════════════════════════════════════════════
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-agent-b-'))
  const b = await boot({
    debugTools: true,
    statePath: join(dir, 'state.json'),
    onebotUrl: 'ws://127.0.0.1:3999',
    targetSessionId: TARGET,
    ownerQQ: '10001',
    checklogNotifyMode: 'agent',
    napcatInstallDir: join(dir, 'napcat-absent'),
  })
  const statePath = (await b.status()).statePath
  try {
    feedChecklogFinished(b.handlers, failedResult())
    // followup 是异步链（ensureTargetAsync 等），等它落地再往下
    await waitFor(() => b.agentState.followups === 1)
    check('兜底：处境投给她了', b.agentState.followups === 1, String(b.agentState.followups))
    // 她一个字都没说，轮直接结束
    herTurnEnds(b.handlers, TARGET, 'completed')
    const got = await waitFor(() => sendFrames().length >= 1 && lastFrameText().startsWith('[任务通知]'))
    check('兜底：收到的是模板一条（不是静默）', got, lastFrameText().slice(0, 60))
    check('兜底：模板说的是失败那一句', lastFrameText().includes('失败了：出错'), lastFrameText())
    const st = await readState(statePath, (s) => s?.checklogNotify?.count === 1)
    check('兜底：模板那条也正常计数', st?.checklogNotify?.count === 1, JSON.stringify(st?.checklogNotify))
    check('兜底：outbox spokenBy=template（知道这条是兜底）', (st?.outbox || []).some((o) => o.via === 'checklog' && o.spokenBy === 'template'), JSON.stringify((st?.outbox || []).find((o) => o.via === 'checklog')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 验收 4：agent 档，成功任务默认不投给她；开 onSuccess 后才投
// ══════════════════════════════════════════════════════════════════════════
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-agent-c-'))
  const b = await boot({
    debugTools: true,
    statePath: join(dir, 'state.json'),
    onebotUrl: 'ws://127.0.0.1:3999',
    targetSessionId: TARGET,
    ownerQQ: '10001',
    checklogNotifyMode: 'agent',
    checklogNotifyOnSuccess: false,
    napcatInstallDir: join(dir, 'napcat-absent'),
  })
  try {
    const okResult = { ...failedResult(), ok: true, reason: 'completed', status: '成功' }
    const framesBefore = sendFrames().length
    feedChecklogFinished(b.handlers, okResult)
    await sleep(120)
    check('成功口径：默认不理她（成功是本分，不投不卖）', b.agentState.followups === 0 && sendFrames().length === framesBefore, JSON.stringify({ followups: b.agentState.followups, frames: sendFrames().length - framesBefore }))

    const sFlip = await writeSettingsFlip(b, dir, { checklogNotifyOnSuccess: true })
    check('成功口径：设置文件写进去、读出来已生效', sFlip.checklogNotifyOnSuccess === true, JSON.stringify(sFlip.checklogNotifyOnSuccess))
    feedChecklogFinished(b.handlers, okResult)
    await waitFor(() => b.agentState.followups === 1)
    check('成功口径：开了 onSuccess → 处境投给她', b.agentState.followups === 1, String(b.agentState.followups))
    check('成功口径：处境里结果是「完成了」', b.agentState.injected[0].includes('结果=完成了'), b.agentState.injected[0].slice(0, 60))
    sheSays(b.handlers, TARGET, '主人，hello.py 写好了，能跑。')
    herTurnEnds(b.handlers, TARGET, 'completed')
    const got = await waitFor(() => sendFrames().length === framesBefore + 1)
    check('成功口径：她说的话发主人了', got && lastFrameText() === '主人，hello.py 写好了，能跑。', lastFrameText())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 边界：她在说上一句时又来一件事 → 这件用模板兜底（不排队、不等她）
// ══════════════════════════════════════════════════════════════════════════
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-agent-d-'))
  const b = await boot({
    debugTools: true,
    statePath: join(dir, 'state.json'),
    onebotUrl: 'ws://127.0.0.1:3999',
    targetSessionId: TARGET,
    ownerQQ: '10001',
    checklogNotifyMode: 'agent',
    napcatInstallDir: join(dir, 'napcat-absent'),
  })
  const statePath = (await b.status()).statePath
  try {
    feedChecklogFinished(b.handlers, failedResult())
    await waitFor(() => b.agentState.followups === 1)
    check('排队：第一件投给她了', b.agentState.followups === 1)
    // 第一件她还没回完，第二件又来了
    const framesBefore = sendFrames().length
    feedChecklogFinished(b.handlers, { ...failedResult(), task: '修一下 README 的错别字', sessionTitle: '工作·修README' })
    await waitFor(() => sendFrames().length === framesBefore + 1)
    check('排队：第二件没再投（她的轮还占着）', b.agentState.followups === 1, String(b.agentState.followups))
    check('排队：第二件走模板发出去了', lastFrameText().startsWith('[任务通知]') && lastFrameText().includes('修README'), lastFrameText().slice(0, 60))
    // 兜底那条的发送链走完（回复帧往返）再让她说完，免得两次发送抢同一个 count=0+1
    await readState(statePath, (s) => s?.checklogNotify?.count === 1)

    // 然后她把第一件说完了 → 她的话照常发
    const framesBefore2 = sendFrames().length
    sheSays(b.handlers, TARGET, '主人，hello.py 那个我看了，是报错了。')
    herTurnEnds(b.handlers, TARGET, 'completed')
    const got = await waitFor(() => sendFrames().length === framesBefore2 + 1)
    check('排队：她把第一件说完 → 照常发她说的话', got && lastFrameText() === '主人，hello.py 那个我看了，是报错了。', lastFrameText())
    const st = await readState(statePath, (s) => s?.checklogNotify?.count === 2)
    check('排队：两件各占一条额度', st?.checklogNotify?.count === 2, JSON.stringify(st?.checklogNotify))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 边界：agent 档但拿不到她 → 退回模板（别因为通道坏了就把事吞了）
// ══════════════════════════════════════════════════════════════════════════
{
  // 没配 targetSessionId → ensureTargetAgent 那一步就回退
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-agent-e-'))
  const b = await boot({
    debugTools: true,
    statePath: join(dir, 'state.json'),
    onebotUrl: 'ws://127.0.0.1:3999',
    ownerQQ: '10001',
    checklogNotifyMode: 'agent',
    napcatInstallDir: join(dir, 'napcat-absent'),
  })
  try {
    check('没会话：传输已连上', await waitFor(async () => (await b.status()).transport.state === 'open'))
    const framesBefore = sendFrames().length
    feedChecklogFinished(b.handlers, failedResult())
    const got = await waitFor(() => sendFrames().length === framesBefore + 1)
    check('没会话：没投成 followup', b.agentState.followups === 0)
    check('没会话：退回模板发了一条', got && lastFrameText().startsWith('[任务通知]'), lastFrameText().slice(0, 60))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
if (failed === 0) {
  console.log('ALL PASS')
} else {
  console.log(`${failed} FAILED`)
}
process.exit(failed === 0 ? 0 : 1)
