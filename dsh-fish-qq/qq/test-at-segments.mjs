/**
 * test-at-segments.mjs —— 出站 `@QQ号` → 真正的 at 消息段（2026-10-28）
 *
 * 验收清单：
 *   纯函数：`@10001` → at 段；`@昵称` / `@1234` / 邮箱里的 @ → 保持纯文本；
 *           一条消息多个 @、@ 在中间 → 按顺序切成 text/at/text/…，文字原样不动；
 *           显式 atQQ（单个 / 逗号串 / 数组）拼在最前；正文已 @ 同一个号时不重复。
 *   出站路径：qq_bridge_send / qq_bridge_send_multi / qq_bridge_subsend / 标记块
 *           四条路发出去的 OneBot 帧里都带 at 段（不是正文里的 `@123456` 字符串）。
 *
 * 跑法：node test-at-segments.mjs（脚本式断言，与 test-send-multi.mjs 同一套写法）
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 假 WebSocket：连得上、捕获出站帧 ─────────────────────────────────────────
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
    wsSent.push({ ...frame, at: Date.now() })
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

const { apply, buildMessageSegments, normalizeAtTargets } = await import('./index.js')

// ── 断言器 ────────────────────────────────────────────────────────────────
let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = (v) => JSON.stringify(v)
/** 把消息段还原成“人看到的字”，用来验证正文一个字都没变。 */
const render = (segs) =>
  (Array.isArray(segs) ? segs : [])
    .map((s) => (s?.type === 'at' ? `@${s?.data?.qq}` : String(s?.data?.text ?? '')))
    .join('')
const ats = (segs) => (Array.isArray(segs) ? segs : []).filter((s) => s?.type === 'at').map((s) => String(s?.data?.qq))
const texts = (segs) => (Array.isArray(segs) ? segs : []).filter((s) => s?.type === 'text').map((s) => s?.data?.text)

