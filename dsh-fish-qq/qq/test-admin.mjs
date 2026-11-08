/**
 * test-admin.mjs —— 「管理员」这一类身份（2026-10-29）
 *
 * 验收清单（任务书口径，fileget / filesend 经主人确认放开给管理员）：
 *   解析：`admin add/del <5–12 位 QQ 号>`、`admin list/列表` 整条消息才算
 *         （大小写 / 首尾空白不敏感）；带正文、位数不对、不在开头都 null（= 普通聊天）。
 *   存储：名单就是设置里那一项 admins —— 写进 qq-bridge-settings.json 的 values.admins，
 *         与设置卡片同一个文件、同一份结构，不另起一套；legacy 宿主如实回「没写成」。
 *   权限：admin 指令只有 ownerQQ 发的才认；非主人发一样的字 → 不解析、不改名单、不回话。
 *   热生效：写完**不重启**，同一条进程里下一条入站消息就能读到新名单
 *         （加进去 → 立刻贴管理员标记；删掉 → 立刻退回非主人标记）。
 *   三档来源标记：主人不带标记；管理员 `[来源：管理员用户]`；普通人现有的非主人那行。
 *   help：**谁都能用**，内容按身份分档 —— 主人全量、管理员自己能用、普通人聊天。
 *   派任务：管理员的消息不带「禁止派活」标记，提示词写明管理员可以 work_request
 *         （工具在 fish 那一侧，桥接的机制就是标记 + 提示词 + 指令解析）。
 *   边界（管理员**不能**）：subsend / whitelist / admin ——
 *         指令不解析、不附系统说明，工具闸门（subsend 的身份闸门）照拒。
 *   边界（管理员**能**）：fileget / filesend —— 指令解析必唤醒（reason=admin-file），
 *         说明按管理员口径写（fileget 走 qq_bridge_filesend 发给管理员自己），
 *         工具闸门（currentTurnFromAdmin）放行。
 *   普通人：除了 help（拿到聊天那份）之外什么都用不了 ——
 *         fileget/subsend/whitelist/admin 的文本都不算指令，工具调用被拒。
 *
 * 跑法：node test-admin.mjs（与 test-filesend.mjs 同一套脚本式断言）
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 工作区根 = 仓库根（本文件在 dsh-fish-qq/qq/ 下，往上两级），与 test-filesend 同一口径
const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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
      this.onmessage?.({ data: JSON.stringify({ echo: frame.echo, status: 'ok', retcode: 0, data: { file_id: 'test-fid' } }) })
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
  parseAdminCommand,
  adminReplyText,
  ADMIN_PREFIX,
  ADMIN_MARKER,
  NON_OWNER_MARKER,
  senderRole,
  isAdminSender,
  canUseFileCommand,
  ownerMarkerFor,
  buildHelpText,
  buildUsagePrompt,
  renderFileInstruction,
} = await import('./index.js')

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
  const p = (t) => parseAdminCommand(t)
  check('解析：admin add 算指令', p('admin add 12345678')?.op === 'add' && p('admin add 12345678')?.targetQQ === '12345678')
  check('解析：admin del 算指令', p('admin del 12345678')?.op === 'del' && p('admin del 12345678')?.targetQQ === '12345678')
  check('解析：大小写不敏感', p('ADMIN DEL 12345678')?.op === 'del')
  check('解析：首尾空白不敏感', p('  Admin   Add   12345678  ')?.op === 'add')
  check('解析：admin list 算指令', p('admin list')?.op === 'list')
  check('解析：admin 列表 也行', p('admin 列表')?.op === 'list')
  for (const text of [
    'admin add 12345678 你好', // 带正文 → 聊天
    'admin del 123', // 4 位 → 太短
    'admin add 1234567890123', // 13 位 → 太长
    '帮我 admin add 12345678', // 不在开头
    'admins add 12345678', // 前缀不是 admin 这个词
    'admin', // 没操作词
    'admin add', // 没号码
    'admin add abc', // 不是数字
    'admin xyz', // 不认识的操作词
    '', '？', null,
  ]) {
    check(`解析：${JSON.stringify(text)} 不算指令`, p(text) === null)
  }
  check('解析：前缀常量是 admin', ADMIN_PREFIX === 'admin')

  // ── 回执文案（各档都带号码 / 如实说，不报假成功）
  check('文案：加成功带号码', adminReplyText({ op: 'add', targetQQ: '20002' }).includes('20002') && adminReplyText({ op: 'add', targetQQ: '20002' }).includes('加进管理员名单'))
  check('文案：重复加提示「已经在名单里」', adminReplyText({ op: 'add', targetQQ: '20002', already: true }).includes('已经在管理员名单里'))
  check('文案：移除成功', adminReplyText({ op: 'del', targetQQ: '20002' }).includes('移除'))
  check('文案：不在名单里不报移除成功', (() => {
    const t = adminReplyText({ op: 'del', targetQQ: '20002', missing: true })
    return t.includes('不在管理员名单里') && !t.includes('移除')
  })())
  check('文案：空名单说明怎么加', adminReplyText({ op: 'list', list: [] }).includes('空的'))
  check('文案：名单内容带人数与号码', (() => {
    const t = adminReplyText({ op: 'list', list: ['20002', '30003'] })
    return t.includes('2 人') && t.includes('20002') && t.includes('30003')
  })())
  check('文案：失败如实说没写成、不带成功字样', (() => {
    const t = adminReplyText({ op: 'add', targetQQ: '20002', failed: '磁盘满了' })
    return t.includes('没写成') && t.includes('磁盘满了') && !t.includes('加进管理员名单')
  })())

  // ── 三档身份与标记
  const id = { ownerQQ: '10001', admins: ['20002'] }
  check('身份：主人是 owner', senderRole('10001', id) === 'owner')
  check('身份：管理员是 admin', senderRole('20002', id) === 'admin')
  check('身份：普通人是 other', senderRole('30003', id) === 'other')
  check('身份：主人在管理员名单里也算 owner（主人那档优先）', senderRole('10001', { ownerQQ: '10001', admins: ['10001'] }) === 'owner')
  check('身份：没配主人时谁都不是主人', senderRole('10001', { ownerQQ: '', admins: [] }) === 'other')
  check('身份：admins 乱值不炸', isAdminSender('10001', null) === false && isAdminSender('', ['1']) === false)
  check('标记：主人空串', ownerMarkerFor('10001', '10001', ['10001']) === '')
  check('标记：管理员那行', ownerMarkerFor('20002', '10001', ['20002']) === ADMIN_MARKER)
  check('标记：普通人那行（不变）', ownerMarkerFor('30003', '10001', ['20002']) === NON_OWNER_MARKER)
  check('标记：老两参签名仍然能算（默认无管理员）', ownerMarkerFor('20002', '10001') === NON_OWNER_MARKER)
  check('标记常量：[来源：管理员用户]', ADMIN_MARKER === '[来源：管理员用户]')

  // ── fileget / filesend 的身份判定
  check('文件指令：主人能下', canUseFileCommand('10001', id) === true)
  check('文件指令：管理员能下', canUseFileCommand('20002', id) === true)
  check('文件指令：普通人不能下', canUseFileCommand('30003', id) === false)
  check('文件指令：参数兜底不炸', canUseFileCommand(undefined, undefined) === false)

  // ── 三份 help 列表
  const base = { ownerQQ: '10001', admins: ['20002'], workspaceRoot: WORKSPACE_ROOT, subsendEnabled: true }
  const ownerText = buildHelpText(base) // 不传 sender = 主人那份（老签名兼容）
  check('help·主人：全量（带 admin add / del / list）', ownerText.includes('admin add <QQ号>') && ownerText.includes('admin del <QQ号>') && ownerText.includes('admin list'))
  check('help·主人：带 subsend / whitelist', ownerText.includes('subsend') && ownerText.includes('whitelist'))
  check('help·主人：不再列加好友指令', !ownerText.includes('addfriend'))
  check('help·主人：带主人号', ownerText.includes('10001'))
  const adminText = buildHelpText(base, { senderId: '20002' })
  check('help·管理员：列 fileget / filesend', adminText.includes('fileget <相对路径>') && adminText.includes('filesend <QQ号> <相对路径>'))
  check('help·管理员：列 help 自己', adminText.includes('help'))
  check('help·管理员：写明可以派活（work_request）', adminText.includes('work_request'))
  check('help·管理员：写明哪些只有主人能用', adminText.includes('subsend') && adminText.includes('whitelist') && adminText.includes('admin'))
  check('help·管理员：不教主人专用的指令用法', !adminText.includes('admin add <QQ号>') && !adminText.includes('subsend <QQ号>'))
  const otherText = buildHelpText(base, { senderId: '30003' })
  check('help·普通人：只说能聊天', otherText.includes('只能聊天'))
  check('help·普通人：列 help 自己', otherText.includes('help'))
  check('help·普通人：不列任何有副作用的指令', !otherText.includes('fileget') && !otherText.includes('subsend') && !otherText.includes('admin add') && !otherText.includes('whitelist') && !otherText.includes('addfriend'))
  // 管理员看 help 不受 subsendEnabled 影响（本来就没有那一条）
  const adminOff = buildHelpText({ ...base, subsendEnabled: false }, { senderId: '20002' })
  check('help·管理员：与 subsend 开关无关', adminOff.includes('fileget') && !adminOff.includes('subsend <QQ号>'))
  // 工作区没配时管理员那份也标明
  const noWs = buildHelpText({ ...base, workspaceRoot: '' }, { senderId: '20002' })
  check('help·管理员：工作区没配时标明发文件用不了', noWs.includes('工作区还没配'))

  // ── 管理员口径的文件说明
  const inst = renderFileInstruction({ kind: 'fileget', path: 'qq/x.md' }, base, { senderId: '20002' })
  check('说明·管理员：写明是管理员的指令', inst.includes('这是管理员（QQ 20002）的 fileget 指令'))
  check('说明·管理员：改走 qq_bridge_filesend 发给管理员自己', inst.includes('qq_bridge_filesend') && inst.includes('targetQQ="20002"'))
  check('说明·管理员：不带主人那版本', !inst.includes('这是主人的 fileget 指令'))
  const instSend = renderFileInstruction({ kind: 'filesend', targetQQ: '30003', path: 'qq/y.md' }, base, { senderId: '20002' })
  check('说明·管理员：filesend 目标号照抄', instSend.includes('targetQQ="30003"') && instSend.includes('qq/y.md'))
  // 主人那条一字不变（老签名）
  check('说明·主人：老签名不变', renderFileInstruction({ kind: 'fileget', path: 'qq/x.md' }, base).includes('这是主人的 fileget 指令'))

  // ── 用法说明：教模型三档身份
  const prompt = buildUsagePrompt({ ownerQQ: '10001', workspaceRoot: WORKSPACE_ROOT })
  check('提示词：标题改成「谁是主人、谁是管理员」', prompt.includes('【谁是主人、谁是管理员】'))
  check('提示词：教 ADMIN_MARKER 的读法', prompt.includes(ADMIN_MARKER))
  check('提示词：写明管理员可以派活（work_request）', prompt.includes('管理员比普通人多两项权限') && prompt.includes('work_request'))
  check('提示词：写明管理员的文件权限', prompt.includes('fileget') && prompt.includes('filesend'))
  check('提示词：写明主人专用指令管理员不能下', prompt.includes('subsend') && prompt.includes('管理员**不能**下'))
  check('提示词：发文件一节写明主人和管理员都能下', prompt.includes('只有主人和管理员能下这个指令'))
  check('提示词：普通人那行原样保留', prompt.includes(NON_OWNER_MARKER))
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：0.2.x 链路（设置文件是唯一持久存储；名单从空起步）
// ══════════════════════════════════════════════════════════════════════════
const stateDir = mkdtempSync(join(tmpdir(), 'qq-bridge-admin-'))
const statePath = join(stateDir, 'state.json')
const settingsFile = join(stateDir, 'qq-bridge-settings.json')
{
  const warnings = []
  const registered = []
  const handlers = {}
  let resolvedSettings = {}

  const agent = {
    id: 'session-admin',
    status: 'idle',
    session: { id: 'session-admin' },
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
      // 0.2.x 宿主：没有 register/get，设置表单从 Config schema 派生
    },
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      roots: () => [],
      resume: async () => {
        throw new Error('admin-test: no resume')
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
    targetSessionId: 'session-admin',
    statePath,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3997',
    selfId: '99999999',
    whitelist: ['10001', '20002', '30003'],
    groupWhitelist: ['90001'],
    nicknames: ['244'],
    wakeProbability: 1,
    privateWakeProbability: 1,
    ownerQQ: '10001',
    workspaceRoot: WORKSPACE_ROOT,
  }

  apply(ctx, config)

  const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
  const status = registered.find((t) => t.name === 'qq_bridge_status')
  const fileget = registered.find((t) => t.name === 'qq_bridge_fileget')
  const filesend = registered.find((t) => t.name === 'qq_bridge_filesend')
  const subsend = registered.find((t) => t.name === 'qq_bridge_subsend')
  check('注册：工具都在（simulate/status/fileget/filesend/subsend）', Boolean(sim && status && fileget && filesend && subsend))

  const sessionHandler = handlers['session/event']
  const fire = (type, data = {}) => sessionHandler({ id: 'session-admin' }, { type, data })
  const lastInjected = () => {
    const msg = agent.followups.at(-1)
    const blocks = msg?.content ?? []
    return blocks.map((b) => b?.text ?? '').join('')
  }
  const sends = () => wsSent.filter((f) => f.action === 'send_private_msg' || f.action === 'send_group_msg')
  const lastPrivateBody = () => {
    const frame = [...wsSent].reverse().find((f) => f.action === 'send_private_msg')
    return (frame?.params?.message ?? []).map((s) => s?.data?.text ?? '').join('')
  }
  const uploads = () => wsSent.filter((f) => f.action === 'upload_private_file')
  const openTransport = async () => {
    for (let i = 0; i < 100; i++) {
      const st = JSON.parse(await status.execute({}))
      if (st.transport?.state === 'open') return true
      await sleep(20)
    }
    return false
  }
  check('链路：假 OneBot 连接已建立', await openTransport())

  // 工作区里真实存在的一个小文件（与 test-filesend 同一口径）
  const realFile = 'docs/archive/dsh-qq-bridge__CHANGELOG.md'
  const settingsValues = () => {
    try {
      return JSON.parse(readFileSync(settingsFile, 'utf8')).values ?? {}
    } catch {
      return {}
    }
  }

  // ── 场景 1：主人 admin add，桥接层自己办（不叫模型）─────────────────────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'admin add 20002', userId: '10001', nickname: '主人' }))
    check('add：决策是 admin', r.preview?.action === 'admin' && r.preview?.reason === 'owner-admin', JSON.stringify(r.preview))
    check('add：没有唤醒模型', agent.followups.length === 0)
    check('add：回了一句确认', sends().length === 1 && lastPrivateBody().includes('20002') && lastPrivateBody().includes('加进管理员名单'), lastPrivateBody().slice(0, 60))
    check('add：delivered=true', r.decision?.delivered === true, JSON.stringify(r.decision))
    check('add：写进了设置文件的 values.admins', JSON.stringify(settingsValues().admins) === '["20002"]', JSON.stringify(settingsValues().admins))
    const st = JSON.parse(await status.execute({}))
    check('add：status 暴露 admins', Array.isArray(st.admins?.list) && st.admins?.list?.length === 1 && st.admins?.count === 1, JSON.stringify(st.admins))
    check('add：outbox 记了 via=admin', st.recentOutbox.some((o) => o.via === 'admin' && o.to?.userId === '10001'))
  }

  // ── 场景 2：热生效 —— 20002 的下一条消息立刻贴管理员标记 ─────────────────
  agent.followups.length = 0
  wsSent.length = 0
  {
    await sim.execute({ text: '你好呀', userId: '20002', nickname: '管理员' })
    check('标记：管理员消息被唤醒', agent.followups.length === 1)
    const injected = lastInjected()
    check('标记：管理员带 [来源：管理员用户]', injected.startsWith(ADMIN_MARKER), injected.slice(0, 60))
    check('标记：不带非主人那行', !injected.includes(NON_OWNER_MARKER))
    check('标记：正文在标记之后', injected.indexOf('[QQ · 私聊]') > injected.indexOf(ADMIN_MARKER))
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 3：主人不带标记；普通人带非主人那行 ─────────────────────────────
  agent.followups.length = 0
  {
    await sim.execute({ text: '我在', userId: '10001', nickname: '主人' })
    check('标记：主人不带任何标记', !lastInjected().includes(ADMIN_MARKER) && !lastInjected().includes(NON_OWNER_MARKER), lastInjected().slice(0, 40))
    fire('turn/end', { reason: { kind: 'completed' } })
  }
  agent.followups.length = 0
  {
    await sim.execute({ text: '路过', userId: '30003', nickname: '群友' })
    check('标记：普通人带非主人那行', lastInjected().startsWith(NON_OWNER_MARKER), lastInjected().slice(0, 60))
    check('标记：普通人不是管理员那行', !lastInjected().startsWith(ADMIN_MARKER))
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 4：help 按身份给三份（谁都能用，不叫模型）──────────────────────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'help', userId: '10001', nickname: '主人' }))
    check('help·主人：决策 help / owner-help', r.preview?.action === 'help' && r.preview?.reason === 'owner-help', JSON.stringify(r.preview))
    check('help·主人：不叫模型', agent.followups.length === 0)
    const body = lastPrivateBody()
    check('help·主人：全量列表（admin add / subsend）', body.includes('admin add <QQ号>') && body.includes('subsend'), body.slice(0, 50))
  }
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'help', userId: '20002', nickname: '管理员' }))
    check('help·管理员：决策 help / admin-help', r.preview?.action === 'help' && r.preview?.reason === 'admin-help', JSON.stringify(r.preview))
    check('help·管理员：不叫模型', agent.followups.length === 0)
    const body = lastPrivateBody()
    check('help·管理员：列 fileget / filesend', body.includes('fileget') && body.includes('filesend'))
    check('help·管理员：写明可以派活', body.includes('work_request'))
    check('help·管理员：不列主人专属指令', !body.includes('subsend <QQ号>') && !body.includes('admin add <QQ号>') && !body.includes('whitelist <QQ号>'))
    check('help·管理员：不再列加好友指令', !body.includes('addfriend'))
    check('help·管理员：写明哪些只有主人能用', body.includes('只有主人能用'))
    check('help·管理员：delivered', r.decision?.delivered === true)
  }
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: '帮助', userId: '30003', nickname: '群友' }))
    check('help·普通人：决策 help / other-help', r.preview?.action === 'help' && r.preview?.reason === 'other-help', JSON.stringify(r.preview))
    check('help·普通人：不叫模型', agent.followups.length === 0)
    const body = lastPrivateBody()
    check('help·普通人：只教聊天', body.includes('只能聊天') && !body.includes('fileget') && !body.includes('admin'))
    check('help·普通人：delivered', r.decision?.delivered === true)
  }

  // ── 场景 5：管理员能用 fileget / filesend ────────────────────────────────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: `fileget ${realFile}`, userId: '20002', nickname: '管理员' }))
    check('fileget·管理员：必唤醒（reason=admin-file）', r.preview?.action === 'wake' && r.preview?.reason === 'admin-file', JSON.stringify(r.preview))
    const injected = lastInjected()
    check('fileget·管理员：附管理员口径的说明', injected.includes('这是管理员（QQ 20002）的 fileget 指令'), injected.slice(-140))
    check('fileget·管理员：说明点名 filesend + 管理员自己的号', injected.includes('qq_bridge_filesend') && injected.includes('targetQQ="20002"'))
    check('fileget·管理员：不带非主人标记', !injected.includes(NON_OWNER_MARKER))
  }
  // 这一轮里按说明调 filesend：闸门放行，文件发给管理员自己
  fire('turn/start', { turn: 1 })
  wsSent.length = 0
  {
    const r = JSON.parse(await filesend.execute({ targetQQ: '20002', path: realFile }))
    check('fileget·管理员：工具放行（currentTurnFromAdmin）', r.ok === true, JSON.stringify(r).slice(0, 200))
    check('fileget·管理员：文件真的发给管理员', uploads().length === 1 && String(uploads()[0]?.params?.user_id) === '20002', JSON.stringify(wsSent.map((f) => f.action)))
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // filesend 给别人也行（管理员要文件给别人）
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: `filesend 30003 ${realFile}`, userId: '20002', nickname: '管理员' }))
    check('filesend·管理员：必唤醒', r.preview?.action === 'wake' && r.preview?.reason === 'admin-file', JSON.stringify(r.preview))
    check('filesend·管理员：说明写明管理员 + 目标号', lastInjected().includes('这是管理员（QQ 20002）的 filesend 指令') && lastInjected().includes('30003'))
  }
  fire('turn/start', { turn: 2 })
  wsSent.length = 0
  {
    const r = JSON.parse(await filesend.execute({ targetQQ: '30003', path: realFile }))
    check('filesend·管理员：工具放行', r.ok === true && String(uploads()[0]?.params?.user_id) === '30003', JSON.stringify(r).slice(0, 160))
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // ── 场景 6：管理员调 subsend 被拒（主人专用通道，闸门不认 admin 标记）────
  agent.followups.length = 0
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'subsend 30003 帮我问个好', userId: '20002', nickname: '管理员' }))
    check('subsend·管理员：不解析成 owner-subsend', r.preview?.action !== 'wake' || r.preview?.reason !== 'owner-subsend', JSON.stringify(r.preview))
    const injected = lastInjected()
    check('subsend·管理员：不附系统说明（当普通聊天）', !injected.includes('subsend 指令'))
    check('subsend·管理员：消息照样进会话（不丢）', injected.includes('帮我问个好'))
  }
  fire('turn/start', { turn: 3 })
  wsSent.length = 0
  {
    const r = JSON.parse(await subsend.execute({ targetQQ: '30003', message: '你好' }))
    check('subsend·管理员：工具被拒 not-owner', r.ok === false && r.reason === 'not-owner', JSON.stringify(r).slice(0, 200))
    check('subsend·管理员：一个字都没发', wsSent.filter((f) => f.action === 'send_private_msg').length === 0)
    const st = JSON.parse(await status.execute({}))
    check('subsend·管理员：台账记了 denied/not-owner', st.recentLog.some((l) => l.kind === 'subsend' && l.decision !== undefined ? false : l.kind === 'subsend' && l.outcome === 'denied' && l.reason === 'not-owner'))
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // ── 场景 7：管理员发 whitelist / admin 文本 → 不是指令 ───────────────────
  const whitelistBefore = JSON.stringify(settingsValues().whitelist)
  agent.followups.length = 0
  {
    const preview = JSON.parse(await sim.execute({ text: 'whitelist 77777777', userId: '20002', dryRun: true })).preview
    check('whitelist·管理员：不解析成 whitelist 指令', preview?.action !== 'whitelist', JSON.stringify(preview))
    check('whitelist·管理员：白名单没被动', JSON.stringify(settingsValues().whitelist) === whitelistBefore, JSON.stringify(settingsValues().whitelist))
    await sim.execute({ text: 'whitelist 77777777', userId: '20002', nickname: '管理员' })
    check('whitelist·管理员：只是普通聊天（消息进会话）', lastInjected().includes('whitelist 77777777'))
    fire('turn/end', { reason: { kind: 'completed' } })
  }
  agent.followups.length = 0
  {
    const before = JSON.stringify(settingsValues().admins)
    await sim.execute({ text: 'admin add 40004', userId: '20002', nickname: '管理员' })
    check('admin·管理员：自己不能加管理员', JSON.stringify(settingsValues().admins) === before, JSON.stringify(settingsValues().admins))
    check('admin·管理员：没有回话', sends().filter((f) => String(f.params?.user_id) === '20002').length === 0)
    check('admin·管理员：消息进会话', lastInjected().includes('admin add 40004'))
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 8：普通人除了 help 之外什么都用不了 ─────────────────────────────
  for (const text of [`fileget ${realFile}`, 'subsend 20002 你好', 'whitelist 80001', 'admin add 20002', 'addfriend 90001']) {
    agent.followups.length = 0
    wsSent.length = 0
    // eslint-disable-next-line no-await-in-loop
    const r = JSON.parse(await sim.execute({ text, userId: '30003', nickname: '群友' }))
    check(`边界·普通人：${JSON.stringify(text).slice(0, 24)}… 不是特殊指令`, !['whitelist', 'admin', 'owner-subsend', 'owner-file'].includes(r.preview?.reason), JSON.stringify(r.preview))
    check(`边界·普通人：${JSON.stringify(text).slice(0, 24)}… 照常当聊天`, agent.followups.length === 1)
    check(`边界·普通人：不带任何指令说明`, !lastInjected().includes('这是主人的') && !lastInjected().includes('这是管理员'))
    check(`边界·普通人：带非主人标记`, lastInjected().startsWith(NON_OWNER_MARKER))
    fire('turn/end', { reason: { kind: 'completed' } })
  }
  // 工具闸门也认普通人这轮：filesend 直接拒
  agent.followups.length = 0
  wsSent.length = 0
  {
    await sim.execute({ text: '给我看看那个文件', userId: '30003', nickname: '群友' })
    fire('turn/start', { turn: 4 })
    const r = JSON.parse(await filesend.execute({ targetQQ: '30003', path: realFile }))
    check('边界·普通人：filesend 工具被拒 not-owner', r.ok === false && r.reason === 'not-owner', JSON.stringify(r).slice(0, 160))
    const st = JSON.parse(await status.execute({}))
    check('边界·普通人：台账记了 file denied/not-owner', st.recentLog.some((l) => l.kind === 'file' && l.outcome === 'denied' && l.reason === 'not-owner'))
    fire('turn/end', { reason: { kind: 'completed' } })
  }

  // ── 场景 9：admin list / 重复加 / 移除 / 热生效退回 ──────────────────────
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'admin list', userId: '10001', nickname: '主人' }))
    check('list：决策 admin', r.preview?.action === 'admin')
    check('list：回执带名单', lastPrivateBody().includes('20002') && lastPrivateBody().includes('1 人'), lastPrivateBody().slice(0, 60))
  }
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'admin add 20002', userId: '10001', nickname: '主人' }))
    check('重复：回「已经在名单里」', lastPrivateBody().includes('已经在管理员名单里'), lastPrivateBody().slice(0, 60))
    check('重复：名单不重复追加', settingsValues().admins?.length === 1, JSON.stringify(settingsValues().admins))
  }
  // 再加一个，凑成两人
  wsSent.length = 0
  {
    await sim.execute({ text: 'admin add 30003', userId: '10001', nickname: '主人' })
    check('再加：名单变两人', JSON.stringify(settingsValues().admins) === '["20002","30003"]', JSON.stringify(settingsValues().admins))
  }
  wsSent.length = 0
  {
    await sim.execute({ text: 'admin list', userId: '10001', nickname: '主人' })
    check('list：两人都在', lastPrivateBody().includes('20002') && lastPrivateBody().includes('30003') && lastPrivateBody().includes('2 人'), lastPrivateBody().slice(0, 60))
  }
  // 删掉 20002：下一条消息立刻退回非主人标记（热生效，不重启）
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'admin del 20002', userId: '10001', nickname: '主人' }))
    check('del：回执写明移除', lastPrivateBody().includes('移除') && lastPrivateBody().includes('20002'), lastPrivateBody().slice(0, 60))
    check('del：名单里只剩 30003', JSON.stringify(settingsValues().admins) === '["30003"]', JSON.stringify(settingsValues().admins))
  }
  agent.followups.length = 0
  {
    await sim.execute({ text: '我还能派活吗', userId: '20002', nickname: '前管理员' })
    check('del·热生效：退回非主人标记', lastInjected().startsWith(NON_OWNER_MARKER), lastInjected().slice(0, 60))
    fire('turn/end', { reason: { kind: 'completed' } })
  }
  wsSent.length = 0
  {
    await sim.execute({ text: 'admin del 20002', userId: '10001', nickname: '主人' })
    check('重复删：回「不在名单里」', lastPrivateBody().includes('不在管理员名单里'), lastPrivateBody().slice(0, 60))
  }

  // ── 场景 10：指令形状不合法 = 普通聊天 ───────────────────────────────────
  for (const text of ['admin', 'admin add', 'admin add 123', 'admin add 1234567890123', 'admin add 12345678 好的', '帮我 admin add 12345678']) {
    const preview = JSON.parse(await sim.execute({ text, userId: '10001', dryRun: true })).preview
    check(`边界·形状：${JSON.stringify(text)} 不是 admin 指令`, preview?.action !== 'admin', JSON.stringify(preview))
  }

  // ── 场景 11 已并入第三部分（空名单 bootstrap，白名单为空时主人仍能用 admin）──

  check('全程没有异常告警（admin 没办好之类）', !warnings.some((w) => w.includes('admin 没办好')), JSON.stringify(warnings.slice(-3)))
  rmSync(stateDir, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
// 第三部分：空名单 bootstrap —— whitelist 都为空时，主人仍然能用 admin
// ══════════════════════════════════════════════════════════════════════════
{
  const stateDir2 = mkdtempSync(join(tmpdir(), 'qq-bridge-admin2-'))
  const handlers = {}
  const registered = []
  const agent = {
    id: 'session-admin2',
    status: 'idle',
    session: { id: 'session-admin2' },
    followups: [],
    followup(msg) {
      this.followups.push(msg)
      return Promise.resolve()
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    settings: {},
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      roots: () => [],
      resume: async () => {
        throw new Error('admin-test2: no resume')
      },
    },
    tools: { register: (def) => registered.push(def) },
    on: (name, fn) => {
      handlers[name] = fn
      return () => {}
    },
    // ⚠️ effect 必须立刻执行回调（注册 scoped effect，传输层靠它起来），
    // 只在销毁时才调是不够的 —— 那样 transport 永远连不上。
    effect: (fn) => {
      const d = fn?.()
      return () => d?.()
    },
    get: () => undefined,
  }
  ctx.inject = (_deps, cb) => cb(ctx)
  apply(ctx, {
    targetSessionId: 'session-admin2',
    statePath: join(stateDir2, 'state.json'),
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3996',
    whitelist: [], // ← 完全 fail-closed
    groupWhitelist: [],
    ownerQQ: '10001',
    nicknames: ['244'],
    privateWakeProbability: 1,
  })
  const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
  const status = registered.find((t) => t.name === 'qq_bridge_status')
  const openTransport = async () => {
    for (let i = 0; i < 100; i++) {
      const st = JSON.parse(await status.execute({}))
      if (st.transport?.state === 'open') return true
      await sleep(20)
    }
    return false
  }
  check('bootstrap：连接已建立', await openTransport())
  {
    const r = JSON.parse(await sim.execute({ text: 'admin add 20002', userId: '10001', nickname: '主人' }))
    check('bootstrap：空名单时主人仍能用 admin', r.preview?.action === 'admin', JSON.stringify(r.preview))
    check('bootstrap：写进去了', JSON.stringify(JSON.parse(readFileSync(join(stateDir2, 'qq-bridge-settings.json'), 'utf8')).values?.admins) === '["20002"]')
  }
  // 反面：陌生人哪怕发一样的字也被 drop
  {
    const r = JSON.parse(await sim.execute({ text: 'admin add 50005', userId: '99999', nickname: '陌生人', dryRun: true }))
    check('bootstrap：陌生人的 admin 被丢（fail-closed）', r.preview?.action === 'drop', JSON.stringify(r.preview))
  }
  rmSync(stateDir2, { recursive: true, force: true })
}

// ═══════════════════════════════════════════════════ assertion
// 第四部分：legacy 宿主（register/get）—— 没有写入接口，如实说「没写成」
// ══════════════════════════════════════════════════════════════════════════
{
  const stateDir3 = mkdtempSync(join(tmpdir(), 'qq-bridge-admin3-'))
  const handlers = {}
  const registered = []
  const agent = {
    id: 'session-admin3',
    status: 'idle',
    session: { id: 'session-admin3' },
    followups: [],
    followup(msg) {
      this.followups.push(msg)
      return Promise.resolve()
    },
  }
  let legacySettings = {}
  const ctx = {
    logger: { info() {}, warn() {} },
    settings: {
      register: (ns, schema, opts) => {
        legacySettings = { ...(opts?.base ?? {}) }
        return {}
      },
      get: () => legacySettings,
    },
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      roots: () => [],
      resume: async () => {
        throw new Error('admin-test3: no resume')
      },
    },
    tools: { register: (def) => registered.push(def) },
    on: (name, fn) => {
      handlers[name] = fn
      return () => {}
    },
    // ⚠️ 同上：effect 必须立刻执行回调，否则传输层起不来。
    effect: (fn) => {
      const d = fn?.()
      return () => d?.()
    },
    get: () => undefined,
  }
  ctx.inject = (_deps, cb) => cb(ctx)
  apply(ctx, {
    targetSessionId: 'session-admin3',
    statePath: join(stateDir3, 'state.json'),
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3995',
    whitelist: ['10001'],
    groupWhitelist: [],
    ownerQQ: '10001',
    nicknames: ['244'],
    privateWakeProbability: 1,
  })
  const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
  const status = registered.find((t) => t.name === 'qq_bridge_status')
  const legacySettingsFile = join(stateDir3, 'qq-bridge-settings.json')
  const openTransport = async () => {
    for (let i = 0; i < 100; i++) {
      const st = JSON.parse(await status.execute({}))
      if (st.transport?.state === 'open') return true
      await sleep(20)
    }
    return false
  }
  check('legacy：连接已建立', await openTransport())
  wsSent.length = 0
  {
    const r = JSON.parse(await sim.execute({ text: 'admin add 20002', userId: '10001', nickname: '主人' }))
    check('legacy：决策仍是 admin（指令认了）', r.preview?.action === 'admin', JSON.stringify(r.preview))
    check('legacy：没有唤醒模型', agent.followups.length === 0)
    const frame = [...wsSent].reverse().find((f) => f.action === 'send_private_msg')
    const body = (frame?.params?.message ?? []).map((s) => s?.data?.text ?? '').join('')
    check('legacy：回的是「没写成」而不是装成功', body.includes('没写成'), JSON.stringify(body))
    check('legacy：delivered=false（没办成）', r.decision?.delivered === false, JSON.stringify(r.decision))
    check('legacy：没有偷写设置文件', !existsSync(legacySettingsFile))
    const st = JSON.parse(await status.execute({}))
    check('legacy：log 决策是 admin-failed', st.recentLog.some((l) => l.decision === 'admin-failed'))
  }
  rmSync(stateDir3, { recursive: true, force: true })
}

console.log('')
if (failed === 0) console.log('ALL PASS')
else console.log(`${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
