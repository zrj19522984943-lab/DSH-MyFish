// 收文件测试（2026-10-30）：群里 / 私聊有人发文件（OneBot 的 file 段），桥接层要把文件
// 真正下载到工作区的 receive/ 目录，命名「发送人昵称_原文件名」（重名加序号），并在
// 投递给她的正文里带上路径与大小（`[文件 path=… 大小=… 来自=…]`）。
//
// 四部分：
//   1) 纯函数矩阵（parseReceiveCommand / inlineFileNotes 的占位替换 / 文件名清理与
//      重名序号 / buildReceiveReport 的回执文案）；
//   2) 端到端（假 OneBot WS + 假 fetch + workspaceRoot 指到临时目录）：
//      文件段落地产出带路径的文本、重名加序号、超过 50MB 不下载、下载失败写清原因、
//      没带 url 时走 get_file 兜底 / 兜不下来也如实说；
//   3) `receive` 指令：主人 / 管理员收到回执（直发、不叫模型），普通人发了被忽略；
//   4) 收件箱容量：最多 200 个文件，超了删最旧的。
//
// 运行：node test-receive.mjs
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  buildReceiveReport,
  formatBytes,
  formatReceiveTime,
  inlineFileNotes,
  parseReceiveCommand,
  sanitizeForFileName,
  uniqueReceiveName,
} from './index.js'

// ── 最小 WebSocket 服务器（与 test-images.mjs / test-forward.mjs 同构）──────────

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

  const reply = (msg, data, status = 'ok', retcode = 0) =>
    client.write(encodeFrame(JSON.stringify({ status, retcode, data, echo: msg.echo })))

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
        } else if (msg.action === 'get_file') {
          // 没带 url 的文件段会走 get_file 兜底：bad-fid 回个失败，其余回假 url。
          if (String(msg.params?.file ?? '') === 'bad-fid') {
            reply(msg, {}, 'failed', 1404)
          } else {
            reply(msg, { url: 'https://gf.invalid/from-get-file.txt', file_name: 'from-get-file.txt' })
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
    routeCalls(key) {
      return calls.filter((u) => u.includes(key)).length
    },
  }
}

// ── 测试脚手架（与 test-images.mjs 同构）──────────────────────────────────────

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

// ══════════════════════════════════════════════════════════════════════════
// 第 1 部分：纯函数
// ══════════════════════════════════════════════════════════════════════════

{
  const p = (t) => parseReceiveCommand(t)
  check('解析：receive 算指令', p('receive')?.command === 'receive')
  check('解析：大小写不敏感', p('RECEIVE')?.command === 'receive')
  check('解析：首尾空白不敏感', p('  Receive  ')?.command === 'receive')
  for (const text of [
    'receive 一下', // 带正文 → 聊天
    '帮我 receive', // 不在开头
    'receives', // 前缀词
    'received', // 过去式
    'receive?', // 带标点
    '', '？', null,
  ]) {
    check(`解析：${JSON.stringify(text)} 不算指令`, p(text) === null)
  }
}

