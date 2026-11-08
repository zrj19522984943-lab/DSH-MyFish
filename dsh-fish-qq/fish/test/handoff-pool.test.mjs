/**
 * handoff-pool.test.mjs —— 摘要的模型池优先级 / 回退（2026-11-03）
 *
 * 契约：
 *   - 第一个「已启用且填全」的槽位优先；
 *   - 请求体必须带关闭思考的参数（reasoning_effort=low，或 thinking=disabled）；
 *   - 模型池超时/401/空正文一律 ok:false，由 generateHandoff 回退宿主 llm；
 *   - 所有外部请求都有硬超时，测试里把预算压小验证“不会无限等”。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  generateHandoff,
  loadModelPool,
  pickModelPoolSlot,
  summarizeWithModelPool,
} from '../lib/handoff.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-handoff-pool-'))
}

function writeRaw(root, rows) {
  mkdirSync(join(root, 'memory'), { recursive: true })
  const day = '2026-11-03'
  const lines = rows.map((r, i) => JSON.stringify({
    seq_id: i + 1,
    ts: `2026-11-03T10:0${i}:00.000Z`,
    role: r.role,
    text: r.text,
  }))
  writeFileSync(join(root, 'memory', `raw_${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
}

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, base: `http://127.0.0.1:${port}` }
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return body
}

function fakeLlm(reply = '宿主 llm 的提要') {
  const calls = []
  return {
    calls,
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low' }] } } },
    listProviders: () => [{ id: 'demo' }],
    listModels: async () => [{ id: 'flash' }],
    stream(args) {
      calls.push(args)
      return (async function* () {
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
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

const SLOT = {
  enabled: true,
  apiUrl: 'http://127.0.0.1:1',
  apiKey: 'pool-key',
  modelName: 'pool-model',
}

test('pickModelPoolSlot：只取第一个已启用且填全的槽位', () => {
  const picked = pickModelPoolSlot([
    { enabled: false, apiUrl: 'u1', apiKey: 'k1', modelName: 'm1' },
    { enabled: true, apiUrl: 'u2', apiKey: 'k2', modelName: 'm2' },
    { enabled: true, apiUrl: 'u3', apiKey: 'k3', modelName: 'm3' },
  ])
  assert.equal(picked.modelName, 'm2')
  assert.equal(pickModelPoolSlot([{ enabled: true, apiUrl: 'u', apiKey: '', modelName: 'm' }]), null)
  assert.equal(pickModelPoolSlot([]), null)
})

test('summarizeWithModelPool：请求体带 reasoning_effort=low，返回清理后的提要', async () => {
  const seen = []
  const { server, base } = await startServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}')
    seen.push(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '《近期剧情提要》\n你们聊到了香蕉。' } }] }))
  })
  try {
    const r = await summarizeWithModelPool({ ...SLOT, apiUrl: base }, '他：暗号\n你：香蕉', { timeoutMs: 3_000 })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.text, '你们聊到了香蕉')
    assert.equal(r.source, 'pool:pool-model')
    assert.equal(seen[0].reasoning_effort, 'low')
    assert.deepEqual(seen[0].messages[0].role, 'user')
    assert.ok(String(seen[0].messages[0].content).includes('近期剧情提要'))
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
})

test('summarizeWithModelPool：服务端不认 thinking 时，换一种关闭思考的写法重试', async () => {
  const seen = []
  const { server, base } = await startServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}')
    seen.push(body)
    if (body.thinking) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unknown parameter: thinking' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '重试之后成功' } }] }))
  })
  try {
    const r = await summarizeWithModelPool({ ...SLOT, apiUrl: base }, '对话', { timeoutMs: 3_000 })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.text, '重试之后成功')
    assert.ok(seen.length >= 2, `实际请求 ${seen.length} 次`)
    assert.equal(seen[0].thinking?.type, 'disabled')
    assert.equal(seen[1].reasoning_effort, 'low')
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
})

test('summarizeWithModelPool：服务端永远不回 → 硬超时返回 ok:false，不挂住', async () => {
  const { server, base } = await startServer(() => { /* 故意不响应 */ })
  try {
    const t0 = Date.now()
    const r = await summarizeWithModelPool({ ...SLOT, apiUrl: base }, '对话', { timeoutMs: 400 })
    assert.equal(r.ok, false)
    assert.match(r.why, /超时/)
    assert.ok(Date.now() - t0 < 3_000, `耗时 ${Date.now() - t0}ms`)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
})

test('generateHandoff：模型池成功时不再调用宿主 llm', async () => {
  const root = tmpRoot()
  const { server, base } = await startServer(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '模型池写的提要' } }] }))
  })
  try {
    writeRaw(root, [{ role: 'user', text: '在吗' }, { role: 'assistant', text: '在' }])
    const llm = fakeLlm()
    const r = await generateHandoff(root, {
      ctx: fakeCtx(llm),
      modelPool: [{ ...SLOT, apiUrl: base }],
    })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.text, '模型池写的提要')
    assert.equal(r.source, 'pool:pool-model')
    assert.equal(llm.calls.length, 0)
  } finally {
    server.closeAllConnections?.()
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('generateHandoff：模型池 401 → 立即回退宿主 llm，且带低推理强度', async () => {
  const root = tmpRoot()
  const { server, base } = await startServer(async (req, res) => {
    await readBody(req)
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
  })
  try {
    writeRaw(root, [{ role: 'user', text: '在吗' }, { role: 'assistant', text: '在' }])
    const llm = fakeLlm('宿主 llm 兜底的提要')
    const r = await generateHandoff(root, {
      ctx: fakeCtx(llm),
      modelPool: [{ ...SLOT, apiUrl: base }],
    })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.text, '宿主 llm 兜底的提要')
    assert.equal(r.source, 'host:demo/flash')
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].reasoningEffort, 'low')
  } finally {
    server.closeAllConnections?.()
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('generateHandoff：模型池超时 → 仍回退宿主 llm（总预算内）', async () => {
  const root = tmpRoot()
  const { server, base } = await startServer(() => { /* 永不响应 */ })
  try {
    writeRaw(root, [{ role: 'user', text: '在吗' }, { role: 'assistant', text: '在' }])
    const llm = fakeLlm('超时之后宿主兜底')
    const t0 = Date.now()
    const r = await generateHandoff(root, {
      ctx: fakeCtx(llm),
      modelPool: [{ ...SLOT, apiUrl: base }],
      timeoutMs: 1_500,
    })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.text, '超时之后宿主兜底')
    assert.equal(r.source, 'host:demo/flash')
    assert.ok(Date.now() - t0 < 5_000, `耗时 ${Date.now() - t0}ms`)
  } finally {
    server.closeAllConnections?.()
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadModelPool：从 qq-bridge-settings.json 的 values.modelPool 读，坏文件不抛', async () => {
  const root = tmpRoot()
  try {
    const file = join(root, 'qq-bridge-settings.json')
    writeFileSync(file, JSON.stringify({ version: 1, values: { modelPool: [SLOT] } }), 'utf8')
    const pool = await loadModelPool({}, { modelPoolFile: file })
    assert.equal(pool.length, 3)
    assert.equal(pool[0].modelName, 'pool-model')

    writeFileSync(file, '{bad json', 'utf8')
    const broken = await loadModelPool({}, { modelPoolFile: file })
    assert.equal(broken.length, 3)
    assert.equal(broken.every((slot) => slot.enabled === false), true)
    // 坏的是 qq 的设置文件：只当没配，绝不能像 fish 自己的 store 那样改名/动它。
    assert.equal(existsSync(file), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
