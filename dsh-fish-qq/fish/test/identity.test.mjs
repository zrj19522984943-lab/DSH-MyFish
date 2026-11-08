/**
 * identity.test.mjs —— 系统提示词段的挂载与内容
 *
 * identity.js 挂七个段：fish:handoff（换房后的提要，2026-11-02）、fish:identity
 * （自我文档）、fish:space（当前空间）、fish:dream（梦境一次性提示，2026-11-02）、
 * fish:physical（物理感知事件 + 手机电量，2026-11-07）、fish:wake（这一次的处境）、
 * fish:senses（赛博感官引导，2026-11-02）。
 *
 * 2026-11-04 动态工具路由：fish:decorate（装修）与 fish:memory（记忆检索规矩）
 * 两个常驻段已删掉 —— 它们是扩展工具说明，改由 QQ 桥接层按意图当轮注入。
 *
 * 这里只验「挂载」与「段的内容契约」：
 *   - 七个段名都注册上、顺序是 handoff < identity < space < dream < physical < wake < senses；
 *   - physical 段：事件读走即删、电量只在插着且新鲜时出现；
 *   - handoff 段就是任务书指定的那句外壳 + home.json 里的提要，过期/轮数用完就空；
 *   - senses 段只讲基础池工具（check_body / fish_list_dir 的修改时间）；
 *   - decorate / memory 段确实不再挂（否则又变成每轮常驻开销）；
 *   - dream 段是有新梦才有一行、展示一次就不再出现（与 dream.test.mjs 的
 *     状态机同一个，但这里验的是「段里怎么用它的」）。
 *
 * 人格文本本身不测——那是她长出来的，不是契约。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { attachIdentity, spaceText, physicalText, SENSES_GUIDE } from '../lib/identity.js'
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

test('attachIdentity：七个段都挂上，顺序 handoff < identity < space < dream < physical < wake < senses', () => {
  const root = tmpRoot()
  try {
    const { r, sections } = harness(root)
    assert.equal(r.ok, true, r.why)
    const names = sections.map((s) => s.name)
    assert.deepEqual(names.sort(), [
      'fish:dream',
      'fish:handoff',
      'fish:identity',
      'fish:physical',
      'fish:senses',
      'fish:space',
      'fish:wake',
    ])
    const order = Object.fromEntries(sections.map((s) => [s.name, s.order]))
    assert.ok(order['fish:handoff'] < order['fish:identity'], 'handoff 是系统级前缀，排在最前')
    assert.ok(order['fish:identity'] < order['fish:space'], 'space 在身份之后')
    assert.ok(order['fish:space'] < order['fish:dream'], 'space 在 dream 前')
    assert.ok(order['fish:dream'] < order['fish:physical'], 'physical 在 dream 后')
    assert.ok(order['fish:physical'] < order['fish:wake'], 'physical 在 wake 前')
    assert.ok(order['fish:wake'] < order['fish:senses'], 'senses 在 wake 后（系统设定末尾）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('space 段：校园/小屋快照会动态换前缀', () => {
  const root = tmpRoot()
  try {
    mkdirSync(join(root, 'cyber_house'), { recursive: true })
    const file = join(root, 'cyber_house', 'current_space.json')
    writeFileSync(file, JSON.stringify({
      environment: 'campus',
      room: '老图书馆',
      status: '在武大校园散步',
      poi: { name: '老图书馆', kind: 'building' },
      virtual: { x: 500, y: 500 },
      geo: { lng: 114.3635, lat: 30.535 },
    }), 'utf8')
    const campus = spaceText(root)
    assert.match(campus, /武汉大学校园/)
    assert.match(campus, /老图书馆/)
    assert.match(campus, /114\.363500/)
    assert.match(campus, /500\.0, 500\.0/)

    writeFileSync(file, JSON.stringify({
      environment: 'home',
      room: '客厅',
      status: '在家休息',
      poi: null,
      virtual: { x: 532.5, y: 690 },
      geo: { lng: 114.3635, lat: 30.535 },
    }), 'utf8')
    const home = spaceText(root)
    assert.match(home, /赛博小屋/)
    assert.match(home, /客厅/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('decorate / memory 段：已从常驻 system prompt 删掉', () => {
  const root = tmpRoot()
  try {
    const { byName } = harness(root)
    assert.equal(byName('fish:decorate'), undefined, '装修说明不该再常驻')
    assert.equal(byName('fish:memory'), undefined, '记忆检索规矩不该再常驻')
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

test('senses 段：只讲基础池工具，且是静态的', () => {
  const root = tmpRoot()
  try {
    const { byName } = harness(root)
    const s = byName('fish:senses')
    assert.ok(s, 'fish:senses 段必须挂上')
    assert.equal(s.text(), SENSES_GUIDE)
    const lines = SENSES_GUIDE.split('\n')
    assert.equal(lines.length, 5)
    assert.ok(lines[0].includes('check_body'), '第一句要提到 check_body')
    assert.ok(lines[1].includes('修改时间'), '第二句要说目录的修改时间')
    // 2026-11-05：表情包工具常驻后，引导句也进这一段
    assert.ok(lines[2].includes('qq_bridge_sticker'), '第三句要提到 qq_bridge_sticker')
    assert.ok(lines[2].includes('自主决定'), '第三句要鼓励自主使用')
    // 任务书 2：屋里 NPC 的对话要让她知道可以自己翻
    assert.ok(lines[3].includes('read_house_events'), '第四句要提到 read_house_events')
    // 跨空间认知：校园模式下用真实地点回答
    assert.ok(lines[4].includes('武汉大学校园'), '第五句要提校园环境')
    assert.ok(/樱花大道|老图书馆/.test(lines[4]), '第五句要有真实地点示例')
    assert.ok(!SENSES_GUIDE.includes('read_user_rhythm'), '扩展工具不该再常驻')
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

test('physical 段：事件读走即删，手机插着且新鲜时给电量行', () => {
  const root = tmpRoot()
  try {
    const dir = join(root, 'cyber_house', 'physical_events')
    mkdirSync(dir, { recursive: true })
    const now = Date.now()
    writeFileSync(join(dir, `${now - 1000}-a.json`), JSON.stringify({
      id: 'phys-a',
      kind: 'network',
      text: '[物理感知：局域网信号极其不稳定，可能有人走动机箱，或者网卡过载。]',
      at: now - 1000,
    }), 'utf8')
    writeFileSync(join(dir, `${now}-b.json`), JSON.stringify({
      id: 'phys-b',
      kind: 'battery',
      text: '[物理感知：主人的手机插上了电脑，当前电量 85%。]',
      at: now,
    }), 'utf8')
    writeFileSync(join(root, 'cyber_house', 'phone_battery.json'), JSON.stringify({
      level: 0.85,
      percent: 85,
      charging: true,
      plugged: true,
      updatedAtMs: now,
    }), 'utf8')

    const first = physicalText(root)
    assert.match(first, /局域网信号极其不稳定/)
    assert.match(first, /手机插上了电脑，当前电量 85%/)
    assert.match(first, /正插在电脑上充电，当前电量 85%/)
    assert.equal(readdirSync(dir).length, 0, '读走的事件必须从队列里删掉')

    const second = physicalText(root)
    assert.equal(second, '[系统：主人的手机正插在电脑上充电，当前电量 85%。]')
    assert.ok(!second.includes('局域网信号'), '同一条事件只交付一次')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('physical 段：过期事件与旧电量都不出现', () => {
  const root = tmpRoot()
  try {
    const dir = join(root, 'cyber_house', 'physical_events')
    mkdirSync(dir, { recursive: true })
    const now = Date.now()
    writeFileSync(join(dir, `${now - 31 * 60 * 1000}-old.json`), JSON.stringify({
      id: 'phys-old',
      text: '[物理感知：很久以前的一次抖动。]',
      at: now - 31 * 60 * 1000,
    }), 'utf8')
    writeFileSync(join(root, 'cyber_house', 'phone_battery.json'), JSON.stringify({
      level: 0.42,
      percent: 42,
      charging: true,
      plugged: true,
      updatedAtMs: now - 4 * 60 * 1000,
    }), 'utf8')

    assert.equal(physicalText(root), '')
    assert.equal(readdirSync(dir).length, 0, '过期事件应该被清掉')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('physical 段：没有事件、手机没插着时是空串', () => {
  const root = tmpRoot()
  try {
    assert.equal(physicalText(root), '')
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