{
  const win = 'C:\\demo\\workspace\\receive\\小明_report.pdf'
  const posix = 'C:/demo/workspace/receive/小明_report.pdf'
  check(
    'inlineFileNotes：收到 → [文件:名 path=… 大小=… 来自=…]（路径正斜杠）',
    inlineFileNotes('发个 [文件] 看看', [{ ok: true, path: win, name: '小明_report.pdf', size: 1536, from: '小明' }]) ===
      `发个 [文件:小明_report.pdf path=${posix} 大小=${formatBytes(1536)} 来自=小明] 看看`,
  )
  check(
    'inlineFileNotes：大小按 formatBytes 渲染（11B / 1.5KB）',
    inlineFileNotes('[文件]', [{ ok: true, path: win, name: 'a', size: 11, from: 'x' }]).includes('大小=11B') &&
      inlineFileNotes('[文件]', [{ ok: true, path: win, name: 'a', size: 1536, from: 'x' }]).includes('大小=1.5KB'),
  )
  check(
    'inlineFileNotes：没有 from 就不写 来自=',
    !inlineFileNotes('[文件]', [{ ok: true, path: win, name: 'a', size: 11, from: '' }]).includes('来自='),
  )
  check(
    'inlineFileNotes：超过上限 → [文件:名]：原因，不静默丢弃',
    inlineFileNotes('[文件]', [{ ok: false, reason: '超过 50MB 上限（声明 60MB），不下载', name: 'big.zip' }]) ===
      '[文件:big.zip]：超过 50MB 上限（声明 60MB），不下载',
  )
  check(
    'inlineFileNotes：下载失败 → [文件:名]：原因',
    inlineFileNotes('[文件]', [{ ok: false, reason: 'HTTP 404', name: 'x.zip' }]) === '[文件:x.zip]：HTTP 404',
  )
  check(
    'inlineFileNotes：失败但没名字 → 裸占位符 + 原因',
    inlineFileNotes('[文件]', [{ ok: false, reason: 'HTTP 404' }]) === '[文件]：HTTP 404',
  )
  check(
    'inlineFileNotes：多图逐位对齐（成功的位不会顶到失败的位上）',
    inlineFileNotes('[文件] 和 [文件]', [
      { ok: true, path: win, name: 'a.pdf', size: 11, from: '小明' },
      { ok: false, reason: 'HTTP 404', name: 'b.zip' },
    ]) ===
      `[文件:a.pdf path=${posix} 大小=11B 来自=小明] 和 [文件:b.zip]：HTTP 404`,
  )
  check(
    'inlineFileNotes：占位符比槽位多 → 多出来的原样保留',
    inlineFileNotes('[文件][文件]', [{ ok: false, reason: 'HTTP 404', name: 'b.zip' }]) === '[文件:b.zip]：HTTP 404[文件]',
  )
  check('inlineFileNotes：没有占位符就不动正文', inlineFileNotes('只有文字', [{ ok: true, path: win, name: 'a', size: 1, from: 'x' }]) === '只有文字')
}

{
  check('sanitizeForFileName：去掉 Windows 非法字符与分隔符', sanitizeForFileName('x<>:"/\\|?*y') === 'xy')
  check('sanitizeForFileName：去掉控制字符', sanitizeForFileName('a\x00\x07b') === 'ab')
  check('sanitizeForFileName：结尾的点和空格被削掉', sanitizeForFileName('x..  .') === 'x')
  check('sanitizeForFileName：全清理空了 → 空串', sanitizeForFileName('***') === '')
  check('sanitizeForFileName：按码点截断（默认 80）', [...sanitizeForFileName('字'.repeat(100))].length === 80)
  check('sanitizeForFileName：普通名字原样', sanitizeForFileName('report 最终版.pdf') === 'report 最终版.pdf')
}

