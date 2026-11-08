// 引用回复（reply 段）测试：别人在 QQ 里「回复」某句话时，入站只有 reply 段
// （type:'reply'，带被引用消息的 id）。桥接层要用 OneBot 的 `get_msg` 把被引用
// 的那条取回来，在投递正文前面加一行 `[引用 @某人：被引用的那句话……]`
// （摘要 ≤ 30 字，图片写 [图片]）；取不到 / 已撤回 → `[引用：原消息取不到]`，
// 绝不让整条消息消失；被引用消息自己带的 reply 段不递归展开（只展开一层）。
//
// 两部分：
//   1) 纯函数矩阵（quotedMessageSender / quotedMessageSummary / buildReplyQuoteLine）；
//   2) 端到端（假 OneBot WS 服务器 —— 与 test-onebot.mjs / test-forward.mjs 同一套
//      手写 RFC 6455，mock 的 get_msg 按 id 回假消息 / 回失败 / 回空消息体）。
//
// 运行：node test-reply-quote.mjs
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  REPLY_QUOTE_FAIL_LABEL,
  REPLY_QUOTE_MAX_CHARS,
  quotedMessageSender,
  quotedMessageSummary,
  buildReplyQuoteLine,
} from './index.js'

// ── 最小 WebSocket 服务器（与 test-onebot.mjs / test-forward.mjs 同构）──────────

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 服务端 → 客户端：不带掩码的文本帧。 */
function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(len, 2)
  }
  return Buffer.concat([header, payload])
}

/** 尝试从缓冲区里取出一个完整帧；不完整返回 null。 */
function parseFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < offset + 2) return null
    len = buf.readUInt16BE(offset)
    offset += 2
  } else if (len === 127) {
    if (buf.length < offset + 8) return null
    len = Number(buf.readBigUInt64BE(offset))
    offset += 8
  }
  let mask = null
  if (masked) {
    if (buf.length < offset + 4) return null
    mask = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null
  const payload = Buffer.from(buf.subarray(offset, offset + len))
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  return { total: offset + len, opcode, payload }
}

/**
 * 假 OneBot：记录收到的 action；`get_msg` 按 id 从 `msgById` 取响应。
 * 没登记的 id → 回失败包（`retcode != 0`），模拟「被撤回 / 取不到」。
 */
function createMockOneBot() {
  const actions = []
  /** id -> { data: object } | { fail: string }；未登记 = 取不到。 */
  const msgById = new Map()
  let client = null
  const server = createServer()

  const reply = (msg, data, ok = true) =>
    client.write(
      encodeFrame(
        JSON.stringify(
          ok
            ? { status: 'ok', retcode: 0, data, echo: msg.echo }
            : { status: 'failed', retcode: 1200, message: String(data), echo: msg.echo },
        ),
      ),
    )

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(String(key) + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    client = socket
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const frame = parseFrame(buf)
        if (!frame) break
        buf = buf.subarray(frame.total)
        if (frame.opcode === 0x8) {
          socket.end()
          return
        }
        if (frame.opcode !== 0x1) continue
        let msg
        try {
          msg = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          continue
        }
        actions.push(msg)
        if (msg.action === 'get_login_info') {
          reply(msg, { user_id: 10001, nickname: 'test-bot' })
        } else if (msg.action === 'get_group_info') {
          reply(msg, { group_id: msg.params?.group_id, group_name: '测试群' })
        } else if (msg.action === 'get_msg') {
          const id = String(msg.params?.message_id ?? '')
          const entry = msgById.get(id)
          if (!entry) {
            reply(msg, `msg not found: ${id}`, false)
          } else if (entry.fail) {
            reply(msg, entry.fail, false)
          } else {
            reply(msg, entry.data)
          }
        } else {
          reply(msg, { message_id: 9001 })
        }
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (client === socket) client = null
    })
  })

  return {
    actions,
    msgById,
    setMsg(id, data) {
      msgById.set(String(id), { data })
    },
    setMsgFailure(id, message = '消息不存在或已被撤回') {
      msgById.set(String(id), { fail: message })
    },
    get connected() {
      return client !== null
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
      })
    },
    sendEvent(event) {
      if (!client) throw new Error('mock: no client connected')
      client.write(encodeFrame(JSON.stringify(event)))
    },
    close() {
      return new Promise((resolve) => {
        try {
          client?.destroy()
        } catch {
          /* 已经断了 */
        }
        server.close(() => resolve())
      })
    },
  }
}

