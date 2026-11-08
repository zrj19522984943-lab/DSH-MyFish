/**
 * test-model-pool.mjs —— 模型池后端（2026-11-03）
 *
 * 只测纯函数，不启动整个插件：
 *   - /v1/models 拉取（成功 / 401 / 超时）；
 *   - /v1/chat/completions 测连通（成功 / 401 / 防思考参数 / 超时）；
 *   - 槽位归一化与 URL 拼接。
 *
 * 运行：node test-model-pool.mjs（不要用 node --test：DSH 沙箱会挡子进程）
 */

import { createServer } from 'node:http'

import {
  chatEndpointOf,
  fetchModelsFromApi,
  modelsEndpointOf,
  normalizeModelPool,
  pickEnabledModelSlot,
  testModelConnection,
} from './index.js'

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
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

// ── 纯函数 ──────────────────────────────────────────────────────────────────
{
  const pool = normalizeModelPool([{ enabled: true, apiUrl: ' u ', apiKey: ' k ', modelName: ' m ' }])
  check('normalizeModelPool：固定 3 槽、空位补默认', pool.length === 3 && pool[1].enabled === false)
  check('normalizeModelPool：字段 trim', pool[0].apiUrl === 'u' && pool[0].apiKey === 'k' && pool[0].modelName === 'm')
  check('pickEnabledModelSlot：取第一个启用且填全的', pickEnabledModelSlot([
    { enabled: false, apiUrl: 'u1', apiKey: 'k1', modelName: 'm1' },
    { enabled: true, apiUrl: 'u2', apiKey: 'k2', modelName: 'm2' },
  ])?.modelName === 'm2')
  check('pickEnabledModelSlot：缺 key 不算配置好', pickEnabledModelSlot([{ enabled: true, apiUrl: 'u', apiKey: '', modelName: 'm' }]) === null)
  check('modelsEndpointOf：不带 /v1 时补上', modelsEndpointOf('https://api.deepseek.com') === 'https://api.deepseek.com/v1/models')
  check('modelsEndpointOf：已带 /v1 不重复', modelsEndpointOf('https://api.deepseek.com/v1/') === 'https://api.deepseek.com/v1/models')
  check('chatEndpointOf：不带 /v1 时补上', chatEndpointOf('https://api.deepseek.com') === 'https://api.deepseek.com/v1/chat/completions')
  check('chatEndpointOf：已经写到 chat/completions 不重复拼', chatEndpointOf('https://x/v1/chat/completions') === 'https://x/v1/chat/completions')
}

// ── 拉模型 / 测连通（本地假 OpenAI）──────────────────────────────────────────
{
  const seen = []
  const { server, base } = await startServer(async (req, res) => {
    const body = await readBody(req)
    seen.push({ url: req.url, auth: req.headers.authorization, body })
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer good-key') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad key' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      if (req.headers.authorization !== 'Bearer good-key') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'bad key' } }))
        return
      }
      const parsed = JSON.parse(body)
      if (parsed.thinking) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'unknown parameter: thinking' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: parsed.model, choices: [{ message: { content: 'hi' } }] }))
      return
    }
    res.writeHead(404)
    res.end('no')
  })
  try {
    const models = await fetchModelsFromApi({ apiUrl: base, apiKey: 'good-key' })
    check('fetchModelsFromApi：成功返回模型 id 列表', models.ok === true && models.models.join(',') === 'model-a,model-b', JSON.stringify(models))

    const bad = await fetchModelsFromApi({ apiUrl: base, apiKey: 'bad-key' })
    check('fetchModelsFromApi：401 返回 ok:false + HTTP 401', bad.ok === false && /HTTP 401/.test(bad.error), JSON.stringify(bad))

    const tested = await testModelConnection({ apiUrl: base, apiKey: 'good-key', modelName: 'model-a' })
    check('testModelConnection：成功返回耗时', tested.ok === true && Number.isFinite(tested.latencyMs), JSON.stringify(tested))

    const chatCalls = seen.filter((x) => x.url === '/v1/chat/completions')
    const firstChat = JSON.parse(chatCalls[0].body)
    check('testModelConnection：max_tokens=5 / 只有一条 hi', firstChat.max_tokens === 5 && firstChat.messages.length === 1 && firstChat.messages[0].content === 'hi')
    check('testModelConnection：强制带 reasoning_effort=low', firstChat.reasoning_effort === 'low', JSON.stringify(firstChat))
    check('testModelConnection：服务端不认 thinking 时自动换写法并成功', chatCalls.length >= 2 && JSON.parse(chatCalls[1].body).reasoning_effort === 'low')

    const badTest = await testModelConnection({ apiUrl: base, apiKey: 'bad-key', modelName: 'model-a' })
    check('testModelConnection：401 立即失败（不重试）', badTest.ok === false && /HTTP 401/.test(badTest.error), JSON.stringify(badTest))
    const badCalls = seen.filter((x) => x.url === '/v1/chat/completions' && x.auth === 'Bearer bad-key')
    check('testModelConnection：401 只发一次', badCalls.length === 1, String(badCalls.length))
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

// ── 超时 ────────────────────────────────────────────────────────────────────
{
  const { server, base } = await startServer(() => { /* 永不响应 */ })
  try {
    const t0 = Date.now()
    const models = await fetchModelsFromApi({ apiUrl: base, apiKey: 'k', timeoutMs: 300 })
    check('fetchModelsFromApi：超时返回 ok:false', models.ok === false && /超时/.test(models.error), JSON.stringify(models))
    check('fetchModelsFromApi：超时在硬上限内返回', Date.now() - t0 < 2_000, `${Date.now() - t0}ms`)

    const t1 = Date.now()
    const tested = await testModelConnection({ apiUrl: base, apiKey: 'k', modelName: 'm', timeoutMs: 300 })
    check('testModelConnection：超时返回 ok:false', tested.ok === false && /超时/.test(tested.error), JSON.stringify(tested))
    check('testModelConnection：超时在硬上限内返回', Date.now() - t1 < 2_000, `${Date.now() - t1}ms`)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

// ── 只回头、不结束正文（比“完全不响应”更阴）────────────────────────────────
{
  const { server, base } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"data":[') // 正文永远不结束
  })
  try {
    const t0 = Date.now()
    const models = await fetchModelsFromApi({ apiUrl: base, apiKey: 'k', timeoutMs: 300 })
    check(
      'fetchModelsFromApi：响应体一直不结束也会被硬超时掐断',
      models.ok === false && /超时/.test(models.error) && Date.now() - t0 < 2_000,
      JSON.stringify(models),
    )
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exitCode = failed ? 1 : 0