{
  const tmp = mkdtempSync(join(tmpdir(), 'qq-bridge-receive-pure-'))
  try {
    const first = uniqueReceiveName(tmp, '小明', 'report.pdf')
    check('uniqueReceiveName：第一个就是 昵称_文件名', first === join(tmp, '小明_report.pdf'))
    writeFileSync(first, Buffer.from('1'))
    const second = uniqueReceiveName(tmp, '小明', 'report.pdf')
    check('uniqueReceiveName：重名加序号 _1', second === join(tmp, '小明_report_1.pdf'))
    writeFileSync(second, Buffer.from('2'))
    check('uniqueReceiveName：再重名 → _2', uniqueReceiveName(tmp, '小明', 'report.pdf') === join(tmp, '小明_report_2.pdf'))
    // 没拓展名的文件
    const noExt = uniqueReceiveName(tmp, '群友', 'README')
    check('uniqueReceiveName：无扩展名也行', noExt === join(tmp, '群友_README'))
    writeFileSync(noExt, Buffer.from('3'))
    check('uniqueReceiveName：无扩展名重名 → _1', uniqueReceiveName(tmp, '群友', 'README') === join(tmp, '群友_README_1'))
    // 昵称 / 文件名里带非法字符 → 清理后再拼
    check(
      'uniqueReceiveName：非法字符先清理',
      uniqueReceiveName(tmp, '小/明*', 'a<b>.zip') === join(tmp, '小明_a<b>.zip'.replace(/[<>]/g, '')),
    )
    // 空昵称 / 空文件名有兜底
    check('uniqueReceiveName：空昵称兜底「未知」', uniqueReceiveName(tmp, '', 'x.txt') === join(tmp, '未知_x.txt'))
    check('uniqueReceiveName：空文件名兜底「未命名文件」', uniqueReceiveName(tmp, '小明', '') === join(tmp, '小明_未命名文件'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

{
  const dir = 'D:\\demo\\workspace\\receive'
  check(
    'buildReceiveReport：目录没配 → 如实说用不了',
    buildReceiveReport({ dir: '' }).includes('收件箱用不了') && buildReceiveReport({ dir: '' }).includes('工作区根目录'),
  )
  check(
    'buildReceiveReport：空目录 → 现在是空的',
    buildReceiveReport({ dir, files: [] }).includes('现在是空的') && buildReceiveReport({ dir, files: [] }).includes(slashed(dir)),
  )
  const files = [
    { name: '小明_report.pdf', size: 1536, at: Date.parse('2026-10-30T12:00:00+08:00') },
    { name: '群友_照片.zip', size: 204800, at: Date.parse('2026-10-30T18:30:00+08:00') },
    { name: '小红_笔记.txt', size: 11, at: Date.parse('2026-10-29T09:05:00+08:00') },
  ]
  const report = buildReceiveReport({ dir, files })
  const lines = report.split('\n')
  check('buildReceiveReport：头部写目录与总数', lines[0].includes(`收件箱（${slashed(dir)}）共 3 个文件`) && lines[0].includes('最近 3 个'), lines[0])
  check('buildReceiveReport：按时间从新到旧排', lines[1].includes('群友_照片.zip') && lines[2].includes('小明_report.pdf') && lines[3].includes('小红_笔记.txt'), lines.slice(1).join(' | '))
  check('buildReceiveReport：每行带大小与时间', lines[1].includes(formatBytes(204800)) && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(lines[1]), lines[1])
  check(
    'buildReceiveReport：limit 截到前 N 个',
    buildReceiveReport({ dir, files, limit: 2 }).split('\n').length === 3 && buildReceiveReport({ dir, files, limit: 2 }).includes('最近 2 个'),
  )
  check('buildReceiveReport：limit 非法 → 退回默认 5（这里只有 3 个，列 3 个）', buildReceiveReport({ dir, files, limit: 0 }).includes('最近 3 个'))
  check('formatReceiveTime：YYYY-MM-DD HH:mm', formatReceiveTime(Date.parse('2026-10-30T18:30:00+08:00')) === '2026-10-30 18:30')
  check('formatReceiveTime：非法时间兜底', formatReceiveTime('not-a-time') === '未知时间')
}

// ══════════════════════════════════════════════════════════════════════════
// 第 2 部分：端到端（假 OneBot WS + 假 fetch + 临时 workspaceRoot）
// ══════════════════════════════════════════════════════════════════════════

const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-receive-'))
const workspaceRoot = dir // receive 目录 = <工作区>/receive
const receiveDir = join(workspaceRoot, 'receive')
const fishHome = join(dir, 'fish-home')
const statePath = join(dir, 'state.json')

const PDF = Buffer.from('这是一个假 PDF 的内容，用来当入站文件' + 'x'.repeat(64))
const TXT = Buffer.from('hello file via get_file')

const savedFishHome = process.env.DSH_FISH_HOME
const savedFetch = globalThis.fetch
process.env.DSH_FISH_HOME = fishHome

const ff = createFakeFetch()
// 路由表：key 是 URL 子串。
ff.set('file.invalid', { body: PDF })
ff.set('second.invalid', { body: PDF })
ff.set('gf.invalid', { body: TXT })
ff.set('bad.invalid', { error: 'fetch failed（网络不通）' })
ff.set('http404.invalid', { status: 404 })
ff.set('bighead.invalid', {
  // Content-Length 声明 50MB+1：应该在读 body 之前就拦下
  headers: new Map([['content-length', String(50 * 1024 * 1024 + 1)]]),
  body: Buffer.alloc(32),
})
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
  whitelist: ['1001', '1002', '1003'],
  groupWhitelist: ['2001'],
  admins: ['1002'],
  workspaceRoot,
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
  sendPrivate({ raw_message: rawMessage ?? '244 看这个', message })
  const ok = await waitFor(() => state.followups.length === before + 1)
  if (!ok) return null
  const text = textOf(state.followups[state.followups.length - 1])
  const line = text.split('\n').find((l) => l.startsWith('[QQ · ')) ?? text
  return { text, body: line.replace(/^\[QQ · 私聊\] 小明：/, '') }
}

/** 收件箱里现在有几个文件。 */
const receiveCount = () => {
  try {
    return readdirSync(receiveDir).length
  } catch {
    return 0
  }
}

// 1) 文件段 → 落盘 + 带路径的文本（验收：入站文件落地 + 投递文本带路径与大小）
{
  const r = await fireWake(
    [
      { type: 'text', data: { text: '244 看这个文件 ' } },
      { type: 'file', data: { url: 'https://file.invalid/report.pdf', file: 'report.pdf', file_size: PDF.length } },
    ],
    '244 看这个文件',
  )
  check('文件消息唤醒投递成功', r !== null)
  const expectPath = slashed(join(receiveDir, '小明_report.pdf'))
  check(
    '投递文本里带 [文件 path=… 大小=… 来自=…]',
    r !== null && r.body.includes(`[文件:小明_report.pdf path=${expectPath} 大小=${formatBytes(PDF.length)} 来自=小明]`),
    r ? r.body.slice(0, 160) : '未投递',
  )
  check('文件真的落到了 receive 目录', existsSync(join(receiveDir, '小明_report.pdf')))
  check('文件名就是「发送人昵称_原文件名」', existsSync(join(receiveDir, '小明_report.pdf')) && readdirSync(receiveDir).includes('小明_report.pdf'))
  check('文件内容就是下载的内容', statSync(join(receiveDir, '小明_report.pdf')).size === PDF.length)
  check('文件字节没有塞进文本', r !== null && !r.text.includes(PDF.toString('hex')) && !r.text.includes('base64'), r ? r.body.slice(0, 80) : '未投递')
  const st = JSON.parse(await statusTool.execute({}))
  check('status 的 receive 段看得到目录与计数', st.receive?.dir === slashed(receiveDir) && st.receive?.files >= 1, JSON.stringify(st.receive))
  check('status 的 receive 段写明上限', st.receive?.maxFiles === 200 && st.receive?.maxSingleBytes === 50 * 1024 * 1024, JSON.stringify(st.receive))
}

// 2) 同一个人又发了同名文件：重名加序号
{
  const r = await fireWake(
    [
      { type: 'text', data: { text: '244 又是这份 ' } },
      { type: 'file', data: { url: 'https://second.invalid/report.pdf', file: 'report.pdf', file_size: PDF.length } },
    ],
    '244 又是这份',
  )
  check('重名 → 落成 _1', existsSync(join(receiveDir, '小明_report_1.pdf')))
  check('重名 → 文本里是 _1 的路径', r !== null && r.body.includes(`path=${slashed(join(receiveDir, '小明_report_1.pdf'))}`), r ? r.body.slice(0, 120) : '未投递')
}

// 3) 一条消息带两个文件：两个都落地，正文各带各的路径
{
  const r = await fireWake(
    [
      { type: 'text', data: { text: '244 两个一起发 ' } },
      { type: 'file', data: { url: 'https://file.invalid/a.pdf', file: 'a.pdf', file_size: PDF.length } },
      { type: 'file', data: { url: 'https://second.invalid/b.txt', file: 'b.txt', file_size: PDF.length } },
    ],
    '244 两个一起发',
  )
  check('多文件：两个都落地', existsSync(join(receiveDir, '小明_a.pdf')) && existsSync(join(receiveDir, '小明_b.txt')))
  check(
    '多文件：正文里两个路径都在、且逐位对齐',
    r !== null && r.body.indexOf('小明_a.pdf') < r.body.indexOf('小明_b.txt'),
    r ? r.body.slice(0, 200) : '未投递',
  )
}

// 4) 超过 50MB 不下载（验收：超大跳过）
{
  const before = receiveCount()
  const r = await fireWake(
    [
      { type: 'text', data: { text: '244 这个太大 ' } },
      { type: 'file', data: { url: 'https://bighead.invalid/big.zip', file: 'big.zip', file_size: 60 * 1024 * 1024 } },
    ],
    '244 这个太大',
  )
  // 段里声明了 60MB：应该在发 fetch 之前就拦下
  check('段里声明超过 50MB → 不下载（fetch 没调）', ff.routeCalls('bighead.invalid') === 0, JSON.stringify(ff.calls.slice(-2)))
  check('段里声明超过 50MB → 没有新文件', receiveCount() === before, `${before} -> ${receiveCount()}`)
  check('段里声明超过 50MB → 占位提示带「超过」', r !== null && r.body.includes('[文件:big.zip]：超过'), r ? r.body.slice(0, 120) : '未投递')
  check('段里声明超过 50MB → warn 写明原因', state.warnings.some((w) => w.includes('文件接收失败') && w.includes('big.zip') && w.includes('超过')), JSON.stringify(state.warnings.slice(-1)))
}
{
  // 段里没声明大小、但 HTTP 头声明了 50MB+1：读完之前拦下
  const before = receiveCount()
  const r = await fireWake(
    [
      { type: 'text', data: { text: '244 这个也大 ' } },
      { type: 'file', data: { url: 'https://bighead.invalid/big2.zip', file: 'big2.zip' } },
    ],
    '244 这个也大',
  )
  check('HTTP 头声明超过 50MB → body 没读', ff.routeBodyReads('bighead.invalid') === 0, `bodyReads=${ff.routeBodyReads('bighead.invalid')}`)
  check('HTTP 头声明超过 50MB → 没有新文件', receiveCount() === before)
  check('HTTP 头声明超过 50MB → 占位提示带「超过」', r !== null && r.body.includes('[文件:big2.zip]：超过'), r ? r.body.slice(0, 120) : '未投递')
}

// 5) 下载失败 → 写清原因（验收：失败不静默丢弃）
{
  const before = receiveCount()
  const r = await fireWake(
    [
      { type: 'text', data: { text: '244 这个下不动 ' } },
      { type: 'file', data: { url: 'https://bad.invalid/x.zip', file: 'x.zip' } },
    ],
    '244 这个下不动',
  )
  check('下载失败 → 占位提示带原因', r !== null && r.body.includes('[文件:x.zip]：fetch failed'), r ? r.body.slice(0, 120) : '未投递')
  check('下载失败 → 没有新文件', receiveCount() === before)
  check('下载失败 → 记了一行原因（warn）', state.warnings.some((w) => w.includes('文件接收失败') && w.includes('x.zip') && w.includes('fetch failed')), JSON.stringify(state.warnings.slice(-1)))
}
{
  // HTTP 404：同样兜底
  const r = await fireWake(
    [
      { type: 'text', data: { text: '244 这个 404 ' } },
      { type: 'file', data: { url: 'https://http404.invalid/y.zip', file: 'y.zip' } },
    ],
    '244 这个 404',
  )
  check('HTTP 404 → 占位提示 HTTP 404', r !== null && r.body.includes('[文件:y.zip]：HTTP 404'), r ? r.body.slice(0, 120) : '未投递')
  check('HTTP 404 → warn 里有 HTTP 404', state.warnings.some((w) => w.includes('HTTP 404')))
}

// 6) 没带 url 的文件段：走 get_file 兜底 / 兜不下来也如实说
{
  const r = await fireWake(
    [
      { type: 'text', data: { text: '244 这个没链接 ' } },
      { type: 'file', data: { file: 'no-url.txt', file_id: 'fid-ok', file_size: TXT.length } },
    ],
    '244 这个没链接',
  )
  check('没 url → 走 get_file（mock 收到调用）', mock.actions.some((a) => a.action === 'get_file' && a.params?.file === 'fid-ok'), JSON.stringify(mock.actions.slice(-2)))
  check('没 url → get_file 取回的 url 照常下载落地', existsSync(join(receiveDir, '小明_no-url.txt')))
  check('没 url → 文本里带落地路径', r !== null && r.body.includes(`path=${slashed(join(receiveDir, '小明_no-url.txt'))}`), r ? r.body.slice(0, 120) : '未投递')
}
{
  // get_file 失败（retcode 1404）：如实写原因
  const r = await fireWake(
    [
      { type: 'text', data: { text: '244 get_file 也失败 ' } },
      { type: 'file', data: { file: 'dead.bin', file_id: 'bad-fid' } },
    ],
    '244 get_file 也失败',
  )
  check('get_file 失败 → 占位提示写 get_file 失败', r !== null && r.body.includes('[文件:dead.bin]：get_file 失败'), r ? r.body.slice(0, 140) : '未投递')
  check('get_file 失败 → warn 里能看到 retcode', state.warnings.some((w) => w.includes('dead.bin') && w.includes('1404')), JSON.stringify(state.warnings.slice(-1)))
}
{
  // 既没 url / file、也没 file_id：没的下了，如实说
  const r = await fireWake(
    [
      { type: 'text', data: { text: '244 啥都没带 ' } },
      { type: 'file', data: { name: 'ghost.bin' } },
    ],
    '244 啥都没带',
  )
  check('没地址也没 file_id → 占位提示「没带能下载的 url / file」', r !== null && r.body.includes('[文件:ghost.bin]：文件段没带能下载的 url / file'), r ? r.body.slice(0, 140) : '未投递')
}

// 7) 纯文件消息（无正文、没 @、没叫名字）：不唤醒也照常落地（验收：收到就下载）
{
  const before = receiveCount()
  sendPrivate({
    raw_message: '[CQ:file,url=https://file.invalid/silent.pdf,file=silent.pdf]',
    message: [{ type: 'file', data: { url: 'https://file.invalid/silent.pdf', file: 'silent.pdf', file_size: PDF.length } }],
  })
  const landed = await waitFor(() => existsSync(join(receiveDir, '小明_silent.pdf')))
  check('未唤醒的纯文件消息 → 文件照常落盘', landed)
  const buffered = await waitFor(async () => JSON.parse(await statusTool.execute({})).bufferedUnwoken > 0)
  check('未唤醒的纯文件消息 → 进缓冲（没唤醒、零模型调用）', buffered)
  check('未唤醒的文件消息 → receive 目录多了一个文件', receiveCount() === before + 1, `${before} -> ${receiveCount()}`)
}

// 8) 收件箱里缓存的文件：下一次唤醒在摘要里也能看到路径
{
  const r = await fireWake([{ type: 'text', data: { text: '244 在吗' } }], '244 在吗')
  check('下一次唤醒正常投递', r !== null)
  check('摘要里看得到那个文件的路径', r !== null && r.text.includes(`path=${slashed(join(receiveDir, '小明_silent.pdf'))}`), r ? r.text.slice(0, 200).replace(/\n/g, ' ') : '未投递')
}

// ══════════════════════════════════════════════════════════════════════════
// 第 3 部分：receive 指令（主人 / 管理员能用，普通人被忽略）
// ══════════════════════════════════════════════════════════════════════════

/** 收到的 send_* 动作里，目的地是 userId 的那条的文本；没有就 null。 */
const bridgeReplyTo = (userId) => {
  const sent = [...mock.actions]
    .reverse()
    .find((a) => a.action === 'send_private_msg' && String(a.params?.user_id ?? '') === String(userId))
  return sent ? String(sent.params?.message?.[0]?.data?.text ?? '') : null
}

// 8) 主人发 receive → 直回一句收件箱情况
{
  const repliesBefore = mock.actions.filter((a) => a.action === 'send_private_msg').length
  sendPrivate({ raw_message: 'receive', message: [{ type: 'text', data: { text: 'receive' } }] })
  const arrived = await waitFor(() => mock.actions.filter((a) => a.action === 'send_private_msg').length === repliesBefore + 1)
  check('主人发 receive → 桥接层直发一句（不叫模型）', arrived)
  const text = bridgeReplyTo(1001)
  check('主人收到回执：写目录与总数', text !== null && text.includes(`收件箱（${slashed(receiveDir)}）共`) && /\d+ 个文件/.test(text), text ?? '未收到')
  // 最新落盘的是 get_file 兜回来的那个（no-url.txt），它一定在最近 5 条里
  check('主人收到回执：列出最近文件（名字 / 大小 / 时间）', text !== null && text.includes('小明_no-url.txt') && text.includes(formatBytes(TXT.length)) && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text), text ?? '未收到')
  const st = JSON.parse(await statusTool.execute({}))
  check('receive 回执记进 outbox（via=receive）', Array.isArray(st.recentOutbox) && st.recentOutbox.some((o) => o?.via === 'receive'), JSON.stringify(st.recentOutbox?.slice(-1)))
  const followupsBefore = state.followups.length
  await sleep(300)
  check('receive 没有唤醒模型（没有新注入）', state.followups.length === followupsBefore)
}

// 9) 管理员发 receive → 也能用
{
  const repliesBefore = mock.actions.filter((a) => a.action === 'send_private_msg' && String(a.params?.user_id ?? '') === '1002').length
  mock.sendEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 1002,
    self_id: 10001,
    message_id: 556,
    sender: { nickname: '管理员' },
    raw_message: 'receive',
    message: [{ type: 'text', data: { text: 'receive' } }],
  })
  const arrived = await waitFor(() => mock.actions.filter((a) => a.action === 'send_private_msg' && String(a.params?.user_id ?? '') === '1002').length === repliesBefore + 1)
  check('管理员发 receive → 同样收到回执', arrived)
  const text = bridgeReplyTo(1002)
  check('管理员的回执内容一样（不是空话）', text !== null && text.includes('收件箱（'), text ?? '未收到')
}