// ── 测试脚手架（与 test-forward.mjs 同构）──────────────────────────────────────

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let v = false
    try {
      v = await fn()
    } catch {
      v = false
    }
    if (v) return true
    if (Date.now() > deadline) return false
    await sleep(50)
  }
}

function createFakeCtx() {
  const state = { listeners: new Map(), disposers: [], registered: [], warnings: [], followups: [], resolvedSettings: {} }
  const targetAgent = {
    id: 'session-target',
    session: { id: 'session-target' },
    followup: (m) => state.followups.push(m),
    inject: () => {},
  }
  const handle = { agent: targetAgent, dispose: async () => {} }
  const ctx = {
    logger: { info() {}, warn: (m) => state.warnings.push(String(m)) },
    settings: {
      register: (_ns, _schema, opts) => {
        state.resolvedSettings = { ...(opts?.base ?? {}) }
        return {}
      },
      get: () => state.resolvedSettings,
    },
    agents: {
      get: () => undefined,
      roots: () => [],
      resume: async () => handle,
      withInitiator: (_agent, op) => op(),
    },
    tools: { register: (def) => state.registered.push(def) },
    on: (name, fn) => state.listeners.set(name, fn),
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') state.disposers.push(d)
    },
    get: (name) =>
      name === 'credentials'
        ? {
            resolve: async (ref) =>
              String(ref) === 'QQ_BRIDGE_TEST_TOKEN' ? { value: 'tok-123', source: 'test' } : undefined,
          }
        : undefined,
  }
  return { ctx, state }
}

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

// ── 第 1 部分：纯函数 ─────────────────────────────────────────────────────

check('REPLY_QUOTE_FAIL_LABEL 是「[引用：原消息取不到]」', REPLY_QUOTE_FAIL_LABEL === '[引用：原消息取不到]')
check('REPLY_QUOTE_MAX_CHARS = 30', REPLY_QUOTE_MAX_CHARS === 30)

// quotedMessageSender：card > nickname > user_id > 某人
check('quotedMessageSender：群名片优先', quotedMessageSender({ sender: { card: '群名片', nickname: '昵称', user_id: 1002 } }) === '群名片')
check('quotedMessageSender：没有名片用昵称', quotedMessageSender({ sender: { nickname: '小红', user_id: 1002 } }) === '小红')
check('quotedMessageSender：都没有用 QQ 号', quotedMessageSender({ sender: { user_id: 1002 } }) === '1002')
check('quotedMessageSender：名片是空串不顶位', quotedMessageSender({ sender: { card: '   ', nickname: '小红' } }) === '小红')
check('quotedMessageSender：扁平形态的 nickname 兜底', quotedMessageSender({ nickname: '顶层昵称' }) === '顶层昵称')
check('quotedMessageSender：扁平形态的 user_id 兜底', quotedMessageSender({ user_id: 1002 }) === '1002')
check('quotedMessageSender：什么都没有 → 某人', quotedMessageSender({}) === '某人')
check('quotedMessageSender：null 入参 → 某人', quotedMessageSender(null) === '某人')

// quotedMessageSummary：array 形态
check(
  'quotedMessageSummary：文本段按序拼接',
  quotedMessageSummary({ message: [{ type: 'text', data: { text: '今天' } }, { type: 'text', data: { text: '吃什么' } }] }) === '今天吃什么',
)
check(
  'quotedMessageSummary：图片写 [图片]',
  quotedMessageSummary({
    message: [
      { type: 'text', data: { text: '看这张' } },
      { type: 'image', data: { url: 'https://example.invalid/x.png', file: 'x.png' } },
    ],
  }) === '看这张[图片]',
)
check(
  'quotedMessageSummary：纯图片消息摘要就是 [图片]',
  quotedMessageSummary({ message: [{ type: 'image', data: { url: 'https://example.invalid/x.png' } }] }) === '[图片]',
)
check(
  'quotedMessageSummary：表情包段写摘要',
  quotedMessageSummary({ message: [{ type: 'mface', data: { summary: '开心', url: 'https://example.invalid/m.gif' } }] }) === '[表情包:开心]',
)
check(
  'quotedMessageSummary：没摘要的 mface 写裸标签',
  quotedMessageSummary({ message: [{ type: 'mface', data: { url: 'https://example.invalid/m.gif' } }] }) === '[表情包]',
)
check(
  'quotedMessageSummary：at 段渲染成 @QQ号（末尾空格被 trim）',
  quotedMessageSummary({ message: [{ type: 'text', data: { text: '叫人' } }, { type: 'at', data: { qq: '1003' } }] }) === '叫人@1003',
)
check(
  'quotedMessageSummary：表情段写占位符',
  quotedMessageSummary({ message: [{ type: 'face', data: { id: 12 } }] }) === '[表情12]',
)
check(
  'quotedMessageSummary：reply 段被跳过（引用的引用不展开）',
  quotedMessageSummary({
    message: [
      { type: 'reply', data: { id: 'inner-quote' } },
      { type: 'text', data: { text: '回的是这句' } },
    ],
  }) === '回的是这句',
)
check(
  'quotedMessageSummary：只有 reply 段的空壳 → 未知内容',
  quotedMessageSummary({ message: [{ type: 'reply', data: { id: 'inner-quote' } }] }) === '未知内容',
)
check(
  'quotedMessageSummary：转发段在摘要里只留标签（不去取）',
  quotedMessageSummary({ message: [{ type: 'forward', data: { id: 'fwd-x' } }] }) === '[合并转发]',
)

