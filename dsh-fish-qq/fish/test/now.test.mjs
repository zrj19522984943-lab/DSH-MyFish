/**
 * now.test.mjs —— fish_now 的守门
 *
 * 这只工具不碰文件系统、不联网，唯一的作用是回答「现在几点」。
 * 所以测试只盯四件事：
 *   1. 渲染格式固定（日期 / 星期 / 时间 / 时区偏移 / Unix 时间戳）；
 *   2. 星期映射、补零、进位（跨月、月末、年初）真的对；
 *   3. 工具注册形状和别的工具一致（parameters 是 object-rooted JSON Schema）；
 *   4. 名字进了 FISH_TOOLS（否则工具面收窄会把它挡在外面，她连钟都看不见）。
 *
 * ⚠️ 时区：这里的固定值用 `new Date(年, 月, 日, 时, 分)` 构造，本身是本地时间，
 * 所以断言里的时区偏移与 Unix 时间戳都从**同一个 Date** 现算——
 * 换一台别的时区的机器跑也不会假红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  NOW_TOOL_NAME,
  WEEKDAY_NAMES,
  formatNow,
  formatUtcOffset,
  readNow,
  registerNow,
} from '../lib/now.js'
import { FISH_TOOLS, HER_TOOLS } from '../lib/restrict.js'

/** 「2026-10-30 17:25:17（本地）」——下面多处用它做锚点。 */
const ANCHOR = new Date(2026, 9, 30, 17, 25, 17)

test('WEEKDAY_NAMES：0=日 … 6=六，七个', () => {
  assert.equal(WEEKDAY_NAMES.length, 7)
  assert.deepEqual([...WEEKDAY_NAMES], ['日', '一', '二', '三', '四', '五', '六'])
})

test('formatUtcOffset：把分钟渲染成 ±HH:MM', () => {
  assert.equal(formatUtcOffset(480), '+08:00')
  assert.equal(formatUtcOffset(-300), '-05:00')
  assert.equal(formatUtcOffset(-210), '-03:30')
  assert.equal(formatUtcOffset(0), '+00:00')
  assert.equal(formatUtcOffset(570), '+09:30')
})

test('formatUtcOffset：非数字返回空串（调用方自己兜底）', () => {
  assert.equal(formatUtcOffset(NaN), '')
  assert.equal(formatUtcOffset(Infinity), '')
  assert.equal(formatUtcOffset('480'), '+08:00')
})

test('formatNow：固定锚点的第一行（日期 / 星期 / 分号时间 / 偏移）', () => {
  const lines = formatNow(ANCHOR).split('\n')
  assert.equal(lines.length, 2, '正文恰好两行')
  // 偏移量从同一个 Date 现算：换时区跑也不会假红
  const off = formatUtcOffset(-ANCHOR.getTimezoneOffset())
  assert.equal(lines[0], `2026-10-30 星期五 17:25（UTC${off}）`, lines[0])
  // 本机（UTC+8）就是这一句：
  // 2026-10-30 星期五 17:25（UTC+08:00）
})

test('formatNow：第二行是 Unix 秒（从同一个 Date 现算，时区无关）', () => {
  const lines = formatNow(ANCHOR).split('\n')
  assert.equal(lines[1], `Unix 时间戳（秒）${Math.floor(ANCHOR.getTime() / 1000)}`)
  // 本机锚点：1793352317
})

test('formatNow：接受数字时间戳，与传 Date 等价', () => {
  assert.equal(formatNow(ANCHOR.getTime()), formatNow(ANCHOR))
})

test('formatNow：小时与分钟补零（不是 17:5）', () => {
  const lines = formatNow(new Date(2026, 9, 30, 8, 5)).split('\n')
  assert.equal(lines[0].startsWith('2026-10-30 星期五 08:05（UTC'), true, lines[0])
})

