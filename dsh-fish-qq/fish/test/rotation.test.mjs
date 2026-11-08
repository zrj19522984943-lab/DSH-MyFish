/**
 * rotation.test.mjs —— 「聊满 N 轮换新会话」对 QQ 也成立（2026-11-02）
 *
 * 这一组守的是这次升级的核心：
 *   1. QQ 轮会被计数（history-logger → rotation → bumpTurns）；
 *   2. 到点后**先摘要、再换房**：home.json 里新 sessionId 与 handoff 同时落地；
 *   3. 提要失败（没 key / 模型坏）也不拦轮换，退回 talkmem 原话续接（carry）；
 *   4. 非 QQ 轮（侧栏/设置页说话）不在这里重复计数——say.js 已经数过；
 *   5. 老会话只改名留档，不删。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerHistoryLogger } from '../lib/history-logger.js'
import { createRotationHandler } from '../lib/rotation.js'
import { activeHandoffBlockSync, waitHandoffReady } from '../lib/home.js'

const OLD_ID = 'session-aaaaaaaa-1111-1111-1111-111111111111'
const NEW_ID = 'session-bbbbbbbb-2222-2222-2222-222222222222'

function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-rotate-'))
  mkdirSync(join(root, 'home'), { recursive: true })
  return root
}

function writeHome(root, patch = {}) {
  writeFileSync(
    join(root, 'home.json'),
    JSON.stringify(
      {
        wsId: 'ws-1',
        sessionId: OLD_ID,
        title: '跟大肥鱼说话',
        createdAt: new Date().toISOString(),
        turns: 2,
        ...patch,
      },
      null,
      2,
    ),
    'utf8',
  )
}

function writeConfig(root, chat = {}) {
  writeFileSync(join(root, 'config.json'), JSON.stringify({ chat: { rotateAfter: 3, ...chat } }, null, 2), 'utf8')
}

function writeRaw(root, rows) {
  mkdirSync(join(root, 'memory'), { recursive: true })
  const lines = rows.map((r, i) =>
    JSON.stringify({ seq_id: i + 1, ts: new Date(Date.now() - (rows.length - i) * 1000).toISOString(), role: r.role, text: r.text }),
  )
  writeFileSync(join(root, 'memory', 'raw_2026-11-02.jsonl'), `${lines.join('\n')}\n`, 'utf8')
}

function readHome(root) {
  return JSON.parse(readFileSync(join(root, 'home.json'), 'utf8'))
}

function makeCtx({ llm = null } = {}) {
  const listeners = new Map()
  const created = []
  const renamed = []
  const ctx = {
    on(type, fn) {
      listeners.set(type, fn)
      return () => listeners.delete(type)
    },
    emit(type, session, event) {
      listeners.get(type)?.(session, event)
    },
    // 宿主 llm：这一版摘要**只**走这条路（不再有外部 HTTP）
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel' && llm) {
        return { currentSelection: () => ({ provider: 'demo', model: 'flash' }) }
      }
      return undefined
    },
    sessionController: {
      async create(args) {
        created.push(args)
        return { sessionId: args?.sessionId ?? NEW_ID }
      },
      async rename(args) {
        renamed.push(args)
        return { ok: true }
      },
      async list() {
        return { items: [{ sessionId: NEW_ID, blank: false }] }
      },
    },
  }
  return { ctx, created, renamed }
}

/** 假宿主 llm：延迟 delayMs 后给一段提要（用于观察 handoffPending 占位）。 */
function makeFakeLlm({ text = '你们对了暗号（香蕉）。', delayMs = 0, hang = false } = {}) {
  return {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
    },
    stream() {
      return (async function* () {
        if (hang) {
          await new Promise(() => {})
          return
        }
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function inboundTurn() {
  return [
    {
      type: 'turn/start',
      data: { turn: 1 },
    },
    {
      type: 'user/message',
      data: {
        turn: 1,
        message: {
          content: [{ type: 'text', text: '[QQ · 私聊] 244：在吗' }],
          source: { kind: 'plugin', plugin: 'dsh-fish-qq' },
        },
      },
    },
    {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '在。' }] } },
    },
    { type: 'turn/end', data: { turn: 1 } },
  ]
}

