// 目标会话解析（2026-11-02）＋ 交接占位闸门（2026-11-03）。
// 运行：node qq/test-target-session.mjs
import assert from 'node:assert/strict'
import { handoffPendingFresh, resolveTargetSessionId } from './index.js'

let pass = 0
function ok(name, fn) {
  fn()
  pass++
  console.log(`✔ ${name}`)
}

const FISH = 'session-2a99fa40-3359-4098-a7d2-e7141ef62c24'
const STALE = 'session-00000000-0000-0000-0000-000000000000'
const CONFIG = 'session-11111111-1111-1111-1111-111111111111'

ok('合并包：home.json 的 id 赢过设置文件里的旧值（这次修的主症状）', () => {
  assert.equal(resolveTargetSessionId({ stored: STALE, configId: CONFIG, fishId: FISH, fromFish: true }), FISH)
})

ok('合并包：home.json 读不到时，退回设置值（不凭空丢目标）', () => {
  assert.equal(resolveTargetSessionId({ stored: STALE, configId: CONFIG, fishId: '', fromFish: true }), STALE)
  assert.equal(resolveTargetSessionId({ stored: '', configId: CONFIG, fishId: '', fromFish: true }), CONFIG)
})

ok('独立安装（没有开关）：行为与以前完全一致，设置值 > config', () => {
  assert.equal(resolveTargetSessionId({ stored: STALE, configId: CONFIG, fishId: FISH, fromFish: false }), STALE)
  assert.equal(resolveTargetSessionId({ stored: '', configId: CONFIG, fishId: FISH, fromFish: false }), CONFIG)
  assert.equal(resolveTargetSessionId({ stored: '', configId: '', fishId: '', fromFish: false }), '')
})

ok('空白字符不会漏过去', () => {
  assert.equal(resolveTargetSessionId({ stored: '  ', configId: ' ', fishId: ` ${FISH} `, fromFish: true }), FISH)
})

ok('交接占位：刚换房（pending + 新时间）要等；超过 30 秒的陈旧占位不等', () => {
  const now = Date.now()
  assert.equal(handoffPendingFresh({ handoffPending: true, rotatedAt: new Date(now - 1000).toISOString() }, now), true)
  assert.equal(handoffPendingFresh({ handoffPending: true, rotatedAt: new Date(now - 60_000).toISOString() }, now), false)
  assert.equal(handoffPendingFresh({ handoffPending: false, rotatedAt: new Date(now).toISOString() }, now), false)
  assert.equal(handoffPendingFresh({ handoffPending: true, rotatedAt: '坏时间' }, now), false)
  assert.equal(handoffPendingFresh(null, now), false)
})

console.log(`\n${pass} 项全部通过`)
