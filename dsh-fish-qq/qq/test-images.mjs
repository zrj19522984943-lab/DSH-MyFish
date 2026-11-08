// 入站图片 / 表情包落地测试（2026-10-29）：群里 / 私聊有人发图，桥接层要把图
// 真正下载到本地固定目录（~/.dsh-fish/attachments/），并在投递给她的正文里带上
// 路径（`[图片 path=…]`、`[表情包 path=…]`），让她用 image_look 直接打开看。
//
// 三部分：
//   1) 纯函数矩阵（inlineImageNotes 的路径渲染 / inlineMfaceNotes 的占位替换）；
//   2) 落盘规则矩阵（cacheImage 的边界：超过 10MB 不下载、不是 png/jpg/webp/gif
//      跳过、base64 / 本地路径两种本机形态、按内容哈希命名、去重）；
//   3) 端到端（假 OneBot WS + 假 fetch + DSH_FISH_HOME 指到临时目录）：
//      图片段产出带路径的文本、失败时留占位提示、超限被跳过、mface 落一份 /
//      下不动有提示、目录超过上限删最旧、只记录的图之后在摘要里也能看到路径。
//
// 运行：node test-images.mjs
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inlineImageNotes, inlineMfaceNotes, MFACE_LABEL } from './index.js'
import { hashOfBuffer, shortHash } from './stickers.js'

// ── 最小 WebSocket 服务器（与 test-forward.mjs / test-onebot.mjs 同构）──────────

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

function createMockOneBot() {
  const actions = []
  let client = null
  const server = createServer()

  const reply = (msg, data) =>
    client.write(
      encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo })),
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