function sayTurn() {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: {
        turn: 1,
        message: {
          content: [{ type: 'text', text: '## 这次\n\n## 他跟你说话了\n\n你好呀' }],
          source: { kind: 'user' },
        },
      },
    },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '嗯。' }] } } },
    { type: 'turn/end', data: { turn: 1 } },
  ]
}

async function waitFor(fn, timeoutMs = 4000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function harness(root, { llm = null } = {}) {
  const { ctx, created, renamed } = makeCtx({ llm })
  const handler = createRotationHandler(ctx, { root, wake: false, log: () => {} })
  const off = registerHistoryLogger(ctx, { root, herDir: join(root, 'home'), onTurn: handler.onTurn })
  const session = { header: { id: OLD_ID, cwd: join(root, 'home') } }
  return { ctx, created, renamed, handler, off, session }
}

/**
 * 把 DSH_HOME 指到临时目录，避免读到机器上真实的设置文件。
 * （这一版已经不再读任何外部 key，但隔离仍能让测试与环境解耦。）
 */
function isolateHome(root) {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = root
  return () => {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
}

test('QQ 轮会计数：第 3 轮触发换房，home.json 换 id、turns 归零、原话进 carry', async () => {
  const root = tmpRoot()
  const restore = isolateHome(root)
  try {
    writeHome(root, { turns: 2 })
    writeConfig(root)
    writeRaw(root, [
      { role: 'user', text: '在吗' },
      { role: 'assistant', text: '在。' },
    ])
    const { ctx, created, renamed, session } = harness(root)

    for (const ev of inboundTurn()) ctx.emit('session/event', session, ev)

    const home = await waitFor(async () => {
      const h = readHome(root)
      return h.sessionId === NEW_ID ? h : null
    })
    assert.equal(home.turns, 0)
    assert.equal(home.rotatedFrom, OLD_ID)
    assert.ok(String(home.carry).includes('在吗'), `carry 应带上刚才那句原话：${home.carry}`)
    // 老会话只改名留档
    assert.ok(renamed.some((r) => r.sessionId === OLD_ID && /之前/.test(r.title)))
    // 新会话建在同一个工作区里
    assert.ok(created.some((c) => c.workspaceId === 'ws-1'))
  } finally { restore(); rmSync(root, { recursive: true, force: true }) }
})

test('非 QQ 轮不在这里重复计数（say.js 那条链自己数）', async () => {
  const root = tmpRoot()
  const restore = isolateHome(root)
  try {
    writeHome(root, { turns: 2 })
    writeConfig(root)
    writeRaw(root, [{ role: 'user', text: '你好呀' }])
    const { ctx, session } = harness(root)

    for (const ev of sayTurn()) ctx.emit('session/event', session, ev)
    await new Promise((r) => setTimeout(r, 120))

    const home = readHome(root)
    assert.equal(home.sessionId, OLD_ID, '没到阈值不该换')
    assert.equal(home.turns, 2, '侧栏/设置页的轮次不该被 QQ 侧再数一遍')
  } finally { restore(); rmSync(root, { recursive: true, force: true }) }
})

test('提要成功：先换房占位，宿主 llm 出提要后落盘，系统段与可读副本都在', async () => {
  const root = tmpRoot()
  const restore = isolateHome(root)
  try {
    writeHome(root, { turns: 2 })
    writeConfig(root)
    writeRaw(root, [
      { role: 'user', text: '暗号是什么' },
      { role: 'assistant', text: '香蕉' },
    ])

    // 假宿主 llm 慢 300ms：正好观察「先占位、后落盘」
    const { ctx, session } = harness(root, { llm: makeFakeLlm({ delayMs: 300 }) })
    for (const ev of inboundTurn()) ctx.emit('session/event', session, ev)

    // 1) 先换房：sessionId 立刻变，提要还挂着「生成中」的占位
    const flipped = await waitFor(async () => {
      const h = readHome(root)
      return h.sessionId === NEW_ID ? h : null
    })
    assert.equal(flipped.handoffPending, true, '换房后先占位，提要慢慢生成')
    assert.equal(flipped.handoff, '')

    // 2) 下一条消息的闸门会等它（waitHandoffReady，最多 12 秒）
    const started = Date.now()
    const ready = await waitHandoffReady(root, { sessionId: NEW_ID, timeoutMs: 5_000, pollMs: 50 })
    assert.equal(ready, true)
    assert.ok(Date.now() - started >= 100, '应该真的等了一会儿，而不是直接放行')

    const home = readHome(root)
    assert.equal(home.handoff, '你们对了暗号（香蕉）')
    assert.equal(home.handoffPending, false)
    assert.equal(home.handoffSource, 'host:demo/flash')
    assert.ok(existsSync(join(root, 'home', 'handoff.md')), '要留一份可读副本，方便校验')

    const block = activeHandoffBlockSync(root)
    assert.ok(block.includes('你们对了暗号（香蕉）'), block)
    assert.ok(block.startsWith('[系统：你刚刚搬到了新房间'), block)
  } finally {
    restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('宿主 llm 不可用也不拦轮换：占位必须变成 false，并写最近 4 轮原话兜底', async () => {
  const root = tmpRoot()
  const restore = isolateHome(root)
  try {
    writeHome(root, { turns: 2 })
    writeConfig(root)
    writeRaw(root, [
      { role: 'user', text: '在吗' },
      { role: 'assistant', text: '在。' },
    ])
    const { ctx, session } = harness(root) // 没有 llm 服务
    for (const ev of inboundTurn()) ctx.emit('session/event', session, ev)

    const home = await waitFor(async () => {
      const h = readHome(root)
      return h.sessionId === NEW_ID && h.handoffPending === false ? h : null
    })
    assert.ok(home.handoff.length > 0, '失败也要有兜底提要，绝不空着')
    assert.ok(home.handoff.includes('在吗'), `兜底应是最近原话：${home.handoff}`)
    assert.equal(home.handoffSource, 'fallback:recent')
    assert.ok(String(home.handoffError).length > 0, '失败原因要落盘，事后查得到')
    // 系统段照样有内容（不是空段）
    assert.ok(activeHandoffBlockSync(root).includes('在吗'))
  } finally {
    restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('陈旧占位（30 秒前、一直没放掉）→ waitHandoffReady 立即放行并把标志写回 false', async () => {
  const root = tmpRoot()
  try {
    writeHome(root, {
      turns: 0,
      handoff: '',
      handoffPending: true,
      rotatedAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const started = Date.now()
    const ok = await waitHandoffReady(root, { sessionId: OLD_ID, timeoutMs: 5_000, pollMs: 50 })
    assert.equal(ok, true)
    assert.ok(Date.now() - started < 1_000, '陈旧占位不该再等')
    assert.equal(readHome(root).handoffPending, false, '顺手把陈旧标志写回 false')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rotateAfter=0 时永不换房（关掉开关的行为和以前一致）', async () => {
  const root = tmpRoot()
  const restore = isolateHome(root)
  try {
    writeHome(root, { turns: 99 })
    writeFileSync(join(root, 'config.json'), JSON.stringify({ chat: { rotateAfter: 0 } }), 'utf8')
    writeRaw(root, [{ role: 'user', text: '在吗' }])
    const { ctx, session } = harness(root)
    for (const ev of inboundTurn()) ctx.emit('session/event', session, ev)
    await new Promise((r) => setTimeout(r, 150))
    const home = readHome(root)
    assert.equal(home.sessionId, OLD_ID)
    assert.equal(home.turns, 100, '计数照走，只是不换')
  } finally { restore(); rmSync(root, { recursive: true, force: true }) }
})
