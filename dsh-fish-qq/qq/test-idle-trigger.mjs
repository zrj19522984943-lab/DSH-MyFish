/**
 * test-idle-trigger.mjs —— 私人时间 / 自主待机（2026-10-31）
 *
 * 任务书的三层验收都落在这里：
 *
 *   1. 触发层：空闲判定（纯函数）+ 权重抽签（silent 必须高频）；
 *   2. 注入层：命中非 silent 时注入的是「处境提示」——有时间、有 [IDLE] 说法，
 *      没有「执行任务」式的祈使句；
 *   3. 出站层（Ghost Mode）：她回 [IDLE] / 没写 [QQ] 块 → QQ 一个字都没有；
 *      她明确写了 [QQ] 块 → 消息发到主人私聊；计数落盘、重启不丢。
 *
 * 跑法：node test-idle-trigger.mjs（与 test-owner-proactive.mjs 同一套脚本式断言）
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

const { apply, extractQQReply, dayKeyOf } = await import('./index.js')
const {
  buildIdleTriggerText,
  IDLE_TRIGGER_DEFAULTS,
  isIdleRefusal,
  normalizeIdleWeights,
  pickIdleAction,
  shouldFireIdleTime,
  timeOfDayMood,
} = await import('./idle-trigger.js')

// ── 断言器 ────────────────────────────────────────────────────────────────
let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ══════════════════════════════════════════════════════════════════════════
// 第一部分：纯函数（idle-trigger.js）
// ══════════════════════════════════════════════════════════════════════════
{
  // ── shouldFireIdleTime：门槛 ──
  const base = {
    enabled: true,
    scanIntervalMinutes: 30,
    minIdleHours: 2,
    dailyMax: 3,
    lastActivityAt: 1_000_000,
    lastAt: 0,
    dayKey: '2026-10-31',
    todayKey: '2026-10-31',
    usedCount: 0,
    now: 1_000_000 + 3 * 3_600_000, // 空闲 3 小时
  }
  const run = (patch) => shouldFireIdleTime({ ...base, ...patch })

  check('门槛：关着就不触发', run({ enabled: false }).reason === 'disabled')
  check('门槛：上限 0 视为不发', run({ dailyMax: 0 }).reason === 'limit-zero')
  check('门槛：今日已满就不触发', run({ usedCount: 3 }).reason === 'daily-limit')
  check('门槛：跨天把昨天计数作废', run({ usedCount: 3, dayKey: '2026-10-30' }).fire === true)
  check('门槛：没活动基线不触发', run({ lastActivityAt: 0 }).reason === 'no-activity-yet')
  check('门槛：空闲不够不触发', run({ now: 1_000_000 + 1 * 3_600_000 }).reason === 'not-idle')
  check('门槛：冷却期内不重复', run({ lastAt: 1_000_000 + 2.9 * 3_600_000 }).reason === 'cooldown')
  check('门槛：条件齐了才触发', run({}).fire === true)
  // minIdleHours=0 = 不看空闲（任务书验证清单要求）
  check('门槛：minIdleHours=0 时不看空闲', run({ minIdleHours: 0, now: 1_000_000 + 60_000 }).fire === true)

  // ── pickIdleAction：权重抽签 ──
  const w = { silent: 80, message: 10, browse: 5, diary: 5 }
  check('抽签：rnd=0 命中 silent（权重最高）', pickIdleAction(w, 0) === 'silent')
  check('抽签：silent 桶内（0.79 * 100）', pickIdleAction(w, 0.799) === 'silent')
  check('抽签：message 桶起点（0.80）', pickIdleAction(w, 0.8) === 'message')
  check('抽签：browse 桶起点（0.90）', pickIdleAction(w, 0.9) === 'browse')
  check('抽签：diary 桶起点（0.95）', pickIdleAction(w, 0.95) === 'diary')
  check('抽签：全 0 权重退回 silent', pickIdleAction({ silent: 0, message: 0, browse: 0, diary: 0 }, 0.5) === 'silent')
  check('抽签：只开 diary 时永远 diary', pickIdleAction({ silent: 0, message: 0, browse: 0, diary: 7 }, 0.99) === 'diary')
  const nw = normalizeIdleWeights({ silent: 'x', message: -3, browse: undefined, diary: '5' })
  check('权重：坏值归 0、字符串数字收下', nw.silent === 0 && nw.message === 0 && nw.browse === 0 && nw.diary === 5)

  // 概率口径：默认权重下 silent 应该占 80%
  let silentHits = 0
  for (let i = 0; i < 2000; i += 1) {
    if (pickIdleAction(IDLE_TRIGGER_DEFAULTS.weights, i / 2000) === 'silent') silentHits += 1
  }
  check('抽签：默认权重下 silent 恰好占 80%', silentHits === 1600, `${silentHits}/2000`)

  // ── timeOfDayMood / buildIdleTriggerText ──
  const at = (h) => Date.parse(`2026-10-31T${String(h).padStart(2, '0')}:00:00+08:00`)
  check('时段：2 点是深夜', timeOfDayMood(at(2)).period === '深夜')
  check('时段：10 点是上午', timeOfDayMood(at(10)).period === '上午')
  check('时段：20 点是晚上', timeOfDayMood(at(20)).period === '晚上')
  check('时段：晚上的旁白提到「天已经黑了」', timeOfDayMood(at(20)).cue.includes('天已经黑了'))

  const t = buildIdleTriggerText({ pick: 'diary', now: at(20), idleHours: 2.5 })
  check('文案：是 [系统：私人时间] 开头', t.startsWith('[系统：私人时间]'))
  check('文案：带真实时间（周六 20:00）', t.includes('周六 20:00'), t.split('\n')[0])
  check('文案：写空闲时长', t.includes('已经 2.5 小时没人来找你了'))
  check('文案：教了她 [IDLE] 怎么用', t.includes('[IDLE]'))
  check('文案：教了她想找人写 [QQ] 块', t.includes('[QQ]…[/QQ]'))
  check('文案：不是祈使句 / 任务清单', !/执行任务|请完成|请立刻|你的任务|今天记得/.test(t), t.slice(0, 40))
  check(
    '文案：不写配额（「还剩 N 次」是桥接的隐形安全网）',
    !/还剩|配额|额度|今天还有几次/.test(t),
  )
  const tMsg = buildIdleTriggerText({ pick: 'message', now: at(3), idleHours: 0 })
  check('文案：message 抽签把「给他发条消息」放最前', tMsg.includes('给他发条消息'), tMsg.split('\n')[3])
  check('文案：idleHours=0 时写「最近没什么人找你」', tMsg.includes('最近没什么人找你'))
  const tBrowse = buildIdleTriggerText({ pick: 'browse', now: at(15), idleHours: 0 })
  check('文案：browse 抽签把「去 B 站看看」放最前', tBrowse.includes('你可以去 B 站看看'), tBrowse.split('\n')[3])

  // ── isIdleRefusal ──
  check('拒绝：整行就是 [IDLE]', isIdleRefusal('[IDLE]') === true)
  check('拒绝：[IDLE] 带短尾巴', isIdleRefusal('[IDLE] 不想动，继续躺着') === true)
  check('拒绝：[IDLE] 大小写不敏感', isIdleRefusal('[idle] 累') === true)
  check('拒绝：[IDLE] 在多行文本里也算', isIdleRefusal('嗯。\n[IDLE]') === true)
  check('拒绝：尾巴太长不算（那是正文）', isIdleRefusal('[IDLE] 不过想想还是可以写点东西的，正好今天有些想法想趁机记下来，顺便把昨天那件事也想一想') === false)
  check('拒绝：正文里提到 [IDLE] 但不是行首', isIdleRefusal('他说回 [IDLE] 就行') === false)
  check('拒绝：没提 [IDLE] 就不算', isIdleRefusal('不想动') === false)
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：走真实 apply —— 触发 → 注入 → Ghost Mode 出站
// ══════════════════════════════════════════════════════════════════════════
const statePath = join(mkdtempSync(join(tmpdir(), 'qq-bridge-idle-')), 'state.json')
{
  const warnings = []
  const registered = []
  const handlers = {}
  let resolvedSettings = {}

  const agent = {
    id: 'session-idle',
    status: 'idle',
    session: { id: 'session-idle' },
    followups: [],
    followup(msg) {
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
        throw new Error('idle-test: no resume')
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
    targetSessionId: 'session-idle',
    statePath,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3998',
    whitelist: ['10001'],
    nicknames: ['244'],
    wakeProbability: 1,
    ownerQQ: '10001',
    proactiveEnabled: false,
    idleTriggerEnabled: false, // 先关着，下面逐个开
    idleTriggerMinIdleHours: 2,
    idleTriggerDailyMax: 2,
    idleTriggerWeightSilent: 80,
    idleTriggerWeightMessage: 10,
    idleTriggerWeightBrowse: 5,
    idleTriggerWeightDiary: 5,
  }

  apply(ctx, config)

  const status = registered.find((t) => t.name === 'qq_bridge_status')
  const idleTool = registered.find((t) => t.name === 'qq_bridge_idle')
  check('接线：qq_bridge_idle 调试入口在', Boolean(idleTool))
  const lastInjected = () => {
    const msg = agent.followups.at(-1)
    const blocks = msg?.content ?? []
    return blocks.map((b) => b?.text ?? '').join('')
  }

  const sessionHandler = handlers['session/event']
  const fire = (type, data) => sessionHandler({ id: 'session-idle' }, { type, data })

  const openTransport = async () => {
    for (let i = 0; i < 100; i++) {
      const st = JSON.parse(await status.execute({}))
      if (st.transport?.state === 'open') return true
      await sleep(20)
    }
    return false
  }
  check('接线：假 OneBot 连接已建立', await openTransport())

  // ---- 0. 关着的时候 force 也不发 ----
  {
    const r = JSON.parse(await idleTool.execute({ action: 'force' }))
    check('门槛：总开关关着时 force 也不注入', r.result.fire === false && r.result.reason === 'disabled')
    check('门槛：关着时一个字都没注入', agent.followups.length === 0)
  }

  // 打开；空闲门槛设 0（任务书验证清单：minIdleHours: 0 反复扫描）
  resolvedSettings.idleTriggerEnabled = true
  resolvedSettings.idleTriggerMinIdleHours = 0
  resolvedSettings.idleTriggerDailyMax = 2

  // ---- 1. 命中 silent：什么都没发，也没有额度被消耗 ----
  resolvedSettings.idleTriggerWeightSilent = 100
  resolvedSettings.idleTriggerWeightMessage = 0
  resolvedSettings.idleTriggerWeightBrowse = 0
  resolvedSettings.idleTriggerWeightDiary = 0
  {
    const r = JSON.parse(await idleTool.execute({ action: 'scan' }))
    check('静默：抽签只能是 silent', r.result.reason === 'silent')
    check('静默：没有注入任何提示', agent.followups.length === 0)
    const st = JSON.parse(await idleTool.execute({ action: 'status' }))
    check('静默：安静次数 +1', st.quietToday === 1, JSON.stringify({ quiet: st.quietToday }))
    check('静默：每日上限没有被消耗', st.todayCount === 0)
    check('静默：wsSent 里没有任何出站', wsSent.every((f) => f.action !== 'send_private_msg' && f.action !== 'send_group_msg'))
  }

  // 恢复权重，后面用 force 指定动作（scan 用 Math.random，不好断言）
  resolvedSettings.idleTriggerWeightSilent = 80
  resolvedSettings.idleTriggerWeightDiary = 5

  // ---- 2. 强制命中 write_diary：注入的是处境提示 ----
  {
    const r = JSON.parse(await idleTool.execute({ action: 'force', pick: 'diary' }))
    check('注入：force 命中并注入', r.result.fire === true && r.result.pick === 'diary', JSON.stringify(r.result))
    check('注入：是 [系统：私人时间] 开头', lastInjected().startsWith('[系统：私人时间]'))
    check('注入：有时间与时段（不是任务清单）', /现在是 .+，(深夜|凌晨|上午|中午|下午|晚上|夜里)/.test(lastInjected()))
    check('注入：提到写日记（抽到的选项在最前）', lastInjected().includes('写写日记'))
    check('注入：教了 [IDLE]', lastInjected().includes('[IDLE]'))
    const st = JSON.parse(await idleTool.execute({ action: 'status' }))
    check('注入：今日计数 +1（silent 那次不含在内）', st.todayCount === 1)
    check('台账：有一条 pending 记录', st.state.recent.some((e) => e.pick === 'diary' && e.outcome === 'pending'))
  }

  // ---- 3. 她回 [IDLE] → Ghost Mode：QQ 一个字都没有 ----
  wsSent.length = 0
  fire('turn/start', { turn: 1 })
  fire('assistant/message', { message: { content: [{ type: 'text', text: '[IDLE] 还不想动，继续躺着。' }] } })
  fire('turn/end', { reason: { kind: 'completed' } })
  await sleep(80)
  {
    const dm = wsSent.filter((f) => f.action === 'send_private_msg')
    check('Ghost：她回 [IDLE] 时 QQ 一个字都没发', dm.length === 0, JSON.stringify(wsSent.map((f) => f.action)))
    check('Ghost：标记块路径也没有出站', wsSent.every((f) => f.action !== 'send_group_msg'))
    const st = JSON.parse(await idleTool.execute({ action: 'status' }))
    const e = st.state.recent.at(-1)
    check('台账：结局记成 refused', e?.outcome === 'refused', JSON.stringify(e))
    check('台账：outbox 里没有这一轮', !JSON.parse(await status.execute({})).recentOutbox.some((o) => o.via === 'idle-trigger'))
  }

  // ---- 4. 她明确写了 [QQ] 块 → 发到主人私聊 ----
  agent.followups.length = 0
  {
    const r = JSON.parse(await idleTool.execute({ action: 'force', pick: 'browse' }))
    check('注入：第二段也能注入', r.result.fire === true && r.result.pick === 'browse')
  }
  wsSent.length = 0
  fire('turn/start', { turn: 2 })
  fire('assistant/message', { message: { content: [{ type: 'text', text: '刚刚去 B 站逛了一圈。\n[QQ]在呢，忽然想跟你说一声。[/QQ]' }] } })
  fire('turn/end', { reason: { kind: 'completed' } })
  await sleep(80)
  {
    const dm = wsSent.filter((f) => f.action === 'send_private_msg')
    check('出站：她写了 [QQ] 块 → 真的调了 send_private_msg', dm.length === 1, JSON.stringify(wsSent.map((f) => f.action)))
    check('出站：发给了主人号', String(dm[0]?.params?.user_id) === '10001')
    const dmText = JSON.stringify(dm[0]?.params?.message ?? '')
    check('出站：只发块里的话（正文其余部分不发）', dmText.includes('忽然想跟你说一声') && !dmText.includes('刚刚去 B 站逛了一圈'))
    const st = JSON.parse(await idleTool.execute({ action: 'status' }))
    check('台账：结局记成 sent', st.state.recent.at(-1)?.outcome === 'sent')
    check('出站：outbox 里 via=idle-trigger', JSON.parse(await status.execute({})).recentOutbox.some((o) => o.via === 'idle-trigger'))
  }

  // ---- 5. 今日上限到了：force 也不破 ----
  agent.followups.length = 0
  {
    const r = JSON.parse(await idleTool.execute({ action: 'force', pick: 'message' }))
    check('限流：到上限后不再注入（force 也不破）', r.result.fire === false && r.result.reason === 'daily-limit', JSON.stringify(r.result))
    check('限流：没有再让她开口', agent.followups.length === 0)
  }

  // ---- 6. 空闲计时：「有人找她」会刷新基线 ----
  {
    const before = JSON.parse(await idleTool.execute({ action: 'status' })).state.lastActivityAt
    // 人在 DSH 界面说话（kind=user）
    fire('user/message', { message: { content: [{ type: 'text', text: '在吗？' }], source: { kind: 'user' } } })
    const st2 = JSON.parse(await idleTool.execute({ action: 'status' }))
    check(
      '计时：DSH 界面有人说话会刷新 lastActivityAt',
      Number(st2.state.lastActivityAt) > 0 && st2.state.lastActivityAt !== before,
    )
    // QQ 真人消息（kind=plugin + [QQ · 前缀）也算
    const lastQQ = JSON.parse(await idleTool.execute({ action: 'status' })).state.lastActivityAt
    fire('user/message', {
      message: {
        content: [{ type: 'text', text: '[QQ · 私聊] 主人：在不在' }],
        source: { kind: 'plugin', plugin: 'qq-bridge' },
      },
    })
    const st3 = JSON.parse(await idleTool.execute({ action: 'status' }))
    check('计时：QQ 来人也刷新 lastActivityAt', Number(st3.state.lastActivityAt) > Number(lastQQ))
    // 我们自己注入的提示不算
    const lastPrompt = st3.state.lastActivityAt
    fire('user/message', {
      message: {
        content: [{ type: 'text', text: '[系统：私人时间] 现在是 23:00，夜里。' }],
        source: { kind: 'plugin', plugin: 'qq-bridge' },
      },
    })
    const st4 = JSON.parse(await idleTool.execute({ action: 'status' }))
    check('计时：私人时间提示不刷新 lastActivityAt', st4.state.lastActivityAt === lastPrompt)
  }

  // ---- 7. 空闲门槛未满时不注入 ----
  {
    resolvedSettings.idleTriggerMinIdleHours = 999
    resolvedSettings.idleTriggerDailyMax = 9
    const r = JSON.parse(await idleTool.execute({ action: 'force' }))
    check('门槛：空闲不够（刚被人找过）时 force 也不注入', r.result.fire === false && r.result.reason === 'not-idle', JSON.stringify(r.result))
    agent.followups.length = 0
  }

  // ---- 8. 用法说明里有【私人时间】这一节（开关开着才挂）----
  {
    const st = JSON.parse(await status.execute({}))
    check('用法说明：设置里看得到 idleTrigger 开关', st.settings.idleTriggerEnabled === true)
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分 b：没配目标会话 → no-target（独立 ctx，config 不给 targetSessionId）
// ══════════════════════════════════════════════════════════════════════════
{
  const registeredB = []
  const ctxB = {
    logger: { info() {}, warn() {} },
    settings: { register: (_ns, _s, _opts) => ({}), get: () => ({}) },
    agents: { get: () => undefined, roots: () => [], resume: async () => { throw new Error('no') } },
    tools: { register: (d) => registeredB.push(d) },
    on: () => () => {},
    effect: (fn) => { const d = fn?.(); return () => d?.() },
    get: () => undefined,
  }
  ctxB.inject = (_d, cb) => cb(ctxB)
  apply(ctxB, {
    // 故意不配 targetSessionId
    statePath: join(mkdtempSync(join(tmpdir(), 'qq-bridge-idle-b-')), 'state.json'),
    debugTools: true,
    onebotUrl: '', // 不需要传输
    idleTriggerEnabled: true,
    idleTriggerMinIdleHours: 0,
    idleTriggerDailyMax: 3,
  })
  const toolB = registeredB.find((t) => t.name === 'qq_bridge_idle')
  const r = JSON.parse(await toolB.execute({ action: 'force' }))
  check('兜底：没配 targetSessionId 时如实说 no-target', r.result.fire === false && r.result.reason === 'no-target', JSON.stringify(r.result))
}

// ══════════════════════════════════════════════════════════════════════════
// 第三部分：重启后计数不丢（同一 statePath 再 apply 一次）
// ══════════════════════════════════════════════════════════════════════════
{
  const raw = JSON.parse(readFileSync(statePath, 'utf8'))
  check('持久化：计数已落盘', raw.idleTrigger?.count === 2 && raw.idleTrigger?.dayKey === dayKeyOf(), JSON.stringify(raw.idleTrigger))
  check('持久化：台账已落盘', Array.isArray(raw.idleTrigger?.recent) && raw.idleTrigger.recent.length > 0)
  check('持久化：空闲基线已落盘', Number(raw.idleTrigger?.lastActivityAt) > 0)

  const registered2 = []
  const handlers2 = {}
  let settings2 = {}
  const ctx2 = {
    logger: { info() {}, warn() {} },
    settings: { register: (_ns, _s, opts) => { settings2 = { ...(opts?.base ?? {}) }; return {} }, get: () => settings2 },
    agents: { get: () => undefined, roots: () => [], resume: async () => { throw new Error('x') } },
    tools: { register: (d) => registered2.push(d) },
    on: (n, f) => { handlers2[n] = f; return () => {} },
    effect: (fn) => { const d = fn?.(); return () => d?.() },
    get: () => undefined,
  }
  ctx2.inject = (_d, cb) => cb(ctx2)
  apply(ctx2, {
    targetSessionId: '',
    statePath,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3997',
    idleTriggerEnabled: true,
    idleTriggerMinIdleHours: 0,
    idleTriggerDailyMax: 2,
  })
  const tool2 = registered2.find((t) => t.name === 'qq_bridge_idle')
  for (let i = 0; i < 100; i++) {
    const st = JSON.parse(await tool2.execute({ action: 'status' }))
    if (st.state?.lastActivityAt > 0) break
    await sleep(20)
  }
  const st3 = JSON.parse(await tool2.execute({ action: 'status' }))
  check('重启：今天已注入 2 段仍然算数', st3.todayCount === 2, JSON.stringify(st3.state))
  // 上限 2：重启后仍然挡住
  const scan = JSON.parse(await tool2.execute({ action: 'force' }))
  check('重启：上限继续生效（force 也不破）', scan.result.fire === false && scan.result.reason === 'daily-limit', JSON.stringify(scan.result))
}

// ══════════════════════════════════════════════════════════════════════════
if (existsSync(statePath)) rmSync(statePath, { force: true, recursive: true })

console.log('')
if (failed === 0) {
  console.log('ALL PASS')
} else {
  console.log(`${failed} FAILED`)
}

// OneBot 传输在测试里一直连着，定时器会拖住事件循环；结论已出完，直接退出。
process.exit(failed === 0 ? 0 : 1)
