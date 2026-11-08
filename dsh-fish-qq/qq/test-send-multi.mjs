/**
 * test-send-multi.mjs —— 分条发送 `qq_bridge_send_multi`（2026-10-28）
 *
 * 验收清单：
 *   参数：1–3 条字符串；空数组 / 4 条 / 空条目 / 非字符串全部拒绝，且**一条都不发**。
 *   发送：逐条按顺序发，私聊走 send_private_msg、群聊走 send_group_msg；
 *         两条之间随机停 500–1000ms（真等，不是只写在回执里）。
 *   回执：全部成功 → ok:true；中途失败 → ok:false + 已发几条 + 第几条失败 + 原因。
 *   marker：调用并发出去之后，这一轮的 [QQ]…[/QQ] 整段丢弃，不能重复发一遍。
 *   闸门：非 QQ 轮第一次调用只回确认、一个字不发（与 qq_bridge_send 同一道门）。
 *
 * 跑法：node test-send-multi.mjs（脚本式断言，与 test-subsend.mjs 同一套写法）
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 假 WebSocket：连得上、捕获出站帧、可指定某条文本失败 ─────────────────────
const wsSent = []
/** 命中的出站文本会让这一帧回 failed（测试「中途失败」用）。 */
let failText = null
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
    const segments = frame?.params?.message
    const text = Array.isArray(segments)
      ? segments.filter((s) => s?.type === 'text').map((s) => s?.data?.text ?? '').join('')
      : ''
    wsSent.push({ ...frame, at: Date.now(), text })
    if (failText !== null && text.includes(failText)) {
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({ echo: frame.echo, status: 'failed', retcode: 1200, message: 'mock send failed' }),
        })
      }, 0)
      return
    }
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

const {
  apply,
  buildUsagePrompt,
  multiSendGapMs,
  routeToolIntent,
  validateMultiSendMessages,
  MULTI_SEND_GAP_MAX_MS,
  MULTI_SEND_GAP_MIN_MS,
  MULTI_SEND_MAX,
} = await import('./index.js')

