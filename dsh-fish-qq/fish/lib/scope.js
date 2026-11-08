/**
 * scope.js —— 会话级工具隔离（2026-11-08）
 *
 * ## 为什么需要它
 *
 * 插件的工具原来都注册在**插件 ctx** 上（`ctx.tools.register`）。宿主的工具表是
 * 分层可见的：插件 ctx 不在任何一个 agent 的 scope 里，注册进去就落进 global 层，
 * **每个会话都看得见**——包括用户写代码的工作区。她自己的 restrict 只对
 * `cwd === herDir` 的那条会话生效，挡不住别的会话看见这些工具。结果就是用户
 * 的工作区里出现 `fish_search_history` / `fish_decorate_room` 等一整套她的工具，
 * 上下文被污染（2026-11-08 用户报）。
 *
 * ## 宿主给的正确入口
 *
 * `agent.ctx.tools.register(def)`：Cordis 的 service 是 traceable 的，通过
 * `agent.ctx.tools` 访问时 `this.ctx` 会被重绑到调用方上下文，`scopeOf()` 因此
 * 拿到这个 agent 的 scope key；注册落进该 agent 的 **own 层**，只有它自己看得见。
 * （宿主的 `restrict()` 也明确说 own 层不受 allow/deny 影响——所以 scoped 注册
 * 是"只有她能看见"，不是"注册了再挡"。）
 *
 * 但注册必须等到 agent 存在。于是分两步：
 *   1. 插件启动时，用 {@link createToolCapture} 把每个工具的**定义**收进一个数组，
 *      不碰 global 层；
 *   2. `agent/created` 确认是她那条会话后，用 {@link mountToolDefinitions} 把定义
 *      挂进 `agent.ctx.tools`。
 *
 * 这样即使挂载失败，也只影响她自己的会话，用户工作区永远不会出现这些工具。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 归一化目录，用于判断"这条会话是不是她的屋子"。Windows 大小写不敏感。 */
// @doc fish.scope
export function normDir(p) {
  if (!p) return ''
  let s = String(p).replace(/[\\/]+$/, '')
  try {
    s = resolve(s)
  } catch {
    /* 保持原样 */
  }
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 读 `home.json` 里她的身份。
 *
 * 为什么以 sessionId **和** cwd 两个判据：会话会轮换（`chat.rotateAfter`），
 * 轮换后 sessionId 变了但 cwd 永远是她的屋子；反过来，如果用户手动把某个会话的
 * cwd 指到别处，sessionId 还在，也不该因此丢掉工具。两个判据任一命中即可。
 *
 * `rotatedFrom` 也收进来：轮换刚发生、home.json 已经指向新会话时，旧会话若还在
 * 收尾，仍应被认作她。
 *
 * 永不抛：文件不在 / 半截损坏都只返回空集合，调用方退回 cwd 判据。
 */
// @doc fish.scope
export function readHerIdentity(root) {
  const out = { sessionIds: new Set(), wsId: '', title: '' }
  const base = String(root ?? '').trim()
  if (!base) return out
  try {
    const raw = JSON.parse(readFileSync(join(base, 'home.json'), 'utf8'))
    for (const key of ['sessionId', 'rotatedFrom']) {
      const id = String(raw?.[key] ?? '').trim()
      if (id) out.sessionIds.add(id)
    }
    out.wsId = String(raw?.wsId ?? '').trim()
    out.title = String(raw?.title ?? '').trim()
  } catch {
    /* 没有 home.json / 读不动：只靠 cwd */
  }
  return out
}

/**
 * 判断这个 agent 是不是"她"。
 *
 * @param {object} agent  宿主 `agent/created` 里的 agent
 * @param {string} herDir 她的屋子（`<root>/home`，也是她那条会话的 cwd）
 * @param {string} [root] 状态库根（含 home.json）；不给就从 herDir 推
 * @returns {boolean}
 */
// @doc fish.scope
export function isHerAgent(agent, herDir, root) {
  const id = String(agent?.id ?? agent?.session?.id ?? agent?.session?.header?.sessionId ?? '').trim()
  const base = String(root ?? '').trim() || (herDir ? dirname(String(herDir)) : '')
  if (id && readHerIdentity(base).sessionIds.has(id)) return true

  const want = normDir(herDir)
  if (!want) return false
  const got =
    agent?.session?.header?.cwd ??
    agent?.header?.cwd ??
    agent?.session?.cwd ??
    ''
  return normDir(got) === want
}

/**
 * 造一个"只收定义、不注册"的 ctx 门面，给各工具模块的 `registerX(ctx, deps)` 用。
 *
 * 门面把 `ctx.tools` 换成收集器（`register` 只入数组、不碰宿主），其余能力
 * **原样转发给真 ctx**——因为 execute 里还会用到 `ctx.get('attachments')`
 * （image_look）、`ctx.get('sessionController')` + `ctx.on` / `ctx.emit`
 * （work_request 派活后的完成日志监听）。只给 tools/get 两个口不够。
 *
 * 为什么用 Proxy 并把函数绑回真 ctx：这些方法（on / emit / get / effect）都依赖
 * Cordis 的调用方上下文，`this` 必须还是真 ctx；绑回 target 最稳。
 *
 * @param {object} baseCtx 真插件 ctx
 * @param {object[]} sink  收定义的数组（可以是 bundle 里共享的那一个）
 * @returns {object} 给 registerX 用的门面 ctx
 */
// @doc fish.tools
// @doc fish.scope
export function createToolCapture(baseCtx, sink) {
  if (!Array.isArray(sink)) throw new TypeError('createToolCapture: sink 必须是数组')
  const base = baseCtx ?? {}
  const recorder = {
    register(definition) {
      if (definition && typeof definition.name === 'string' && definition.name) {
        sink.push(definition)
      }
      // 注册函数会把这个返回值当 disposer 存起来；定义还没挂，先给个空操作。
      return () => {}
    },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'tools') return recorder
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target)
    },
    has(target, prop) {
      return prop === 'tools' || prop in target
    },
  })
}

