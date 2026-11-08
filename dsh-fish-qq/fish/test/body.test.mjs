/**
 * body.test.mjs —— check_body 的守门
 *
 * 这个工具是「赛博感官」的读取端（2026-11-02）：采集脚本把一行状态写进
 * 工作区 sensors/status.md，她按需来读。测试只盯四件事：
 *   1. 文件新鲜：原样读出那一行 + 「更新于 …」；
 *   2. 文件旧了：照给，但补一句「数据有点旧了」（不替她决定要不要理）；
 *   3. 没文件 / 没配工作区 / 坏文件：老实说，不编数据。
 *
 * 不测「她会不会因此说什么」——那是她的事。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readBodyStatus, registerBody, BODY_STALE_MS } from '../lib/body.js'
import { FISH_TOOLS } from '../lib/restrict.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-body-'))
}

function writeStatus(root, line) {
  mkdirSync(join(root, 'sensors'), { recursive: true })
  writeFileSync(join(root, 'sensors', 'status.md'), `${line}\n`, 'utf8')
}

test('readBodyStatus：新鲜状态原样读出，并报更新于几分钟前', () => {
  const root = tmpRoot()
  try {
    writeStatus(root, '[内存占用:72%] [机箱状态:正常] [天气:小雨 12°C]')
    const r = readBodyStatus(root)
    assert.equal(r.ok, true, r.note)
    assert.ok(r.text.includes('[内存占用:72%]'), r.text)
    assert.match(r.text, /更新于/)
    assert.ok(!r.text.includes('旧了'), '新数据不该说旧')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readBodyStatus：文件旧了照给，但明说可能不准', async () => {
  const root = tmpRoot()
  try {
    writeStatus(root, '[内存占用:90%] [机箱状态:高负载]')
    const stalePath = join(root, 'sensors', 'status.md')
    // 写一个老的 mtime：状态文件超期（BODY_STALE_MS），但仍可读
    const mtime = new Date(Date.now() - BODY_STALE_MS - 3600_000)
    await utimes(stalePath, mtime, mtime)
    const r = readBodyStatus(root)
    assert.equal(r.ok, true)
    assert.ok(r.text.includes('[内存占用:90%]'))
    assert.ok(r.text.includes('旧了'), '旧数据要明说')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readBodyStatus：没有状态文件时老实说没有，不编', () => {
  const root = tmpRoot()
  try {
    const r = readBodyStatus(root)
    assert.equal(r.ok, false)
    assert.equal(r.text, '')
    assert.match(r.note, /还没采过状态/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readBodyStatus：没配工作区时不猜目录', () => {
  const r = readBodyStatus('')
  assert.equal(r.ok, false)
  assert.match(r.note, /还没说能看哪儿/)
})

test('readBodyStatus：空状态文件等于采集没跑成', () => {
  const root = tmpRoot()
  try {
    writeStatus(root, '   ')
    const r = readBodyStatus(root)
    assert.equal(r.ok, false)
    assert.match(r.note, /空的/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('registerBody：工具形状一致 + 在白名单里', () => {
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  registerBody(ctx)
  assert.equal(defs.length, 1)
  const d = defs[0]
  assert.equal(d.name, 'check_body')
  assert.ok(FISH_TOOLS.includes('check_body'), '新工具必须进 FISH_TOOLS，否则 restrict 挂不上')
  assert.equal(d.parameters?.type, 'object')
  assert.equal(d.output?.schema?.type, 'object')
  assert.equal(typeof d.output.render, 'function')
  assert.equal(typeof d.execute, 'function')
})

test('registerBody：execute 的输出就是读到的那一行', async () => {
  const root = tmpRoot()
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  try {
    writeStatus(root, '[内存占用:72%] [机箱状态:正常]')
    registerBody(ctx, { workspaceRoot: root })
    const out = await defs[0].execute({})
    assert.equal(out.ok, true, out.note)
    assert.match(out.text, /\[内存占用:72%\]/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('registerBody：工作区根可以是 getter', async () => {
  const root = tmpRoot()
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  let current = ''
  try {
    registerBody(ctx, { workspaceRoot: () => current })
    assert.equal((await defs[0].execute({})).ok, false)
    writeStatus(root, '[内存占用:50%] [机箱状态:正常]')
    current = root
    const out = await defs[0].execute({})
    assert.equal(out.ok, true, out.note)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
