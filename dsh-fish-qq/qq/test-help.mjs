/**
 * test-help.mjs —— help 指令词（2026-10-27）
 *
 * 验收清单：
 *   解析：整条消息恰好是 help / /help / 帮助 / 指令（大小写不敏感）才算；
 *         「help me」「帮我看看 help 文档」这些是在聊天，不算。
 *   拦截：主人的 help **不叫模型**（agent.followups 不增加），桥接层直接回列表；
 *         列表走 OneBot 直发，不经 replyMode 的 marker / tool 闸门。
 *   权限：只有主人能用。群友发 help 照常走唤醒策略（当普通聊天，可能回一句）。
 *   群聊：主人在群里发 help 也不必先 @（排在 atOnlyInGroup 之前），回在群里。
 *   内容：列表只列真的能用的指令（subsend 关着就不列；工作区没配就标明）。
 *
 * 跑法：node test-help.mjs（与 test-filesend.mjs 一样是脚本式断言）
 */

import { mkdtempSync, rmSync } from 'node:fs'
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
      this.onmessage?.({
        data: JSON.stringify({ echo: frame.echo, status: 'ok', retcode: 0, data: { user_id: 99999999, nickname: 'bot' } }),
      })
    }, 0)
  }

  close() {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: 'test' })
  }
}
globalThis.WebSocket = FakeWS