/**
 * 每个 agent 的工具挂载控制器（进程内）。
 * agent 销毁后条目自然被 GC；不主动清理，避免在 dispose 顺序里和宿主抢生命周期。
 */
const controls = new WeakMap()

/**
 * 把收集到的工具定义挂进**某一个 agent 自己的层**，并返回一个按轮收放的小控制器。
 *
 * 同名定义只挂最后一次（插件重载 / 重复 apply 时不会因为 duplicate 整条失败）。
 * 单个工具失败不影响其余工具——她少一只手，总比整条会话没有工具好。
 *
 * 为什么还要 controller：QQ 桥接原来用 `agent.ctx.tools.restrict({ allow })` 做
 * **按轮**收窄（这一轮只放开用得到的工具）。restrict 管不到 own 层——她的工具现在
 * 正是 own 层，必须改用"卸下 / 重新挂上"来实现同样的按轮收放。
 *
 * @param {object} agent 宿主 agent（必须有 `agent.ctx.tools.register`）
 * @param {object[]} definitions 工具定义数组
 * @returns {{mounted: string[], failed: string[], control: object|null}}
 */
// @doc fish.tools
// @doc fish.scope
export function mountToolDefinitions(agent, definitions = []) {
  const tools = agent?.ctx?.tools
  if (!tools || typeof tools.register !== 'function') {
    return {
      mounted: [],
      failed: ['agent.ctx.tools.register 不可用（宿主版本不支持会话级注册）'],
      control: null,
    }
  }

  const byName = new Map()
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    const name = definition?.name
    if (typeof name === 'string' && name) byName.set(name, definition)
  }

  const active = new Set()
  const disposers = new Map()
  const failed = []

  const put = (name, definition) => {
    if (active.has(name)) return true
    try {
      const dispose = tools.register(definition)
      disposers.set(name, typeof dispose === 'function' ? dispose : () => {})
      active.add(name)
      return true
    } catch (err) {
      failed.push(`${name}: ${String(err?.message ?? err).slice(0, 180)}`)
      return false
    }
  }

  for (const [name, definition] of byName) put(name, definition)

  const control = {
    /** 全部定义名（不管当前是否挂上）。 */
    names: [...byName.keys()],
    /** 当前真的挂在这个 agent 上的名字。 */
    active: () => [...active],
    /**
     * 这一轮只留下 `allow` 里点到的工具：没点到的卸下，点到的（重新）挂上。
     * 不认识的 / 不属于本插件的名字直接忽略。返回真正挂上的名字。
     */
    setAllowed(allow) {
      const wanted = new Set(
        (Array.isArray(allow) ? allow : [])
          .map((n) => String(n))
          .filter((n) => byName.has(n)),
      )
      for (const name of [...active]) {
        if (wanted.has(name)) continue
        try { disposers.get(name)?.() } catch { /* 已经不在这一层了 */ }
        disposers.delete(name)
        active.delete(name)
      }
      for (const [name, definition] of byName) {
        if (!wanted.has(name) || active.has(name)) continue
        put(name, definition)
      }
      return [...active]
    },
    /** 收回按轮收窄：把全部工具重新挂上。 */
    restore() {
      return control.setAllowed(control.names)
    },
    /** 插件卸载时把挂在这个 agent 上的工具全部摘掉（避免热重载后重名注册失败）。 */
    disposeAll() {
      for (const name of [...active]) {
        try { disposers.get(name)?.() } catch { /* ignore */ }
        disposers.delete(name)
        active.delete(name)
      }
      return []
    },
  }

  controls.set(agent, control)
  return { mounted: [...active], failed, control }
}

/** 取某个 agent 的工具挂载控制器（没挂过就是 null）。 */
export function toolControlFor(agent) {
  return controls.get(agent) ?? null
}

/**
 * 按轮收放某个 agent 的 scoped 工具。
 * @returns {string[]|null} 真正挂上的名字；这个 agent 不是她 / 没挂过工具时返回 null
 */
// @doc fish.scope
export function setAgentToolsAllowed(agent, allow) {
  const control = controls.get(agent)
  if (!control) return null
  return control.setAllowed(allow)
}

/** 把某个 agent 的 scoped 工具全部挂回去。 */
// @doc fish.scope
export function restoreAgentTools(agent) {
  const control = controls.get(agent)
  if (!control) return null
  return control.restore()
}
