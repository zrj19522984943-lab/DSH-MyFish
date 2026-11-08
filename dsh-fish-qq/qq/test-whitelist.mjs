/**
 * test-whitelist.mjs —— `whitelist <QQ号>` 主人指令（2026-10-29）
 *
 * 验收清单：
 *   解析：`whitelist <5-12 位 QQ 号>` 整条消息才算（大小写 / 首尾空白不敏感）；
 *         带正文、位数不对、中间提到 whitelist 都不算指令（null = 普通聊天）。
 *   存储：白名单就是设置里那一项 —— 写进 qq-bridge-settings.json 的 values.whitelist
 *         （0.2.x 宿主路径），与设置卡片同一个文件、同一份结构，不另起一套。
 *   热生效：写完**不重启**，同一条进程里下一条入站消息就能读到新名单
 *         （白名单空 → 陌生人被 drop；加进去 → 立刻能唤醒）。
 *   权限：只有 ownerQQ 发的才认；非主人发一样的字 → 不解析、不加人、不回话。
 *   bootstrap：白名单为空（fail-closed）时，主人仍能用这条指令加回第一个人
 *         （排在 isAllowed 之前）—— 否则主人在 QQ 上连话都说不了。
 *   重复：同一个号回一句「已经在名单里」，名单不重复追加。
 *   legacy 宿主（register/get）：桥接层没有写入接口 → 如实回「没写成」，
 *         不偷写文件、不装成功。
 *
 * 跑法：node test-whitelist.mjs（与 test-help.mjs 同一套脚本式断言）
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

const { apply, parseWhitelistCommand, whitelistReplyText, WHITELIST_PREFIX, NON_OWNER_MARKER } = await import('./index.js')

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
  const p = (t) => parseWhitelistCommand(t)
  for (const text of ['whitelist 12345678', 'WHITELIST 12345678', 'Whitelist 12345678', '  whitelist   12345678  ']) {
    check(`解析：${JSON.stringify(text)} 算指令`, p(text)?.targetQQ === '12345678')
  }
  for (const text of [
    'whitelist 12345678 你好', // 带正文 → 聊天
    'whitelist 123', // 4 位 → 太短
    'whitelist 1234567890123', // 13 位 → 太长
    '帮我 whitelist 12345678', // 不在开头
    'whitelist', // 没号码
    'whitelist abc', // 不是数字
    '', '？', null,
  ]) {
    check(`解析：${JSON.stringify(text)} 不算指令`, p(text) === null)
  }
  check('解析：前缀常量是 whitelist', WHITELIST_PREFIX === 'whitelist')

  check('文案：加成功带号码', whitelistReplyText({ targetQQ: '88889999' }).includes('88889999') && whitelistReplyText({ targetQQ: '88889999' }).includes('加进私聊白名单'))
  check('文案：重复加提示「已经在名单里」', whitelistReplyText({ targetQQ: '88889999', already: true }).includes('已经在') && whitelistReplyText({ targetQQ: '88889999', already: true }).includes('88889999'))
  check('文案：失败如实说没写成、不带成功字样', (() => {
    const t = whitelistReplyText({ targetQQ: '88889999', failed: '磁盘满了' })
    return t.includes('没写成') && t.includes('磁盘满了') && !t.includes('加进私聊白名单')
  })())
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：0.2.x 链路（设置文件是唯一持久存储；空名单 bootstrap 起步）
// ══════════════════════════════════════════════════════════════════════════
const stateDir = mkdtempSync(join(tmpdir(), 'qq-bridge-wl-'))
const statePath = join(stateDir, 'state.json')
const settingsFile = join(stateDir, 'qq-bridge-settings.json')
const readStoredWhitelist = () => {
  if (!existsSync(settingsFile)) return null
  try {
    return JSON.parse(readFileSync(settingsFile, 'utf8'))?.values?.whitelist ?? null
  } catch {
    return null
  }
}
{
  const warnings = []
  const registered = []
  const handlers = {}

  const agent = {
    id: 'session-wl',
    status: 'idle',
    session: { id: 'session-wl' },
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

  // 注意：ctx 故意**没有** settings（register/get）—— 这是 0.2.x 宿主的形状，
  // readSettings 走 qq-bridge-settings.json 那条路。legacy 分支在第三部分单独验。
  const ctx = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)) },
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      roots: () => [],
      resume: async () => {
        throw new Error('wl-test: no resume')
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
    targetSessionId: 'session-wl',
    statePath,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3998',
    selfId: '99999999',
    whitelist: [], // 起步就是空名单（fail-closed），验证 bootstrap
    groupWhitelist: ['90001'],
    nicknames: ['244'],
    privateWakeProbability: 1,
    wakeProbability: 0.05,
    ownerQQ: '10001',
  }

  apply(ctx, config)

  const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
  const status = registered.find((t) => t.name === 'qq_bridge_status')
  check('注册：调试工具在（simulate / status）', Boolean(sim && status))

  const sessionHandler = handlers['session/event']
  const fire = (type, data = {}) => sessionHandler({ id: 'session-wl' }, { type, data })
  const sends = () => wsSent.filter((f) => f.action === 'send_private_msg' || f.action === 'send_group_msg')
  const lastPrivateBody = () => {
    const f = sends().findLast?.((x) => x.action === 'send_private_msg')
    return ((f?.params?.message ?? []).map((s) => s?.data?.text ?? '').join('')) || ''
  }

  const openTransport = async () => {
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(await status.execute({})).transport?.state === 'open') return true
      await sleep(20)
    }
    return false
  }
  check('链路：假 OneBot 连接已建立', await openTransport())

  // ── 场景 0：空名单 fail-closed —— 主人发普通消息也被 drop，无任何回复 ─────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: '在吗', userId: '10001', nickname: '主人' }))
    check('空名单：主人发普通消息也被 drop', r.preview?.action === 'drop' && r.preview?.reason === 'not-allowlisted', JSON.stringify(r.preview))
    check('空名单：没有唤醒模型', agent.followups.length === 0)
    check('空名单：没有任何出站', sends().length === 0)
  }

  // ── 场景 1：bootstrap —— 主人不在白名单也能用 whitelist 加自己 ───────────
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'whitelist 10001', userId: '10001', nickname: '主人' }))
    check('bootstrap：决策是 whitelist（排在 isAllowed 之前）', r.preview?.action === 'whitelist' && r.preview?.reason === 'owner-whitelist', JSON.stringify(r.preview))
    check('bootstrap：没有唤醒模型', agent.followups.length === 0, `followups=${agent.followups.length}`)
    check('bootstrap：直发了一条私聊', sends().length === 1)
    const body = lastPrivateBody()
    check('bootstrap：确认里带号码', body.includes('10001') && body.includes('加进私聊白名单'), JSON.stringify(body))
    check('bootstrap：decision.delivered=true', r.decision?.delivered === true, JSON.stringify(r.decision))
    const stored = readStoredWhitelist()
    check('bootstrap：写进了设置文件（values.whitelist）', Array.isArray(stored) && stored.includes('10001'), JSON.stringify(stored))
  }
  {
    const st = JSON.parse(await status.execute({}))
    check('台账：outbox 记了 via=whitelist', st.recentOutbox.some((o) => o.via === 'whitelist' && o.to?.userId === '10001'))
    check('台账：log 决策是 whitelist', st.recentLog.some((l) => l.kind === 'inbound' && l.decision === 'whitelist'))
  }

  // ── 场景 2：热生效 —— 设置文件写完，下一条消息立刻能读到 ─────────────────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: '在吗', userId: '10001', nickname: '主人' }))
    check('热生效：主人现在能唤醒了（不再是 drop）', r.preview?.action === 'wake', JSON.stringify(r.preview))
    check('热生效：真的唤醒了模型', agent.followups.length === 1, `followups=${agent.followups.length}`)
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 3：别人（88889999）加进白名单前 → drop；加进去 → 立刻能说话 ────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: '你好啊', userId: '88889999', nickname: '朋友' }))
    check('加人前：陌生人被 drop', r.preview?.action === 'drop' && r.preview?.reason === 'not-allowlisted', JSON.stringify(r.preview))
    check('加人前：没有唤醒模型', agent.followups.length === 0)
  }
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'whitelist 88889999', userId: '10001', nickname: '主人' }))
    check('加人：决策是 whitelist', r.preview?.action === 'whitelist', JSON.stringify(r.preview))
    check('加人：没有唤醒模型', agent.followups.length === 0)
    check('加人：确认私聊带号码', sends().length === 1 && lastPrivateBody().includes('88889999'), JSON.stringify(sends().map((f) => f.action)))
    check('加人：delivered=true', r.decision?.delivered === true)
    const stored = readStoredWhitelist()
    check('加人：设置文件里有新号', stored?.includes('88889999'), JSON.stringify(stored))
  }
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: '你好啊', userId: '88889999', nickname: '朋友' }))
    check('热生效：新号立刻能唤醒（不用重启 / 不用重载插件）', r.preview?.action === 'wake', JSON.stringify(r.preview))
    check('热生效：真的唤醒了模型', agent.followups.length === 1, `followups=${agent.followups.length}`)
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 4：重复加同一个号 → 回「已经在名单里」，名单不重复追加 ───────────
  const beforeRepeat = readStoredWhitelist()
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'whitelist 88889999', userId: '10001', nickname: '主人' }))
    check('重复：决策仍是 whitelist', r.preview?.action === 'whitelist')
    check('重复：没有唤醒模型', agent.followups.length === 0)
    const body = lastPrivateBody()
    check('重复：回「已经在名单里」且带号码', body.includes('已经在') && body.includes('88889999'), JSON.stringify(body))
    const after = readStoredWhitelist()
    check('重复：名单一个都没多', Array.isArray(after) && after.length === beforeRepeat?.length && after.filter((x) => x === '88889999').length === 1, JSON.stringify(after))
    check('重复：delivered=true', r.decision?.delivered === true)
  }

  // ── 场景 5：非主人（已在白名单）发同样的字 → 不解析、不加人、不回话 ──────
  // 先把朋友 20002 也加进白名单（主人的正常操作），他才是「能说话但不是主人」那一档。
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'whitelist 20002', userId: '10001', nickname: '主人' }))
    check('铺垫：主人把朋友 20002 加进白名单', r.preview?.action === 'whitelist' && r.decision?.delivered === true)
    check('铺垫：名单里有 20002', readStoredWhitelist()?.includes('20002'), JSON.stringify(readStoredWhitelist()))
  }
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'whitelist 77777777', userId: '20002', nickname: '朋友' }))
    check('权限：非主人发同样开头不是 whitelist 指令', r.preview?.action !== 'whitelist', JSON.stringify(r.preview))
    check('权限：当成普通聊天处理（被唤醒）', agent.followups.length === 1, `followups=${agent.followups.length}`)
    check('权限：桥接层没有直发任何回复', sends().length === 0, JSON.stringify(wsSent.map((f) => f.action)))
    const injected = (agent.followups.at(-1)?.content ?? []).map((b) => b?.text ?? '').join('')
    check('权限：正文带非主人标记', injected.includes(NON_OWNER_MARKER))
    const stored = readStoredWhitelist()
    check('权限：77777777 没被加进白名单', !(stored ?? []).includes('77777777'), JSON.stringify(stored))
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 6：非主人且不在白名单 → 直接 drop，不回话 ────────────────────────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'whitelist 77777777', userId: '66666666', nickname: '陌生人' }))
    check('权限：陌生人被 drop（非主人 + 非白名单）', r.preview?.action === 'drop', JSON.stringify(r.preview))
    check('权限：没有唤醒模型', agent.followups.length === 0)
    check('权限：没有任何出站', sends().length === 0)
    const stored = readStoredWhitelist()
    check('权限：名单不变', !(stored ?? []).includes('77777777'))
  }

  // ── 场景 7：主人在群里发 whitelist → 回在群里 ─────────────────────────────
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'whitelist 33334444', userId: '10001', groupId: '90001', nickname: '主人' }))
    check('群聊：决策是 whitelist', r.preview?.action === 'whitelist', JSON.stringify(r.preview))
    const frame = sends().find((f) => f.action === 'send_group_msg')
    check('群聊：发到群里而不是私聊', Boolean(frame) && String(frame?.params?.group_id) === '90001', JSON.stringify(wsSent.map((f) => f.action)))
    const body = ((frame?.params?.message ?? []).map((s) => s?.data?.text ?? '').join('')) || ''
    check('群聊：群里的确认带号码', body.includes('33334444'))
    const stored = readStoredWhitelist()
    check('群聊：白名单也写进了设置文件', stored?.includes('33334444'), JSON.stringify(stored))
  }

  // ── 场景 8：help 列表里有 whitelist 这条 ──────────────────────────────────
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'help', userId: '10001', nickname: '主人' }))
    check('help：决策是 help', r.preview?.action === 'help', JSON.stringify(r.preview))
    const body = lastPrivateBody()
    check('help：列表里有 whitelist <QQ号>', body.includes('whitelist <QQ号>'), JSON.stringify(body.slice(0, 120)))
  }

  check('全程没有「whitelist 没办好」告警', !warnings.some((w) => w.includes('whitelist 没办好')), JSON.stringify(warnings.slice(-3)))
}

// ══════════════════════════════════════════════════════════════════════════
// 第三部分：legacy 宿主（ctx.settings 有 register/get）—— 如实报不可写
// ══════════════════════════════════════════════════════════════════════════
const legacyDir = mkdtempSync(join(tmpdir(), 'qq-bridge-wl-legacy-'))
const legacyStatePath = join(legacyDir, 'state.json')
const legacySettingsFile = join(legacyDir, 'qq-bridge-settings.json')
{
  const registered = []
  const handlers = {}
  let resolvedSettings = {}

  const agent = {
    id: 'session-wl2',
    status: 'idle',
    session: { id: 'session-wl2' },
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
    logger: { info() {}, warn() {} },
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
        throw new Error('wl-test: no resume')
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
    targetSessionId: 'session-wl2',
    statePath: legacyStatePath,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3999',
    selfId: '99999999',
    whitelist: ['10001'],
    ownerQQ: '10001',
    privateWakeProbability: 1,
  }

  apply(ctx, config)

  const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
  const status = registered.find((t) => t.name === 'qq_bridge_status')
  const sessionHandler = handlers['session/event']
  const fire = (type, data = {}) => sessionHandler({ id: 'session-wl2' }, { type, data })
  const sends = () => wsSent.filter((f) => f.action === 'send_private_msg' || f.action === 'send_group_msg')
  const lastPrivateBody = () => {
    const f = sends().findLast?.((x) => x.action === 'send_private_msg')
    return ((f?.params?.message ?? []).map((s) => s?.data?.text ?? '').join('')) || ''
  }

  const openTransport = async () => {
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(await status.execute({})).transport?.state === 'open') return true
      await sleep(20)
    }
    return false
  }
  check('legacy：假 OneBot 连接已建立', await openTransport())

  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'whitelist 66666666', userId: '10001', nickname: '主人' }))
    check('legacy：决策仍是 whitelist（指令认了）', r.preview?.action === 'whitelist', JSON.stringify(r.preview))
    check('legacy：没有唤醒模型', agent.followups.length === 0)
    check('legacy：回的是「没写成」而不是装成功', lastPrivateBody().includes('没写成'), JSON.stringify(lastPrivateBody()))
    check('legacy：delivered=false（没办成）', r.decision?.delivered === false, JSON.stringify(r.decision))
    check('legacy：没有偷写设置文件', !existsSync(legacySettingsFile))
    const st = JSON.parse(await status.execute({}))
    check('legacy：log 决策是 whitelist-failed', st.recentLog.some((l) => l.decision === 'whitelist-failed'))
  }
  fire('turn/end', { reason: { kind: 'completed' } })
}

rmSync(stateDir, { recursive: true, force: true })
rmSync(legacyDir, { recursive: true, force: true })

console.log('')
if (failed === 0) console.log('ALL PASS')
else console.log(`${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
