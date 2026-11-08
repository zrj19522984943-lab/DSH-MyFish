/**
 * identity.test.mjs —— 系统提示词段的挂载与内容
 *
 * identity.js 挂七个段：fish:handoff（换房后的提要，2026-11-02）、fish:identity
 * （自我文档）、fish:wake（这一次的处境）、fish:dream（梦境一次性提示，2026-11-02）、
 * fish:senses（赛博感官引导，2026-11-02）、fish:decorate（小屋装修引导，2026-11-03）、
 * fish:memory（摘要→原文的记忆规矩，2026-11-02）。
 *
 * 这里只验「挂载」与「段的内容契约」：
 *   - 七个段名都注册上、顺序是 handoff < identity < dream < wake < senses < decorate < memory；
 *   - handoff 段就是任务书指定的那句外壳 + home.json 里的提要，过期/轮数用完就空；
 *   - senses 段是任务书那三句原话（唯一常驻的感官文本）；
 *   - memory 段就是任务书步骤 4 那两句防退化警告（摘要可能失真，必须回原文）；
 *   - dream 段是有新梦才有一行、展示一次就不再出现（与 dream.test.mjs 的
 *     状态机同一个，但这里验的是「段里怎么用它的」）。
 *
 * 人格文本本身不测——那是她长出来的，不是契约。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { attachIdentity, DECORATE_GUIDE, MEMORY_GUIDE, SENSES_GUIDE } from '../lib/identity.js'
import { DREAM_HINT } from '../lib/dream.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-identity-'))
}

function harness(root) {
  const sections = []
  const agent = {
    ctx: {
      systemPrompt: {
        section(def) { sections.push(def) },
      },
    },
  }
  const r = attachIdentity(agent, root, { workspaceRoot: root })
  return { r, sections, byName: (n) => sections.find((s) => s.name === n) }
}

test('attachIdentity：七个段都挂上，顺序 handoff < identity < dream < wake < senses < decorate < memory', () => {
  const root = tmpRoot()
  try {
    const { r, sections } = harness(root)
    assert.equal(r.ok, true, r.why)
    const names = sections.map((s) => s.name)
    assert.deepEqual(names.sort(), [
      'fish:decorate',
      'fish:dream',
      'fish:handoff',
      'fish:identity',
      'fish:memory',
      'fish:senses',
      'fish:wake',
    ])
    const order = Object.fromEntries(sections.map((s) => [s.name, s.order]))
    assert.ok(order['fish:handoff'] < order['fish:identity'], 'handoff 是系统级前缀，排在最前')
    assert.ok(order['fish:identity'] < order['fish:dream'], 'identity 在 dream 前')
    assert.ok(order['fish:dream'] < order['fish:wake'], 'dream 在 wake 前')
    assert.ok(order['fish:wake'] < order['fish:senses'], 'senses 在 wake 后')
    assert.ok(order['fish:senses'] < order['fish:decorate'], 'decorate 在 senses 后')
    assert.ok(order['fish:decorate'] < order['fish:memory'], 'memory 在最后（系统设定末尾）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('decorate 段：就是任务书那句装修引导', () => {
  const root = tmpRoot()
  try {
    const { byName } = harness(root)
    const text = byName('fish:decorate').text()
    assert.equal(text, DECORATE_GUIDE)
    assert.ok(text.includes('fish_decorate_room'))
    assert.ok(text.includes('赛博小屋'))
    assert.ok(text.includes('书架') && text.includes('摇椅'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('handoff 段：换房后就是任务书那句外壳 + 提要；没提要是空段', () => {
  const root = tmpRoot()
  try {
    // 没有 home.json：空段（等于不存在）
    let { byName } = harness(root)
    assert.equal(byName('fish:handoff').text(), '')

    writeFileSync(
      join(root, 'home.json'),
      JSON.stringify({
        wsId: 'w1',
        sessionId: 'session-11111111-1111-1111-1111-111111111111',
        turns: 1,
        rotatedAt: new Date().toISOString(),
        handoff: '前三十轮里你们聊了暗号、约定明天去看海。',
        handoffSource: 'model:test',
      }),
      'utf8',
    )
    ;({ byName } = harness(root))
    const text = byName('fish:handoff').text()
    assert.ok(text.startsWith('[系统：你刚刚搬到了新房间，这是你之前的记忆提要：'), text)
    assert.ok(text.includes('前三十轮里你们聊了暗号、约定明天去看海。'))
    assert.ok(text.endsWith('如果忘记更早的事，请调用 fish_search_history。]'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('handoff 段：轮数用满（8 轮）或超过 3 天就不再贴', () => {
  const root = tmpRoot()
  try {
    const old = new Date(Date.now() - 4 * 86_400_000).toISOString()
    writeFileSync(
      join(root, 'home.json'),
      JSON.stringify({ sessionId: 's', turns: 0, rotatedAt: old, handoff: '很久以前的提要' }),
      'utf8',
    )
    let { byName } = harness(root)
    assert.equal(byName('fish:handoff').text(), '', '超过 3 天不该再贴')

    writeFileSync(
      join(root, 'home.json'),
      JSON.stringify({ sessionId: 's', turns: 8, rotatedAt: new Date().toISOString(), handoff: '提要' }),
      'utf8',
    )
    ;({ byName } = harness(root))
    assert.equal(byName('fish:handoff').text(), '', '用满 8 轮就该消失')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('senses 段：就是任务书那三句引导，且是静态的', () => {
  const root = tmpRoot()
  try {
    const { byName } = harness(root)
    const s = byName('fish:senses')
    assert.ok(s, 'fish:senses 段必须挂上')
    assert.equal(s.text(), SENSES_GUIDE)
    const lines = SENSES_GUIDE.split('\n')
    assert.equal(lines.length, 3)
    assert.ok(lines[0].includes('check_body'), '第一句要提到 check_body')
    assert.ok(lines[1].includes('read_user_rhythm'), '第二句要提到 read_user_rhythm')
    assert.ok(lines[2].includes('修改时间'), '第三句要说目录的修改时间')
    // 静态：调两次一样（区别于 identity / dream 的现读）
    assert.equal(s.text(), s.text())
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('senses 段：不包含任何环境数据本身（数据只在她调工具时进上下文）', () => {
  const root = tmpRoot()
  try {
    mkdirSync(join(root, 'sensors'), { recursive: true })
    writeFileSync(join(root, 'sensors', 'status.md'), '[内存占用:99%] [机箱状态:高负载] [天气:暴雨]\n', 'utf8')
    const { byName } = harness(root)
    const t = byName('fish:senses').text()
    assert.ok(!t.includes('内存占用'), '引导段里不该出现当前数据')
    assert.ok(!t.includes('天气'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('memory 段：就是「摘要可能失真、重要的事回原文」那条规矩', () => {
  const root = tmpRoot()
  try {
    const { byName } = harness(root)
    const s = byName('fish:memory')
    assert.ok(s, 'fish:memory 段必须挂上')
    assert.equal(s.text(), MEMORY_GUIDE)
    // 任务书步骤 4 的原话要点，一个字都不能少
    assert.ok(MEMORY_GUIDE.includes('检索到的只是摘要片段，可能失真'))
    assert.ok(MEMORY_GUIDE.includes('请立刻调用 fish_read_raw 查阅原话'))
    assert.ok(MEMORY_GUIDE.includes('绝对不要基于残缺的摘要强行推理'))
    assert.ok(MEMORY_GUIDE.includes('fish_search_history'))
    // 静态：每轮都在，不随盘上数据变
    assert.equal(s.text(), s.text())
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dream 段：有新梦时给那一句，展示一次之后就空了', () => {
  const root = tmpRoot()
  try {
    mkdirSync(join(root, 'dreams'), { recursive: true })
    writeFileSync(join(root, 'dreams', 'tonight.md'), '一段碎片\n', 'utf8')
    const { byName } = harness(root)
    const d = byName('fish:dream')
    assert.equal(d.text(), DREAM_HINT, '新梦：只给那一句提示')
    assert.equal(d.text(), '', '同一段梦只提示一次（标记已写下）')
    // 提示里不带碎片内容
    assert.ok(!DREAM_HINT.includes('碎片内容'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dream 段：没有梦文件时段是空的（等于不存在）', () => {
  const root = tmpRoot()
  try {
    const { byName } = harness(root)
    assert.equal(byName('fish:dream').text(), '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('attachIdentity：宿主不支持 systemPrompt.section 时如实说', () => {
  const root = tmpRoot()
  try {
    const r = harness(root).r
    assert.equal(r.ok, true) // 正常路径先过
    const bad = attachIdentity({ ctx: {} }, root, {})
    assert.equal(bad.ok, false)
    assert.match(bad.why, /systemPrompt\.section/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