// quotedMessageSummary：string / CQ 形态
check(
  'quotedMessageSummary：raw_message 字符串原样',
  quotedMessageSummary({ message: '今天吃什么', raw_message: '今天吃什么' }) === '今天吃什么',
)
check(
  'quotedMessageSummary：CQ 图片 → [图片]',
  quotedMessageSummary({ raw_message: '看这张[CQ:image,url=https://example.invalid/x.png,file=x.png]' }) === '看这张[图片]',
)
check(
  'quotedMessageSummary：CQ reply 码被剥掉（不展开引用的引用）',
  quotedMessageSummary({ raw_message: '[CQ:reply,id=12345]回的是这句' }) === '回的是这句',
)
check(
  'quotedMessageSummary：CQ at 码渲染成 @QQ号（末尾空格被 trim）',
  quotedMessageSummary({ raw_message: '叫人[CQ:at,qq=1003]' }) === '叫人@1003',
)
check(
  'quotedMessageSummary：CQ 表情包码 → 裸标签',
  quotedMessageSummary({ raw_message: '[CQ:mface,url=]' }) === '[表情包]',
)

// quotedMessageSummary：截断（按码点，emoji 计 1 个字）
{
  const exact = '一二三四五六七八九十'.repeat(3) // 恰好 30 字
  check(`quotedMessageSummary：恰好 30 字原样保留（${[...exact].length} 字）`, quotedMessageSummary({ message: exact }) === exact)
}
{
  const long = '一二三四五六七八九十'.repeat(4) // 40 字
  const summary = quotedMessageSummary({ message: long })
  check('quotedMessageSummary：超长截到 30 字以内', [...summary].length <= REPLY_QUOTE_MAX_CHARS, `${[...summary].length} 字：${summary}`)
  check('quotedMessageSummary：截断补省略号', summary.endsWith('……'), JSON.stringify(summary))
  check(
    'quotedMessageSummary：截断保留前 28 字 + ……（总长恰 30）',
    summary === '一二三四五六七八九十'.repeat(2) + '一二三四五六七八' + '……' && [...summary].length === REPLY_QUOTE_MAX_CHARS,
    JSON.stringify(summary),
  )
}
{
  const emoji = '😀'.repeat(35)
  const summary = quotedMessageSummary({ message: emoji })
  check('quotedMessageSummary：emoji 按码点计 1 个字', [...summary].length === REPLY_QUOTE_MAX_CHARS, `${[...summary].length}`)
}

// quotedMessageSummary：消息体缺失 / 空
check('quotedMessageSummary：没有 message 字段 → 未知内容', quotedMessageSummary({ sender: { nickname: '小红' } }) === '未知内容')
check('quotedMessageSummary：message 为 null → 未知内容', quotedMessageSummary({ message: null }) === '未知内容')
check('quotedMessageSummary：message 为空数组 → 未知内容', quotedMessageSummary({ message: [] }) === '未知内容')
check('quotedMessageSummary：消息体是空白 → 未知内容', quotedMessageSummary({ message: '   \n ' }) === '未知内容')
check('quotedMessageSummary：null 入参不抛错', quotedMessageSummary(null) === '未知内容')

