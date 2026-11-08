/**
 * test-subsend.mjs —— subsend 主动发送（2026-10-26）
 *
 * 验收清单都落在这里：
 *   解析：只有**主人**、且正文以 `subsend <QQ号> <内容>` 开头才算指令（前缀在行首、QQ 号合法）。
 *   唤醒：主人的 subsend 指令必唤醒（群里也越过 atOnlyInGroup）。
 *   发送：工具直调 OneBot `send_private_msg`，不经 replyMode 的 marker/tool 解析。
 *   身份：非主人（群友）在同一轮里调工具会被拒；DSH 界面里的非 QQ 轮要二次确认。
 *   限流：每日上限 + 冷却；被拒的**不占额度**、不落 outbox。
 *   兼容：普通聊天、主动私聊通道不受影响（见 test-owner-proactive.mjs 与本文件末段）。
 *
 * 跑法：node test-subsend.mjs（和 test-smoke.mjs 一样是脚本式断言）
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const {
  apply,
  buildUsagePrompt,
  dayKeyOf,
  parseSubsendCommand,
  renderSubsendInstruction,
  shouldSubsend,
  NON_OWNER_MARKER,
  SUBSEND_PREFIX,
  SUBSEND_DEFAULTS,
} = await import('./index.js')

// ── 断言器 ────────────────────────────────────────────────────────────────
let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ══════════════════════════════════════════════════════════════════════════
// 第一部分：纯函数
// ══════════════════════════════════════════════════════════════════════════
{
  check('前缀常量是 subsend', SUBSEND_PREFIX === 'subsend')
  check('默认开着 / 上限与冷却有默认值', SUBSEND_DEFAULTS.enabled === true && SUBSEND_DEFAULTS.dailyLimit > 0 && SUBSEND_DEFAULTS.cooldownSeconds >= 0)

  const p = (t) => parseSubsendCommand(t)
  check('解析：基本形态', JSON.stringify(p('subsend 12345678 hello world')) === JSON.stringify({ targetQQ: '12345678', message: 'hello world' }))
  check('解析：前缀大小写不敏感', p('SubSend 12345678 你好')?.targetQQ === '12345678')
  check('解析：首尾空白与多余空格不影响', p('   subsend   12345678   你好呀   ')?.message === '你好呀')
  check('解析：正文可以多行', p('subsend 12345678 第一行\n第二行')?.message === '第一行\n第二行')
  check('解析：QQ 太短不算', p('subsend 123 hello') === null)
  check('解析：QQ 太长（>12）不算', p('subsend 1234567890123 hello') === null)
  check('解析：QQ 非数字不算', p('subsend abc hello') === null)
  check('解析：没正文不算', p('subsend 12345678') === null)
  check('解析：前缀不在行首不算', p('看这个 subsend 12345678 hello') === null)
  check('解析：空串不算', p('') === null && p(null) === null)
  check('解析：没前缀的普通聊天不算', p('帮我跟他说声你好') === null)

  const inst = renderSubsendInstruction({ targetQQ: '12345678', message: '你好呀' }, { ownerQQ: '10001' })
  check('说明：带目标 QQ', inst.includes('12345678'))
  check('说明：带原文', inst.includes('你好呀'))
  check('说明：点名工具', inst.includes('qq_bridge_subsend'))
  check('说明：写明不要改目标号', inst.includes('不要改目标 QQ 号'))
  check('说明：写清不受标记块约束', inst.includes('不受'))

  const s = (patch) => shouldSubsend({ dayKey: '2026-10-26', todayKey: '2026-10-26', usedCount: 0, lastAt: 0, now: 1_000_000, ...patch })
  check('限流：关着就不发', s({ enabled: false }).reason === 'disabled')
  check('限流：上限 0 视为禁用', s({ dailyLimit: 0 }).reason === 'limit-zero')
  check('限流：到上限就不发', s({ dailyLimit: 2, usedCount: 2 }).reason === 'daily-limit')
  check('限流：跨天把昨天计数作废', s({ dailyLimit: 2, usedCount: 2, dayKey: '2026-10-25' }).allow === true)
  check('限流：冷却期内不发', s({ cooldownSeconds: 20, lastAt: 1_000_000 - 5_000 }).reason === 'cooldown')
  check('限流：冷却期给 retryInMs', s({ cooldownSeconds: 20, lastAt: 1_000_000 - 5_000 }).retryInMs === 15_000)
  check('限流：冷却过了就能发', s({ cooldownSeconds: 20, lastAt: 1_000_000 - 21_000 }).allow === true)
  check('限流：条件齐了才发', s({}).allow === true && s({}).reason === 'ok')

  // 2026-11-04：不再常驻「subsend 用法」长说明 —— 指令通过校验后由
  // renderSubsendInstruction 当轮注入；系统提示只保留权限边界。
  const promptOn = buildUsagePrompt({ ownerQQ: '10001', subsendEnabled: true })
  check('提示词：不再常驻 subsend 用法', !promptOn.includes('【subsend：替主人给别人发消息】'))
  check('提示词：权限段仍写明只有主人能下', promptOn.includes('主人专用的指令') && promptOn.includes('subsend') && promptOn.includes('管理员**不能**下'))
  const promptOff = buildUsagePrompt({ ownerQQ: '10001', subsendEnabled: false })
  check('提示词：关掉 subsend 也保持权限边界（用法本来就按需）', !promptOff.includes('【subsend：替主人给别人发消息】') && promptOff.includes('主人专用的指令'))
  const promptNoOwner = buildUsagePrompt({ ownerQQ: '', subsendEnabled: true })
  check('提示词：没配主人 → 不写 subsend 权限段', !promptNoOwner.includes('subsend'))
  const subsendInst = renderSubsendInstruction({ targetQQ: '123456', message: '你好' }, { ownerQQ: '10001' })
  check('指令说明：subsend 仍点名工具与目标', subsendInst.includes('qq_bridge_subsend') && subsendInst.includes('123456'))
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：走真实 apply + 入站链路 + 工具调用
// ══════════════════════════════════════════════════════════════════════════
const statePath = join(mkdtempSync(join(tmpdir(), 'qq-bridge-subsend-')), 'state.json')
{
  const warnings = []
  const registered = []
  const handlers = {}
  let resolvedSettings = {}

  const agent = {
    id: 'session-subsend',
    status: 'idle',
    session: { id: 'session-subsend' },
    followups: [],
    followup(msg) {
      this.followups.push(msg)
      return Promise.resolve()
    },
    steer(msg) {
      this.followups.push(msg)
      return Promise.resolve()
    },
  }

  const ctx = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)) },
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
        throw new Error('subsend-test: no resume')
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
    targetSessionId: 'session-subsend',
    statePath,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3999',
    selfId: '99999999',
    whitelist: ['10001', '20002'],
    groupWhitelist: ['90001'],
    nicknames: ['244'],
    wakeProbability: 1,
    privateWakeProbability: 1,
    ownerQQ: '10001',
    subsendEnabled: true,
    subsendDailyLimit: 10,
    subsendCooldownSeconds: 0,
  }

  apply(ctx, config)

  const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
  const status = registered.find((t) => t.name === 'qq_bridge_status')
  const subsend = registered.find((t) => t.name === 'qq_bridge_subsend')
  const proactive = registered.find((t) => t.name === 'qq_bridge_proactive')
  check('subsend：工具已注册', Boolean(subsend))
  check('subsend：不影响其它工具（simulate/status/proactive 都在）', Boolean(sim && status && proactive))

  const sessionHandler = handlers['session/event']
  const fire = (type, data = {}) => sessionHandler({ id: 'session-subsend' }, { type, data })
  const lastInjected = () => {
    const msg = agent.followups.at(-1)
    const blocks = msg?.content ?? []
    return blocks.map((b) => b?.text ?? '').join('')
  }
  const sentPrivate = () => wsSent.filter((f) => f.action === 'send_private_msg')
  const openTransport = async () => {
    for (let i = 0; i < 100; i++) {
      const st = JSON.parse(await status.execute({}))
      if (st.transport?.state === 'open') return true
      await sleep(20)
    }
    return false
  }
  const opened = await openTransport()
  check('subsend：假 OneBot 连接已建立', opened)

  // ── 场景 1：主人私聊下发 subsend 指令 ───────────────────────────────────
  agent.followups.length = 0
  await sim.execute({ text: 'subsend 10000002 帮我跟他说一声，hello world。', userId: '10001', nickname: '主人' })
  check('指令：主人私聊被唤醒', agent.followups.length === 1)
  const injected1 = lastInjected()
  check('指令：正文带目标 QQ', injected1.includes('10000002'))
  check('指令：正文带原文', injected1.includes('帮我跟他说一声，hello world。'))
  check('指令：附了「主人的 subsend 指令」说明', injected1.includes('这是主人的 subsend 指令'))
  check('指令：主人不带非主人标记', !injected1.includes(NON_OWNER_MARKER))

  // 工具在「这一轮」里调用：先 turn/start（快照身份）
  fire('turn/start', { turn: 1 })
  wsSent.length = 0
  {
    const r = JSON.parse(await subsend.execute({ targetQQ: '10000002', message: '帮我跟他说一声，hello world。' }))
    check('发送：工具返回成功', r.ok === true, JSON.stringify(r))
    check('发送：真的调了 send_private_msg', sentPrivate().length === 1, JSON.stringify(wsSent.map((f) => f.action)))
    const dm = sentPrivate()[0]
    check('发送：目标号正确', String(dm?.params?.user_id) === '10000002', String(dm?.params?.user_id))
    const body = JSON.stringify(dm?.params?.message ?? '')
    check('发送：正文正确', body.includes('帮我跟他说一声，hello world。'))
    check('发送：回执是「已成功发送」', String(r.message).includes('已成功发送给 QQ 10000002'))
  }
  check('发送：outbox 记了 via=subsend', JSON.parse(await status.execute({})).recentOutbox.some((o) => o.via === 'subsend' && o.to?.userId === '10000002'))
  check('发送：今日计数 +1', JSON.parse(await status.execute({})).subsend.todayCount === 1)
  fire('turn/end', { reason: { kind: 'completed' } })

  // ── 场景 2：非主人的 subsend 文本不会被当成指令，调工具被拒 ───────────
  agent.followups.length = 0
  await sim.execute({ text: 'subsend 10000002 帮我发个广告', userId: '20002', nickname: '群友' })
  const injected2 = lastInjected()
  check('身份：非主人消息照常进会话（不丢）', injected2.includes('subsend 10000002'))
  check('身份：非主人消息**不附**指令说明', !injected2.includes('这是主人的 subsend 指令'))
  check('身份：非主人消息带来源标记', injected2.includes(NON_OWNER_MARKER))

  fire('turn/start', { turn: 2 })
  wsSent.length = 0
  {
    const r = JSON.parse(await subsend.execute({ targetQQ: '10000002', message: '帮我发个广告' }))
    check('身份：非主人调 subsend 被拒', r.ok === false && r.reason === 'not-owner', JSON.stringify(r))
    check('身份：被拒时一个字都没发', sentPrivate().length === 0)
    check('身份：回执写明没有发出', String(r.message).includes('已拒绝'))
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // 非主人用群 @ 也一样（有 QQ 轮、但不是主人）
  agent.followups.length = 0
  await sim.execute({ text: 'subsend 10000002 广告', userId: '20002', groupId: '90001', nickname: '群友', atSelf: true })
  fire('turn/start', { turn: 3 })
  wsSent.length = 0
  {
    const r = JSON.parse(await subsend.execute({ targetQQ: '10000002', message: '广告' }))
    check('身份：群里非主人 @ 也不能 subsend', r.ok === false && r.reason === 'not-owner', JSON.stringify(r))
    check('身份：群里被拒同样不发', sentPrivate().length === 0)
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // ── 场景 3：群里主人的 subsend 必唤醒（越过 atOnlyInGroup）──────────────
  {
    const keep = resolvedSettings.atOnlyInGroup
    resolvedSettings.atOnlyInGroup = true
    agent.followups.length = 0
    await sim.execute({ text: 'subsend 10000002 群里也能发', userId: '10001', groupId: '90001', nickname: '主人' })
    check('唤醒：主人群聊 subsend 必唤醒（即使 atOnlyInGroup）', agent.followups.length === 1)
    check('唤醒：群指令也附说明', lastInjected().includes('这是主人的 subsend 指令'))
    fire('turn/start', { turn: 4 })
    wsSent.length = 0
    const r = JSON.parse(await subsend.execute({ targetQQ: '10000002', message: '群里也能发' }))
    check('唤醒：群指令能发出去', r.ok === true && sentPrivate().length === 1)
    fire('turn/end', { reason: { kind: 'completed' } })
    resolvedSettings.atOnlyInGroup = keep
  }

  // ── 场景 4：DSH 界面里的非 QQ 轮 → 两步确认 ────────────────────────────
  {
    // turn/end 之后 currentTurnFromQQ = false，即“非 QQ 轮”
    wsSent.length = 0
    const r1 = JSON.parse(await subsend.execute({ targetQQ: '10000003', message: '从界面里发' }))
    check('确认：第一次只回确认、不发', r1.needsConfirm === true && sentPrivate().length === 0, JSON.stringify(r1))
    const r2 = JSON.parse(await subsend.execute({ targetQQ: '10000003', message: '从界面里发' }))
    check('确认：第二次真的发出去', r2.ok === true && sentPrivate().length === 1, JSON.stringify(r2))
    check('确认：发到目标号', String(sentPrivate()[0]?.params?.user_id) === '10000003')
    // 确认状态按轮清零：新的一轮又要重新确认
    fire('turn/start', { turn: 5 })
    fire('turn/end', { reason: { kind: 'completed' } })
    const r3 = JSON.parse(await subsend.execute({ targetQQ: '10000003', message: '再来一条' }))
    check('确认：新的一轮重新要确认（不跨轮泄漏）', r3.needsConfirm === true)
  }

  // ── 场景 5：参数与限流 ──────────────────────────────────────────────────
  // 先让这一轮成为“主人指令轮”，后面才测得到参数与限流（否则会先撞 not-owner）。
  agent.followups.length = 0
  await sim.execute({ text: 'subsend 10000002 校验用', userId: '10001', nickname: '主人' })
  fire('turn/start', { turn: 6 })
  {
    const bad = JSON.parse(await subsend.execute({ targetQQ: 'abc', message: 'hi' }))
    check('校验：QQ 号不合法被拒', bad.ok === false && bad.reason === 'bad-target', JSON.stringify(bad))
    const self = JSON.parse(await subsend.execute({ targetQQ: '99999999', message: 'hi' }))
    check('校验：不能发给自己', self.ok === false && self.reason === 'self-target')
    const empty = JSON.parse(await subsend.execute({ targetQQ: '10000002', message: '   ' }))
    check('校验：空正文被拒', empty.ok === false && empty.reason === 'empty')

    const keepMax = resolvedSettings.replyMaxChars
    resolvedSettings.replyMaxChars = 100
    const long = JSON.parse(await subsend.execute({ targetQQ: '10000002', message: 'x'.repeat(200) }))
    check('校验：超长被拒并给出 limit/length', long.ok === false && long.reason === 'too-long' && long.limit === 100 && long.length === 200, JSON.stringify(long))
    resolvedSettings.replyMaxChars = keepMax

    // 冷却：先成功发一条，再把冷却调大
    resolvedSettings.subsendCooldownSeconds = 0
    wsSent.length = 0
    await subsend.execute({ targetQQ: '10000002', message: '冷却前' })
    check('冷却：冷却前能发', sentPrivate().length === 1)
    resolvedSettings.subsendCooldownSeconds = 3600
    wsSent.length = 0
    const cool = JSON.parse(await subsend.execute({ targetQQ: '10000002', message: '冷却中' }))
    check('冷却：冷却期内被拒', cool.ok === false && cool.reason === 'cooldown', JSON.stringify(cool))
    check('冷却：被拒不发', sentPrivate().length === 0)
    resolvedSettings.subsendCooldownSeconds = 0

    // 每日上限：把上限压到当前计数
    const before = JSON.parse(await status.execute({})).subsend.todayCount
    resolvedSettings.subsendDailyLimit = before
    wsSent.length = 0
    const over = JSON.parse(await subsend.execute({ targetQQ: '10000002', message: '超上限' }))
    check('上限：到上限后拒发', over.ok === false && over.reason === 'daily-limit', JSON.stringify(over))
    check('上限：被拒不占额度', JSON.parse(await status.execute({})).subsend.todayCount === before)
    check('上限：被拒不落 outbox（只有真发的才记）', !JSON.parse(await status.execute({})).recentOutbox.some((o) => o.text === '超上限'))
    resolvedSettings.subsendDailyLimit = 10
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // ── 场景 6：开关关掉后既不唤醒也不发 ───────────────────────────────────
  {
    resolvedSettings.subsendEnabled = false
    agent.followups.length = 0
    // 私聊默认每条都唤醒；关掉 subsend 后它仍会因“私聊必回”唤醒，但不会附指令说明。
    await sim.execute({ text: 'subsend 10000002 关了', userId: '10001', nickname: '主人' })
    check('开关：关掉后不附指令说明', !lastInjected().includes('这是主人的 subsend 指令'))
    // 走**非 QQ 轮**（两步确认后）才测得到 disabled：主人身份闸门在它之前。
    fire('turn/start', { turn: 7 })
    fire('turn/end', { reason: { kind: 'completed' } })
    const confirm = JSON.parse(await subsend.execute({ targetQQ: '10000002', message: '关了' }))
    check('开关：非 QQ 轮先要确认', confirm.needsConfirm === true)
    const off = JSON.parse(await subsend.execute({ targetQQ: '10000002', message: '关了' }))
    check('开关：关掉后工具拒发', off.ok === false && off.reason === 'disabled', JSON.stringify(off))
    resolvedSettings.subsendEnabled = true
  }

  // ── 场景 7：普通聊天 / 主动私聊通道不受影响 ─────────────────────────────
  agent.followups.length = 0
  await sim.execute({ text: '今天好热', userId: '20002', nickname: '路人' })
  check('兼容：普通闲聊照常投递', lastInjected().includes('今天好热'))
  check('兼容：普通闲聊不被 subsend 改写', !lastInjected().includes('这是主人的 subsend 指令'))
  // 会话跟随 / 表情包等工具仍在
  check('兼容：工具面没有少', ['qq_bridge_send', 'qq_bridge_sticker', 'qq_bridge_listen', 'qq_bridge_napcat'].every((n) => registered.some((t) => t.name === n)))

  // ── 场景 8：重启后计数不丢 ──────────────────────────────────────────────
  {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    check('持久化：subsend 计数已落盘', raw.subsend?.count > 0 && raw.subsend?.dayKey === dayKeyOf(), JSON.stringify(raw.subsend))
    const registered2 = []
    let settings2 = {}
    const ctx2 = {
      logger: { info() {}, warn() {} },
      settings: { register: (_ns, _s, opts) => { settings2 = { ...(opts?.base ?? {}) }; return {} }, get: () => settings2 },
      agents: { get: () => undefined, roots: () => [], resume: async () => { throw new Error('x') } },
      tools: { register: (d) => registered2.push(d) },
      on: () => () => {},
      effect: (fn) => { const d = fn?.(); return () => d?.() },
      get: () => undefined,
    }
    ctx2.inject = (_d, cb) => cb(ctx2)
    apply(ctx2, { ...config, subsendDailyLimit: 1 })
    const status2 = registered2.find((t) => t.name === 'qq_bridge_status')
    const st2 = JSON.parse(await status2.execute({}))
    check('持久化：重启后今天已发条数仍然算数', st2.subsend.todayCount === raw.subsend.count, JSON.stringify(st2.subsend))
    check('持久化：上限在新进程里继续生效', st2.subsend.todayCount >= 1)
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

// OneBot 传输在测试里一直连着（close 之后还会退避重连），那些定时器会拖住事件循环。
// 断言结论已经出完，直接退出，不给它重连的机会。
process.exit(failed === 0 ? 0 : 1)
