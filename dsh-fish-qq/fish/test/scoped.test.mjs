/**
 * scoped.test.mjs —— 会话级工具隔离的守门（2026-11-08）
 *
 * 复现用户报的那个污染：插件的工具注册在插件 ctx 上 = 落进 global 层，
 * 用户写代码的工作区也看得见 `fish_search_history` / `fish_decorate_room`。
 *
 * 这个测试用一个"真分层"的假宿主钉四件事：
 *   1. 她的工具只出现在她那条会话的 own 层，global 层一个都没有；
 *   2. 别的会话（用户工作区）看不到任何 fish_* / qq_bridge_send 回复工具；
 *   3. 她的 restrict allow 里不再有 scoped 工具名（否则宿主会判 unknown）；
 *   4. 历史遗留/误注册在 global 层的插件工具，非她的会话会被 deny 兜底摘掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FISH_TOOLS,
  HER_TOOLS,
  QQ_BRIDGE_TOOLS,
  registerToolRestrict,
  rememberKnownTools,
} from '../lib/restrict.js'
import { createToolCapture, isHerAgent, mountToolDefinitions } from '../lib/scope.js'

const GUARD_REFUSAL = '这件事我做不到。'

/** 一个够用的、真的分 global / own 两层的假宿主。 */
function makeHost({ globalNames = [] } = {}) {
  const globalTools = new Map()
  const scopedTools = new Map()
  const restrictions = new Map()
  const guards = new Map()
  const agents = []
  const handlers = new Map()
  const restrictCalls = []

  const putGlobal = (definition) => globalTools.set(definition.name, definition)
  for (const name of globalNames) putGlobal({ name })

  const admits = (restriction, name) => {
    if (!restriction) return true
    if (restriction.deny?.has(name)) return false
    if (restriction.allow) return restriction.allow.has(name)
    return true
  }

  const view = (agent) => {
    const inherited = new Map(globalTools)
    const own = agent ? (scopedTools.get(agent) ?? new Map()) : new Map()
    const visible = new Map()
    const knownNames = new Set()
    const restriction = agent ? restrictions.get(agent) : undefined
    for (const [name, definition] of inherited) {
      knownNames.add(name)
      if (admits(restriction, name)) visible.set(name, definition)
    }
    // own 层不受 restrict 影响（宿主源码：own 直接 visible.set）
    for (const [name, definition] of own) {
      knownNames.add(name)
      visible.set(name, definition)
    }
    return { visible, knownNames, restrictableNames: new Set(inherited.keys()) }
  }

  const toolsFor = (agent) => ({
    view(scope) {
      return view(scope ?? agent)
    },
    register(definition) {
      if (!agent) {
        if (globalTools.has(definition.name)) throw new Error(`duplicate global tool ${definition.name}`)
        globalTools.set(definition.name, definition)
        return () => globalTools.delete(definition.name)
      }
      let own = scopedTools.get(agent)
      if (!own) {
        own = new Map()
        scopedTools.set(agent, own)
      }
      if (own.has(definition.name)) throw new Error(`duplicate scoped tool ${definition.name}`)
      own.set(definition.name, definition)
      return () => own.delete(definition.name)
    },
    restrict(filter) {
      if (!agent) throw new Error('tools.restrict() requires a scoped context')
      const known = view(agent).restrictableNames
      for (const name of [...(filter.allow ?? []), ...(filter.deny ?? [])]) {
        if (!known.has(name)) throw new Error(`tools.restrict() names unknown global tool "${name}"`)
      }
      const current = restrictions.get(agent) ?? {}
      if (filter.allow !== undefined) current.allow = new Set(filter.allow)
      if (filter.deny !== undefined) current.deny = new Set(filter.deny)
      restrictions.set(agent, current)
      restrictCalls.push({ agent, allow: filter.allow, deny: filter.deny })
      return () => {}
    },
    guard(fn) {
      guards.set(agent, fn)
      return () => {}
    },
  })

  const makeAgent = ({ id, cwd }) => {
    const agent = { id, session: { id, header: { cwd } }, header: { cwd } }
    agent.ctx = { tools: toolsFor(agent), effect: () => {} }
    agents.push(agent)
    return agent
  }

  const ctx = {
    on(name, fn) {
      handlers.set(name, fn)
      return () => {}
    },
    get(name) {
      if (name === 'agents') return { list: () => agents.slice() }
      return undefined
    },
  }

  return {
    ctx,
    makeAgent,
    emit: (agent) => handlers.get('agent/created')?.({ agent }),
    globalTools,
    scopedTools,
    restrictions,
    guards,
    restrictCalls,
    putGlobal,
  }
}

