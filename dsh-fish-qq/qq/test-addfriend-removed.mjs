// test-addfriend-removed.mjs —— 加好友功能已下线的回归守卫（2026-11-01）
//
// `addfriend` / `qq_bridge_add_friend` 曾是「授权制加好友」功能（2026-10-28 加入，
// 2026-11-01 移除）：OneBot v11 没有主动加好友的标准动作，本机 NapCat 不支持，
// 整套机制护着的是一个发不出去的东西。这个文件守住「下线就是下线」：
//   ① 主人在私聊发 addfriend <QQ号>：不再被拦截成特殊指令（无 owner-addfriend 唤醒），
//      作为普通消息进会话、无授权说明附体；
//   ② 桥接层不回任何「已发送好友申请」式的假回执（零出站、无 friend 动作）；
//   ③ 工具表里没有 qq_bridge_add_friend；
//   ④ 系统提示词里没有【加好友】一节、不再点名工具或指令；
//   ⑤ status 输出里没有 addFriend 段 / grant。
// 跑法：node test-addfriend-removed.mjs（与 test-subsend.mjs 同一套假 OneBot 脚本式断言）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const wsSent = []
class FakeWS {
  constructor(url) {
    this.readyState = 2
    this.url = url
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

const { apply, buildUsagePrompt } = await import('./index.js')

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const statePath = join(mkdtempSync(join(tmpdir(), 'qq-verify-addfriend-removal-')), 'state.json')
const warnings = []
const registered = []
const handlers = {}
let resolvedSettings = {}

const agent = {
  id: 'session-verify',
  status: 'idle',
  session: { id: 'session-verify' },
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
      throw new Error('verify: no resume')
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

apply(ctx, {
  targetSessionId: 'session-verify',
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
})

const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
const status = registered.find((t) => t.name === 'qq_bridge_status')
const sessionHandler = handlers['session/event']
const fire = (type, data = {}) => sessionHandler({ id: 'session-verify' }, { type, data })
const lastInjected = () => {
  const msg = agent.followups.at(-1)
  const blocks = msg?.content ?? []
  return blocks.map((b) => b?.text ?? '').join('')
}
const openTransport = async () => {
  for (let i = 0; i < 100; i++) {
    const st = JSON.parse(await status.execute({}))
    if (st.transport?.state === 'open') return true
    await sleep(20)
  }
  return false
}
check('假 OneBot 连接已建立', await openTransport())

// ── 场景 1：主人在私聊里发 addfriend 12345678 ──────────────────────────────
{
  // dryRun：看唤醒决策
  const preview = JSON.parse(
    await sim.execute({ text: 'addfriend 12345678', userId: '10001', nickname: '主人', dryRun: true }),
  )
  check('① 决策不是特殊指令（无 owner-addfriend）', preview?.preview?.reason !== 'owner-addfriend', JSON.stringify(preview?.preview))
  check('① 决策就是普通私聊唤醒', preview?.preview?.action === 'wake' && preview?.preview?.reason === 'private-always', JSON.stringify(preview?.preview))

  // 真跑：消息应照常进会话
  agent.followups.length = 0
  wsSent.length = 0
  await sim.execute({ text: 'addfriend 12345678', userId: '10001', nickname: '主人' })
  check('② 消息照常进会话（一轮 followup）', agent.followups.length === 1)
  const injected = lastInjected()
  check('② 原文照抄进会话', injected.includes('addfriend 12345678'), JSON.stringify(injected).slice(0, 120))
  check('② 不附任何授权说明', !injected.includes('授权') && !injected.includes('qq_bridge_add_friend'), JSON.stringify(injected).slice(0, 120))
  check('③ 桥接层不回话给主人（零出站）', wsSent.length === 0, JSON.stringify(wsSent.map((f) => f.action)))
  check('③ 没有发出好友申请动作', !wsSent.some((f) => String(f.action).includes('friend')), JSON.stringify(wsSent.map((f) => f.action)))
  fire('turn/end', { reason: { kind: 'completed' } })
}

// ── 场景 2：工具表 ──────────────────────────────────────────────────────────
check('④ 工具表无 qq_bridge_add_friend', !registered.some((t) => t.name === 'qq_bridge_add_friend'))
check('④ 其余工具仍在（send / status / simulate）', ['qq_bridge_send', 'qq_bridge_status', 'qq_bridge_simulate'].every((n) => registered.some((t) => t.name === n)))
check('④ 工具总数 = 13', registered.length === 13, String(registered.length))

// ── 场景 3：系统提示词 ────────────────────────────────────────────────────
const prompt = buildUsagePrompt({ ownerQQ: '10001', subsendEnabled: true })
check('⑤ 提示词无【加好友】一节', !prompt.includes('【加好友'))
check('⑤ 提示词不点名 qq_bridge_add_friend', !prompt.includes('qq_bridge_add_friend'))
check('⑤ 提示词不提 addfriend 指令', !prompt.includes('addfriend'))

// ── 场景 4：state 里不再有 addFriend 字段（status 输出） ──────────────────
const st = JSON.parse(await status.execute({}))
check('⑥ status 输出无 addFriend 段', !('addFriend' in st), JSON.stringify(Object.keys(st)))
check('⑥ status 输出无 grant', !JSON.stringify(st).includes('grant'))

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
