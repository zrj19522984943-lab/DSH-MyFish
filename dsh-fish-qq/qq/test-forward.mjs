// 合并转发（forward 段）测试：入站消息里的 `[合并转发]` 占位符要被换成真正的
// 「发送人：文本」多行内容；取不到 / 报错时留 `[合并转发：内容读取失败]`，
// 绝不让整条消息消失；嵌套转发默认再展开一层。
//
// 两部分：
//   1) 纯函数矩阵（labelForSegment 之外新加的 forward 渲染函数，注入假 fetcher）；
//   2) 端到端（假 OneBot WS 服务器 —— 与 test-onebot.mjs 同一套手写 RFC 6455，
//      mock 的 get_forward_msg 按 id 回假节点 / 回失败）。
//
// 运行：node test-forward.mjs
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  FORWARD_LABEL,
  FORWARD_FAIL_LABEL,
  FORWARD_DEPTH_LABEL,
  MAX_FORWARD_DEPTH,
  forwardNodeSender,
  forwardNodeContent,
  wrapForwardBlock,
  replaceForwardPlaceholders,
  renderForwardNodes,
} from './index.js'

// ── 最小 WebSocket 服务器（与 test-onebot.mjs 同构）──────────────────────────

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
 * 假 OneBot：记录收到的 action；`get_forward_msg` 按 id 从 `forwardById` 取响应。
 * 没登记的 id → 回失败包（`retcode != 0`），模拟「这条转发取不到」。
 */