test('formatNow：午夜是 00:00', () => {
  const lines = formatNow(new Date(2026, 9, 30, 0, 0)).split('\n')
  assert.equal(lines[0].startsWith('2026-10-30 星期五 00:00（UTC'), true, lines[0])
})

test('formatNow：月和日也补零', () => {
  const lines = formatNow(new Date(2026, 0, 5, 9, 5)).split('\n')
  assert.equal(lines[0].startsWith('2026-01-05 星期一 09:05（UTC'), true, lines[0])
})

test('formatNow：星期映射对（同一周里七天各是各的）', () => {
  const cases = [
    [2026, 9, 25, '日'],
    [2026, 9, 26, '一'],
    [2026, 9, 30, '五'],
    [2026, 9, 31, '六'],
    [2026, 10, 1, '日'],
  ]
  for (const [y, m, d, w] of cases) {
    const lines = formatNow(new Date(y, m, d, 12, 0)).split('\n')
    assert.ok(lines[0].includes(`星期${w}`), `${y}-${m + 1}-${d} 应该是 星期${w}，实际 ${lines[0]}`)
  }
})

test('formatNow：跨月进位（10 月最后一天的下一天是 11 月）', () => {
  const lines = formatNow(new Date(2026, 11, 31, 23, 59)).split('\n')
  assert.equal(lines[0].startsWith('2026-12-31 星期四 23:59（UTC'), true, lines[0])
})

test('readNow：返回 {ok, text, note}，正文就是 formatNow', () => {
  const out = readNow(ANCHOR)
  assert.equal(out.ok, true)
  assert.equal(out.text, formatNow(ANCHOR))
  assert.equal(out.note, '')
})

test('readNow：不传参也能跑（真的读现在）', () => {
  const out = readNow()
  assert.equal(out.ok, true)
  assert.match(out.text, /^\d{4}-\d{2}-\d{2} 星期[日一二三四五六] \d{2}:\d{2}（UTC[+-]\d{2}:\d{2}）\nUnix 时间戳（秒）\d{10}$/)
})

test('registerNow：工具形状和别的工具一致', () => {
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  registerNow(ctx)
  assert.equal(defs.length, 1)
  const d = defs[0]
  assert.equal(d.name, NOW_TOOL_NAME)
  assert.equal(NOW_TOOL_NAME, 'fish_now')
  assert.ok(FISH_TOOLS.includes('fish_now'), '新工具必须进 FISH_TOOLS，否则 restrict 挂不上')
  assert.ok(HER_TOOLS.includes('fish_now'), 'HER_TOOLS 里也要有')
  assert.equal(d.parameters?.type, 'object')
  assert.equal(typeof d.parameters.properties, 'object')
  assert.equal(d.output?.schema?.type, 'object')
  assert.equal(typeof d.output.render, 'function')
  assert.equal(typeof d.execute, 'function')
})

test('registerNow：execute 真的读现在，格式与 formatNow 一致', async () => {
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  registerNow(ctx)
  const out = await defs[0].execute({})
  assert.equal(out.ok, true)
  assert.match(out.text, /^\d{4}-\d{2}-\d{2} 星期[日一二三四五六] \d{2}:\d{2}（UTC[+-]\d{2}:\d{2}）\nUnix 时间戳（秒）\d{10}$/)
  assert.equal(out.note, '')
})

test('registerNow：render 把文本交给模型，失败时写明原因', () => {
  const defs = []
  const ctx = { tools: { register(d) { defs.push(d); return () => {} } } }
  registerNow(ctx)
  const render = defs[0].output.render
  const ok = render({}, { ok: true, text: '2026-10-30 星期五 17:25（UTC+08:00）\nUnix 时间戳（秒）1793352317', note: '' })
  assert.equal(ok.length, 1)
  assert.equal(ok[0].type, 'text')
  assert.ok(ok[0].text.includes('2026-10-30 星期五'))
  const bad = render({}, { ok: false, text: '', note: '钟停了' })
  assert.equal(bad[0].text, '没读到：钟停了')
})
