/**
 * readfile.test.mjs —— fish_read_file 的守门（2026-10-27）
 *
 * 这个工具会碰两片文件系统：用户的工作区，和她自己的状态库。所以测试只盯四件事：
 *   1. 两道沙箱都真的拦得住越界（../、绝对路径、符号链接/junction 外跳）；
 *   2. scope=self 真的只放开白名单（日记能读，config.json / owner.json 读不到）；
 *   3. 行号范围、二进制、超大文件、编码这些边界都有一句人话回执；
 *   4. 工具注册形状和别的工具一致，且名字进了 FISH_TOOLS（否则 restrict 挂不上）。
 *
 * 不测「她会不会用」——那是她的事。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_FILE_BYTES,
  SELF_ALLOW,
  resolveReadFile,
  readTextFile,
  readForHer,
  selfAllowed,
  decodeText,
  registerReadFile,
} from '../lib/readfile.js'
import { FISH_TOOLS } from '../lib/restrict.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-readfile-'))
}

test('基本读取：带路径与行号范围的头', () => {
  const root = tmpRoot()
  try {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    const r = readTextFile(root, 'a.txt')
    assert.equal(r.ok, true, r.note)
    assert.match(r.text, /a\.txt（第 1–3 行 \/ 共 3 行）/)
    assert.match(r.text, /one\ntwo\nthree/)
    assert.equal(r.note, '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('行范围：offset / limit 只给那一段，并说清还有多少', () => {
  const root = tmpRoot()
  try {
    writeFileSync(join(root, 'a.txt'), Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'))
    const r = readTextFile(root, 'a.txt', { offset: 3, limit: 4 })
    assert.equal(r.ok, true, r.note)
    assert.match(r.text, /第 3–6 行 \/ 共 10 行/)
    assert.match(r.text, /L3\nL4\nL5\nL6/)
    assert.doesNotMatch(r.text, /L7/)
    assert.match(r.note, /还有 4 行没显示/)
    assert.match(r.note, /offset=7/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('行范围：offset 超过总行数如实说', () => {
  const root = tmpRoot()
  try {
    writeFileSync(join(root, 'a.txt'), 'only\n')
    const r = readTextFile(root, 'a.txt', { offset: 9 })
    assert.equal(r.ok, false)
    assert.match(r.note, /只有 1 行/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('空文件也给一句能懂的话', () => {
  const root = tmpRoot()
  try {
    writeFileSync(join(root, 'empty.txt'), '')
    const r = readTextFile(root, 'empty.txt')
    assert.equal(r.ok, true)
    assert.match(r.text, /空文件/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('沙箱：../ 与绝对路径越界都被拒', () => {
  const root = tmpRoot()
  try {
    for (const bad of ['..', '../x.txt', 'sub/../../x.txt']) {
      const r = resolveReadFile(root, bad)
      assert.equal(r.ok, false, `${bad} 不该放行`)
      assert.equal(r.reason, 'outside')
    }
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname'
    const r = resolveReadFile(root, outside)
    assert.equal(r.ok, false)
    assert.match(r.note, /权限拒绝/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('沙箱：符号链接/junction 指到外面被拒（建不了链接就跳过）', () => {
  if (process.platform !== 'win32') return
  const root = tmpRoot()
  const outside = tmpRoot()
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    try {
      symlinkSync(outside, join(root, 'escape'), 'junction')
    } catch {
      return
    }
    const r = resolveReadFile(root, 'escape/secret.txt')
    assert.equal(r.ok, false, '指向外面的链接不该放行')
    assert.equal(r.reason, 'outside')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('文件不存在 / 是目录 / 没配根，都有一句中文回执', () => {
  const root = tmpRoot()
  try {
    mkdirSync(join(root, 'sub'))
    const missing = readTextFile(root, 'nope.txt')
    assert.equal(missing.ok, false)
    assert.match(missing.note, /没有这个文件/)
    const dir = readTextFile(root, 'sub')
    assert.equal(dir.ok, false)
    assert.match(dir.note, /目录/)
    const noRoot = readTextFile('', 'a.txt')
    assert.equal(noRoot.ok, false)
    assert.match(noRoot.note, /还没说能看哪儿/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('二进制：含 NUL 的文件不当文本硬读', () => {
  const root = tmpRoot()
  try {
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]))
    const r = readTextFile(root, 'bin.dat')
    assert.equal(r.ok, false)
    assert.match(r.note, /二进制/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('超大文件：超过上限如实拒绝', () => {
  const root = tmpRoot()
  try {
    writeFileSync(join(root, 'big.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
    const r = readTextFile(root, 'big.txt')
    assert.equal(r.ok, false)
    assert.match(r.note, /太大/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('编码：GB18030 的旧 txt 也能读', () => {
  const d = decodeText(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
  // 某些 Node 构建不带 gb18030（full-icu 才有），那种情况只要求它老实拒绝。
  if (d.ok) assert.equal(d.text, '你好')
  else assert.match(d.note, /不是能读的文本/)
})

test('self 白名单：日记 / 事件流能读，参数与凭据读不到', () => {
  const root = tmpRoot()
  try {
    mkdirSync(join(root, 'diary'))
    writeFileSync(join(root, 'diary', '2026-10-26.md'), '今天下雨。')
    writeFileSync(join(root, 'events.jsonl'), '{"a":1}\n')
    writeFileSync(join(root, 'config.json'), '{"cookie":"SECRET"}')
    writeFileSync(join(root, 'owner.json'), '{"cookie":"SECRET"}')

    const diary = readForHer({ selfRoot: root }, { path: 'diary/2026-10-26.md', scope: 'self' })
    assert.equal(diary.ok, true, diary.note)
    assert.match(diary.text, /今天下雨/)

    const events = readForHer({ selfRoot: root }, { path: 'events.jsonl', scope: 'self' })
    assert.equal(events.ok, true, events.note)

    for (const bad of ['config.json', 'owner.json', './config.json']) {
      const r = readForHer({ selfRoot: root }, { path: bad, scope: 'self' })
      assert.equal(r.ok, false, `${bad} 不该读得到`)
      assert.match(r.note, /读不了/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('self 白名单：前缀相近的兄弟目录不能混进来', () => {
  const root = tmpRoot()
  try {
    const evil = `${root}-evil`
    mkdirSync(evil)
    try {
      writeFileSync(join(evil, 'x.md'), 'nope')
      assert.equal(selfAllowed(root, join(evil, 'x.md')), false)
    } finally { rmSync(evil, { recursive: true, force: true }) }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('self 白名单清单本身只放开那几样', () => {
  for (const a of SELF_ALLOW) assert.ok(!/config|owner|log/i.test(a), `${a} 不该在白名单里`)
  assert.ok(SELF_ALLOW.includes('diary'))
  assert.ok(SELF_ALLOW.includes('events.jsonl'))
})

test('scope：不认识的值如实说，不猜', () => {
  const r = readForHer({}, { path: 'a.txt', scope: 'nope' })
  assert.equal(r.ok, false)
  assert.match(r.note, /只能是 workspace/)
})

test('工作区根可以是 getter（设置改了下一次调用生效）', () => {
  const root = tmpRoot()
  try {
    writeFileSync(join(root, 'a.txt'), 'hi')
    let current = ''
    assert.equal(readForHer({ workspaceRoot: () => current }, { path: 'a.txt' }).ok, false)
    current = root
    assert.equal(readForHer({ workspaceRoot: () => current }, { path: 'a.txt' }).ok, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('registerReadFile：工具形状和别的工具一致，名字进了 FISH_TOOLS', () => {
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  registerReadFile(ctx, { root: tmpdir() })
  assert.equal(defs.length, 1)
  const d = defs[0]
  assert.equal(d.name, 'fish_read_file')
  assert.ok(FISH_TOOLS.includes('fish_read_file'), '新工具必须进 FISH_TOOLS，否则 restrict 挂不上')
  assert.equal(d.parameters?.type, 'object')
  assert.equal(d.parameters.properties.path?.type, 'string')
  assert.deepEqual(d.parameters.properties.scope?.enum, ['workspace', 'self'])
  assert.ok(d.parameters.required?.includes('path'))
  assert.equal(d.output?.schema?.type, 'object')
  assert.equal(typeof d.output.render, 'function')
  assert.equal(typeof d.execute, 'function')
})

test('registerReadFile：execute 越界同样拒绝', async () => {
  const root = tmpRoot()
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  try {
    registerReadFile(ctx, { workspaceRoot: root, selfRoot: root })
    const out = await defs[0].execute({ path: '../../x.txt' })
    assert.equal(out.ok, false)
    assert.match(out.note, /权限拒绝/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