// buildReplyQuoteLine
check('buildReplyQuoteLine：基本格式', buildReplyQuoteLine('小红', '今天吃什么') === '[引用 @小红：今天吃什么]')
check('buildReplyQuoteLine：带截断省略号', buildReplyQuoteLine('小红', '今天中午到底吃什么好呢，我想吃火锅但……') === '[引用 @小红：今天中午到底吃什么好呢，我想吃火锅但……]')
check('buildReplyQuoteLine：发送人是 QQ 号时写成 @1002', buildReplyQuoteLine('1002', '嗯') === '[引用 @1002：嗯]')

// ── 第 2 部分：端到端（假 OneBot WS）──────────────────────────────────────

const mock = createMockOneBot()
const port = await mock.listen()

// 被引用消息 fixture（array 形态）
mock.setMsg('quoted-plain', {
  message_id: 'quoted-plain',
  real_id: 'quoted-plain',
  time: 1730000000,
  sender: { user_id: 1002, nickname: '小红', card: '群名片小红' },
  message: [{ type: 'text', data: { text: '今天吃什么' } }],
  raw_message: '今天吃什么',
})
// 被引用消息 fixture（string / CQ 形态）
mock.setMsg('quoted-cq', {
  message_id: 'quoted-cq',
  real_id: 'quoted-cq',
  time: 1730000001,
  sender: { user_id: 1003, nickname: '小蓝' },
  message: '看这张[CQ:image,url=https://example.invalid/x.png,file=x.png]',
  raw_message: '看这张[CQ:image,url=https://example.invalid/x.png,file=x.png]',
})
// 被引用消息自己也是一条引用消息（引用的引用 → 不展开）
mock.setMsg('quoted-nested', {
  message_id: 'quoted-nested',
  real_id: 'quoted-nested',
  time: 1730000002,
  sender: { user_id: 1002, nickname: '小红' },
  message: [
    { type: 'reply', data: { id: 'quoted-plain' } },
    { type: 'text', data: { text: '我也是回你的' } },
  ],
  raw_message: '[CQ:reply,id=quoted-plain]我也是回你的',
})
// 超长被引用消息 → 摘要要截断（35 字）
mock.setMsg('quoted-long', {
  message_id: 'quoted-long',
  real_id: 'quoted-long',
  time: 1730000003,
  sender: { user_id: 1002, nickname: '小红' },
  message: [{ type: 'text', data: { text: '今天中午到底吃什么好呢，我想吃火锅但是又怕胖，要不算了吧，干脆点外卖吧' } }],
  raw_message: '今天中午到底吃什么好呢，我想吃火锅但是又怕胖，要不算了吧，干脆点外卖吧',
})
// 被撤回：get_msg 直接失败
mock.setMsgFailure('quoted-recalled', '消息不存在或已被撤回')
// 被撤回（另一种实现形态）：取到了但消息体是 null
mock.setMsg('quoted-no-body', {
  message_id: 'quoted-no-body',
  real_id: 'quoted-no-body',
  time: 1730000004,
  sender: { user_id: 1002, nickname: '小红' },
  message: null,
  raw_message: null,
})

const { ctx, state } = createFakeCtx()
const statePath = join(tmpdir(), 'qq-bridge-reply-quote-test.json')
if (existsSync(statePath)) rmSync(statePath)

apply(ctx, {
  targetSessionId: 'session-target',
  agentPreset: '',
  statePath,
  debugTools: true,
  onebotUrl: `ws://127.0.0.1:${port}`,
  accessTokenEnv: 'QQ_BRIDGE_TEST_TOKEN',
  selfId: '',
  replyWithQuote: false,
  atOnlyInGroup: false,
  stripMarkdown: true,
  heartbeatTimeoutMs: 60000,
  nicknames: ['244'],
  wakeProbability: 0,
  privateWakeProbability: 0,
  ownerQQ: '1001',
  whitelist: ['1001'],
  groupWhitelist: ['2001'],
})

const tool = (n) => state.registered.find((t) => t.name === n)
const transportTool = tool('qq_bridge_transport')
check('qq_bridge_transport 已注册', !!transportTool)
const connected = await waitFor(async () => JSON.parse(await transportTool.execute({})).transport.state === 'open')
check('已连上假 OneBot', connected)

const sendPrivate = (payload) =>
  mock.sendEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 1001,
    self_id: 10001,
    message_id: 555,
    sender: { nickname: '小明' },
    ...payload,
  })

const replySegments = (id) => [{ type: 'reply', data: { id } }]

