/**
 * checklog.test.mjs —— 任务完成日志（CheckLogs/，2026-10-27）
 *
 * 用户的要求很具体：派任务之后，任务**完成**时在 CheckLogs 里生成一个日志文件。
 * 所以测试盯三件事：
 *   1. 「完成」判据 = 那条会话的 turn/end，别的会话 / 别的事件都不算；
 *   2. 成功、失败、中止、超时都各有一行能看懂的结果；
 *   3. 文件真的落到磁盘上，内容不抄她的回复正文。
 *   4.（任务书 4）写成之后才往事件总线喊 `checklog/finished`，写失败不喊。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describeTurnEnd,
  formatTime,
  humanDuration,
  renderTaskLog,
  writeTaskLog,
  writeTaskLogAndAnnounce,
  buildTaskResult,
  CHECKLOG_FINISHED_EVENT,
  createTaskWatcher,
  defaultCheckLogsDir,
} from '../lib/checklog.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('describeTurnEnd：宿主的几种结束原因都有中文说法', () => {
  assert.equal(describeTurnEnd('completed').status, '成功')
  assert.equal(describeTurnEnd('completed').ok, true)
  for (const kind of ['max-tokens', 'aborted', 'interrupted', 'blocked', 'error', 'timeout']) {
    const r = describeTurnEnd(kind)
    assert.equal(r.ok, false, `${kind} 不该算成功`)
    assert.ok(r.status.length > 0)
  }
  assert.match(describeTurnEnd('something-new').status, /something-new/)
})

test('humanDuration：秒 / 分 / 小时都说人话', () => {
  assert.equal(humanDuration(42_000), '42 秒')
  assert.equal(humanDuration(149_000), '2 分 29 秒')
  assert.equal(humanDuration(120_000), '2 分')
  assert.equal(humanDuration(3_600_000), '1 小时')
  assert.equal(humanDuration(3_780_000), '1 小时 3 分')
})

test('formatTime：本地时间、补零', () => {
  const t = new Date(2026, 9, 27, 23, 6, 5).getTime()
  assert.equal(formatTime(t), '2026-10-27 23:06:05')
})

test('renderTaskLog：任务 / 时间 / 结果齐全，没有回复正文', () => {
  const started = new Date(2026, 9, 27, 23, 12, 1).getTime()
  const ended = started + 149_000
  const text = renderTaskLog({
    task: '帮我写个 hello.py',
    title: '工作·帮我写个 hello.py',
    sessionId: 'session-abc',
    startedAt: started,
    endedAt: ended,
    status: '成功',
    note: '',
  })
  assert.match(text, /# 任务完成日志/)
  assert.match(text, /- 结果：成功/)
  assert.match(text, /- 任务：帮我写个 hello.py/)
  assert.match(text, /- 派发时间：2026-10-27 23:12:01/)
  assert.match(text, /- 结束时间：2026-10-27 23:14:30/)
  assert.match(text, /- 耗时：2 分 29 秒/)
  assert.match(text, /session-abc/)
  assert.ok(!text.includes('她说'), '日志不抄她的回复')
})

test('writeTaskLog：真的落一个 .md（一个任务一个文件）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fish-checklog-'))
  try {
    const started = new Date(2026, 9, 27, 23, 12, 1).getTime()
    const file = await writeTaskLog({
      dir,
      task: '跑一遍测试',
      title: '工作·跑一遍测试',
      sessionId: 'session-x',
      startedAt: started,
      endedAt: started + 5_000,
      status: '成功',
      note: '',
    })
    assert.ok(file, '应该返回文件路径')
    assert.equal(existsSync(file), true)
    assert.match(file, /\.md$/)
    const text = readFileSync(file, 'utf8')
    assert.match(text, /跑一遍测试/)
    assert.match(text, /- 结果：成功/)

    const again = await writeTaskLog({
      dir,
      task: '跑一遍测试',
      sessionId: 'session-x',
      startedAt: started,
      endedAt: started + 5_000,
      status: '失败（出错）',
      note: 'error',
    })
    assert.notEqual(again, file, '同一秒同一任务也不能互相覆盖')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('defaultCheckLogsDir：落在包根下的 CheckLogs（可用环境变量改）', () => {
  const dir = defaultCheckLogsDir({})
  assert.match(dir, /CheckLogs$/)
  assert.equal(defaultCheckLogsDir({ DSH_FISH_CHECKLOGS_DIR: 'D:\\logs' }), 'D:\\logs')
})

test('watcher：只认那条会话的 turn/end', async () => {
  const handlers = {}
  const ctx = { on: (name, fn) => { handlers[name] = fn; return () => { delete handlers[name] } } }
  const got = []
  const w = createTaskWatcher(ctx, { sessionId: 'session-want', onDone: (r) => got.push(r) })
  assert.ok(w)

  handlers['session/event']({ id: 'session-other' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(got.length, 0, '别的会话不算')

  handlers['session/event']({ id: 'session-want' }, { type: 'turn/start', data: {} })
  assert.equal(got.length, 0, '开始不算完成')

  handlers['session/event']({ id: 'session-want' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await sleep(0)
  assert.equal(got.length, 1)
  assert.equal(got[0].status, '成功')
  assert.equal(w.done, true)

  // 结束之后再来事件不该重复写
  assert.equal(handlers['session/event'], undefined, '完成后要自己摘掉监听')
  w.cleanup()
})

test('watcher：拿不到事件总线时返回 null，不抛', () => {
  assert.equal(createTaskWatcher({}, { sessionId: 's' }), null)
  assert.equal(createTaskWatcher({ on: () => {} }, { sessionId: '' }), null)
})

test('watcher：卡住不动超时也留一条', async () => {
  const handlers = {}
  const ctx = { on: (name, fn) => { handlers[name] = fn; return () => { delete handlers[name] } } }
  const got = []
  createTaskWatcher(ctx, { sessionId: 'session-slow', timeoutMs: 20, onDone: (r) => got.push(r) })
  await sleep(40)
  assert.equal(got.length, 1)
  assert.match(got[0].status, /超时/)
})

test('buildTaskResult：字段是既有计算的搬运（契约对齐 qq 侧 notifyTaskFinished）', () => {
  const r = buildTaskResult({
    kind: 'error',
    ok: false,
    task: '写个 hello.py',
    title: '工作·写个 hello.py',
    sessionId: 'session-x',
    startedAt: 1000,
    endedAt: 91000,
    status: '失败（出错）',
    file: 'D:/CheckLogs/20261028-120000-abc12345.md',
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'error', 'reason 用宿主 turn/end 的 kind')
  assert.equal(r.task, '写个 hello.py')
  assert.equal(r.sessionTitle, '工作·写个 hello.py')
  assert.equal(r.sessionId, 'session-x')
  assert.equal(r.status, '失败（出错）', 'status 是 describeTurnEnd 的中文状态，qq 侧据它说原因')
  assert.equal(r.startedAt, 1000)
  assert.equal(r.endedAt, 91000)
  assert.equal(r.elapsedMs, 90000, 'elapsedMs 是两个时间之差，不另算')
  assert.equal(r.file, 'D:/CheckLogs/20261028-120000-abc12345.md')
})

test('buildTaskResult：ok 缺省按失败（fail-safe，与 qq 侧同口径）', () => {
  assert.equal(buildTaskResult({ kind: 'completed' }).ok, false)
  assert.equal(buildTaskResult({ kind: 'completed', ok: true }).ok, true)
})

test('writeTaskLogAndAnnounce：写成了才喊，写失败不喊', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fish-checklog-'))
  const emitted = []
  const ctx = { emit: (name, payload) => emitted.push([name, payload]) }
  try {
    const out = await writeTaskLogAndAnnounce(ctx, {
      dir,
      task: '跑一遍测试',
      title: '工作·跑一遍测试',
      sessionId: 'session-x',
      startedAt: 1000,
      endedAt: 91000,
      status: '失败（出错）',
      note: 'error',
      ok: false,
      kind: 'error',
    })
    assert.ok(out.file, '日志先写成')
    assert.equal(out.announced, true)
    assert.equal(emitted.length, 1, '只 emit 一次')
    assert.equal(emitted[0][0], CHECKLOG_FINISHED_EVENT)
    const result = emitted[0][1]
    assert.equal(result.reason, 'error')
    assert.equal(result.ok, false)
    assert.equal(result.status, '失败（出错）', '载荷带上中文状态')
    assert.equal(result.file, out.file, '载荷带上日志路径')
    assert.equal(result.elapsedMs, 90000)

    // 写失败：目录被一个文件占着 → writeTaskLog 返回空串 → 不 emit
    const blocker = join(dir, 'blocker.txt')
    writeFileSync(blocker, 'x')
    const bad = await writeTaskLogAndAnnounce(ctx, {
      dir: blocker,
      task: 'x',
      sessionId: 's',
      startedAt: 1,
      endedAt: 2,
      status: '失败',
      note: '',
      ok: false,
      kind: 'error',
    })
    assert.equal(bad.file, '', '日志没写成')
    assert.equal(bad.announced, false)
    assert.equal(bad.result, null)
    assert.equal(emitted.length, 1, '写失败就不再 emit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeTaskLogAndAnnounce：没有事件总线的宿主上只写日志，不抛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fish-checklog-'))
  try {
    const out = await writeTaskLogAndAnnounce(undefined, {
      dir,
      task: 'x',
      sessionId: 's',
      startedAt: 1,
      endedAt: 2,
      status: '成功',
      note: '',
      ok: true,
      kind: 'completed',
    })
    assert.ok(out.file)
    assert.equal(out.announced, false, '宿主没有 emit，日志照写、事件算了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
