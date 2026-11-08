/**
 * listdir.test.mjs —— fish_list_dir 的守门
 *
 * 这个工具是**唯一碰用户文件系统**的工具，所以测试只盯三件事：
 *   1. 沙箱真的拦得住越界（../、绝对路径、前缀相近的兄弟目录、符号链接）；
 *   2. 噪音目录真的不列（.git / node_modules / __pycache__）；
 *   3. 工具注册形状和别的工具一致（parameters 是 object-rooted JSON Schema）。
 *
 * 不测「她会不会用」——那是她的事。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HIDDEN_ENTRIES,
  MAX_ENTRIES,
  resolveInside,
  renderListing,
  listDirectory,
  registerListDir,
} from '../lib/listdir.js'
import { FISH_TOOLS } from '../lib/restrict.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-listdir-'))
}

test('resolveInside：根本身可以看', () => {
  const root = tmpRoot()
  try {
    const r = resolveInside(root, '.')
    assert.equal(r.ok, true, r.reason)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('resolveInside：工作区里的子目录可以看', () => {
  const root = tmpRoot()
  try {
    mkdirSync(join(root, 'src'))
    const r = resolveInside(root, 'src')
    assert.equal(r.ok, true, r.reason)
    assert.match(r.resolved, /src$/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('resolveInside：../ 越界被拒', () => {
  const root = tmpRoot()
  try {
    for (const bad of ['..', '../..', 'src/../../..']) {
      const r = resolveInside(root, bad)
      assert.equal(r.ok, false, `${bad} 不该放行`)
      assert.match(r.reason, /权限拒绝/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('resolveInside：绝对路径指向工作区外被拒', () => {
  const root = tmpRoot()
  try {
    const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
    const r = resolveInside(root, outside)
    assert.equal(r.ok, false)
    assert.match(r.reason, /权限拒绝/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('resolveInside：前缀相近的兄弟目录不能混进来', () => {
  const root = tmpRoot()
  try {
    // 造一个和根目录同前缀、但不在里面的兄弟目录：<root>-evil
    const evil = `${root}-evil`
    mkdirSync(evil)
    try {
      const r = resolveInside(root, `../${evil.split(/[\\/]/).pop()}`)
      assert.equal(r.ok, false, '同前缀兄弟目录不该被当成工作区内')
      assert.match(r.reason, /权限拒绝/)
    } finally { rmSync(evil, { recursive: true, force: true }) }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('resolveInside：符号链接指到工作区外被拒（没有权限建链接就跳过）', () => {
  if (process.platform !== 'win32') return
  const root = tmpRoot()
  const outside = tmpRoot()
  try {
    try {
      symlinkSync(outside, join(root, 'escape'), 'junction')
    } catch {
      return // 沙箱/策略不允许建链接：这条跳过，不制造假红
    }
    const r = resolveInside(root, 'escape')
    assert.equal(r.ok, false, '指向外面的链接不该放行')
    assert.match(r.reason, /权限拒绝/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('resolveInside：不存在的目录老实说没有', () => {
  const root = tmpRoot()
  try {
    const r = resolveInside(root, 'nope')
    assert.equal(r.ok, false)
    assert.match(r.reason, /没有这个目录/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('listDirectory：过滤 .git / node_modules / __pycache__', () => {
  const root = tmpRoot()
  try {
    for (const d of ['.git', 'node_modules', '__pycache__', 'src']) mkdirSync(join(root, d))
    writeFileSync(join(root, 'index.js'), '')
    writeFileSync(join(root, '.DS_Store'), '')
    const r = listDirectory(root, '.')
    assert.equal(r.ok, true, r.note)
    assert.match(r.text, /\[DIR\] src\//)
    assert.match(r.text, /\[FILE\] index\.js/)
    for (const h of HIDDEN_ENTRIES) assert.ok(!r.text.includes(h), `${h} 不该出现在列表里`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('listDirectory：目录在前、文件在后、各按名字排（文件带最后修改时间）', () => {
  const root = tmpRoot()
  try {
    mkdirSync(join(root, 'zdir'))
    mkdirSync(join(root, 'adir'))
    writeFileSync(join(root, 'b.txt'), '')
    writeFileSync(join(root, 'a.txt'), '')
    const lines = listDirectory(root, '.').text.split('\n').slice(1)
    assert.deepEqual(lines.slice(0, 2), ['[DIR] adir/', '[DIR] zdir/'])
    assert.match(lines[2], /^\[FILE\] a\.txt \[最后修改: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/, lines[2])
    assert.match(lines[3], /^\[FILE\] b\.txt \[最后修改: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/, lines[3])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('renderListing：文件带 mtimeMs 才有修改时间，没有就退回旧行', () => {
  const out = renderListing('D:\\x', [
    { name: 'a.txt', isDirectory: () => false, mtimeMs: Date.parse('2026-11-02T03:14:00') },
    { name: 'b.txt', isDirectory: () => false },
  ])
  assert.match(out, /\[FILE\] a\.txt \[最后修改: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/)
  assert.ok(!/\[最后修改/.test(out.split('\n').find((l) => l.includes('b.txt'))), '没有 mtimeMs 的条目不该带时间')
})

test('renderListing：目录不带修改时间（目录 mtime 只说明有东西进出）', () => {
  const out = renderListing('D:\\x', [{ name: 'src', isDirectory: () => true, mtimeMs: Date.now() }])
  assert.equal(out.split('\n')[1], '[DIR] src/')
})

test('listDirectory：第一行是绝对路径（她知道自己站在哪）', () => {
  const root = tmpRoot()
  try {
    mkdirSync(join(root, 'src'))
    const r = listDirectory(root, 'src')
    const first = r.text.split('\n')[0]
    assert.equal(first, resolveInside(root, 'src').resolved)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('listDirectory：条目过多时封顶并说明还有多少', () => {
  const root = tmpRoot()
  try {
    for (let i = 0; i < MAX_ENTRIES + 7; i++) writeFileSync(join(root, `f${String(i).padStart(3, '0')}.txt`), '')
    const r = listDirectory(root, '.')
    assert.equal(r.ok, true)
    assert.match(r.text, /（还有 7 项没列出）/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('listDirectory：拿文件当目录看会老实说不是目录', () => {
  const root = tmpRoot()
  try {
    writeFileSync(join(root, 'a.txt'), '')
    const r = listDirectory(root, 'a.txt')
    assert.equal(r.ok, false)
    assert.match(r.note, /不是目录/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('listDirectory：越界不抛异常，只返回权限拒绝', () => {
  const root = tmpRoot()
  try {
    const r = listDirectory(root, '../..')
    assert.equal(r.ok, false)
    assert.match(r.note, /权限拒绝/)
    assert.equal(r.text, '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('renderListing：空目录只有一行路径', () => {
  assert.equal(renderListing('D:\\x', []), 'D:\\x')
})

test('registerListDir：工具形状和别的工具一致', () => {
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  registerListDir(ctx)
  assert.equal(defs.length, 1)
  const d = defs[0]
  assert.equal(d.name, 'fish_list_dir')
  assert.ok(FISH_TOOLS.includes('fish_list_dir'), '新工具必须进 FISH_TOOLS，否则 restrict 挂不上')
  assert.equal(d.parameters?.type, 'object')
  assert.equal(typeof d.parameters.properties, 'object')
  assert.equal(d.output?.schema?.type, 'object')
  assert.equal(typeof d.output.render, 'function')
  assert.equal(typeof d.execute, 'function')
})

test('registerListDir：execute 对越界同样拒绝', async () => {
  const root = tmpRoot()
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  try {
    registerListDir(ctx, { workspaceRoot: root })
    const out = await defs[0].execute({ dirPath: '../..' })
    assert.equal(out.ok, false)
    assert.match(out.note, /权限拒绝/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('registerListDir：工作区根来自设置（不再写死）', async () => {
  const root = tmpRoot()
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  try {
    mkdirSync(join(root, 'src'))
    registerListDir(ctx, { workspaceRoot: root })
    const out = await defs[0].execute({})
    assert.equal(out.ok, true, out.note)
    assert.match(out.text, /\[DIR\] src\//)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('registerListDir：没配工作区时如实说，不猜目录', async () => {
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  registerListDir(ctx)
  const out = await defs[0].execute({})
  assert.equal(out.ok, false)
  assert.match(out.note, /还没说能看哪儿/)
})

test('registerListDir：工作区根可以是 getter（设置改了下一次调用生效）', async () => {
  const root = tmpRoot()
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  let current = ''
  try {
    registerListDir(ctx, { workspaceRoot: () => current })
    assert.equal((await defs[0].execute({})).ok, false)
    mkdirSync(join(root, 'src'))
    current = root
    const out = await defs[0].execute({})
    assert.equal(out.ok, true, out.note)
    assert.match(out.text, /\[DIR\] src\//)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
