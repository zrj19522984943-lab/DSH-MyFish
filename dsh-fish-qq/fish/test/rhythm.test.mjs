/**
 * rhythm.test.mjs —— read_user_rhythm 的守门
 *
 * 与 body.test.mjs 同一套口径（2026-11-02 赛博感官模块 2）：采集脚本
 * pipeline/update_rhythm.js 把按小时聚成的一行写进 sensors/user_rhythm.md，
 * 她按需来读。测的东西也是四件：新鲜、旧了照给并明说、没有就说没有、
 * 工具形状 + 白名单。
 *
 * 注意：本测试只测**读**这一侧；聚合逻辑（raw jsonl → 一行）在
 * pipeline/update_rhythm.js 里，由 qq 那侧的流水线测试覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readUserRhythm, registerRhythm, RHYTHM_STALE_MS } from '../lib/rhythm.js'
import { FISH_TOOLS } from '../lib/restrict.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-rhythm-'))
}

function writeRhythm(root, line) {
  mkdirSync(join(root, 'sensors'), { recursive: true })
  writeFileSync(join(root, 'sensors', 'user_rhythm.md'), `${line}\n`, 'utf8')
}

test('readUserRhythm：新鲜记录原样读出 + 更新于', () => {
  const root = tmpRoot()
  try {
    writeRhythm(root, '09:00-10:00 高频打字; 14:00-15:00 无操作')
    const r = readUserRhythm(root)
    assert.equal(r.ok, true, r.note)
    assert.ok(r.text.includes('09:00-10:00 高频打字'), r.text)
    assert.match(r.text, /更新于/)
    assert.ok(!r.text.includes('一半'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readUserRhythm：很久没更新时明说「只到记录的一半」', async () => {
  const root = tmpRoot()
  try {
    writeRhythm(root, '09:00-10:00 高频打字')
    const file = join(root, 'sensors', 'user_rhythm.md')
    const mtime = new Date(Date.now() - RHYTHM_STALE_MS - 7200_000)
    await utimes(file, mtime, mtime)
    const r = readUserRhythm(root)
    assert.equal(r.ok, true)
    assert.ok(r.text.includes('一半'), r.text)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readUserRhythm：还没有记录时说还没有，不编', () => {
  const root = tmpRoot()
  try {
    const r = readUserRhythm(root)
    assert.equal(r.ok, false)
    assert.match(r.note, /还没有节奏记录/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readUserRhythm：没配工作区时不猜目录', () => {
  const r = readUserRhythm('')
  assert.equal(r.ok, false)
  assert.match(r.note, /还没说能看哪儿/)
})

test('registerRhythm：工具形状一致 + 在白名单里', () => {
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  registerRhythm(ctx)
  assert.equal(defs.length, 1)
  const d = defs[0]
  assert.equal(d.name, 'read_user_rhythm')
  assert.ok(FISH_TOOLS.includes('read_user_rhythm'), '新工具必须进 FISH_TOOLS，否则 restrict 挂不上')
  assert.equal(d.parameters?.type, 'object')
  assert.equal(d.output?.schema?.type, 'object')
  assert.equal(typeof d.output.render, 'function')
  assert.equal(typeof d.execute, 'function')
})

test('registerRhythm：execute 读到那一行', async () => {
  const root = tmpRoot()
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  try {
    writeRhythm(root, '10:00-11:00 间歇操作')
    registerRhythm(ctx, { workspaceRoot: root })
    const out = await defs[0].execute({})
    assert.equal(out.ok, true, out.note)
    assert.match(out.text, /10:00-11:00 间歇操作/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