// 10) 普通人发 receive → 忽略：不回话、不解析，按普通聊天处理
{
  const repliesBefore = mock.actions.filter((a) => a.action === 'send_private_msg').length
  const stBefore = JSON.parse(await statusTool.execute({}))
  const bufferedBefore = stBefore.bufferedUnwoken ?? 0
  const receiveOutboxBefore = (stBefore.recentOutbox ?? []).filter((o) => o?.via === 'receive').length
  mock.sendEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 1003,
    self_id: 10001,
    message_id: 557,
    sender: { nickname: '路人' },
    raw_message: 'receive',
    message: [{ type: 'text', data: { text: 'receive' } }],
  })
  await sleep(500)
  const sentAfter = mock.actions.filter((a) => a.action === 'send_private_msg').length
  check('普通人发 receive → 没有任何回话', sentAfter === repliesBefore, JSON.stringify(mock.actions.slice(-1)))
  const buffered = await waitFor(async () => {
    const st = JSON.parse(await statusTool.execute({}))
    return (st.bufferedUnwoken ?? 0) > bufferedBefore
  })
  check('普通人发 receive → 当普通聊天处理（进了缓冲，不是指令）', buffered)
  const st = JSON.parse(await statusTool.execute({}))
  check(
    '普通人发 receive → outbox 里没有新的 receive 记录',
    (st.recentOutbox ?? []).filter((o) => o?.via === 'receive').length === receiveOutboxBefore,
    JSON.stringify(st.recentOutbox?.slice(-2)),
  )
}

