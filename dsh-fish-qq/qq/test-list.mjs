// list 指令测试（2026-10-30）：主人 / 管理员在 QQ 里发 `list` / `list dist` / `list managehub`，
// 桥接层**不叫模型**，直接把工作区里 dist/ 与 managehub/ 两个目录的文件清单发回去
// （每行一个文件：名字 / 大小 / 修改时间；目录不存在或为空也如实说；超过 20 个只列
// 最新 20 个并注明总数）。普通人发 `list` 不是指令 —— 不解析、不回话。
//
// 两部分：
//   1) 纯函数矩阵（parseListCommand / listWorkspaceFiles / buildListReport）；
//   2) 端到端（假 OneBot WS + workspaceRoot 指到临时目录）：
//      主人能列、管理员能列、普通人被忽略、目录为空 / 不存在的输出、超过 20 个截断。
//
// 运行：node test-list.mjs
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, buildListReport, formatBytes, listWorkspaceFiles, parseListCommand, LIST_DIR_NAMES } from './index.js'

// ── 最小 WebSocket 服务器（与 test-receive.mjs 同构）──────────────────────────

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
    const accept = createHash('sha1')
      .update(String(req.headers['sec-websocket-key']) + WS_GUID)
      .digest('base64')
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

// ── 测试脚手架（与 test-receive.mjs 同构）──────────────────────────────────────

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
    get: (name) => undefined,
  }
  return { ctx, state }
}

/** 路径转正斜杠 —— 与投递给模型的字面量同一套（slashedPath）。 */
function slashed(p) {
  return String(p ?? '').split(/[\\/]/).join('/')
}

// ══════════════════════════════════════════════════════════════════════════
// 第 1 部分：纯函数
// ══════════════════════════════════════════════════════════════════════════

{
  const p = (t) => parseListCommand(t)
  check('解析：list 算指令（两个都列）', p('list')?.command === 'list' && p('list')?.target === null)
  check('解析：大小写不敏感', p('LIST')?.command === 'list')
  check('解析：首尾空白不敏感', p('  List  ')?.command === 'list')
  check('解析：list dist 只看 dist', p('list dist')?.target === 'dist')
  check('解析：list managehub 只看 managehub', p('list managehub')?.target === 'managehub')
  check('解析：参数大小写不敏感（LIST DIST）', p('LIST DIST')?.target === 'dist')
  check('解析：参数与指令之间空白随便几个', p('list  dist')?.target === 'dist')
  check('解析：参数带尾随空白被 trim', p('list dist ')?.target === 'dist')
  for (const text of [
    'list 一下', // 带正文 → 聊天
    '帮我 list', // 不在开头
    'list dist managehub', // 两个参数 → 不是指令
    'list foo', // 白名单外的目录
    'list receive', // 另一条指令的名字，不能串
    'list .', // 路径注入
    'list ..', // 路径注入
    'list ..\\qq', // 路径注入
    'list?', // 带标点
    'listdist', // 前缀词
    'lists', // 复数
    '', '？', null,
  ]) {
    check(`解析：${JSON.stringify(text)} 不算指令`, p(text) === null)
  }
  check('解析：LIST_DIR_NAMES 就 dist / managehub 两个', LIST_DIR_NAMES.length === 2 && LIST_DIR_NAMES.includes('dist') && LIST_DIR_NAMES.includes('managehub'))
}