// ══════════════════════════════════════════════════════════════════════════
// 第一部分：纯函数
// ══════════════════════════════════════════════════════════════════════════
{
  const plain = buildMessageSegments('今天天气不错')
  check('纯文本：只剩一个 text 段（与旧行为一致）',
    plain.length === 1 && plain[0].type === 'text' && plain[0].data.text === '今天天气不错', j(plain))

  const one = buildMessageSegments('@10001 你好')
  check('数字 @：转成 at 段 + 后面的文字',
    one.length === 2 && one[0].type === 'at' && one[0].data.qq === '10001' && one[1].data.text === ' 你好', j(one))
  check('数字 @：正文一个字都没丢', render(one) === '@10001 你好', render(one))

  const middle = buildMessageSegments('你好 @10001 在吗')
  check('@ 在中间：前面的文字原样保留',
    middle.length === 3 && middle[0].data.text === '你好 ' && middle[1].type === 'at' && middle[2].data.text === ' 在吗', j(middle))
  check('@ 在中间：还原后与原文一致', render(middle) === '你好 @10001 在吗', render(middle))

  const two = buildMessageSegments('@10001 和 @20002 你好')
  check('多个 @：按顺序两个 at 段',
    ats(two).join(',') === '10001,20002' && texts(two).join('|') === ' 和 | 你好', j(two))
  check('多个 @：还原后与原文一致', render(two) === '@10001 和 @20002 你好', render(two))

  const atOnly = buildMessageSegments('@10001')
  check('只有 @：只有 at 段，没有空 text 段',
    atOnly.length === 1 && atOnly[0].type === 'at' && ats(atOnly).join(',') === '10001', j(atOnly))

  // 不该转的（宁可不 @，也不能误 @）
  const nickname = buildMessageSegments('@小明 你好')
  check('昵称 @：保持纯文本，不猜 QQ 号',
    nickname.length === 1 && nickname[0].type === 'text' && nickname[0].data.text === '@小明 你好', j(nickname))
  check('太短的号：保持纯文本', texts(buildMessageSegments('@1234 你好')).join('') === '@1234 你好')
  check('太长的号（13 位）：保持纯文本',
    texts(buildMessageSegments('@1234567890123 你好')).join('') === '@1234567890123 你好')
  const email = buildMessageSegments('写信到 name@123456.com 就行')
  check('邮箱里的 @：保持纯文本', email.length === 1 && email[0].type === 'text', j(email))
  const glued = buildMessageSegments('abc@123456 不是提及')
  check('紧贴字母的 @：保持纯文本', glued.length === 1 && glued[0].type === 'text', j(glued))
  check('@全体成员：保持纯文本', buildMessageSegments('@全体成员 开会了').length === 1)

  // 显式 at 目标
  const explicit = buildMessageSegments('你好', { atQQ: '20002' })
  check('显式 atQQ：拼在最前面', explicit[0]?.type === 'at' && explicit[0].data.qq === '20002' && explicit[1].data.text === '你好', j(explicit))
  const explicitList = buildMessageSegments('你好', { atQQ: '20002, 30003' })
  check('显式 atQQ：逗号串拆成两个 at 段', ats(explicitList).join(',') === '20002,30003', j(explicitList))
  const explicitArr = buildMessageSegments('你好', { atQQ: ['20002', '@30003', '不是号'] })
  check('显式 atQQ：数组也只留合法号', ats(explicitArr).join(',') === '20002,30003', j(explicitArr))
  const noDup = buildMessageSegments('@10001 你好', { atQQ: '10001' })
  check('显式 atQQ 与正文重复：不重复加 at 段', ats(noDup).join(',') === '10001', j(noDup))
  const badExplicit = buildMessageSegments('你好', { atQQ: '小明' })
  check('显式 atQQ 不是号：忽略它，正文照发',
    badExplicit.length === 1 && badExplicit[0].type === 'text', j(badExplicit))

  check('空文本：没有段（调用方本来也会判空）', buildMessageSegments('').length === 0)
  check('normalizeAtTargets：去重', normalizeAtTargets(['10001', '10001']).length === 1)
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：真实 apply + 假 OneBot + 四条出站路径
// ══════════════════════════════════════════════════════════════════════════
const statePath = join(mkdtempSync(join(tmpdir(), 'qq-bridge-at-')), 'state.json')
{
  const registered = []
  const handlers = {}
  let resolvedSettings = {}

  const agent = {
    id: 'session-at',
    status: 'idle',
    session: { id: 'session-at' },
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
        throw new Error('at-segments-test: no resume')
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
    targetSessionId: 'session-at',
    statePath,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3997',
    selfId: '99999999',
    whitelist: ['10001'],
    groupWhitelist: ['90001'],
    nicknames: ['244'],
    wakeProbability: 1,
    privateWakeProbability: 1,
    ownerQQ: '10001',
    replyMode: 'marker',
    subsendEnabled: true,
    subsendDailyLimit: 10,
    subsendCooldownSeconds: 0,
  }

  apply(ctx, config)

  const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
  const status = registered.find((t) => t.name === 'qq_bridge_status')
  const send = registered.find((t) => t.name === 'qq_bridge_send')
  const multi = registered.find((t) => t.name === 'qq_bridge_send_multi')
  const subsend = registered.find((t) => t.name === 'qq_bridge_subsend')
  check('工具：四条出站路径都在', Boolean(send && multi && subsend && sim))

  const sessionHandler = handlers['session/event']
  const fire = (type, data = {}) => sessionHandler({ id: 'session-at' }, { type, data })
  const sends = (action) => wsSent.filter((f) => f.action === action)
  const segmentsOf = (frame) => frame?.params?.message
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

  const startQQTurn = async ({ text, userId = '10001', groupId, atSelf = false, turn }) => {
    agent.followups.length = 0
    const args = { text, userId, nickname: '主人', atSelf }
    if (groupId !== undefined) args.groupId = groupId
    await sim.execute(args)
    check(`轮：${text} 被唤醒`, agent.followups.length === 1)
    fire('turn/start', { turn })
  }

  // ── 场景 1：qq_bridge_send 把数字 @ 变成 at 段 ──────────────────────────
  {
    await startQQTurn({ text: '发一条带 @ 的', turn: 1 })
    wsSent.length = 0
    const r = JSON.parse(await send.execute({ text: '你好 @10001 在吗' }))
    check('send：回执成功', r.sent === 1, j(r))
    const segs = segmentsOf(sends('send_private_msg')[0])
    check('send：帧里有 at 段，qq 号正确', ats(segs).join(',') === '10001', j(segs))
    check('send：at 后面的文字分成了 text 段', render(segs) === '你好 @10001 在吗', render(segs))
    check('send：不再是正文里的纯文本 @',
      !texts(segs).some((t) => t.includes('@10001')), j(texts(segs)))
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 2：显式 atQQ ───────────────────────────────────────────────────
  {
    await startQQTurn({ text: '显式指定 at', turn: 2 })
    wsSent.length = 0
    await send.execute({ text: '看这个', atQQ: '20002' })
    const segs = segmentsOf(sends('send_private_msg')[0])
    check('send：显式 atQQ 变成 at 段且在最前', segs?.[0]?.type === 'at' && segs[0].data.qq === '20002', j(segs))
    check('send：显式 at 后面的正文还在', render(segs) === '@20002看这个', render(segs))
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 3：昵称 @ 保持纯文本 ───────────────────────────────────────────
  {
    await startQQTurn({ text: '昵称 @ 不算提及', turn: 3 })
    wsSent.length = 0
    await send.execute({ text: '@小明 你好呀' })
    const segs = segmentsOf(sends('send_private_msg')[0])
    check('send：昵称 @ 不产生 at 段', ats(segs).length === 0, j(segs))
    check('send：昵称 @ 原样留在 text 里', texts(segs).join('') === '@小明 你好呀', j(segs))
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 4：分条发送：正文 @ 与显式 atQQ（只加第 1 条）───────────────────
  {
    await startQQTurn({ text: '分两条带 at', turn: 4 })
    wsSent.length = 0
    const r = JSON.parse(await multi.execute({
      messages: ['@10001 第一句', '第二句 @20002'],
      atQQ: '30003',
    }))
    const frames = sends('send_private_msg')
    check('multi：两条都发出', r.ok === true && frames.length === 2, j(r))
    const first = segmentsOf(frames[0])
    const second = segmentsOf(frames[1])
    check('multi：第 1 条 = 显式 at + 正文 at（顺序）', ats(first).join(',') === '30003,10001', j(first))
    check('multi：第 2 条只有正文里的 at', ats(second).join(',') === '20002', j(second))
    check('multi：两条正文都没丢', render(first) === '@30003@10001 第一句' && render(second) === '第二句 @20002',
      `${render(first)} | ${render(second)}`)
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 5：subsend 通道同样转 at 段 ────────────────────────────────────
  {
    await startQQTurn({ text: 'subsend 10001 主人让转告', turn: 5 })
    wsSent.length = 0
    const r = JSON.parse(await subsend.execute({ targetQQ: '30003', message: '@10001 主人让你回个电话' }))
    check('subsend：回执成功', r.ok === true, j(r))
    const frame = sends('send_private_msg')[0]
    check('subsend：发给指定的人', String(frame?.params?.user_id) === '30003', j(frame?.params))
    const segs = segmentsOf(frame)
    check('subsend：帧里有 at 段', ats(segs).join(',') === '10001', j(segs))
    check('subsend：正文完整', render(segs) === '@10001 主人让你回个电话', render(segs))
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 6：标记块（marker 模式）也转 at 段 ─────────────────────────────
  {
    await startQQTurn({ text: '标记块里 @ 人', turn: 6 })
    wsSent.length = 0
    fire('assistant/message', {
      message: { content: [{ type: 'text', text: '[QQ]@10001 快来看[/QQ]' }] },
    })
    fire('turn/end', { reason: { kind: 'completed' } })
    await sleep(120)
    const frame = sends('send_group_msg')[0] ?? sends('send_private_msg')[0]
    const segs = segmentsOf(frame)
    check('marker：标记块发出来了', Boolean(frame), j(wsSent.map((f) => f.action)))
    check('marker：帧里有 at 段', ats(segs).join(',') === '10001', j(segs))
    check('marker：正文完整', render(segs) === '@10001 快来看', render(segs))
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
