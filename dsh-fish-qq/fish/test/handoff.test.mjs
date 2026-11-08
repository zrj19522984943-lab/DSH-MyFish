/**
 * handoff.test.mjs —— 换会话时的《近期剧情提要》（2026-11-03 重写）
 *
 * 这一版的核心契约：
 *   - **只走宿主 llm**（ctx.get('llm').stream），不再有任何外部 HTTP / key；
 *   - 推理强度挑最低一档（默认 high 会把 token 全烧在思考上 → 正文为空）；
 *   - 硬超时：到点就返回失败，绝不无限等；
 *   - 失败时用最近 4 轮原话兜底，没有对话就明说「记忆交接失败」；
 *   - 注入外壳就是任务书指定的那句 [系统：…]。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cleanSummary,
  collectRecentTurns,
  FAILED_HANDOFF_TEXT,
  fallbackHandoffText,
  generateHandoff,
  pickHostSelection,
  pickLowestEffort,
  renderHandoff,
  renderTranscript,
  summarizeWithLlm,
} from '../lib/handoff.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-handoff-'))
}

function writeRaw(root, day, rows) {
  mkdirSync(join(root, 'memory'), { recursive: true })
  const lines = rows.map((r) => JSON.stringify({ seq_id: r.seq, ts: r.ts ?? new Date().toISOString(), role: r.role, text: r.text }))
  writeFileSync(join(root, 'memory', `raw_${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
}

/** 假宿主 llm：只实现 stream / resolveModelInfo / listProviders / listModels。 */
function fakeLlm({ reply = '你们聊到了暗号（香蕉）。', finish = 'stop', hang = false, efforts = [{ id: 'low' }, { id: 'high' }] } = {}) {
  const calls = []
  return {
    calls,
    async resolveModelInfo() {
      return { reasoning: { efforts } }
    },
    listProviders: () => [{ id: 'demo' }],
    listModels: async () => [{ id: 'flash' }],
    stream(args) {
      calls.push(args)
      return (async function* () {
        if (hang) {
          await new Promise(() => {})
          return
        }
        if (reply) yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: finish } }
      })()
    },
  }
}

function fakeCtx(llm) {
  return {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'demo', model: 'flash' }) }
      return undefined
    },
  }
}

test('collectRecentTurns：按轮取最近 N 轮，user + assistant 成对', async () => {
  const root = tmpRoot()
  try {
    const rows = []
    let seq = 1
    for (let i = 1; i <= 5; i++) {
      rows.push({ seq: seq++, role: 'user', text: `他第${i}句`, ts: `2026-11-02T10:0${i}:00.000Z` })
      rows.push({ seq: seq++, role: 'assistant', text: `她第${i}句`, ts: `2026-11-02T10:0${i}:10.000Z` })
    }
    writeRaw(root, '2026-11-02', rows)
    const turns = await collectRecentTurns(root, 3)
    assert.equal(turns.length, 3)
    assert.equal(turns[0].user, '他第3句')
    assert.equal(turns[2].assistant, '她第5句')
    const transcript = renderTranscript(turns)
    assert.ok(transcript.includes('他：他第3句'))
    assert.ok(transcript.includes('你：她第5句'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('collectRecentTurns：没有记忆文件时返回空数组（不抛）', async () => {
  const root = tmpRoot()
  try {
    assert.deepEqual(await collectRecentTurns(root, 30), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cleanSummary：去掉标题行、前缀、引号与尾标点（实测模型的几种写法）', () => {
  assert.equal(cleanSummary('《近期剧情提要》\n你们聊了暗号。'), '你们聊了暗号')
  assert.equal(cleanSummary('提要：你们聊了暗号。'), '你们聊了暗号')
  assert.equal(cleanSummary('「你们聊了暗号。」'), '你们聊了暗号')
  assert.equal(cleanSummary('  你们聊了暗号！！！ '), '你们聊了暗号')
})

test('pickHostSelection：显式 provider/model > 部署默认 > 名字带 flash 的模型', async () => {
  const llm = { stream: async function* () {}, listProviders: () => [{ id: 'p1' }], listModels: async () => [{ id: 'big-model' }, { id: 'mini-flash' }] }
  const cfgExplicit = { chat: { handoff: { provider: 'pp', model: 'mm' } } }
  assert.deepEqual(await pickHostSelection({ get: (n) => (n === 'llm' ? llm : null) }, cfgExplicit), { provider: 'pp', model: 'mm' })

  const defaultSel = { get: (n) => (n === 'llm' ? llm : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'd', model: 'dm' }) } : null) }
  assert.deepEqual(await pickHostSelection(defaultSel, {}), { provider: 'd', model: 'dm' })

  const noDefault = { get: (n) => (n === 'llm' ? llm : null) }
  assert.deepEqual(await pickHostSelection(noDefault, {}), { provider: 'p1', model: 'mini-flash' })
  assert.equal(await pickHostSelection({ get: () => null }, {}), null)
})

test('pickLowestEffort：取 none/off/minimal/low 里最低的一档', async () => {
  const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'minimal' }, { id: 'low' }] } }) }
  assert.equal(await pickLowestEffort(llm, { provider: 'p', model: 'm' }), 'minimal')
  const noReasoning = { resolveModelInfo: async () => ({}) }
  assert.equal(await pickLowestEffort(noReasoning, { provider: 'p', model: 'm' }), undefined)
  assert.equal(await pickLowestEffort({ resolveModelInfo: async () => { throw new Error('x') } }, { provider: 'p', model: 'm' }), undefined)
})