// ── 断言器 ────────────────────────────────────────────────────────────────
let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ══════════════════════════════════════════════════════════════════════════
// 第一部分：纯函数（参数校验 + 停顿取值的边界）
// ══════════════════════════════════════════════════════════════════════════
{
  check('上限常量是 3', MULTI_SEND_MAX === 3)
  check('停顿范围是 500–1000ms', MULTI_SEND_GAP_MIN_MS === 500 && MULTI_SEND_GAP_MAX_MS === 1000)

  const v = (m) => validateMultiSendMessages(m)
  check('校验：1 条通过', v(['你好'])?.ok === true && v(['你好']).messages.length === 1)
  check('校验：2 条通过', v(['一', '二'])?.ok === true)
  check('校验：3 条通过', v(['一', '二', '三'])?.ok === true)
  check('校验：3 条按顺序保留', JSON.stringify(v(['一', '二', '三']).messages) === JSON.stringify(['一', '二', '三']))
  check('校验：去首尾空白', v(['  一  ', ' 二 ']).messages[0] === '一' && v([' 一 ', ' 二 ']).messages[1] === '二')

  const four = v(['1', '2', '3', '4'])
  check('校验：4 条被拦下', four.ok === false && four.reason === 'too-many', JSON.stringify(four))
  check('校验：4 条的错误说明给出条数', String(four.message).includes('4'))
  const zero = v([])
  check('校验：空数组被拦下', zero.ok === false && zero.reason === 'empty', JSON.stringify(zero))
  check('校验：非数组被拦下', v('你好').ok === false && v(null).ok === false && v(undefined).ok === false)
  check('校验：空条目被拦下并指出第几条', (() => { const r = v(['好', '   ']); return r.ok === false && r.reason === 'empty-item' && r.index === 1 })())
  check('校验：非字符串条目被拦下', (() => { const r = v(['好', 42]); return r.ok === false && r.reason === 'bad-item' && r.index === 1 })())

  check('停顿：random=0 → 下限', multiSendGapMs(() => 0) === MULTI_SEND_GAP_MIN_MS)
  check('停顿：random≈1 → 上限', multiSendGapMs(() => 0.999999) === MULTI_SEND_GAP_MAX_MS)
  check('停顿：random=0.5 落在范围内', (() => { const g = multiSendGapMs(() => 0.5); return g >= 500 && g <= 1000 && Number.isInteger(g) })())
  check('停顿：random 抛错也不产生 NaN', (() => { const g = multiSendGapMs(() => { throw new Error('x') }); return g === 500 })())
  check('停顿：越界的 random 被夹住', multiSendGapMs(() => -5) === 500 && multiSendGapMs(() => 5) === 1000)
  // 默认 random（不注入）也必须始终落在范围内
  check('停顿：默认随机值始终在 500–1000', Array.from({ length: 50 }, () => multiSendGapMs()).every((g) => g >= 500 && g <= 1000))

  const prompt = buildUsagePrompt({ replyMaxChars: 1500, replyMode: 'marker' })
  check('提示词：不再常驻分条工具用法', !prompt.includes('qq_bridge_send_multi'))
  const routed = routeToolIntent('这些分条发')
  check('动态路由：分条意图当轮点名工具', routed.prompt.includes('qq_bridge_send_multi'))
  check('动态路由：写明调过之后不要再写 [QQ] 块', routed.prompt.includes('不要再写 [QQ] 块'))
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：真实 apply + 假 OneBot + 工具调用
// ══════════════════════════════════════════════════════════════════════════
const statePath = join(mkdtempSync(join(tmpdir(), 'qq-bridge-multi-')), 'state.json')
{
  const registered = []
  const handlers = {}
  let resolvedSettings = {}

  const agent = {
    id: 'session-multi',
    status: 'idle',
    session: { id: 'session-multi' },
    followups: [],
    followup(msg) {
      this.followups.push(msg)
      return Promise.resolve()
    },
    steer(msg) {
      this.followups.push(msg)
      return Promise.resolve()
    },
    inject() {},
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    settings: {
      register: (ns, schema, opts) => {
        resolvedSettings = { ...(opts?.base ?? {}) }
        return {}
      },
      get: () => resolvedSettings,
    },
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      roots: () => [],
      resume: async () => {
        throw new Error('send-multi-test: no resume')
      },
    },
    tools: { register: (def) => registered.push(def) },
    on: (name, fn) => {
      handlers[name] = fn
      return () => {}
    },
    effect: (fn) => {
      const d = fn?.()
      return () => d?.()
    },
    get: () => undefined,
  }
  ctx.inject = (_deps, cb) => cb(ctx)

  const config = {
    targetSessionId: 'session-multi',
    statePath,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3998',
    selfId: '99999999',
    whitelist: ['10001'],
    groupWhitelist: ['90001'],
    nicknames: ['244'],
    wakeProbability: 1,
    privateWakeProbability: 1,
    ownerQQ: '10001',
    replyMode: 'marker',
  }

  apply(ctx, config)

  const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
  const status = registered.find((t) => t.name === 'qq_bridge_status')
  const multi = registered.find((t) => t.name === 'qq_bridge_send_multi')
  check('工具：qq_bridge_send_multi 已注册', Boolean(multi))
  check('工具：原 qq_bridge_send 仍在（没有替换掉旧通道）', registered.some((t) => t.name === 'qq_bridge_send'))

  const sessionHandler = handlers['session/event']
  const fire = (type, data = {}) => sessionHandler({ id: 'session-multi' }, { type, data })
  const sends = (action) => wsSent.filter((f) => f.action === action)
  const openTransport = async () => {
    for (let i = 0; i < 100; i++) {
      const st = JSON.parse(await status.execute({}))
      if (st.transport?.state === 'open') return true
      await sleep(20)
    }
    return false
  }
  const opened = await openTransport()
  check('传输：假 OneBot 连接已建立', opened)

  /** 起一轮「QQ 唤醒」的轮：私聊（可选群聊）。 */
  const startQQTurn = async ({ text, userId = '10001', groupId, atSelf = false, turn }) => {
    agent.followups.length = 0
    const args = { text, userId, nickname: '主人', atSelf }
    if (groupId !== undefined) args.groupId = groupId
    await sim.execute(args)
    check(`轮：${text} 被唤醒`, agent.followups.length === 1)
    fire('turn/start', { turn })
  }

  // ── 场景 1：非 QQ 轮第一次调用只回确认（同一道来源闸门）─────────────────
  {
    wsSent.length = 0
    const r = JSON.parse(await multi.execute({ messages: ['一', '二'] }))
    check('闸门：非 QQ 轮第一次只回确认', r.sent === 0 && r.needsConfirm === true, JSON.stringify(r))
    check('闸门：确认那一次一个字都没发', wsSent.length === 0)
  }

  // ── 场景 2：2 条真的分开发、且中间有停顿 ────────────────────────────────
  {
    await startQQTurn({ text: '分两条说', turn: 1 })
    wsSent.length = 0
    const r = JSON.parse(await multi.execute({ messages: ['第一句：你好。', '第二句：今天怎么样？'] }))
    check('发送：2 条返回成功', r.ok === true && r.sent === 2 && r.total === 2, JSON.stringify(r))
    const frames = sends('send_private_msg')
    check('发送：私聊走 send_private_msg，恰好 2 帧', frames.length === 2, JSON.stringify(wsSent.map((f) => f.action)))
    check('发送：第 1 条正文正确', frames[0]?.text === '第一句：你好。', JSON.stringify(frames[0]?.text))
    check('发送：第 2 条正文正确', frames[1]?.text === '第二句：今天怎么样？', JSON.stringify(frames[1]?.text))
    const gap = frames[1].at - frames[0].at
    check('发送：两条之间有 500–1000ms 的间隔', gap >= 480 && gap <= 1300, `gap=${gap}ms`)
    check('发送：回执写明条间停顿', Array.isArray(r.gapsMs) && r.gapsMs.length === 1 && r.gapsMs[0] >= 500 && r.gapsMs[0] <= 1000, JSON.stringify(r.gapsMs))
    const st = JSON.parse(await status.execute({}))
    check('台账：2 条都记进 outbox（action=multi）', st.recentOutbox.filter((o) => o.via === 'tool' && o.action === 'multi').length === 2)
  }

  // ── 场景 3：marker 模式不重复发送 ───────────────────────────────────────
  {
    // 同一轮里模型照老习惯把整段话又包进 [QQ] 块
    fire('assistant/message', {
      message: { content: [{ type: 'text', text: '[QQ]第一句：你好。 第二句：今天怎么样？[/QQ]' }] },
    })
    wsSent.length = 0
    fire('turn/end', { reason: { kind: 'completed' } })
    await sleep(80) // 给可能发生的异步出站留出时间
    check('marker：分条发过之后，[QQ] 块整段丢弃（没有第 3 帧）', wsSent.length === 0, JSON.stringify(wsSent.map((f) => f.text)))
  }

  // ── 场景 4：4 条被参数校验拦下 ──────────────────────────────────────────
  {
    await startQQTurn({ text: '这次给四条', turn: 2 })
    wsSent.length = 0
    const r = JSON.parse(await multi.execute({ messages: ['1', '2', '3', '4'] }))
    check('校验：4 条被拦下、回执 ok:false', r.ok === false && r.reason === 'too-many', JSON.stringify(r))
    check('校验：4 条时一条都没发', wsSent.length === 0)
    check('校验：4 条时 sent=0', r.sent === 0)
  }

  // ── 场景 5：空数组被拦下 ────────────────────────────────────────────────
  {
    wsSent.length = 0
    const r = JSON.parse(await multi.execute({ messages: [] }))
    check('校验：空数组被拦下', r.ok === false && r.reason === 'empty' && r.sent === 0, JSON.stringify(r))
    check('校验：空数组时一条都没发', wsSent.length === 0)
  }

  // ── 场景 6：3 条按顺序发（边界值能过）──────────────────────────────────
  {
    wsSent.length = 0
    const r = JSON.parse(await multi.execute({ messages: ['甲', '乙', '丙'] }))
    const frames = sends('send_private_msg')
    check('边界：3 条能发', r.ok === true && r.sent === 3 && frames.length === 3, JSON.stringify(r))
    check('边界：3 条顺序正确', frames.map((f) => f.text).join(',') === '甲,乙,丙')
  }
  // 这一轮也带了标记块：同样应当丢弃
  fire('assistant/message', { message: { content: [{ type: 'text', text: '[QQ]甲乙丙[/QQ]' }] } })
  wsSent.length = 0
  fire('turn/end', { reason: { kind: 'completed' } })
  await sleep(80)
  check('marker：3 条那轮也没有重复发', wsSent.length === 0)

  // ── 场景 7：群聊走 send_group_msg ───────────────────────────────────────
  {
    await startQQTurn({ text: '群里说两句', userId: '20002', groupId: '90001', atSelf: true, turn: 3 })
    wsSent.length = 0
    const r = JSON.parse(await multi.execute({ messages: ['群里第一句', '群里第二句'] }))
    const frames = sends('send_group_msg')
    check('群聊：走 send_group_msg，恰好 2 帧', r.ok === true && frames.length === 2, JSON.stringify(r))
    check('群聊：group_id 正确', frames.every((f) => String(f?.params?.group_id) === '90001'))
    check('群聊：正文按顺序', frames[0]?.text === '群里第一句' && frames[1]?.text === '群里第二句')
    check('群聊：私聊通道没被误用', sends('send_private_msg').length === 0)
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // ── 场景 8：中途失败如实返回，不报成功 ─────────────────────────────────
  {
    await startQQTurn({ text: '第二条会失败', turn: 4 })
    wsSent.length = 0
    failText = '第二条必失败'
    const r = JSON.parse(await multi.execute({ messages: ['第一条正常', '第二条必失败', '第三条不该发'] }))
    failText = null
    check('失败：回执 ok:false（不报成功）', r.ok === false, JSON.stringify(r))
    check('失败：如实说明已发出 1 条', r.sent === 1, JSON.stringify(r))
    check('失败：指出第 2 条失败', r.failedAt === 2, JSON.stringify(r))
    check('失败：原因带 send-failed 与原始错误', r.reason === 'send-failed' && String(r.error).includes('retcode=1200'), JSON.stringify(r))
    const frames = sends('send_private_msg')
    check('失败：第 3 条没有继续发', frames.length === 2 && !frames.some((f) => f.text === '第三条不该发'), JSON.stringify(frames.map((f) => f.text)))
    check('失败：已发出的那条仍记进 outbox', JSON.parse(await status.execute({})).recentOutbox.some((o) => o.action === 'multi' && o.text === '第一条正常'))
  }
  // 已经有一条真的到了 QQ：这一轮的标记块也不能再整段补发（否则第一条重复）
  fire('assistant/message', { message: { content: [{ type: 'text', text: '[QQ]第一条正常 第二条必失败[/QQ]' }] } })
  wsSent.length = 0
  fire('turn/end', { reason: { kind: 'completed' } })
  await sleep(80)
  check('失败：部分成功那轮同样不重复发标记块', wsSent.length === 0)

  // ── 场景 9：全部失败时标记块不被吞掉（一个字都没到，不该跟着丢）────────
  {
    await startQQTurn({ text: '全都会失败', turn: 5 })
    wsSent.length = 0
    failText = '全都失败'
    const r = JSON.parse(await multi.execute({ messages: ['全都失败一', '全都失败二'] }))
    failText = null
    check('失败：全失败时 sent=0', r.ok === false && r.sent === 0, JSON.stringify(r))
    fire('assistant/message', { message: { content: [{ type: 'text', text: '[QQ]全失败后的整段回复[/QQ]' }] } })
    wsSent.length = 0
    fire('turn/end', { reason: { kind: 'completed' } })
    await sleep(80)
    check('失败：全失败时标记块照常发出（不吞消息）', sends('send_private_msg').length === 1 && sends('send_private_msg')[0]?.text === '全失败后的整段回复', JSON.stringify(wsSent.map((f) => f.text)))
  }

  // ── 场景 10：空数组/4 条被拦时，标记块照常工作（没发过就不该抑制）──────
  {
    await startQQTurn({ text: '参数被拦也要能回', turn: 6 })
    wsSent.length = 0
    await multi.execute({ messages: ['1', '2', '3', '4'] })
    check('校验：被拦时确实没发', wsSent.length === 0)
    fire('assistant/message', { message: { content: [{ type: 'text', text: '[QQ]参数被拦后照常回复[/QQ]' }] } })
    fire('turn/end', { reason: { kind: 'completed' } })
    await sleep(80)
    check('校验：被拦不影响标记块出站', sends('send_private_msg').length === 1 && sends('send_private_msg')[0]?.text === '参数被拦后照常回复', JSON.stringify(wsSent.map((f) => f.text)))
  }
}

// ══════════════════════════════════════════════════════════════════════════
if (existsSync(statePath)) rmSync(statePath, { force: true })

console.log('')
if (failed === 0) {
  console.log('ALL PASS')
} else {
  console.log(`${failed} FAILED`)
}

// 传输还在退避重连，定时器会拖住事件循环；结论已经出完，直接退出。
process.exit(failed === 0 ? 0 : 1)
