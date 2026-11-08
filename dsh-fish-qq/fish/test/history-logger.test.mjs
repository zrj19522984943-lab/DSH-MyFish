/**
 * history-logger.test.mjs —— 底层对话持久化的守门（2026-11-02）
 *
 * 这一层一旦写错，后面两个检索工具全是空转。测试盯五件事：
 *   1. 一轮两行：user / assistant 各一行，seq_id 连号，文件按天分；
 *   2. 单条 2000 字截断，空文本不占行；
 *   3. seq 在「seq.json 丢了」之后仍能从旧档接上，不会从头重号；
 *   4. 宿主事件接入只记**她的会话**，并剥掉 runtime context / say 包装 / 唤醒触发语；
 *   5. QQ 入站的真人原话必须原样留下（不能把 `[QQ · 昵称]` 当成包装洗掉）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_TEXT_CHARS,
  cleanAssistantText,
  cleanUserText,
  dayKeyOf,
  maxSeqOnDisk,
  memoryDir,
  rawFileFor,
  recordTurn,
  registerHistoryLogger,
  seqFileFor,
  sessionIsHers,
} from '../lib/history-logger.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-history-'))
}

function readLines(root, day) {
  const file = rawFileFor(root, day)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => {
      try { return [JSON.parse(s)] } catch { return [] } // 坏行跳过（与生产端一致）
    })
}

/** 等一个异步落盘（recordTurn 是 fire-and-forget）。 */
async function waitFor(fn, timeoutMs = 2000) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('recordTurn：一轮写成 user/assistant 两行，seq_id 连号，按天分文件', async () => {
  const root = tmpRoot()
  try {
    const when = new Date(2026, 10, 3, 21, 0, 0) // 本地 2026-11-03 21:00
    const r = await recordTurn('我们的暗号是香蕉', '香蕉，记住了。', when, root)
    assert.deepEqual(r.seq_ids, [1, 2])
    assert.equal(r.file, rawFileFor(root, '2026-11-03'))

    const rows = readLines(root, '2026-11-03')
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((x) => x.role), ['user', 'assistant'])
    assert.deepEqual(rows.map((x) => x.seq_id), [1, 2])
    assert.equal(rows[0].text, '我们的暗号是香蕉')
    assert.equal(rows[1].text, '香蕉，记住了。')
    assert.equal(rows[0].ts, when.toISOString())
    assert.ok(!Number.isNaN(Date.parse(rows[0].ts)), 'ts 必须是可解析的 ISO 时间')
    // 只有 spec 要求的四个字段
    assert.deepEqual(Object.keys(rows[0]).sort(), ['role', 'seq_id', 'text', 'ts'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('recordTurn：空文本不占行；单条超 2000 字截断', async () => {
  const root = tmpRoot()
  try {
    const when = new Date(2026, 10, 3, 22, 0, 0)
    const long = '字'.repeat(MAX_TEXT_CHARS + 500)
    const r = await recordTurn('', long, when, root)
    assert.equal(r.seq_ids.length, 1)
    const rows = readLines(root, '2026-11-03')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, 'assistant')
    assert.equal(rows[0].text.length, MAX_TEXT_CHARS)
    assert.ok(rows[0].text.endsWith('…'), '截断要有省略号')

    const r2 = await recordTurn('   ', '\n\n', when, root)
    assert.deepEqual(r2.seq_ids, [], '两边都空就不写')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('recordTurn：并发写不会抢到同一个门牌号', async () => {
  const root = tmpRoot()
  try {
    const when = new Date(2026, 10, 3, 20, 0, 0)
    // 不 await，模拟两轮几乎同时结束
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => recordTurn(`第${i}句`, '', when, root)),
    )
    const ids = results.flatMap((r) => r.seq_ids)
    assert.equal(ids.length, 20)
    assert.equal(new Set(ids).size, 20, '门牌号不能重复')
    assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1))
    assert.equal(readLines(root, '2026-11-03').length, 20)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('seq：seq.json 丢了也能从旧档接上，不重号', async () => {
  const root = tmpRoot()
  try {
    const when = new Date(2026, 10, 3, 23, 0, 0)
    await recordTurn('第一句', '第二句', when, root)
    assert.equal((await maxSeqOnDisk(root)), 2)
    // 模拟 seq.json 被删 / 换机器恢复
    await fs.rm(seqFileFor(root), { force: true })
    const r = await recordTurn('第三句', '', when, root)
    assert.deepEqual(r.seq_ids, [3], '必须接着 2，不能从 1 重来')
    assert.equal((await maxSeqOnDisk(root)), 3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('recordTurn：上次崩在半行时先补换行，新记录不跟着坏', async () => {
  const root = tmpRoot()
  try {
    const when = new Date(2026, 10, 3, 23, 30, 0)
    const file = rawFileFor(root, '2026-11-03')
    // 造一个没有结尾换行的半行（模拟写到一半断电）
    await fs.mkdir(memoryDir(root), { recursive: true })
    writeFileSync(file, '{"seq_id":1,"ts":"2026-11-03T15:00:00.000Z","role":"user","text":"半行', 'utf8')

    const r = await recordTurn('新一句', '', when, root)
    assert.deepEqual(r.seq_ids, [1])
    const rows = readLines(root, '2026-11-03')
    assert.equal(rows.length, 1, '坏行被跳过，新行完整')
    assert.equal(rows[0].text, '新一句')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dayKeyOf：按本地日历分天', () => {
  assert.equal(dayKeyOf(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01')
  assert.equal(dayKeyOf(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31')
})

test('cleanUserText：剥掉宿主 context / say 包装 / 唤醒触发语', () => {
  assert.equal(cleanUserText('Current runtime context\n…很长…'), '')
  assert.equal(cleanUserText('<system-reminder>别听</system-reminder>\n你好'), '你好')
  assert.equal(cleanUserText('（醒一醒）'), '')
  const wrapped = [
    '## 这次',
    '',
    '## 他跟你说话了',
    '',
    '我们的暗号是香蕉',
    '',
    '（你想回就回。可以用 growth_commit 把你想说的留下来；不想说也可以不说。）',
  ].join('\n')
  assert.equal(cleanUserText(wrapped), '我们的暗号是香蕉')
})

test('cleanUserText：QQ 入站的真人原话原样保留', () => {
  const qq = '[QQ · 小明] 我们的暗号是香蕉'
  assert.equal(cleanUserText(qq), qq)
})

test('cleanAssistantText：去掉出站协议标记，保留原话', () => {
  assert.equal(cleanAssistantText('[QQ]\n香蕉，记住了。\n[/QQ]'), '香蕉，记住了。')
  assert.equal(cleanAssistantText('[IDLE]'), '')
})

test('sessionIsHers：只认 cwd 等于她屋子的会话', () => {
  const her = join(tmpdir(), 'dsh-fish-her')
  assert.equal(sessionIsHers({ header: { cwd: her } }, her), true)
  assert.equal(sessionIsHers({ header: { cwd: join(tmpdir(), 'somewhere-else') } }, her), false)
  assert.equal(sessionIsHers({}, her), false)
  assert.equal(sessionIsHers({ header: { cwd: her } }, ''), false, '没给屋子就不猜')
})

test('registerHistoryLogger：turn/end 落盘，非她的会话不记', async () => {
  const root = tmpRoot()
  const herDir = join(root, 'home')
  await fs.mkdir(herDir, { recursive: true })
  const handlers = new Map()
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn)
      return () => handlers.delete(name)
    },
  }
  const off = registerHistoryLogger(ctx, { root, herDir })
  try {
    // 她的 agent：登记会话 id（cwd 判据的第二道保险）
    handlers.get('agent/created')?.({ agent: { session: { header: { id: 's-her', cwd: herDir } } } })
    const herSession = { header: { id: 's-her', cwd: herDir } }
    const emit = (s, e) => handlers.get('session/event')?.(s, e)

    emit(herSession, { type: 'turn/start', data: { turn: 1 } })
    emit(herSession, {
      type: 'user/message',
      data: {
        message: {
          id: 'm1',
          source: { kind: 'user' },
          content: [{ type: 'text', text: '我们的暗号是香蕉' }],
        },
      },
    })
    // 宿主的 runtime context 也被塞进同一轮：不能进记忆
    emit(herSession, {
      type: 'user/message',
      data: {
        message: {
          id: 'm2',
          source: { kind: 'plugin:@deepseek-ai/dsh-system-prompt' },
          content: [{ type: 'text', text: 'Current runtime context\n今天很热' }],
        },
      },
    })
    // 工具结果不是对话：不能进记忆
    emit(herSession, {
      type: 'user/message',
      data: {
        message: {
          id: 'm3',
          source: { kind: 'tool' },
          content: [{ type: 'text', text: '{"type":"tool_result","content":"一大坨 JSON"}' }],
        },
      },
    })
    emit(herSession, {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: '香蕉，记住了。' }] } },
    })

    // 另一个会话（用户自己的窗口）：同样的形状，但 cwd 不是她的屋子
    const otherSession = { header: { id: 's-other', cwd: root } }
    emit(otherSession, { type: 'turn/start', data: { turn: 1 } })
    emit(otherSession, {
      type: 'user/message',
      data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '不该被记住的话' }] } },
    })

    emit(herSession, {
      type: 'turn/end',
      time: '2026-11-03T13:00:05.000Z',
      data: { reason: { kind: 'ok' } },
    })
    emit(otherSession, {
      type: 'turn/end',
      time: '2026-11-03T13:00:06.000Z',
      data: { reason: { kind: 'ok' } },
    })

    const ok = await waitFor(() => readLines(root, dayKeyOf(new Date('2026-11-03T13:00:05.000Z'))).length >= 2)
    assert.equal(ok, true, 'turn/end 之后应落盘')
    const rows = readLines(root, dayKeyOf(new Date('2026-11-03T13:00:05.000Z')))
    assert.equal(rows.length, 2, '只记她的那一轮')
    assert.equal(rows[0].text, '我们的暗号是香蕉')
    assert.equal(rows[1].text, '香蕉，记住了。')
    assert.ok(!rows.some((x) => x.text.includes('不该被记住')), '别的会话不能进记忆')
    assert.ok(!rows.some((x) => x.text.includes('今天很热')), 'runtime context 不能进记忆')
    assert.ok(!rows.some((x) => x.text.includes('一大坨 JSON')), '工具结果不能进记忆')
  } finally {
    off()
    rmSync(root, { recursive: true, force: true })
  }
})

test('registerHistoryLogger：turn/end 后草稿清空，不会把上一轮抄进下一轮', async () => {
  const root = tmpRoot()
  const herDir = join(root, 'home')
  await fs.mkdir(herDir, { recursive: true })
  const handlers = new Map()
  const ctx = { on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) } }
  const off = registerHistoryLogger(ctx, { root, herDir })
  try {
    const s = { header: { id: 's1', cwd: herDir } }
    const emit = (e) => handlers.get('session/event')?.(s, e)
    emit({ type: 'turn/start', data: { turn: 1 } })
    emit({ type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮' }] } } })
    emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一答' }] } } })
    emit({ type: 'turn/end', time: '2026-11-03T13:00:00.000Z', data: {} })

    emit({ type: 'turn/start', data: { turn: 2 } })
    emit({ type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮' }] } } })
    emit({ type: 'turn/end', time: '2026-11-03T13:01:00.000Z', data: {} })

    const day = dayKeyOf(new Date('2026-11-03T13:00:00.000Z'))
    const ok = await waitFor(() => readLines(root, day).length >= 3)
    assert.equal(ok, true)
    const rows = readLines(root, day)
    assert.deepEqual(rows.map((x) => x.text), ['第一轮', '第一答', '第二轮'])
    assert.ok(!rows.some((x) => x.text === '第一答' && x.seq_id > 2), '上一轮不能重复')
  } finally {
    off()
    rmSync(root, { recursive: true, force: true })
  }
})