test('summarizeWithLlm：收集流式正文，带最低推理强度和 2500 token 预算', async () => {
  const llm = fakeLlm()
  const r = await summarizeWithLlm(llm, { provider: 'demo', model: 'flash' }, '他：暗号\n你：香蕉', {})
  assert.equal(r.ok, true, r.why)
  assert.equal(r.text, '你们聊到了暗号（香蕉）')
  assert.equal(r.source, 'host:demo/flash')
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'demo')
  assert.equal(llm.calls[0].maxTokens, 2500)
  assert.equal(llm.calls[0].reasoningEffort, 'low')
  assert.ok(String(llm.calls[0].messages[0].content?.[0]?.text ?? '').includes('不超过'))
})

test('summarizeWithLlm：正文空且 finish=stop → 不再重试，返回 ok:false', async () => {
  const llm = fakeLlm({ reply: '   ' })
  const r = await summarizeWithLlm(llm, { provider: 'demo', model: 'flash' }, 'x', {})
  assert.equal(r.ok, false)
  assert.match(r.why, /返回空/)
  assert.equal(llm.calls.length, 1)
})

test('summarizeWithLlm：正文空且 finish=length → 加大预算重试一次', async () => {
  const llm = fakeLlm({ reply: '', finish: 'length' })
  const r = await summarizeWithLlm(llm, { provider: 'demo', model: 'flash' }, 'x', {})
  assert.equal(r.ok, false)
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[0].maxTokens, 2500)
  assert.equal(llm.calls[1].maxTokens, 6000)
})

test('summarizeWithLlm：模型永远不结束 → 硬超时返回，不卡住调用方', async () => {
  const llm = fakeLlm({ hang: true })
  const t0 = Date.now()
  const r = await summarizeWithLlm(llm, { provider: 'demo', model: 'flash' }, 'x', { timeoutMs: 400 })
  assert.equal(r.ok, false)
  assert.match(r.why, /超时/)
  assert.ok(Date.now() - t0 < 3000, `耗时 ${Date.now() - t0}ms`)
})

test('summarizeWithLlm：没有 llm / 没有模型 / 没有对话都如实说，不抛', async () => {
  assert.equal((await summarizeWithLlm(null, { provider: 'p', model: 'm' }, 'x')).ok, false)
  assert.equal((await summarizeWithLlm(fakeLlm(), null, 'x')).ok, false)
  assert.equal((await summarizeWithLlm(fakeLlm(), { provider: 'p', model: 'm' }, '   ')).ok, false)
})

test('fallbackHandoffText：最近 4 轮原话兜底，剥掉 QQ 的括号说明；没对话就明说失败', () => {
  const turns = [
    { user: '[QQ · 私聊] 244：在吗（回 QQ 用 [QQ]…[/QQ]）', assistant: '在。' },
    { user: '暗号是什么', assistant: '香蕉' },
  ]
  const text = fallbackHandoffText(turns)
  assert.ok(text.includes('在吗'), text)
  assert.ok(!text.includes('回 QQ 用'), text)
  assert.ok(text.includes('香蕉'), text)
  assert.equal(fallbackHandoffText([]), FAILED_HANDOFF_TEXT)
})

test('generateHandoff：走宿主 llm，产出提要（不需要任何 key）', async () => {
  const root = tmpRoot()
  try {
    writeRaw(root, '2026-11-02', [
      { seq: 1, role: 'user', text: '我们的暗号是什么' },
      { seq: 2, role: 'assistant', text: '香蕉' },
    ])
    const llm = fakeLlm({ reply: '你们对了暗号（香蕉）。' })
    // 显式给空模型池：不要让这台机器上真实配置的 qq-bridge-settings.json 影响单测
    // （否则有人配了模型池之后，跑测试会真的去请求外网）。
    const r = await generateHandoff(root, { ctx: fakeCtx(llm), modelPool: [] })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.text, '你们对了暗号（香蕉）')
    assert.equal(r.turns, 1)
    assert.equal(r.source, 'host:demo/flash')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('generateHandoff：没有宿主 llm 时 ok:false，并说明原因', async () => {
  const root = tmpRoot()
  const emptyRoot = tmpRoot()
  try {
    writeRaw(root, '2026-11-02', [{ seq: 1, role: 'user', text: '在吗' }])
    const r = await generateHandoff(root, { ctx: { get: () => null }, modelPool: [] })
    assert.equal(r.ok, false)
    assert.match(r.why, /宿主没有可用的 llm 模型/)

    const empty = await generateHandoff(emptyRoot, { ctx: { get: () => null }, modelPool: [] })
    assert.equal(empty.ok, false)
    assert.match(empty.why, /还没有对话/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(emptyRoot, { recursive: true, force: true })
  }
})

test('renderHandoff：就是任务书指定的那句系统外壳', () => {
  assert.equal(
    renderHandoff('你们聊了暗号。'),
    '[系统：你刚刚搬到了新房间，这是你之前的记忆提要：你们聊了暗号。如果忘记更早的事，请调用 fish_search_history。]',
  )
  assert.equal(renderHandoff(''), '')
})