// 1) 普通消息：一个字都不该变，也不该调 get_msg
sendPrivate({ raw_message: '244 你好', message: [{ type: 'text', data: { text: '244 你好' } }] })
await waitFor(() => state.followups.length === 1)
{
  const t = textOf(state.followups[0])
  check(
    '普通消息原样投递（没有任何引用痕迹）',
    t === '[QQ · 私聊] 小明：244 你好\n（回 QQ 用 [QQ]…[/QQ]）',
    JSON.stringify(t),
  )
  check('普通消息不触发 get_msg', !mock.actions.some((a) => a.action === 'get_msg'))
}

// 2) 引用回复（array 形态）：正文前面加一行，get_msg 参数正确
//    ⚠️ 正文要带昵称「244」才会唤醒（wakeProbability=0），否则只记录不投递。
sendPrivate({
  raw_message: '244 那我也吃',
  message: [...replySegments('quoted-plain'), { type: 'text', data: { text: '244 那我也吃' } }],
})
await waitFor(() => state.followups.length === 2)
{
  const t = textOf(state.followups[1])
  const getMsgCalls = mock.actions.filter((a) => a.action === 'get_msg')
  check(
    'get_msg 被调用且 message_id 正确',
    getMsgCalls.length === 1 && String(getMsgCalls[0].params?.message_id) === 'quoted-plain',
    JSON.stringify(getMsgCalls.map((a) => a.params)),
  )
  check(
    '引用行在正文最前面、独占一行',
    t.startsWith('[引用 @群名片小红：今天吃什么]\n'),
    JSON.stringify(t.slice(0, 60)),
  )
  check('引用行后面就是原来的正文', t.includes('[引用 @群名片小红：今天吃什么]\n[QQ · 私聊] 小明：244 那我也吃'), JSON.stringify(t))
  check('回复指引行仍在末尾', t.endsWith('\n（回 QQ 用 [QQ]…[/QQ]）'), JSON.stringify(t.slice(-40)))
  check('没有取不到的提示', !t.includes(REPLY_QUOTE_FAIL_LABEL), JSON.stringify(t))
}

// 3) 取不到（retcode 失败 = 被撤回）：明确提示，消息不丢
sendPrivate({
  raw_message: '244 嗯嗯',
  message: [...replySegments('quoted-recalled'), { type: 'text', data: { text: '244 嗯嗯' } }],
})
await waitFor(() => state.followups.length === 3)
{
  const t = textOf(state.followups[2])
  check('失败时消息照常投递（没丢）', state.followups.length === 3)
  check('失败留「[引用：原消息取不到]」', t.startsWith(`[引用：原消息取不到]\n`), JSON.stringify(t.slice(0, 60)))
  check('失败时正文其余部分还在', t.includes('[QQ · 私聊] 小明：244 嗯嗯'), JSON.stringify(t))
  check('失败也记了 warn（不吞错）', state.warnings.some((w) => w.includes('quoted-recalled')), JSON.stringify(state.warnings.slice(-3)))
}

// 4) 取到了但消息体为 null（另一种撤回形态）：同样提示取不到
sendPrivate({
  raw_message: '244 好吧',
  message: [...replySegments('quoted-no-body'), { type: 'text', data: { text: '244 好吧' } }],
})
await waitFor(() => state.followups.length === 4)
{
  const t = textOf(state.followups[3])
  check('空消息体也提示取不到', t.startsWith(`[引用：原消息取不到]\n`), JSON.stringify(t.slice(0, 60)))
  check('空消息体那条没丢', t.includes('[QQ · 私聊] 小明：244 好吧'), JSON.stringify(t))
}

// 5) 被引用消息里带图片：摘要写 [图片]
sendPrivate({
  raw_message: '244 图不错',
  message: [...replySegments('quoted-cq'), { type: 'text', data: { text: '244 图不错' } }],
})
await waitFor(() => state.followups.length === 5)
{
  const t = textOf(state.followups[4])
  check('图片在摘要里写 [图片]', t.includes('[引用 @小蓝：看这张[图片]]'), JSON.stringify(t.slice(0, 60)))
}