// 假 fetch：按 URL 子串路由；body 读没读、调过几次都可观测。
function createFakeFetch() {
  const routes = new Map()
  const calls = []
  const fake = async (url) => {
    calls.push(String(url))
    const key = [...routes.keys()].find((k) => String(url).includes(k))
    if (!key) throw new Error(`fake fetch: 没有配这条路由 ${url}`)
    const route = routes.get(key)
    if (route.error) throw new Error(route.error)
    return {
      ok: (route.status ?? 200) === 200,
      status: route.status ?? 200,
      headers: route.headers,
      arrayBuffer: async () => {
        route.bodyReads = (route.bodyReads ?? 0) + 1
        return route.body.buffer.slice(route.body.byteOffset, route.body.byteOffset + route.body.byteLength)
      },
    }
  }
  return {
    fake,
    calls,
    set(key, route) {
      routes.set(key, route)
    },
    routeBodyReads(key) {
      return routes.get(key)?.bodyReads ?? 0
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

/** 路径转正斜杠 —— 与投递给模型的字面量同一套（slashedPath）。 */
function slashed(p) {
  return String(p ?? '').split(/[\\/]/).join('/')
}

// ── 第 1 部分：纯函数（占位符渲染）──────────────────────────────────────────

check('MFACE_LABEL 是「[表情包]」', MFACE_LABEL === '[表情包]')

{
  const win = 'C:\\Users\\user\\.dsh-fish\\attachments\\aaaaaa1111111111.png'
  const posix = 'C:/Users/user/.dsh-fish/attachments/aaaaaa1111111111.png'
  const img = { path: win, hash: 'aaaaaa1111111111' }
  const note = (text, hash) => ({ text, hash })
  const d = new Map([[img, note('一只猫', 'aaaaaa1111111111')]])

  check(
    'inlineImageNotes：有 path 时占位符带路径（正斜杠）',
    inlineImageNotes('看 [图片] 这个', [img], d) === `看 [图片 path=${posix} #aaaaaa]：一只猫 这个`,
  )
  check(
    'inlineImageNotes：有 path 但没拿到描述 → 带路径的「（未描述）」',
    inlineImageNotes('看 [图片]', [img], new Map()) === `看 [图片 path=${posix}]（未描述）`,
  )
  check(
    'inlineImageNotes：note 与图都没有 hash 时退回带路径的裸占位符',
    (() => {
      const legacyNoHash = { path: posix }
      return inlineImageNotes('[图片]', [legacyNoHash], new Map([[legacyNoHash, note('一句话')]])) ===
        `[图片 path=${posix}]：一句话`
    })(),
  )
  // 老fixture（没有 path）的渲染一个字都不变 —— 老缓存条目、老测试都照旧。
  const legacy = { url: 'a', hash: 'bbbbbb2222222222' }
  const dLegacy = new Map([[legacy, note('一只猫', 'bbbbbb2222222222')]])
  check(
    'inlineImageNotes：没 path 的图保持老写法 [图片#xxxxxx]',
    inlineImageNotes('[图片]', [legacy], dLegacy) === '[图片#bbbbbb]：一只猫',
  )
  check(
    'inlineImageNotes：没 path 也没描述 → 老写法 [图片]（未描述）',
    inlineImageNotes('[图片]', [legacy], new Map()) === '[图片]（未描述）',
  )
  check(
    'inlineImageNotes：多出来的占位符原样保留',
    inlineImageNotes('[图片][图片]', [img], d) === `[图片 path=${posix} #aaaaaa]：一只猫[图片]`,
  )
  check('inlineImageNotes：没有占位符就不动正文', inlineImageNotes('只有文字', [img], d) === '只有文字')
  check(
    'inlineImageNotes：多图逐位对齐（path 不会串号）',
    // 第二张没拿到描述：占位符写「（未描述）」且不串到第一张的描述上（与既有断言同口径）
    inlineImageNotes('[图片] 和 [图片]', [img, legacy], d) ===
      `[图片 path=${posix} #aaaaaa]：一只猫 和 [图片]（未描述）`,
  )
}

{
  const win = 'C:\\att\\cccccc3333333333.png'
  const posix = 'C:/att/cccccc3333333333.png'
  check(
    'inlineMfaceNotes：下载成功带摘要 → [表情包:摘要 path=…]',
    inlineMfaceNotes('发了 [表情包]', [{ path: win, summary: 'doge' }]) === `发了 [表情包:doge path=${posix}]`,
  )
  check(
    'inlineMfaceNotes：下载成功没摘要 → [表情包 path=…]',
    inlineMfaceNotes('[表情包]', [{ path: posix }]) === `[表情包 path=${posix}]`,
  )
  check(
    'inlineMfaceNotes：下载失败带摘要 → 明确提示，不静默丢弃',
    inlineMfaceNotes('[表情包]', [{ summary: 'doge' }]) === '[表情包:doge]：图片没取到',
  )
  check(
    'inlineMfaceNotes：下载失败没摘要 → 也给明确提示',
    inlineMfaceNotes('[表情包]', [{}]) === '[表情包]：图片没取到',
  )
  check(
    'inlineMfaceNotes：占位符比槽位多 → 多出来的原样保留',
    inlineMfaceNotes('[表情包][表情包]', [{ path: posix }]) === `[表情包 path=${posix}][表情包]`,
  )
  check('inlineMfaceNotes：没有占位符就不动正文', inlineMfaceNotes('只聊天', [{ path: posix }]) === '只聊天')
  check(
    'inlineMfaceNotes：摘要里的空白被 trim',
    inlineMfaceNotes('[表情包]', [{ path: posix, summary: '  滑稽  ' }]) === `[表情包:滑稽 path=${posix}]`,
  )
  check(
    'inlineMfaceNotes：noUrl 槽位渲染裸占位符（没链接 ≠ 下载失败），且位置被消费掉',
    inlineMfaceNotes('[表情包][表情包]', [{ summary: 'doge', noUrl: true }, { path: posix, summary: 'cat' }]) ===
      `[表情包:doge][表情包:cat path=${posix}]`,
  )
}

// ── 第 2 部分：端到端（假 OneBot WS + 假 fetch + 临时目录）────────────────────

const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-images-'))
const fishHome = join(dir, 'fish-home')
const attachmentsDir = join(fishHome, 'attachments')
const statePath = join(dir, 'state.json')

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
const PNG_HASH = hashOfBuffer(PNG)
const PNG_SHORT = shortHash(PNG_HASH)
// 另一张内容不同的图（检验按内容哈希命名 / 去重）—— 前缀仍是 PNG 魔数，sniff 认得出。
const PNG2 = Buffer.concat([PNG.slice(0, 16), Buffer.from('-second-image')])
const PNG2_HASH = hashOfBuffer(PNG2)

const savedFishHome = process.env.DSH_FISH_HOME
const savedFetch = globalThis.fetch
process.env.DSH_FISH_HOME = fishHome

const ff = createFakeFetch()
// 路由表：key 是 URL 子串。
ff.set('good.invalid', { body: PNG })
ff.set('good2.invalid', { body: PNG2 })
ff.set('bad.invalid', { error: 'fetch failed（网络不通）' })
ff.set('http404.invalid', { status: 404 })
ff.set('bighead.invalid', {
  // Content-Length 声明 11MB：应该在读 body 之前就拦下
  headers: new Map([['content-length', String(11 * 1024 * 1024 + 1)]]),
  body: Buffer.alloc(32),
})
ff.set('bigbody.invalid', {
  // 没有 Content-Length：只能读完再判
  body: Buffer.alloc(11 * 1024 * 1024 + 1),
})
ff.set('notimg.invalid', { body: Buffer.from('这是一段纯文本，不是图片', 'utf8') })
globalThis.fetch = ff.fake

const mock = createMockOneBot()
const port = await mock.listen()

const { ctx, state } = createFakeCtx()
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
const statusTool = tool('qq_bridge_status')
const connected = await waitFor(async () => JSON.parse(await tool('qq_bridge_transport').execute({})).transport.state === 'open')
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

/** 发一条私聊（唤醒），等注入；返回投递文本里「[QQ · 私聊] 小明：」那一行之后的内容。 */
const fireWake = async (message, rawMessage) => {
  const before = state.followups.length
  sendPrivate({ raw_message: rawMessage ?? '244 看图', message })
  const ok = await waitFor(() => state.followups.length === before + 1)
  if (!ok) return null
  const text = textOf(state.followups[state.followups.length - 1])
  const line = text.split('\n').find((l) => l.startsWith('[QQ · ')) ?? text
  return { text, body: line.replace(/^\[QQ · 私聊\] 小明：/, '') }
}

// 1) 图片段 → 落盘 + 带路径的文本（验收第 1 条）
{
  const r = await fireWake([
    { type: 'text', data: { text: '244 看这张 ' } },
    { type: 'image', data: { url: 'https://good.invalid/a.png', file: 'a.png' } },
  ])
  check('图片消息唤醒投递成功', r !== null)
  const expectPath = slashed(join(attachmentsDir, `${PNG_HASH}.png`))
  check('投递文本里带 [图片 path=…]', r.body.includes(`[图片 path=${expectPath}`), r.body.slice(0, 120))
  check('投递文本里带短哈希（模型能指着图存表情包）', r.body.includes(`#${PNG_SHORT}]`), r.body.slice(0, 120))
  check('文件真的落到了 attachments 目录', existsSync(join(attachmentsDir, `${PNG_HASH}.png`)))
  check('扩展名按真实格式（PNG 头 → .png）', join(attachmentsDir, `${PNG_HASH}.png`).endsWith('.png'))
  check(
    '文件内容就是下载的那张图',
    statSync(join(attachmentsDir, `${PNG_HASH}.png`)).size === PNG.length,
  )
  check('图片内容没有塞进文本（无 base64 / 无文件字节）', !r.text.includes('base64') && !r.text.includes(PNG.toString('hex')), r.body.slice(0, 80))
  const st = JSON.parse(await statusTool.execute({}))
  check('status 的 attachments 段看得到目录与计数', st.attachments?.dir === slashed(attachmentsDir) && st.attachments?.files >= 1, JSON.stringify(st.attachments))
  check('status 的 attachments 段写明上限', st.attachments?.maxFiles === 200 && st.attachments?.maxSingleBytes === 10 * 1024 * 1024, JSON.stringify(st.attachments))
}

// 2) 同一张图再来一次：按内容哈希去重，不重复落盘
{
  const before = readdirSync(attachmentsDir).length
  const r = await fireWake([
    { type: 'text', data: { text: '244 又是这张 ' } },
    { type: 'image', data: { url: 'https://good.invalid/again.png', file: 'again.png' } },
  ])
  check('去重：文件数没有增加', readdirSync(attachmentsDir).length === before, `${before} -> ${readdirSync(attachmentsDir).length}`)
  check('去重：第二次照样拿到路径', r !== null && r.body.includes(`[图片 path=${slashed(join(attachmentsDir, `${PNG_HASH}.png`))}`), r ? r.body.slice(0, 120) : '未投递')
  check('去重：只有一个内容哈希文件', readdirSync(attachmentsDir).filter((n) => n.startsWith(PNG_HASH)).length === 1)
}

// 3) 内容不同的图：另一个哈希文件
{
  const r = await fireWake([
    { type: 'text', data: { text: '244 换一张 ' } },
    { type: 'image', data: { url: 'https://good2.invalid/b.png', file: 'b.png' } },
  ])
  check('不同内容 → 新文件（按内容哈希命名）', existsSync(join(attachmentsDir, `${PNG2_HASH}.png`)))
  check('不同内容 → 文本里是它的路径', r !== null && r.body.includes(`[图片 path=${slashed(join(attachmentsDir, `${PNG2_HASH}.png`))}`), r ? r.body.slice(0, 120) : '未投递')
}

// 4) 下载失败 → 占位提示 + 一行原因（验收第 2 条「失败时有占位提示」）
{
  const before = readdirSync(attachmentsDir).length
  const warned = state.warnings.length
  const r = await fireWake([
    { type: 'text', data: { text: '244 这张下不动 ' } },
    { type: 'image', data: { url: 'https://bad.invalid/x.png', file: 'x.png' } },
  ])
  check('下载失败 → 占位符写「（未描述）」', r !== null && r.body.includes('[图片]（未描述）'), r ? r.body : '未投递')
  check('下载失败 → 没有新文件', readdirSync(attachmentsDir).length === before)
  check('下载失败 → 记了一行原因（warn 带 URL 与原因）', state.warnings.slice(warned).some((w) => w.includes('bad.invalid') && w.includes('fetch failed')), JSON.stringify(state.warnings.slice(warned)))
}
{
  // HTTP 404：同样兜底
  const r = await fireWake([
    { type: 'text', data: { text: '244 这个 404 ' } },
    { type: 'image', data: { url: 'https://http404.invalid/y.png', file: 'y.png' } },
  ])
  check('HTTP 404 → 「（未描述）」占位', r !== null && r.body.includes('[图片]（未描述）'), r ? r.body : '未投递')
  check('HTTP 404 → warn 里有 HTTP 404', state.warnings.some((w) => w.includes('HTTP 404')))
}

// 5) 超过 10MB 不下载（验收第 2 条「超限被跳过」）
{
  const before = readdirSync(attachmentsDir).length
  const r = await fireWake([
    { type: 'text', data: { text: '244 这张太大 ' } },
    { type: 'image', data: { url: 'https://bighead.invalid/big.png', file: 'big.png' } },
  ])
  check('声明超过 10MB → 不下载（body 没读）', ff.routeBodyReads('bighead.invalid') === 0, `bodyReads=${ff.routeBodyReads('bighead.invalid')}`)
  check('声明超过 10MB → 没有新文件', readdirSync(attachmentsDir).length === before)
  check('声明超过 10MB → 占位提示', r !== null && r.body.includes('[图片]（未描述）'), r ? r.body : '未投递')
  check('声明超过 10MB → warn 写明「超过」与上限', state.warnings.some((w) => w.includes('bighead.invalid') && w.includes('超过') && w.includes('10MB')), JSON.stringify(state.warnings.slice(-2)))
}
{
  // 没有 Content-Length 的：只能读完再判 —— 仍然不落盘
  const before = readdirSync(attachmentsDir).length
  const r = await fireWake([
    { type: 'text', data: { text: '244 这张也大 ' } },
    { type: 'image', data: { url: 'https://bigbody.invalid/big2.png', file: 'big2.png' } },
  ])
  check('无声明但 body 超 10MB → 不落盘', readdirSync(attachmentsDir).length === before)
  check('无声明但 body 超 10MB → 占位提示', r !== null && r.body.includes('[图片]（未描述）'), r ? r.body : '未投递')
  check('无声明但 body 超 10MB → warn 写明原因', state.warnings.some((w) => w.includes('bigbody.invalid') && w.includes('超过')))
}

// 6) 非 png/jpg/webp/gif → 跳过
{
  const before = readdirSync(attachmentsDir).length
  const r = await fireWake([
    { type: 'text', data: { text: '244 这不是图 ' } },
    { type: 'image', data: { url: 'https://notimg.invalid/t.txt', file: 't.txt' } },
  ])
  check('纯文本字节 → 不落盘', readdirSync(attachmentsDir).length === before)
  check('纯文本字节 → 占位提示', r !== null && r.body.includes('[图片]（未描述）'), r ? r.body : '未投递')
  check('纯文本字节 → warn 写「不是可识别的图片」', state.warnings.some((w) => w.includes('notimg.invalid') && w.includes('不是可识别的图片')))
}

// 7) mface：落一份 / 下不动有提示 / 没链接不下载（验收第 3 条）
{
  const r = await fireWake([
    { type: 'text', data: { text: '244 看这个表情 ' } },
    { type: 'mface', data: { summary: 'doge', url: 'https://good.invalid/m.png' } },
  ])
  check('mface 下载成功 → [表情包:摘要 path=…]', r !== null && r.body.includes(`[表情包:doge path=${slashed(join(attachmentsDir, `${PNG_HASH}.png`))}`), r ? r.body : '未投递')
}
{
  const r = await fireWake([
    { type: 'text', data: { text: '244 这个表情下不动 ' } },
    { type: 'mface', data: { summary: '滑稽', url: 'https://bad.invalid/m.png' } },
  ])
  check('mface 下载失败 → [表情包:摘要]：图片没取到', r !== null && r.body.includes('[表情包:滑稽]：图片没取到'), r ? r.body : '未投递')
}
{
  const callsBefore = ff.calls.length
  const r = await fireWake([
    { type: 'text', data: { text: '244 没链接的表情 ' } },
    { type: 'mface', data: { summary: '[动画表情]' } },
  ])
  check('mface 没带链接 → 不尝试下载', ff.calls.length === callsBefore, JSON.stringify(ff.calls.slice(callsBefore)))
  check('mface 没带链接 → 留可读占位符（消息不丢）', r !== null && r.body.includes('[表情包:[动画表情]]') && !r.body.includes('path='), r ? r.body : '未投递')
}
{
  // 顺序对齐：没链接的 mface 在前、有链接的在后 —— 路径必须落到后面的占位符上
  const r = await fireWake([
    { type: 'text', data: { text: '244 两个表情 ' } },
    { type: 'mface', data: { summary: 'doge' } },
    { type: 'mface', data: { summary: 'cat', url: 'https://good.invalid/order.png' } },
  ])
  check(
    'mface 混排：没链接的渲染摘要、有链接的渲染路径，互不顶位',
    r !== null && r.body.includes(`[表情包:doge][表情包:cat path=${slashed(join(attachmentsDir, `${PNG_HASH}.png`))}]`),
    r ? r.body : '未投递',
  )
}
{
  // 纯 mface（无文字、没叫名字）：消息不能整条消失。
  // 私聊概率是 0（为了测只记录路径），这里用**群里 @** 把它叫醒 —— 与「纯 mface 必唤醒」是同一件事。
  const before = state.followups.length
  mock.sendEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 2001,
    user_id: 1001,
    self_id: 10001,
    message_id: 556,
    raw_message: '[CQ:at,qq=10001][CQ:mface]',
    message: [
      { type: 'at', data: { qq: '10001' } },
      { type: 'mface', data: { summary: '[动画表情]', url: 'https://good.invalid/pure.png' } },
    ],
    sender: { nickname: '群友', card: '' },
  })
  const ok = await waitFor(() => state.followups.length === before + 1)
  check('纯表情包消息没被丢掉（@ 必唤醒）', ok)
  if (ok) {
    const t = textOf(state.followups[state.followups.length - 1])
    check('纯表情包消息也带上了路径', t.includes('[表情包:[动画表情] path='), t.split('\n').find((l) => l.startsWith('[QQ')) ?? t.slice(0, 80))
  }
}

// 8) 只记录（没唤醒）的图：落在缓冲里，下一次唤醒在摘要里看得到路径（验收第 1 条的 record 路径）
{
  const bufferedBefore = JSON.parse(await statusTool.execute({})).bufferedUnwoken
  sendPrivate({
    raw_message: '看这张图（没叫名字）',
    message: [
      { type: 'text', data: { text: '看这张图（没叫名字）' } },
      { type: 'image', data: { url: 'https://good2.invalid/recorded.png', file: 'recorded.png' } },
    ],
  })
  const buffered = await waitFor(async () => JSON.parse(await statusTool.execute({})).bufferedUnwoken === bufferedBefore + 1)
  check('未唤醒的图片消息进了缓冲（没唤醒、零模型调用）', buffered)
  const r = await fireWake([{ type: 'text', data: { text: '244 在吗' } }], '244 在吗')
  check('下一次唤醒正常投递', r !== null)
  check('摘要里看得到那张图的路径', r !== null && r.text.includes(`[图片 path=${slashed(join(attachmentsDir, `${PNG2_HASH}.png`))}`), r ? r.text.slice(0, 160).replace(/\n/g, ' ') : '未投递')
}

// 9) 清理：超过上限（200 个文件）删最旧的（验收第 4 条）
{
  // 预置 202 个旧文件（时间错开，最旧的排第一），再触发一次新下载。
  const oldFiles = []
  const base = Date.now() / 1000 - 10 * 24 * 3600
  for (let i = 0; i < 202; i++) {
    const p = join(attachmentsDir, `old-${String(i).padStart(3, '0')}.png`)
    writeFileSync(p, Buffer.from(`old-${i}`))
    utimesSync(p, base + i, base + i)
    oldFiles.push(p)
  }
  const PNG3 = Buffer.concat([PNG.slice(0, 16), Buffer.from('-third-image')])
  const PNG3_HASH = hashOfBuffer(PNG3)
  ff.set('good3.invalid', { body: PNG3 })
  const r = await fireWake([
    { type: 'text', data: { text: '244 再来一张 ' } },
    { type: 'image', data: { url: 'https://good3.invalid/c.png', file: 'c.png' } },
  ])
  const names = readdirSync(attachmentsDir)
  check('新图照常落盘并带路径', existsSync(join(attachmentsDir, `${PNG3_HASH}.png`)) && r !== null && r.body.includes(`[图片 path=${slashed(join(attachmentsDir, `${PNG3_HASH}.png`))}`), r ? r.body.slice(0, 100) : '未投递')
  check('目录文件数回落到上限（200）', names.length === 200, `实际 ${names.length}`)
  check('删的是最旧的（old-000 没了）', !existsSync(oldFiles[0]))
  check('较旧的也删了几个（凑满 200）', !existsSync(oldFiles[1]) && !existsSync(oldFiles[2]))
  check('最新的那个留着', existsSync(join(attachmentsDir, `${PNG3_HASH}.png`)))
}

// 10) 卸载：传输必须干净停掉
for (const d of state.disposers) await d()
check('dispose 后连接已关闭', await waitFor(() => mock.connected === false, 2000))
await mock.close()

globalThis.fetch = savedFetch
if (savedFishHome === undefined) delete process.env.DSH_FISH_HOME
else process.env.DSH_FISH_HOME = savedFishHome
rmSync(dir, { recursive: true, force: true })

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) process.exitCode = 1