function makeHome(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fish-scope-'))
  const herDir = join(root, 'home')
  mkdirSync(herDir, { recursive: true })
  writeFileSync(
    join(root, 'home.json'),
    JSON.stringify({ wsId: 'ws-test', sessionId: 'session-her-00000000', ...overrides }, null, 2),
  )
  return { root, herDir }
}

const defs = [...FISH_TOOLS, ...QQ_BRIDGE_TOOLS].map((name) => ({ name, async execute() {} }))

test('她的工具只挂在她那条会话的 own 层，global 层一个都没有', () => {
  rememberKnownTools([])
  const { root, herDir } = makeHome()
  const host = makeHost({ globalNames: ['bash', 'write', 'read', 'read_image', 'qq_bridge_status'] })
  try {
    registerToolRestrict(host.ctx, {
      root,
      herDir,
      mount: (agent) => mountToolDefinitions(agent, defs),
    })

    const her = host.makeAgent({ id: 'session-her-00000000', cwd: herDir })
    host.emit(her)

    // 1) 全部挂进她的 own 层
    assert.equal(host.scopedTools.get(her)?.size, defs.length, '她的会话缺少 scoped 工具')
    const herVisible = her.ctx.tools.view(her).visible
    for (const name of FISH_TOOLS) assert.ok(herVisible.has(name), `${name} 应挂在她的会话上`)
    for (const name of QQ_BRIDGE_TOOLS) assert.ok(herVisible.has(name), `${name} 应挂在她的会话上`)

    // 2) global 层永远没有她的工具（污染源）
    for (const definition of defs) {
      assert.equal(host.globalTools.has(definition.name), false, `${definition.name} 不该进 global 层`)
    }

    // 3) 宿主标准工具被她自己的 restrict 挡在外面；read_image 保留
    assert.equal(herVisible.has('bash'), false)
    assert.equal(herVisible.has('write'), false)
    assert.equal(herVisible.has('read'), false)
    assert.ok(herVisible.has('read_image'), 'read_image 是宿主工具，应该留在 allow 里')

    // 4) restrict 的 allow 里不能出现 scoped 名字（否则宿主会整条抛 unknown）
    const call = host.restrictCalls.find((x) => x.agent === her)
    assert.ok(call, '她这条会话应该下过 restrict')
    for (const name of [...FISH_TOOLS, ...QQ_BRIDGE_TOOLS]) {
      assert.equal(call.allow.includes(name), false, `restrict.allow 不该包含 scoped 工具 ${name}`)
    }
    assert.ok(call.allow.includes('read_image'))

    // 5) 守卫放行她自己的工具、仍然挡住宿主标准工具
    const guard = host.guards.get(her)
    assert.equal(guard({ name: 'fish_search_history' }), undefined)
    assert.equal(guard({ name: 'qq_bridge_send' }), undefined)
    assert.equal(guard({ name: 'bash' }), GUARD_REFUSAL)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('用户工作区的会话看不到任何她的工具', () => {
  rememberKnownTools([])
  const { root, herDir } = makeHome()
  const host = makeHost({ globalNames: ['bash', 'write', 'read', 'read_image'] })
  try {
    registerToolRestrict(host.ctx, {
      root,
      herDir,
      mount: (agent) => mountToolDefinitions(agent, defs),
    })
    const user = host.makeAgent({ id: 'session-user-11111111', cwd: 'C:\\demo\\workspace' })
    host.emit(user)

    const visible = user.ctx.tools.view(user).visible
    for (const name of [...FISH_TOOLS, ...QQ_BRIDGE_TOOLS]) {
      assert.equal(visible.has(name), false, `${name} 不该出现在用户工作区`)
    }
    for (const name of ['bash', 'write', 'read', 'read_image']) {
      assert.ok(visible.has(name), `${name} 应该在（宿主工具不受影响）`)
    }
    assert.equal(host.scopedTools.get(user), undefined, '非她的会话不该被挂载任何工具')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('global 层漏了插件工具时，非她的会话会被 deny 兜底摘掉', () => {
  rememberKnownTools([])
  const { root, herDir } = makeHome()
  const host = makeHost({ globalNames: ['bash', 'write', 'read', 'read_image'] })
  try {
    // 模拟旧版本 / 别的模块把 fish 工具注册进了 global 层
    host.putGlobal({ name: 'fish_search_history', async execute() {} })
    host.putGlobal({ name: 'qq_bridge_send', async execute() {} })

    registerToolRestrict(host.ctx, { root, herDir })
    const user = host.makeAgent({ id: 'session-user-22222222', cwd: 'C:\\demo\\workspace' })
    host.emit(user)

    const visible = user.ctx.tools.view(user).visible
    assert.equal(visible.has('fish_search_history'), false, '漏在 global 的 fish 工具必须被摘掉')
    assert.equal(visible.has('qq_bridge_send'), false, '漏在 global 的 QQ 回复工具必须被摘掉')
    assert.ok(visible.has('bash'), '宿主标准工具不受影响')

    const denyCall = host.restrictCalls.find((x) => x.agent === user && Array.isArray(x.deny))
    assert.ok(denyCall, '应该下过 deny')
    assert.ok(denyCall.deny.includes('fish_search_history'))
    assert.ok(denyCall.deny.includes('qq_bridge_send'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sessionId 命中 home.json 时，即使 cwd 不同也认作她', () => {
  const { root, herDir } = makeHome({ sessionId: 'session-her-33333333' })
  try {
    const byId = { id: 'session-her-33333333', session: { id: 'session-her-33333333', header: { cwd: 'D:\\elsewhere' } } }
    const byCwd = { id: 'session-other', session: { id: 'session-other', header: { cwd: herDir } } }
    const stranger = { id: 'session-user', session: { id: 'session-user', header: { cwd: 'C:\\demo\\workspace' } } }

    assert.equal(isHerAgent(byId, herDir, root), true)
    assert.equal(isHerAgent(byCwd, herDir, root), true)
    assert.equal(isHerAgent(stranger, herDir, root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createToolCapture 只收定义、不注册；mount 重名只挂最后一次；可按轮收放', () => {
  const sink = []
  const capture = createToolCapture({ get: () => undefined }, sink)
  const dispose = capture.tools.register({ name: 'fish_demo', async execute() {} })
  assert.equal(sink.length, 1)
  assert.equal(typeof dispose, 'function')

  const own = new Map()
  const agent = {
    ctx: {
      tools: {
        register(definition) {
          if (own.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
          own.set(definition.name, definition)
          return () => own.delete(definition.name)
        },
      },
    },
  }
  const result = mountToolDefinitions(agent, [
    { name: 'fish_demo', value: 1 },
    { name: 'fish_demo', value: 2 },
    { name: 'fish_other', value: 3 },
  ])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.mounted.sort(), ['fish_demo', 'fish_other'])
  assert.equal(own.get('fish_demo').value, 2, '重名应取最后一次定义')

  // 按轮收放：只留 fish_demo，另一个真的从 own 层卸下；restore 再挂回去。
  const control = result.control
  assert.ok(control)
  assert.deepEqual(control.setAllowed(['fish_demo']), ['fish_demo'])
  assert.equal(own.has('fish_other'), false)
  assert.deepEqual(control.restore().sort(), ['fish_demo', 'fish_other'])
  assert.equal(own.has('fish_other'), true)
})

test('capture ctx 把 on / emit / get 转发给真 ctx（work_request 的完成日志依赖）', () => {
  const calls = []
  const base = {
    get(name) {
      calls.push(['get', name])
      return { ok: true }
    },
    on(name, fn) {
      calls.push(['on', name, typeof fn])
      return () => calls.push(['off', name])
    },
    emit(name, payload) {
      calls.push(['emit', name, payload?.ok])
    },
  }
  const sink = []
  const ctx = createToolCapture(base, sink)
  ctx.tools.register({ name: 'fish_demo' })
  assert.deepEqual(ctx.get('attachments'), { ok: true })
  const off = ctx.on('session/event', () => {})
  ctx.emit('checklog/finished', { ok: true })
  off()
  assert.deepEqual(calls, [
    ['get', 'attachments'],
    ['on', 'session/event', 'function'],
    ['emit', 'checklog/finished', true],
    ['off', 'session/event'],
  ])
  assert.equal(sink.length, 1, 'tools.register 仍然只收定义、不碰真 ctx')
})

test('插件热重载：注册时已经活着的 agent 也会被补挂 / 补 deny', () => {
  rememberKnownTools([])
  const { root, herDir } = makeHome()
  const host = makeHost({ globalNames: ['bash', 'write', 'read', 'read_image'] })
  try {
    const her = host.makeAgent({ id: 'session-her-00000000', cwd: herDir })
    const user = host.makeAgent({ id: 'session-user-33333333', cwd: 'C:\\demo\\workspace' })
    host.putGlobal({ name: 'fish_search_history', async execute() {} })

    registerToolRestrict(host.ctx, {
      root,
      herDir,
      mount: (agent) => mountToolDefinitions(agent, defs),
    })

    // 没有 emit agent/created：注册时的 sweep 应该已经处理了两个活着的 agent
    assert.ok(host.scopedTools.get(her)?.has('fish_search_history'))
    assert.equal(user.ctx.tools.view(user).visible.has('fish_search_history'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('白名单里的四个集合关系没被改坏', () => {
  for (const name of FISH_TOOLS) assert.ok(HER_TOOLS.includes(name))
  for (const name of QQ_BRIDGE_TOOLS) assert.ok(HER_TOOLS.includes(name))
  assert.ok(HER_TOOLS.includes('read_image'))
})