// 6) 引用的引用不递归：被引用消息自己的 reply 段被跳过，没有第二次 get_msg
{
  const before = mock.actions.filter((a) => a.action === 'get_msg').length
  sendPrivate({
    raw_message: '244 说的就是它',
    message: [...replySegments('quoted-nested'), { type: 'text', data: { text: '244 说的就是它' } }],
  })
  await waitFor(() => state.followups.length === 6)
  const t = textOf(state.followups[5])
  const getMsgIds = mock.actions.filter((a) => a.action === 'get_msg').map((a) => String(a.params?.message_id))
  check('只为最外层引用调 get_msg（只多一次）', mock.actions.filter((a) => a.action === 'get_msg').length === before + 1, JSON.stringify(getMsgIds))
  check('这次取的是 quoted-nested，没递归取 quoted-plain', getMsgIds[getMsgIds.length - 1] === 'quoted-nested', JSON.stringify(getMsgIds))
  check('引用行只展开一层', t.startsWith('[引用 @小红：我也是回你的]\n'), JSON.stringify(t.slice(0, 60)))
  check('摘要里看不到内层引用痕迹', !t.includes('今天吃什么'), JSON.stringify(t.slice(0, 80)))
}

// 7) 超长被引用消息：摘要截到 30 字以内
sendPrivate({
  raw_message: '244 同意',
  message: [...replySegments('quoted-long'), { type: 'text', data: { text: '244 同意' } }],
})
await waitFor(() => state.followups.length === 7)
{
  const t = textOf(state.followups[6])
  const m = t.match(/^\[引用 @小红：(.*)\]\n/)
  check('引用行能解析出来', !!m, JSON.stringify(t.slice(0, 60)))
  if (m) {
    check('摘要不超过 30 字', [...m[1]].length <= REPLY_QUOTE_MAX_CHARS, `${[...m[1]].length} 字：${m[1]}`)
    check('摘要以省略号收尾', m[1].endsWith('……'), m[1])
  }
}

// 8) string 形态（CQ 码）：[CQ:reply,id=…] 同样展开
sendPrivate({
  raw_message: '244 嗯[CQ:reply,id=quoted-plain]',
  message: '244 嗯[CQ:reply,id=quoted-plain]',
})
await waitFor(() => state.followups.length === 8)
{
  const t = textOf(state.followups[7])
  check('CQ 码形态的引用也展开', t.startsWith('[引用 @群名片小红：今天吃什么]\n'), JSON.stringify(t.slice(0, 60)))
  check('CQ reply 码已从正文剥掉', !t.includes('[CQ:reply'), JSON.stringify(t))
  check('CQ 形态正文其余部分还在', t.includes('[QQ · 私聊] 小明：244 嗯\n'), JSON.stringify(t))
}

// 9) 群聊里的引用回复：正文行带群名
mock.sendEvent({
  post_type: 'message',
  message_type: 'group',
  group_id: 2001,
  user_id: 1001,
  self_id: 10001,
  message_id: 556,
  sender: { nickname: '小明' },
  raw_message: '244 那我也吃',
  message: [...replySegments('quoted-plain'), { type: 'text', data: { text: '244 那我也吃' } }],
})
await waitFor(() => state.followups.length === 9)
{
  const t = textOf(state.followups[8])
  check('群聊引用行在最前', t.startsWith('[引用 @群名片小红：今天吃什么]\n'), JSON.stringify(t.slice(0, 60)))
  check('群聊正文行带群名', t.includes('[QQ · 测试群] 小明：244 那我也吃'), JSON.stringify(t))
}

// 10) 只记录（没唤醒）的引用消息：摘要行进缓冲，下一次唤醒能在记录里看到
sendPrivate({
  raw_message: '记一句（没叫名字）',
  message: [...replySegments('quoted-plain'), { type: 'text', data: { text: '记一句（没叫名字）' } }],
})
await waitFor(async () => JSON.parse(await tool('qq_bridge_status').execute({})).bufferedUnwoken >= 1)
check('未唤醒的引用消息进缓冲', true)
sendPrivate({ raw_message: '244 在吗', message: [{ type: 'text', data: { text: '244 在吗' } }] })
await waitFor(() => state.followups.length === 10)
{
  const t = textOf(state.followups[9])
  check(
    '未唤醒记录里能看到引用行（record 路径也展开）',
    t.includes('小明: [引用 @群名片小红：今天吃什么]\n记一句（没叫名字）'),
    JSON.stringify(t.slice(0, 200)),
  )
}

// 11) 卸载：传输必须干净停掉
for (const d of state.disposers) await d()
check('dispose 后连接已关闭', await waitFor(() => mock.connected === false, 2000))
await mock.close()

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) process.exitCode = 1