// 11) 群里的文件：from 是群里那个人的昵称（命名与 来自= 都用它）
{
  const before = receiveCount()
  mock.sendEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 2001,
    user_id: 1003,
    self_id: 10001,
    message_id: 558,
    raw_message: '244 看群里的文件[CQ:file,url=https://file.invalid/group.xlsx,file=group.xlsx]',
    message: [
      { type: 'text', data: { text: '244 看群里的文件' } },
      { type: 'file', data: { url: 'https://file.invalid/group.xlsx', file: 'group.xlsx', file_size: PDF.length } },
    ],
    sender: { nickname: '群友', card: '' },
  })
  const landed = await waitFor(() => existsSync(join(receiveDir, '群友_group.xlsx')))
  check('群消息的文件照常落地', landed)
  check('群里来的文件：命名用群友昵称', existsSync(join(receiveDir, '群友_group.xlsx')) && receiveCount() === before + 1)
}

// ══════════════════════════════════════════════════════════════════════════
// 第 4 部分：收件箱容量（最多 200 个文件，超了删最旧的）
// ══════════════════════════════════════════════════════════════════════════

{
  // 预置 202 个旧文件（时间错开，最旧的排第一），再收一个新文件。
  const oldFiles = []
  const base = Date.now() / 1000 - 10 * 24 * 3600
  for (let i = 0; i < 202; i++) {
    const p = join(receiveDir, `old-${String(i).padStart(3, '0')}.bin`)
    writeFileSync(p, Buffer.from(`old-${i}`))
    utimesSync(p, base + i, base + i)
    oldFiles.push(p)
  }
  const before = receiveCount()
  check('预置旧文件就位', before >= 202, `${before}`)
  sendPrivate({
    raw_message: '244 再来一个[CQ:file,url=https://file.invalid/new.txt,file=new.txt]',
    message: [
      { type: 'text', data: { text: '244 再来一个' } },
      { type: 'file', data: { url: 'https://file.invalid/new.txt', file: 'new.txt', file_size: PDF.length } },
    ],
  })
  const landed = await waitFor(() => existsSync(join(receiveDir, '小明_new.txt')))
  check('容量测试：新文件照常落盘', landed)
  const names = readdirSync(receiveDir)
  check('容量测试：目录文件数回落到上限（200）', names.length === 200, `实际 ${names.length}`)
  check('容量测试：删的是最旧的（old-000 没了）', !existsSync(oldFiles[0]))
  check('容量测试：较旧的也删了几个（凑满 200）', !existsSync(oldFiles[1]) && !existsSync(oldFiles[2]))
  check('容量测试：最新的那个留着', existsSync(join(receiveDir, '小明_new.txt')))
}

// 12) 卸载：传输必须干净停掉
for (const d of state.disposers) await d()
check('dispose 后连接已关闭', await waitFor(() => mock.connected === false, 2000))
await mock.close()

globalThis.fetch = savedFetch
if (savedFishHome === undefined) delete process.env.DSH_FISH_HOME
else process.env.DSH_FISH_HOME = savedFishHome
rmSync(dir, { recursive: true, force: true })

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) process.exitCode = 1