function createMockOneBot() {
  const actions = []
  /** id -> { nodes: array } | { fail: string }；未登记 = 取不到。 */
  const forwardById = new Map()
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
        } else if (msg.action === 'get_forward_msg') {
          const id = String(msg.params?.message_id ?? '')
          const entry = forwardById.get(id)
          if (!entry) {
            reply(msg, `forward not found: ${id}`, false)
          } else if (entry.fail) {
            reply(msg, entry.fail, false)
          } else {
            reply(msg, { messages: entry.nodes })
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
    forwardById,
    setForward(id, nodes) {
      forwardById.set(String(id), { nodes })
    },
    setForwardFailure(id, message = '取不到这段转发') {
      forwardById.set(String(id), { fail: message })
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

// ── 测试脚手架（与 test-onebot.mjs 同构）──────────────────────────────────────

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

check('FORWARD_LABEL 是「[合并转发]」', FORWARD_LABEL === '[合并转发]')
check('FORWARD_FAIL_LABEL 是「[合并转发：内容读取失败]」', FORWARD_FAIL_LABEL === '[合并转发：内容读取失败]')
check('MAX_FORWARD_DEPTH = 2（外层 + 再展开一层嵌套）', MAX_FORWARD_DEPTH === 2)

// forwardNodeSender：card > nickname > user_id > 未知
check(
  'forwardNodeSender：群名片优先',
  forwardNodeSender({ sender: { card: '群名片', nickname: '昵称', user_id: 1001 } }) === '群名片',
)
check(
  'forwardNodeSender：没有名片用昵称',
  forwardNodeSender({ sender: { nickname: '昵称', user_id: 1001 } }) === '昵称',
)
check(
  'forwardNodeSender：都没有用 QQ 号',
  forwardNodeSender({ sender: { user_id: 1001 } }) === '1001',
)
check('forwardNodeSender：sender 为空用 node.nickname', forwardNodeSender({ nickname: '顶层昵称' }) === '顶层昵称')
check('forwardNodeSender：什么都没有 → 未知', forwardNodeSender({}) === '未知')
check('forwardNodeSender：名片是空串时不顶位', forwardNodeSender({ sender: { card: '', nickname: '昵称' } }) === '昵称')

// forwardNodeContent：content / message / 字符串 / 缺失
check('forwardNodeContent：content 数组', Array.isArray(forwardNodeContent({ content: [{ type: 'text' }] })))
check('forwardNodeContent：退到 message', Array.isArray(forwardNodeContent({ message: [{ type: 'text' }] })))
check('forwardNodeContent：字符串原样', forwardNodeContent({ content: '一句话' }) === '一句话')
check('forwardNodeContent：缺失返回 null', forwardNodeContent({}) === null)

// wrapForwardBlock
check(
  'wrapForwardBlock：头尾标记 + 条数',
  wrapForwardBlock(['小明：第一条', '小红：第二条'].join('\n'), 2) ===
    '[合并转发 · 2 条]\n小明：第一条\n小红：第二条\n[合并转发结束]',
)
check(
  'wrapForwardBlock：body 是行数组时按换行拼（不被逗号粘起来）',
  wrapForwardBlock(['小明：第一条', '小红：第二条'], 2) ===
    '[合并转发 · 2 条]\n小明：第一条\n小红：第二条\n[合并转发结束]',
)
check('wrapForwardBlock：正文为空只剩头', wrapForwardBlock('', 3) === '[合并转发 · 3 条]')
check('wrapForwardBlock：条数 0 写无条数头', wrapForwardBlock('x', 0) === '[合并转发]\nx\n[合并转发结束]')
check('wrapForwardBlock：非法条数当 0', wrapForwardBlock('x', NaN) === '[合并转发]\nx\n[合并转发结束]')

// replaceForwardPlaceholders
check(
  'replaceForwardPlaceholders：按出现顺序逐个替换',
  replaceForwardPlaceholders('看 [合并转发] 和 [合并转发]', ['块A', '块B']) === '看 块A 和 块B',
)
check(
  'replaceForwardPlaceholders：替换串比占位符多 → 多余丢弃',
  replaceForwardPlaceholders('只有一个 [合并转发]', ['块A', '块B']) === '只有一个 块A',
)
check(
  'replaceForwardPlaceholders：替换串比占位符少 → 剩下的原样保留',
  replaceForwardPlaceholders('[合并转发][合并转发]', ['块A']) === '块A[合并转发]',
)
check(
  'replaceForwardPlaceholders：不误伤相近标签',
  replaceForwardPlaceholders('[合并转发：内容读取失败] x [合并转发 · 2 条] y [合并转发]', ['块A']) ===
    '[合并转发：内容读取失败] x [合并转发 · 2 条] y 块A',
)
check('replaceForwardPlaceholders：无替换串原样', replaceForwardPlaceholders('没有占位符', []) === '没有占位符')

// renderForwardNodes（注入假 fetcher）
const FLAT_NODES = [
  { sender: { card: '群名片小明', nickname: '小明', user_id: 1001 }, content: [{ type: 'text', data: { text: '第一条' } }] },
  {
    sender: { nickname: '小红', user_id: 1002 },
    content: [
      { type: 'text', data: { text: '叫人' } },
      { type: 'at', data: { qq: '1003' } },
      { type: 'image', data: { url: 'https://example.invalid/x.png' } },
      { type: 'face', data: { id: 12 } },
    ],
  },
]

{
  const lines = await renderForwardNodes(FLAT_NODES, async () => ({ ok: true }))
  check('renderForwardNodes：名片 + 文本', lines[0] === '群名片小明：第一条', JSON.stringify(lines[0]))
  check(
    'renderForwardNodes：@ / 转发内图片 / 表情占位',
    lines[1] === '小红：叫人@1003 [转发内图片][表情12]',
    JSON.stringify(lines[1]),
  )
}

{
  const lines = await renderForwardNodes(
    [{ sender: { nickname: '小蓝' }, content: '字符串形态的正文' }],
    async () => ({ ok: true }),
  )
  check('renderForwardNodes：content 是字符串', lines[0] === '小蓝：字符串形态的正文', JSON.stringify(lines[0]))
}

{
  const lines = await renderForwardNodes([{ sender: { nickname: '小绿' }, content: [] }], async () => ({ ok: true }))
  check('renderForwardNodes：空内容只留发送人', lines[0] === '小绿：', JSON.stringify(lines[0]))
}

{
  const lines = await renderForwardNodes([{ content: [{ type: 'text', data: { text: '没发送人' } }] }], async () => ({
    ok: true,
  }))
  check('renderForwardNodes：没发送人写未知', lines[0] === '未知：没发送人', JSON.stringify(lines[0]))
}

// 嵌套转发：外层（depth 0）再展开一层，里层（depth 1）的转发不再展开
const NESTED_NODE = {
  sender: { nickname: '小明' },
  content: [
    { type: 'text', data: { text: '外层说的' } },
    { type: 'forward', data: { id: 'inner-fwd' } },
  ],
}
{
  const calls = []
  const lines = await renderForwardNodes(
    [NESTED_NODE],
    async (id, depth) => {
      calls.push({ id, depth })
      return { ok: true, count: 1, text: ['内层人：内层内容'] }
    },
    0,
  )
  check(
    'renderForwardNodes：嵌套展开成多行块',
    lines[0] === '小明：外层说的\n[合并转发 · 1 条]\n内层人：内层内容\n[合并转发结束]',
    JSON.stringify(lines[0]),
  )
  check('renderForwardNodes：嵌套取回带 depth=1', calls.length === 1 && calls[0].id === 'inner-fwd' && calls[0].depth === 1, JSON.stringify(calls))
}

{
  const calls = []
  const lines = await renderForwardNodes(
    [NESTED_NODE],
    async (id) => {
      calls.push(id)
      return { ok: true, count: 1, text: ['不λα'] }
    },
    1,
  )
  check(
    'renderForwardNodes：第二层里的转发标「层级过深」',
    lines[0] === '小明：外层说的[合并转发：层级过深，未展开]',
    JSON.stringify(lines[0]),
  )
  check('renderForwardNodes：层级到顶不再调 fetch', calls.length === 0, JSON.stringify(calls))
}

{
  const lines = await renderForwardNodes([NESTED_NODE], undefined, 0)
  check(
    'renderForwardNodes：没注入 fetcher → 嵌套标未展开',
    lines[0] === '小明：外层说的[合并转发：层级过深，未展开]',
    JSON.stringify(lines[0]),
  )
}

{
  // fetcher 返回 ok:false → 失败提示
  const lines = await renderForwardNodes([NESTED_NODE], async () => ({ ok: false }), 0)
  check('renderForwardNodes：嵌套取回失败 → 失败提示', lines[0] === '小明：外层说的[合并转发：内容读取失败]', JSON.stringify(lines[0]))
}

{
  // fetcher 抛错 → 失败提示（不冒泡，不中断渲染）
  const lines = await renderForwardNodes(
    [NESTED_NODE, { sender: { nickname: '小红' }, content: [{ type: 'text', data: { text: '后面这条还在' } }] }],
    async () => {
      throw new Error('boom')
    },
    0,
  )
  check('renderForwardNodes：fetcher 抛错 → 失败提示', lines[0] === '小明：外层说的[合并转发：内容读取失败]', JSON.stringify(lines[0]))
  check('renderForwardNodes：抛错不中断后面的节点', lines[1] === '小红：后面这条还在', JSON.stringify(lines[1]))
}

{
  // 转发段没带 id → 失败提示
  const lines = await renderForwardNodes(
    [{ sender: { nickname: '小明' }, content: [{ type: 'forward', data: {} }] }],
    async () => ({ ok: true }),
    0,
  )
  check('renderForwardNodes：转发段无 id → 失败提示', lines[0] === '小明：[合并转发：内容读取失败]', JSON.stringify(lines[0]))
}

// ── 第 2 部分：端到端（假 OneBot WS）──────────────────────────────────────

const mock = createMockOneBot()
const port = await mock.listen()

// 转发节点 fixture：两条节点，第一条带图片段（→ [转发内图片]，不下载）
mock.setForward('fwd-flat', [
  {
    sender: { user_id: 1001, nickname: '小明', card: '群名片小明' },
    time: 1,
    content: [
      { type: 'text', data: { text: '今天吃什么' } },
      { type: 'image', data: { url: 'https://example.invalid/f.png', file: 'f.png' } },
    ],
  },
  { sender: { user_id: 1002, nickname: '小红' }, time: 2, content: [{ type: 'text', data: { text: '随便，你定吧' } }] },
])

// 嵌套转发 fixture：fwd-nested 里套一个 fwd-inner；fwd-inner 里再套 fwd-deepest（第三层 → 不展开）
mock.setForward('fwd-nested', [
  {
    sender: { user_id: 1001, nickname: '小明' },
    content: [
      { type: 'text', data: { text: '里面还有一层' } },
      { type: 'forward', data: { id: 'fwd-inner' } },
    ],
  },
])
mock.setForward('fwd-inner', [
  {
    sender: { user_id: 1001, nickname: '小明' },
    content: [
      { type: 'text', data: { text: '这是最里面一层' } },
      { type: 'forward', data: { id: 'fwd-deepest' } },
    ],
  },
])
mock.setForwardFailure('fwd-bad', '合并转发不存在')

const { ctx, state } = createFakeCtx()
const statePath = join(tmpdir(), 'qq-bridge-forward-test.json')
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

// 1) 普通消息：一个字都不该变，也不该调 get_forward_msg
sendPrivate({ raw_message: '244 你好', message: [{ type: 'text', data: { text: '244 你好' } }] })
await waitFor(() => state.followups.length === 1)
{
  const t = textOf(state.followups[0])
  check(
    '普通消息原样投递（无任何合并转发痕迹）',
    t === '[QQ · 私聊] 小明：244 你好\n（回 QQ 用 [QQ]…[/QQ]）',
    JSON.stringify(t),
  )
  check('普通消息不触发 get_forward_msg', !mock.actions.some((a) => a.action === 'get_forward_msg'))
}

// 2) 转发（array 形态）：占位符被换成节点正文，消息不丢
sendPrivate({
  raw_message: '244 看这个',
  message: [{ type: 'text', data: { text: '244 看这个' } }, { type: 'forward', data: { id: 'fwd-flat' } }],
})
await waitFor(() => state.followups.length === 2)
{
  const t = textOf(state.followups[1])
  const fwdCall = mock.actions.filter((a) => a.action === 'get_forward_msg')
  check('get_forward_msg 被调用且 message_id 正确', fwdCall.length >= 1 && String(fwdCall[0].params?.message_id) === 'fwd-flat', JSON.stringify(fwdCall.map((a) => a.params)))
  check('转发被唤醒投递（消息没丢）', state.followups.length === 2)
  check('转发头带条数', t.includes('[合并转发 · 2 条]'), JSON.stringify(t.slice(0, 80)))
  check('节点拼成「发送人：文本」', t.includes('群名片小明：今天吃什么') && t.includes('小红：随便，你定吧'), JSON.stringify(t.slice(0, 120)))
  check('多行节点之间是换行而不是逗号', t.includes('群名片小明：今天吃什么[转发内图片]\n小红：随便，你定吧'), JSON.stringify(t.slice(0, 140)))
  check('转发内图片用独立标签（不下载、不占位）', t.includes('[转发内图片]'), JSON.stringify(t))
  check('块尾有结束标记', t.includes('[合并转发结束]'), JSON.stringify(t))
  check('裸占位符 [合并转发] 已被替换掉', !t.includes('[合并转发]'), JSON.stringify(t))
}

// 3) 嵌套转发：默认再展开一层，第三层如实标「未展开」
sendPrivate({
  raw_message: '244 嵌套的',
  message: [{ type: 'text', data: { text: '244 嵌套的' } }, { type: 'forward', data: { id: 'fwd-nested' } }],
})
await waitFor(() => state.followups.length === 3)
{
  const t = textOf(state.followups[2])
  const fwdCalls = mock.actions.filter((a) => a.action === 'get_forward_msg').map((a) => String(a.params?.message_id))
  check('嵌套层也被取回（fwd-inner）', fwdCalls.includes('fwd-inner'), JSON.stringify(fwdCalls))
  check('外层节点在', t.includes('小明：里面还有一层'), JSON.stringify(t.slice(0, 120)))
  check('内层节点在', t.includes('这是最里面一层'), JSON.stringify(t.slice(0, 160)))
  check('第三层标「层级过深，未展开」', t.includes('[合并转发：层级过深，未展开]'), JSON.stringify(t.slice(0, 200)))
  check('第三层没有真的去取', !fwdCalls.includes('fwd-deepest'), JSON.stringify(fwdCalls))
}

// 4) 取不到（retcode 失败）：消息不丢，正文留失败提示
sendPrivate({
  raw_message: '244 这条取不到',
  message: [{ type: 'text', data: { text: '244 这条取不到' } }, { type: 'forward', data: { id: 'fwd-bad' } }],
})
await waitFor(() => state.followups.length === 4)
{
  const t = textOf(state.followups[3])
  check('失败时消息照常投递（没丢）', state.followups.length === 4)
  check('失败留「[合并转发：内容读取失败]」', t.includes('[合并转发：内容读取失败]'), JSON.stringify(t.slice(0, 120)))
  check('失败时正文其余部分还在', t.includes('244 这条取不到'), JSON.stringify(t.slice(0, 120)))
  check('失败也记了 warn（不吞错）', state.warnings.some((w) => w.includes('fwd-bad')), JSON.stringify(state.warnings.slice(-3)))
}

// 5) 取到了但 messages 为空：同样兜底
mock.setForward('fwd-empty', [])
sendPrivate({
  raw_message: '244 空转发',
  message: [{ type: 'text', data: { text: '244 空转发' } }, { type: 'forward', data: { id: 'fwd-empty' } }],
})
await waitFor(() => state.followups.length === 5)
{
  const t = textOf(state.followups[4])
  check('空节点也兜底成失败提示', t.includes('[合并转发：内容读取失败]'), JSON.stringify(t.slice(0, 120)))
  check('空转发消息没丢', t.includes('244 空转发'), JSON.stringify(t.slice(0, 120)))
}

// 6) string 形态（CQ 码）：[CQ:forward,id=...] 同样展开
sendPrivate({
  raw_message: '244 看这个[CQ:forward,id=fwd-flat]',
  message: '244 看这个[CQ:forward,id=fwd-flat]',
})
await waitFor(() => state.followups.length === 6)
{
  const t = textOf(state.followups[5])
  check('CQ 码形态的转发也展开', t.includes('群名片小明：今天吃什么') && t.includes('[合并转发 · 2 条]'), JSON.stringify(t.slice(0, 120)))
  check('CQ 码已被剥掉', !t.includes('[CQ:forward'), JSON.stringify(t))
}

// 7) 一条消息里两个转发：按位置顺序替换，一个成一个败
sendPrivate({
  raw_message: '244 两个转发',
  message: [
    { type: 'text', data: { text: '244 两个转发' } },
    { type: 'forward', data: { id: 'fwd-flat' } },
    { type: 'forward', data: { id: 'fwd-bad' } },
  ],
})
await waitFor(() => state.followups.length === 7)
{
  const t = textOf(state.followups[6])
  check('两个转发：成功的展开', t.includes('小红：随便，你定吧'), JSON.stringify(t.slice(0, 80)))
  check('两个转发：失败的在后面兜底', t.includes('[合并转发：内容读取失败]'), JSON.stringify(t))
  check('两个转发顺序与占位符对齐', t.indexOf('今天吃什么') < t.indexOf('[合并转发：内容读取失败]'), JSON.stringify(t.slice(0, 160)))
}

// 8) 只记录（没唤醒）的消息：展开后的正文进缓冲，下一次唤醒能在摘要里看到
sendPrivate({
  raw_message: '看这个记录（没叫名字）',
  message: [{ type: 'text', data: { text: '看这个记录（没叫名字）' } }, { type: 'forward', data: { id: 'fwd-flat' } }],
})
await waitFor(async () => JSON.parse(await tool('qq_bridge_status').execute({})).bufferedUnwoken >= 1)
check('未唤醒的转发消息进缓冲', true)
sendPrivate({ raw_message: '244 在吗', message: [{ type: 'text', data: { text: '244 在吗' } }] })
await waitFor(() => state.followups.length === 8)
{
  const t = textOf(state.followups[7])
  check('摘要里能看到转发正文（record 路径也展开了）', t.includes('今天吃什么'), JSON.stringify(t.slice(0, 200)))
}

// 9) 卸载：传输必须干净停掉
for (const d of state.disposers) await d()
check('dispose 后连接已关闭', await waitFor(() => mock.connected === false, 2000))
await mock.close()

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) process.exitCode = 1
