/**
 * worklog.test.mjs —— 派活 → 那一轮结束 → CheckLogs 里出现一个文件（2026-10-27）
 *
 * 单测 checklog.js 只证明「wait 那个函数对」；这里证明**接线也对**：
 *   work.js 在 prompt 之前把监听挂上、prompt 之后不摘，
 *   那一轮的 turn/end 一到，日志就落在指定的目录里。
 *
 * 其中一个用例让 prompt **同步**触发 turn/end —— 如果监听挂晚了一步，这个用例会红。
 *
 * 任务书 4（2026-10-28）：多盯一件事——日志写成之后，`checklog/finished` 事件
 * 真的发出去了，载荷对得上 qq 侧的 notifyTaskFinished；写不出日志时一个事件都没有。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dispatchWork } from '../lib/work.js'

function fakeCtx({ emitOnPrompt = null } = {}) {
  const handlers = {}
  const emitted = []
  const ctx = {
    on: (name, fn) => {
      handlers[name] = fn
      return () => { delete handlers[name] }
    },
    emit: (name, payload) => { emitted.push([name, payload]) },
    get: (name) => {
      if (name === 'workspaceRegistry') {
        return {
          list: () => [],
          create: async () => ({ id: 'ws-test' }),
        }
      }
      return undefined
    },
    sessionController: {
      create: async () => ({ sessionId: 'session-task' }),
      rename: async () => {},
      prompt: async () => {
        // 故意在 prompt 里同步把这一轮结束掉：监听必须在这之前就绪。
        if (emitOnPrompt) emitOnPrompt(handlers)
      },
    },
  }
  return { ctx, handlers, emitted }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('派活成功 → turn/end 后写出日志（成功）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-work-'))
  const logs = mkdtempSync(join(tmpdir(), 'dsh-fish-checklogs-'))
  const { ctx, handlers } = fakeCtx()
  try {
    const r = await dispatchWork(ctx, '写个 hello.py', { root, dir: root, log: () => {}, checkLogsDir: logs })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.sessionId, 'session-task')

    handlers['session/event']({ id: 'session-task' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await sleep(10)

    const names = readdirSync(logs)
    assert.equal(names.length, 1, JSON.stringify(names))
    const text = readFileSync(join(logs, names[0]), 'utf8')
    assert.match(text, /写个 hello\.py/)
    assert.match(text, /- 结果：成功/)
    assert.match(text, /session-task/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(logs, { recursive: true, force: true })
  }
})

test('监听在 prompt 之前就挂好了（prompt 里同步结束也能记到）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-work-'))
  const logs = mkdtempSync(join(tmpdir(), 'dsh-fish-checklogs-'))
  const { ctx } = fakeCtx({
    emitOnPrompt: (handlers) => {
      handlers['session/event']?.({ id: 'session-task' }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    },
  })
  try {
    const r = await dispatchWork(ctx, '跑一遍测试', { root, dir: root, log: () => {}, checkLogsDir: logs })
    assert.equal(r.ok, true, JSON.stringify(r))
    await sleep(10)
    const names = readdirSync(logs)
    assert.equal(names.length, 1, 'prompt 里同步结束的那一轮也必须记到')
    const text = readFileSync(join(logs, names[0]), 'utf8')
    assert.match(text, /- 结果：失败（出错）/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(logs, { recursive: true, force: true })
  }
})

test('没递进去（prompt 抛错）→ 不留日志，也不留监听', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-work-'))
  const logs = mkdtempSync(join(tmpdir(), 'dsh-fish-checklogs-'))
  const { ctx, handlers, emitted } = fakeCtx()
  ctx.sessionController.prompt = async () => { throw new Error('递不进去') }
  try {
    const r = await dispatchWork(ctx, '写个脚本', { root, dir: root, log: () => {}, checkLogsDir: logs })
    assert.equal(r.ok, false)
    assert.equal(handlers['session/event'], undefined, '失败后要摘掉监听')
    await sleep(10)
    assert.equal(readdirSync(logs).length, 0)
    assert.equal(emitted.length, 0, '没递进去就没有任务，也不该有事件')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(logs, { recursive: true, force: true })
  }
})

test('任务失败 → 日志写成后 emit checklog/finished（载荷对齐 notifyTaskFinished）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-work-'))
  const logs = mkdtempSync(join(tmpdir(), 'dsh-fish-checklogs-'))
  const { ctx, handlers, emitted } = fakeCtx()
  try {
    const r = await dispatchWork(ctx, '在 workspace 里写一个 hello.py', { root, dir: root, log: () => {}, checkLogsDir: logs })
    assert.equal(r.ok, true)

    handlers['session/event']({ id: 'session-task' }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    await sleep(10)

    // 日志先写成
    const names = readdirSync(logs)
    assert.equal(names.length, 1)
    // 然后才是事件
    assert.equal(emitted.length, 1, '日志写成才 emit，且只 emit 一次')
    assert.equal(emitted[0][0], 'checklog/finished')
    const result = emitted[0][1]
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'error', 'reason 是宿主 turn/end 的 kind')
    assert.equal(result.task, '在 workspace 里写一个 hello.py')
    assert.equal(result.sessionTitle, r.title)
    assert.equal(result.sessionId, 'session-task')
    assert.ok(result.startedAt > 0 && result.endedAt >= result.startedAt)
    assert.equal(result.elapsedMs, result.endedAt - result.startedAt)
    assert.equal(result.file, join(logs, names[0]), '载荷指向刚写的那个文件')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(logs, { recursive: true, force: true })
  }
})

test('任务成功 → 也 emit（qq 侧按 checklogNotifyOnSuccess 决定发不发）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-work-'))
  const logs = mkdtempSync(join(tmpdir(), 'dsh-fish-checklogs-'))
  const { ctx, handlers, emitted } = fakeCtx()
  try {
    await dispatchWork(ctx, '跑一遍构建', { root, dir: root, log: () => {}, checkLogsDir: logs })
    handlers['session/event']({ id: 'session-task' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await sleep(10)
    assert.equal(readdirSync(logs).length, 1)
    assert.equal(emitted.length, 1, '成功也 emit——发不发给 telegram 由 qq 侧的开关决定')
    assert.equal(emitted[0][1].ok, true)
    assert.equal(emitted[0][1].reason, 'completed')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(logs, { recursive: true, force: true })
  }
})

test('日志写不出来 → 一个事件都不发', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-work-'))
  // 目录用一个文件挡住：writeTaskLog 的 mkdir 会失败
  const blocker = mkdtempSync(join(tmpdir(), 'dsh-fish-checklogs-'))
  rmSync(blocker, { recursive: true, force: true })
  writeFileSync(blocker, 'x')
  const { ctx, handlers, emitted } = fakeCtx()
  try {
    const r = await dispatchWork(ctx, '写个脚本', { root, dir: root, log: () => {}, checkLogsDir: blocker })
    assert.equal(r.ok, true)
    handlers['session/event']({ id: 'session-task' }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    await sleep(10)
    assert.equal(emitted.length, 0, '写失败不 emit——日志是事实，通知是衍生物')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(blocker, { force: true })
  }
})