{
  const tmp = mkdtempSync(join(tmpdir(), 'qq-bridge-list-pure-'))
  try {
    // 工作区根没配 → 连目录都定不了
    const noRoot = listWorkspaceFiles('', 'dist')
    check('listWorkspaceFiles：根没配 → no-root', noRoot.ok === false && noRoot.reason === 'no-root' && noRoot.files.length === 0)
    // 目录名校验：单段名才认
    check('listWorkspaceFiles：空目录名 → bad-dir', listWorkspaceFiles(tmp, '').reason === 'bad-dir')
    check('listWorkspaceFiles：`.` → bad-dir', listWorkspaceFiles(tmp, '.').reason === 'bad-dir')
    check('listWorkspaceFiles：`..` → bad-dir', listWorkspaceFiles(tmp, '..').reason === 'bad-dir')
    check('listWorkspaceFiles：带分隔符 → bad-dir', listWorkspaceFiles(tmp, 'sub\\dir').reason === 'bad-dir' && listWorkspaceFiles(tmp, 'a/b').reason === 'bad-dir')
    // 目录不存在
    const missing = listWorkspaceFiles(tmp, 'dist')
    check('listWorkspaceFiles：目录不存在 → not-found', missing.ok === false && missing.reason === 'not-found' && missing.dir === join(tmp, 'dist'))
    // 造一个 dist：两个文件 + 一个子目录（子目录不算文件）
    mkdirSync(join(tmp, 'dist'), { recursive: true })
    mkdirSync(join(tmp, 'dist', 'nested'), { recursive: true })
    writeFileSync(join(tmp, 'dist', 'a.zip'), Buffer.from('aa'))
    writeFileSync(join(tmp, 'dist', 'b.zip'), Buffer.from('bbbb'))
    const listed = listWorkspaceFiles(tmp, 'dist')
    check('listWorkspaceFiles：列普通文件（名字 / 大小 / 修改时间）', listed.ok === true && listed.dir === join(tmp, 'dist') && listed.files.length === 2)
    check('listWorkspaceFiles：大小就是字节数', listed.files.some((f) => f.name === 'b.zip' && f.size === 4))
    check('listWorkspaceFiles：修改时间是数字（mtimeMs）', listed.files.every((f) => Number.isFinite(Number(f.at))))
    check('listWorkspaceFiles：子目录不算文件', !listed.files.some((f) => f.name === 'nested'))
    // 空目录
    mkdirSync(join(tmp, 'managehub'), { recursive: true })
    const empty = listWorkspaceFiles(tmp, 'managehub')
    check('listWorkspaceFiles：存在的空目录 → ok 但文件为空', empty.ok === true && empty.files.length === 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

{
  const tmp = mkdtempSync(join(tmpdir(), 'qq-bridge-list-report-'))
  const distDir = join(tmp, 'dist')
  const manageDir = join(tmp, 'managehub')
  try {
    // 工作区根没配 → 整句如实说
    check(
      'buildListReport：根没配 → 如实说用不了',
      buildListReport({ root: '' }).includes('list 用不了') && buildListReport({ root: '' }).includes('工作区根目录'),
    )
    // dist 不存在
    check(
      'buildListReport：目录不存在 → 写明「不存在」',
      buildListReport({ root: tmp, results: [listWorkspaceFiles(tmp, 'dist')] }).includes(`${slashed(distDir)} 不存在。`),
    )
    // 造文件：时间错开，最新在前
    mkdirSync(distDir, { recursive: true })
    const T0 = Date.parse('2026-10-27T15:00:00+08:00')
    const T1 = Date.parse('2026-10-27T23:33:57+08:00')
    const T2 = Date.parse('2026-10-29T21:30:24+08:00')
    for (const [name, body, at] of [
      ['old.zip', 'x'.repeat(100), T0],
      ['mid.zip', 'y'.repeat(2784269), T1],
      ['new.zip', 'z'.repeat(3026817), T2],
    ]) {
      const p = join(distDir, name)
      writeFileSync(p, Buffer.from(body))
      utimesSync(p, at / 1000, at / 1000)
    }
    mkdirSync(manageDir, { recursive: true }) // 空的 managehub
    const both = buildListReport({ root: tmp, target: null, results: [listWorkspaceFiles(tmp, 'dist'), listWorkspaceFiles(tmp, 'managehub')] })
    const blocks = both.split('\n\n')
    check('buildListReport：两个目录两块（空行隔开）', blocks.length === 2, JSON.stringify(both.split('\n')))
    const distBlock = blocks[0]
    const distLines = distBlock.split('\n')
    check('buildListReport：表头写目录全路径与文件数', distLines[0] === `${slashed(distDir)}（3 个文件）：`, distLines[0])
    check('buildListReport：按修改时间从新到旧排', distLines[1].includes('new.zip') && distLines[2].includes('mid.zip') && distLines[3].includes('old.zip'), distLines.slice(1).join(' | '))
    check('buildListReport：每行一个文件（名字 · 大小 · 时间）', /^\d+\. old\.zip · 100B · 2026-10-27 15:00$/.test(distLines[3]), distLines[3])
    check('buildListReport：大小走 formatBytes', distLines[1].includes(formatBytes(3026817)))
    check('buildListReport：空目录那块写「是空的」', blocks[1] === `${slashed(manageDir)} 是空的。`, blocks[1])
    // 只看一个
    const onlyManage = buildListReport({ root: tmp, target: 'managehub', results: [listWorkspaceFiles(tmp, 'managehub')] })
    check('buildListReport：单个目标只列那一块', onlyManage === `${slashed(manageDir)} 是空的。` && !onlyManage.includes('dist'))
    // 超过 20 个 → 只列最新 20 个 + 注明总数
    mkdirSync(join(tmp, 'many'), { recursive: true })
    for (let i = 0; i < 25; i++) {
      const p = join(tmp, 'many', `f-${String(i).padStart(2, '0')}.bin`)
      writeFileSync(p, Buffer.from(String(i)))
      const at = T0 + i * 1000 // 越新越大
      utimesSync(p, at / 1000, at / 1000)
    }
    const many = buildListReport({ root: tmp, target: 'many', results: [listWorkspaceFiles(tmp, 'many')] })
    const manyLines = many.split('\n')
    check('buildListReport：超过 20 个 → 表头注明总数', manyLines[0] === `${slashed(join(tmp, 'many'))}（共 25 个文件，只列最近 20 个）：`, manyLines[0])
    check('buildListReport：超过 20 个 → 正好 20 行文件', manyLines.filter((l) => /^\d+\. /.test(l)).length === 20, `实际 ${manyLines.filter((l) => /^\d+\. /.test(l)).length}`)
    check('buildListReport：列的是最新 20 个（f-24 在第一条）', manyLines[1].includes('f-24.bin') && !many.includes('f-00.bin'), manyLines[1])
    check('buildListReport：恰好 20 个 → 不截断、不写「只列」', (() => {
      const r = buildListReport({ root: tmp, target: 'many', results: [{ ok: true, dir: join(tmp, 'many'), name: 'many', files: Array.from({ length: 20 }, (_, i) => ({ name: `g-${i}`, size: 1, at: i })) }] })
      return r.includes('（20 个文件）：') && r.split('\n').filter((l) => /^\d+\. /.test(l)).length === 20 && !r.includes('只列')
    })())
    // results 为空 / 形状不对也不炸
    check('buildListReport：空 results → 空串', buildListReport({ root: tmp, results: [] }) === '')
    check('buildListReport：unreadable → 如实说列不出来', buildListReport({ root: tmp, results: [{ ok: false, reason: 'unreadable', dir: distDir, name: 'dist', files: [] }] }).includes('读不了'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 第 2 部分：端到端（假 OneBot WS + 临时 workspaceRoot）
// ══════════════════════════════════════════════════════════════════════════

const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-list-'))
const workspaceRoot = dir // dist / managehub 都挂在 <工作区>/ 下
const distDir = join(workspaceRoot, 'dist')
const manageDir = join(workspaceRoot, 'managehub')
const statePath = join(dir, 'state.json')

// 预置：dist 两个文件（时间错开），managehub 存在但为空
mkdirSync(distDir, { recursive: true })
mkdirSync(manageDir, { recursive: true })
const T_OLD = Date.parse('2026-10-27T15:00:00+08:00')
const T_NEW = Date.parse('2026-10-29T21:30:24+08:00')
for (const [name, body, at] of [
  ['old.zip', 'x'.repeat(100), T_OLD],
  ['new.zip', 'z'.repeat(3000), T_NEW],
]) {
  const p = join(distDir, name)
  writeFileSync(p, Buffer.from(body))
  utimesSync(p, at / 1000, at / 1000)
}

const mock = createMockOneBot()
const port = await mock.listen()

const { ctx, state } = createFakeCtx()
apply(ctx, {
  targetSessionId: 'session-target',
  agentPreset: '',
  statePath,
  debugTools: true,
  onebotUrl: `ws://127.0.0.1:${port}`,
  accessTokenEnv: '',
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

/** 收到的 send_private_msg 里，目的地是 userId 的最新一条的文本；没有就 null。 */
const bridgeReplyTo = (userId) => {
  const sent = [...mock.actions]
    .reverse()
    .find((a) => a.action === 'send_private_msg' && String(a.params?.user_id ?? '') === String(userId))
  return sent ? String(sent.params?.message?.[0]?.data?.text ?? '') : null
}

const privateMsg = (userId, nickname, text, messageId) => ({
  post_type: 'message',
  message_type: 'private',
  user_id: userId,
  self_id: 10001,
  message_id: messageId,
  sender: { nickname },
  raw_message: text,
  message: [{ type: 'text', data: { text } }],
})

/** 发一条私聊指令，等桥接层直发回执；返回回执文本（没等到就 null）。 */
const fireList = async (userId, nickname, text, messageId) => {
  const before = mock.actions.filter((a) => a.action === 'send_private_msg' && String(a.params?.user_id ?? '') === String(userId)).length
  mock.sendEvent(privateMsg(userId, nickname, text, messageId))
  const arrived = await waitFor(
    () => mock.actions.filter((a) => a.action === 'send_private_msg' && String(a.params?.user_id ?? '') === String(userId)).length === before + 1,
  )
  return arrived ? bridgeReplyTo(userId) : null
}

// 1) 主人发 list → 两个目录都列，不叫模型
{
  const repliesBefore = state.followups.length
  const text = await fireList(1001, '主人', 'list', 601)
  check('主人发 list → 桥接层直发一句（不叫模型）', text !== null, text ?? '未收到')
  check(
    '主人收到回执：dist 那块带路径与文件数',
    text !== null && text.includes(`${slashed(distDir)}（2 个文件）：`),
    text ?? '未收到',
  )
  check(
    '主人收到回执：每行一个文件（名字 / 大小 / 时间），新的在前',
    text !== null && text.split('\n').some((l) => /^1\. new\.zip · 2\.9KB · 2026-10-29 21:30$/.test(l)) && text.split('\n').some((l) => /^2\. old\.zip · 100B · 2026-10-27 15:00$/.test(l)),
    text ?? '未收到',
  )
  check('主人收到回执：managehub 那块写明是空的', text !== null && text.includes(`${slashed(manageDir)} 是空的。`), text ?? '未收到')
  const st = JSON.parse(await statusTool.execute({}))
  check('list 回执记进 outbox（via=list）', Array.isArray(st.recentOutbox) && st.recentOutbox.some((o) => o?.via === 'list'), JSON.stringify(st.recentOutbox?.slice(-1)))
  await sleep(300)
  check('list 没有唤醒模型（没有新注入）', state.followups.length === repliesBefore)
}

// 2) 主人发 list dist → 只列 dist
{
  const text = await fireList(1001, '主人', 'list dist', 602)
  check(
    '主人发 list dist → 只列 dist 那块',
    text !== null && text.includes(slashed(distDir)) && !text.includes(slashed(manageDir)) && !text.includes('managehub'),
    text ?? '未收到',
  )
}

// 3) 管理员发 list → 也能用
{
  const text = await fireList(1002, '管理员', 'list managehub', 603)
  check('管理员发 list managehub → 同样收到回执', text !== null)
  check('管理员的回执内容一样（写明是空的，不是空话）', text !== null && text.includes(`${slashed(manageDir)} 是空的。`), text ?? '未收到')
}

// 4) 普通人发 list → 忽略：不回话、不解析，按普通聊天处理
{
  const sentBefore = mock.actions.filter((a) => a.action === 'send_private_msg').length
  const stBefore = JSON.parse(await statusTool.execute({}))
  const bufferedBefore = stBefore.bufferedUnwoken ?? 0
  const listOutboxBefore = (stBefore.recentOutbox ?? []).filter((o) => o?.via === 'list').length
  mock.sendEvent(privateMsg(1003, '路人', 'list', 604))
  await sleep(500)
  check('普通人发 list → 没有任何回话', mock.actions.filter((a) => a.action === 'send_private_msg').length === sentBefore, JSON.stringify(mock.actions.slice(-1)))
  const buffered = await waitFor(async () => {
    const st = JSON.parse(await statusTool.execute({}))
    return (st.bufferedUnwoken ?? 0) > bufferedBefore
  })
  check('普通人发 list → 当普通聊天处理（进了缓冲，不是指令）', buffered)
  const st = JSON.parse(await statusTool.execute({}))
  check(
    '普通人发 list → outbox 里没有新的 list 记录',
    (st.recentOutbox ?? []).filter((o) => o?.via === 'list').length === listOutboxBefore,
    JSON.stringify(st.recentOutbox?.slice(-2)),
  )
}

// 5) 目录不存在 → 回执如实说
{
  rmSync(distDir, { recursive: true, force: true })
  const text = await fireList(1001, '主人', 'list dist', 605)
  check('目录不存在 → 回执写「不存在」', text !== null && text.includes(`${slashed(distDir)} 不存在。`), text ?? '未收到')
  const both = await fireList(1001, '主人', 'list', 606)
  check('list（不带参数）→ dist 不存在 + managehub 是空的，两块都在', both !== null && both.includes('不存在。') && both.includes('是空的。'), both ?? '未收到')
}

// 6) 超过 20 个文件 → 只列最新 20 个，表头注明总数
{
  mkdirSync(distDir, { recursive: true })
  const base = T_OLD
  for (let i = 0; i < 25; i++) {
    const p = join(distDir, `f-${String(i).padStart(2, '0')}.bin`)
    writeFileSync(p, Buffer.from(String(i)))
    const at = base + i * 1000 // 越新越大
    utimesSync(p, at / 1000, at / 1000)
  }
  const text = await fireList(1001, '主人', 'list dist', 607)
  const lines = text === null ? [] : text.split('\n')
  check('超过 20 个 → 表头注明总数与截断', text !== null && lines[0] === `${slashed(distDir)}（共 25 个文件，只列最近 20 个）：`, text ?? '未收到')
  check('超过 20 个 → 正好 20 行文件', lines.filter((l) => /^\d+\. /.test(l)).length === 20, `实际 ${lines.filter((l) => /^\d+\. /.test(l)).length}`)
  check('超过 20 个 → 列的是最新 20 个（f-24 第一、f-00 没了）', lines[1].includes('f-24.bin') && !text.includes('f-00.bin'), text ?? '未收到')
}

// 7) 卸载：传输必须干净停掉
for (const d of state.disposers) await d()
check('dispose 后连接已关闭', await waitFor(() => mock.connected === false, 2000))
await mock.close()
rmSync(dir, { recursive: true, force: true })

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (failed > 0) process.exitCode = 1
