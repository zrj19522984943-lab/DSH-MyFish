/**
 * memory.test.mjs —— 摘要检索与原文溯源的守门（2026-11-02）
 *
 * 钉住四件事：
 *   1. fish_search_history 只返回 ≤100 字的摘要 + 门牌号，不返回原文；
 *   2. 相邻命中不会变成两段重复的摘要；limit 真的封顶；
 *   3. fish_read_raw 按门牌号读回完整原文（带角色与时间），数组按顺序拼接；
 *   4. 两个工具名都在 FISH_TOOLS 里（否则 restrict 会把她和记忆隔开）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recordTurn } from '../lib/history-logger.js'
import {
  RAW_MAX_IDS,
  SEARCH_LIMIT,
  SEARCH_LIMIT_MAX,
  SNIPPET_CHARS,
  readRaw,
  registerReadRaw,
  registerSearchHistory,
  renderSearch,
  resetMemoryCache,
  searchHistory,
} from '../lib/memory.js'
import { FISH_TOOLS, HER_TOOLS } from '../lib/restrict.js'

function tmpRoot() {
  resetMemoryCache()
  return mkdtempSync(join(tmpdir(), 'dsh-fish-memory-'))
}

function at(day, h, m = 0) {
  return new Date(2026, 10, day, h, m, 0)
}

test('searchHistory：找到关键词，返回摘要 + 门牌号，摘要 ≤100 字', async () => {
  const root = tmpRoot()
  try {
    await recordTurn('我们的暗号是香蕉', '香蕉。记住了。', at(3, 21), root)
    await recordTurn('今天天气怎么样', '有点热。', at(3, 21, 1), root)

    const r = await searchHistory(root, '暗号')
    assert.equal(r.ok, true)
    assert.equal(r.segments.length, 1)
    const seg = r.segments[0]
    assert.ok(seg.text.includes('暗号'), seg.text)
    assert.deepEqual(seg.seqIds, [1, 2])
    assert.ok(seg.text.length <= SNIPPET_CHARS, `摘要超了：${seg.text.length}`)

    const text = renderSearch(r)
    assert.match(text, /^\[检索到以下相关回忆\]/)
    assert.match(text, /来源seq_id: 1, 2/)
    assert.ok(text.includes('[如果觉得记忆不连贯，请调用 fish_read_raw 查看原话]'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('searchHistory：新写的记录立刻能被搜到（缓存按 mtime/size 失效）', async () => {
  const root = tmpRoot()
  try {
    await recordTurn('第一句', '第一答', at(3, 21), root)
    assert.equal((await searchHistory(root, '第二句')).segments.length, 0)
    await recordTurn('第二句在这里', '第二答', at(3, 21, 1), root)
    const r = await searchHistory(root, '第二句')
    assert.equal(r.segments.length, 1)
    assert.ok(r.segments[0].seqIds.includes(3))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('searchHistory：相邻命中不重复成两段；limit 封顶', async () => {
  const root = tmpRoot()
  try {
    // 五次「灯塔」，每次之间隔一整轮无关对话，窗口互不重叠
    for (let i = 0; i < 5; i++) {
      await recordTurn(`第${i + 1}次提到灯塔`, `记下了${i + 1}`, at(3, 10 + i), root)
      await recordTurn(`无关的话${i + 1}`, `无关的回答${i + 1}`, at(3, 10 + i, 30), root)
    }
    const all = await searchHistory(root, '灯塔', { limit: SEARCH_LIMIT_MAX })
    assert.equal(all.segments.length, 5)
    // 每个窗口都是 3 条（命中 + 前后各 1），且互不重叠
    const ids = all.segments.flatMap((s) => s.seqIds)
    assert.equal(new Set(ids).size, ids.length, '窗口不能互相覆盖')

    const two = await searchHistory(root, '灯塔', { limit: 2 })
    assert.equal(two.segments.length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('searchHistory：没命中就说没命中，不编一段', async () => {
  const root = tmpRoot()
  try {
    await recordTurn('我们的暗号是香蕉', '香蕉。记住了。', at(3, 21), root)
    const r = await searchHistory(root, '潜艇')
    assert.equal(r.segments.length, 0)
    const text = renderSearch(r)
    assert.ok(text.includes('没翻到'), text)
    assert.ok(!text.includes('来源seq_id'), '没命中不能给门牌号')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readRaw：单条返回完整原文（角色 + 完整日期时间）', async () => {
  const root = tmpRoot()
  try {
    await recordTurn('我们的暗号是香蕉', '香蕉。记住了。', at(3, 21), root)
    const r = await readRaw(root, 1)
    assert.equal(r.ok, true)
    assert.deepEqual(r.found, [1])
    assert.match(r.text, /\[2026-11-03 21:00\]/)
    assert.match(r.text, /他：我们的暗号是香蕉/)
    assert.ok(!r.text.includes('来源seq_id'), '原文不该再带摘要格式')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readRaw：数组按给定顺序拼接，缺号如实说', async () => {
  const root = tmpRoot()
  try {
    await recordTurn('第一句', '第一答', at(3, 21), root)
    await recordTurn('第二句', '第二答', at(3, 21, 1), root)
    const r = await readRaw(root, [3, 1, 999])
    assert.equal(r.ok, true)
    assert.deepEqual(r.found, [3, 1])
    assert.deepEqual(r.missing, [999])
    const idx1 = r.text.indexOf('第一句')
    const idx3 = r.text.indexOf('第二句')
    assert.ok(idx3 < idx1, '传入 [3,1] 就先给 3 再给 1')
    assert.ok(r.text.includes('999'), '缺号要明说')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('readRaw：一次最多读 10 条，多出来的如实说', async () => {
  const root = tmpRoot()
  try {
    for (let i = 1; i <= RAW_MAX_IDS + 2; i++) {
      await recordTurn(`第${i}句`, '', at(3, 10, i), root)
    }
    const ids = Array.from({ length: RAW_MAX_IDS + 2 }, (_, i) => i + 1)
    const r = await readRaw(root, ids)
    assert.equal(r.found.length, RAW_MAX_IDS)
    assert.ok(r.text.includes('一次最多读 10 条'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('registerSearchHistory / registerReadRaw：工具形状与执行', async () => {
  const root = tmpRoot()
  try {
    await recordTurn('我们的暗号是香蕉', '香蕉。记住了。', at(3, 21), root)
    const defs = []
    const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
    registerSearchHistory(ctx, { root })
    registerReadRaw(ctx, { root })

    assert.deepEqual(defs.map((d) => d.name), ['fish_search_history', 'fish_read_raw'])
    assert.ok(FISH_TOOLS.includes('fish_search_history'), '检索工具必须进 FISH_TOOLS')
    assert.ok(FISH_TOOLS.includes('fish_read_raw'), '溯源工具必须进 FISH_TOOLS')
    assert.ok(HER_TOOLS.includes('fish_search_history'))
    assert.ok(HER_TOOLS.includes('fish_read_raw'))

    const search = await defs[0].execute({ keyword: '暗号' })
    assert.equal(search.found, true)
    assert.ok(search.text.includes('来源seq_id: 1, 2'))

    const raw = await defs[1].execute({ seq_id: [1, 2] })
    assert.equal(raw.found, true)
    assert.ok(raw.text.includes('我们的暗号是香蕉'))
    assert.ok(raw.text.includes('香蕉。记住了。'))

    // read_raw 的 seq_id 必须同时接受数字和数组：手写 schema，且不能被补成 string
    const idSchema = defs[1].parameters.properties.seq_id
    assert.equal(idSchema.type, undefined, 'oneOf 之外不能有 type')
    assert.ok(Array.isArray(idSchema.oneOf) && idSchema.oneOf.length === 2)

    // 默认 limit / 上限常量与文档一致
    assert.equal(SEARCH_LIMIT, 3)
    assert.equal(SEARCH_LIMIT_MAX, 10)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