const { apply, parseHelpCommand, buildHelpText, HELP_WORDS, NON_OWNER_MARKER } = await import('./index.js')

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
  const p = (t) => parseHelpCommand(t)
  for (const word of ['help', '/help', 'HELP', 'Help', '  help  ', '帮助', '指令']) {
    check(`解析：${JSON.stringify(word)} 算指令`, p(word)?.command === 'help')
  }
  for (const text of ['help me', '帮我看看 help 文档', '指令列表', '', null, 'subsend 12345678 help', '？']) {
    check(`解析：${JSON.stringify(text)} 不算指令`, p(text) === null)
  }
  check('解析：HELP_WORDS 就那几个', HELP_WORDS.length === 4 && HELP_WORDS.includes('help'))

  const text = buildHelpText({ ownerQQ: '10001', workspaceRoot: 'D:\\demo', subsendEnabled: true })
  check('列表：开头说明只有主人能用', text.includes('只有主人发了才管用'))
  check('列表：带 subsend', text.includes('subsend <QQ号> <内容>'))
  check('列表：带 fileget / filesend', text.includes('fileget <相对路径>') && text.includes('filesend <QQ号> <相对路径>'))
  check('列表：不再列加好友指令', !text.includes('addfriend'))
  check('列表：help 自己', text.includes('help') && text.includes('发这一份列表'))
  check('列表：带主人号', text.includes('10001'))

  const off = buildHelpText({ ownerQQ: '10001', workspaceRoot: 'D:\\demo', subsendEnabled: false })
  check('列表：subsend 关着就不列它', !off.includes('subsend <QQ号>'))

  const noWs = buildHelpText({ ownerQQ: '10001', workspaceRoot: '' })
  check('列表：工作区没配时标明发文件用不了', noWs.includes('工作区还没配'))
  check('列表：没配主人时不写主人号', !buildHelpText({}).includes('主人的 QQ'))
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：走真实 apply + 入站链路（不唤醒模型）
// ══════════════════════════════════════════════════════════════════════════
const stateDir = mkdtempSync(join(tmpdir(), 'qq-bridge-help-'))
const statePath = join(stateDir, 'state.json')
{
  const warnings = []
  const registered = []
  const handlers = {}
  let resolvedSettings = {}

  const agent = {
    id: 'session-help',
    status: 'idle',
    session: { id: 'session-help' },
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
      register: (_ns, _schema, opts) => {
        resolvedSettings = { ...(opts?.base ?? {}) }
        return {}
      },
      get: () => resolvedSettings,
    },
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      roots: () => [],
      resume: async () => {
        throw new Error('help-test: no resume')
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
    targetSessionId: 'session-help',
    statePath,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3997',
    selfId: '99999999',
    whitelist: ['10001', '20002'],
    groupWhitelist: ['90001'],
    nicknames: ['244'],
    wakeProbability: 1,
    privateWakeProbability: 1,
    ownerQQ: '10001',
    workspaceRoot: 'D:\\demo',
    atOnlyInGroup: true,
  }

  apply(ctx, config)

  const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
  const status = registered.find((t) => t.name === 'qq_bridge_status')
  check('注册：调试工具在（simulate / status）', Boolean(sim && status))

  const sessionHandler = handlers['session/event']
  const fire = (type, data = {}) => sessionHandler({ id: 'session-help' }, { type, data })
  const sends = () => wsSent.filter((f) => f.action === 'send_private_msg' || f.action === 'send_group_msg')

  const openTransport = async () => {
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(await status.execute({})).transport?.state === 'open') return true
      await sleep(20)
    }
    return false
  }
  check('链路：假 OneBot 连接已建立', await openTransport())

  // ── 场景 1：主人私聊发 help → 不叫模型，直发列表 ─────────────────────────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'help', userId: '10001', nickname: '主人' }))
    check('拦截：决策是 help', r.preview?.action === 'help' && r.preview?.reason === 'owner-help', JSON.stringify(r.preview))
    check('拦截：没有唤醒模型（followups 不增加）', agent.followups.length === 0, `followups=${agent.followups.length}`)
    check('拦截：真的发出一条私聊', sends().length === 1, JSON.stringify(wsSent.map((f) => f.action)))
    const frame = sends()[0]
    check('拦截：发给主人号', String(frame?.params?.user_id) === '10001')
    const body = (frame?.params?.message ?? []).map((s) => s?.data?.text ?? '').join('')
    check('拦截：正文是指令列表', body.includes('大肥鱼能用的指令') && body.includes('fileget'))
    check('拦截：decision.delivered=true', r.decision?.delivered === true, JSON.stringify(r.decision))
  }
  {
    const st = JSON.parse(await status.execute({}))
    check('台账：outbox 记了 via=help', st.recentOutbox.some((o) => o.via === 'help' && o.to?.userId === '10001'))
  }

  // ── 场景 1b：会话跟随窗口开着时，主人的 help 仍然先被拦截 ───────────────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const listen = registered.find((t) => t.name === 'qq_bridge_listen')
    check('注册：qq_bridge_listen 在', Boolean(listen))
    await listen.execute({ minutes: 5 })
    const r = JSON.parse(await sim.execute({ text: 'help', userId: '10001', nickname: '主人' }))
    check('窗口：会话跟随开着也先拦 help', r.preview?.action === 'help', JSON.stringify(r.preview))
    check('窗口：没有唤醒模型', agent.followups.length === 0, `followups=${agent.followups.length}`)
    check('窗口：列表照常直发', sends().length === 1)
    await listen.execute({ off: true })
  }

  // ── 场景 2：群友发 help → 也是指令，直发「普通人」那份列表（2026-10-29 改）──
  // 放开后判据：谁都能用 help，但**内容按身份分档**——群友那份只告诉他「能聊天」，
  // 不列任何有副作用的指令。门槛仍然只剩 isAllowed（他在白名单/群白名单里）。
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'help', userId: '20002', nickname: '群友' }))
    check('权限：群友发 help 决策也是 help', r.preview?.action === 'help' && r.preview?.reason === 'other-help', JSON.stringify(r.preview))
    check('权限：群友的 help 不叫模型', agent.followups.length === 0, `followups=${agent.followups.length}`)
    check('权限：直发了一份列表', sends().length === 1, JSON.stringify(wsSent.map((f) => f.action)))
    const body = (sends()[0]?.params?.message ?? []).map((s) => s?.data?.text ?? '').join('')
    check('权限：群友那份写明只能聊天', body.includes('只能聊天'), body.slice(0, 60))
    check('权限：群友那份不列有副作用的指令', !body.includes('fileget') && !body.includes('subsend') && !body.includes('admin add') && !body.includes('whitelist'), body.slice(0, 60))
    check('权限：群友那份仍列 help 自己', body.includes('help'))
  }

  // ── 场景 2b：管理员发 help → 直发「管理员」那份（管理员由 admins 设置项决定）──
  {
    const st = JSON.parse(await status.execute({}))
    const adminList = Array.isArray(st.admins?.list) ? st.admins.list : []
    check('设置：admins 默认空（这个场景的配置里没有管理员）', adminList.length === 0, JSON.stringify(adminList))
  }

  // ── 场景 3：主人在群里发 help → 不必 @，回在群里 ─────────────────────────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: '/help', userId: '10001', groupId: '90001', nickname: '主人' }))
    check('群聊：决策是 help（越过 atOnlyInGroup）', r.preview?.action === 'help', JSON.stringify(r.preview))
    check('群聊：没有唤醒模型', agent.followups.length === 0)
    const frame = sends().find((f) => f.action === 'send_group_msg')
    check('群聊：发到群里而不是私聊', Boolean(frame) && String(frame?.params?.group_id) === '90001', JSON.stringify(wsSent.map((f) => f.action)))
  }

  // ── 场景 4：主人说「help me」→ 是聊天，不是指令 ──────────────────────────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'help me', userId: '10001', nickname: '主人' }))
    check('边界：help me 不算指令', r.preview?.action !== 'help', JSON.stringify(r.preview))
    check('边界：help me 走正常唤醒', agent.followups.length === 1)
    check('边界：没有直发列表', sends().length === 0)
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  check('全程没有异常告警（不应该有 None）', !warnings.some((w) => w.includes('help 列表没发出去')), JSON.stringify(warnings.slice(-3)))
}

rmSync(stateDir, { recursive: true, force: true })

console.log('')
if (failed === 0) console.log('ALL PASS')
else console.log(`${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
