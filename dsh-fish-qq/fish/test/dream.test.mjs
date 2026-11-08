/**
 * dream.test.mjs —— 梦境一次性提示的守门
 *
 * 赛博感官模块 4（2026-11-02）：夜间打工流水线写一句梦境碎片进
 * dreams/tonight.md；她**下一次**组装提示词时，fish:dream 段只出现一句
 * 「[系统：你昨晚做了一个梦，梦的碎片在 workspace/dreams/tonight.md]」，
 * 展示一次后按 mtime 记进 dreams/.seen，同一段梦不再提示。
 *
 * 测的也就是这个状态机：新梦 → 提示；标记之后 → 空；新一段梦（mtime 变了）
 * → 再提示一次。另加边界：没有梦 / 没配工作区 / 标记写不了都不能抛。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pendingDream, markDreamSeen, dreamHintText, DREAM_HINT } from '../lib/dream.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-dream-'))
}

function writeDream(root, text = '电梯在暴雨里翻面，数字 42。') {
  mkdirSync(join(root, 'dreams'), { recursive: true })
  writeFileSync(join(root, 'dreams', 'tonight.md'), `${text}\n`, 'utf8')
}

test('pendingDream：没有梦文件 → null', () => {
  const root = tmpRoot()
  try {
    assert.equal(pendingDream(root), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pendingDream：新梦 → 提示文本恰好是那一句', () => {
  const root = tmpRoot()
  try {
    writeDream(root)
    const p = pendingDream(root)
    assert.ok(p, '有新梦时应返回 {file, mtimeMs}')
    assert.equal(dreamHintText(root), DREAM_HINT)
    assert.ok(DREAM_HINT.includes('dreams/tonight.md'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('markDreamSeen：展示一次后同一段梦不再提示', () => {
  const root = tmpRoot()
  try {
    writeDream(root)
    const p = pendingDream(root)
    markDreamSeen(root, p.mtimeMs)
    assert.equal(pendingDream(root), null, '标记过之后同一 mtime 不算新梦')
    assert.equal(dreamHintText(root), '')
    // 标记文件里记的就是 mtime
    assert.equal(readFileSync(join(root, 'dreams', '.seen'), 'utf8').trim(), String(p.mtimeMs))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('新的一段梦（mtime 变了）会再提示一次', () => {
  const root = tmpRoot()
  try {
    writeDream(root, '旧梦')
    const p1 = pendingDream(root)
    markDreamSeen(root, p1.mtimeMs)
    assert.equal(pendingDream(root), null)
    writeDream(root, '新梦，完全不相干')
    const p2 = pendingDream(root)
    assert.ok(p2, '覆盖之后是新的一段梦')
    assert.notEqual(p2.mtimeMs, p1.mtimeMs)
    assert.equal(dreamHintText(root), DREAM_HINT)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pendingDream：标记文件不存在视为没看过（旧升级路径）', () => {
  const root = tmpRoot()
  try {
    writeDream(root)
    assert.ok(pendingDream(root), '只有梦没有标记 → 是新梦')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pendingDream：没配工作区时返回 null，不抛', () => {
  assert.equal(pendingDream(''), null)
  assert.equal(pendingDream(() => ''), null)
})

test('markDreamSeen：写不了标记也不抛（最坏只是提示重复一次）', () => {
  const root = tmpRoot()
  try {
    writeDream(root)
    const p = pendingDream(root)
    // 把 dreams 目录设成只读，标记写不进去（POSIX 有权限才生效；Windows 上
    // chmod 不一定挡得住，那就只验「不抛」）
    try { chmodSync(join(root, 'dreams'), 0o500) } catch { /* 忽略 */ }
    assert.doesNotThrow(() => markDreamSeen(root, p.mtimeMs))
  } finally {
    try { chmodSync(join(root, 'dreams'), 0o700) } catch { /* 忽略 */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('提示文本里不带碎片内容（内容只在她读文件时进上下文）', () => {
  const root = tmpRoot()
  try {
    writeDream(root, '一句非常独特的碎片内容')
    assert.ok(!dreamHintText(root).includes('一句非常独特的碎片内容'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
