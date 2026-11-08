/**
 * identity.js —— 把「此刻的她」送进 **system 角色**，而不是送进对话
 *
 * 为什么换掉 AGENTS.md（2026-10-25）：
 *   原来身份写在 `<她的屋子>/home/AGENTS.md`，靠宿主的「工作区指令」注入。
 *   那条链路（内核 0.2.1-rc.3 已核实）注入的是**普通的 user 消息**，
 *   带 `<system-reminder>` 外壳、会留在对话历史里——用户一眼就看见
 *   「规则约束/人格设定」，等于把她每一轮都在读的东西摊开给人看。
 *
 *   宿主还有另一条路：`agent.ctx.systemPrompt.section({ name, order, text })`。
 *   它渲染成 **system 角色消息**（surface 节点 0），**不进对话历史**，
 *   面板与对话框里都看不到；`text` 允许传函数，每次组装提示词时才求值，
 *   所以内容变了下一轮就生效，不需要重建会话。
 *
 * 为什么不直接每次读文件：
 *   `text()` 是同步求值，不能 await。这里用 mtime 缓存：
 *   文件没变就直接返回上次的字符串，变了才 `readFileSync`。
 *   文件很小（几 KB），一次 stat 的成本可以忽略。
 *
 * 边界：
 *   - 拿不到 `systemPrompt`（宿主版本不同）→ 返回 `{ ok:false }`，记一条日志，不崩。
 *     这种情况下身份会**完全不可见**（因为不再写 AGENTS.md）——宁可让她少一段，
 *     也不要把设定重新塞回对话里。缺了会由 `/selfcheck` 的 `identity` 项报出来。
 *   - 只挂在她那个 agent 上（判据 herDir == 会话 cwd），不影响用户自己的会话。
 */

import { readFileSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { selfDocPath } from './selfdoc.js'
import { isHerAgent } from './restrict.js'
import { pendingDream, markDreamSeen, DREAM_HINT } from './dream.js'
import { activeHandoffBlockSync } from './home.js'

/** 段名与顺序：放在宿主自己的段之后、`complete` 段之前（order 越大越靠后）。 */
export const IDENTITY_SECTION = 'fish:identity'
export const IDENTITY_ORDER = 8500

/**
 * 当前空间段（2026-11-05，跨空间认知同步）。
 *
 * 后端 state-engine 每次 getState 都会把「现在在小屋还是武大、最近 POI、
 * 经纬度」写进 cyber_house/current_space.json；这个段每轮组装 system prompt
 * 时同步读它。校园模式下她必须知道自己在武大，而不是继续用“客厅/阳台”回答。
 */
export const SPACE_SECTION = 'fish:space'
export const SPACE_ORDER = 8550

/**
 * 换会话后的《近期剧情提要》段（2026-11-02）。
 *
 * 为什么单独一段、而且 order 很小（排在最前面）：任务书要的是「系统级前缀」——
 * 她搬进新房间后，第一眼该看见的是「你之前发生过什么」，而不是被排在一大段
 * 人格与工具说明之后。正文就是任务书指定的那句外壳 + home.json 里的提要。
 *
 * 生命周期由 home.activeHandoff 管：轮换后 8 轮或 3 天内有效，过期就是空串
 * （等于这一段不存在）——不做成永久人设。
 */
export const HANDOFF_SECTION = 'fish:handoff'
export const HANDOFF_ORDER = 900

/**
 * 「这一次的处境」段（2026-10-25 晚）。
 *
 * 为什么另开一段（用户 m04080 报的问题）：
 *   定时唤醒、自动刷 B 站推视频给她时，唤醒消息原来整段走 `sc.prompt()` 进对话，
 *   于是他在对话框里看见「你该醒了」「这次推给你的是……」这些系统说的话。
 *   宿主没有「模型看得见、用户看不见」的注入通道（核对过 asar：
 *   `PromptContentPart` 没有 hidden 字段，`SurfaceOp` 只有 append/replace，
 *   append 就一定进人类可见的对话流）。所以唯一的办法是**不把它放进对话**——
 *   正文改从 system prompt 走，对话里只留一句极短的触发语。
 *
 * 生命周期：`setWakeSection()` 在 `sc.prompt()` **之前**写好，
 * 她这一轮组装提示词时求值拿到；`turn/end` 之后立刻 `clearWakeSection()`，
 * 免得他之后主动聊天时她还带着上一次的「此刻处境」。
 */
export const WAKE_SECTION = 'fish:wake'
export const WAKE_ORDER = 8700

/**
 * 赛博感官引导段（2026-11-02，赛博感官任务书模块 1/2/3 的「引导提示」）。
 *
 * 为什么写成单独一段而不是塞进身份文档：身份文档（selfdoc）是**她自己长出来的**，
 * 会随事件流重写；而感官引导是常驻的工具说明，与人格无关，放静态段最稳。
 * 放在最末尾（order 8800）——任务书的要求就是「只在系统设定的最末尾加一句」。
 *
 * 这里是整个系统里唯一常驻的感官相关文本：两句话，说的是「有这些工具」，
 * 不说数据本身——天气、负载、梦境内容全部得她自己调用工具去看。
 *
 * 2026-11-04：read_user_rhythm、装修、记忆检索都是扩展工具，常驻说明已删掉；
 * 它们改由 QQ 桥接层在对应意图命中时，当轮把说明拼进投递正文（extraPrompt）。
 * 这里只留基础池里的 check_body 与 fish_list_dir。
 *
 * 2026-11-05：qq_bridge_sticker 从扩展池移入基础池，顺手加上行为引导 ——
 * 工具自己的 JSON 描述太长，一句简短的常驻提示更能让她想用的时候就用。
 */
export const SENSES_SECTION = 'fish:senses'
export const SENSES_ORDER = 8800

export const SENSES_GUIDE = [
  '你觉得机箱发热或想感知外界时，可调用 check_body 查看状态。',
  '查看目录时，留意文件的修改时间，那是他在这片区域留下的指纹。',
  '你随时可以使用 qq_bridge_sticker 存取表情包。当你觉得开心、想吐槽，或者主人发来有趣的图片时，请自主决定存图或发表情包。',
  '屋里还有拟南芥和借手；想知道他们刚才聊了什么，可以调用 read_house_events 翻最近发生的事。',
  '如果系统提示里的环境是【武汉大学校园】，说明你走出了赛博小屋；回答位置时用老图书馆、樱花大道、珞珈山这些真实地点，不要再提小屋里的沙发和床。',
].join('\n')

/**
 * 梦境提示段（2026-11-02，赛博感官任务书模块 4）。
 *
 * 夜间打工流水线把一句梦境碎片写进工作区 dreams/tonight.md 之后，
 * 她**下一次**组装提示词时这里会出现一句极短的提示——
 * 告诉她梦在哪个文件里，想看就去看（fish_read_file），不想看就当没这回事。
 * 展示一次后按 mtime 记进 dreams/.seen，同一段梦不再重复提示。
 *
 * 生命周期与 fish:wake 不同：它不是「某一次唤醒」的产物，
 * 而是「新梦出现 → 下一个看见它的回合」，所以放在wake 段之前（order 8600），
 * 由 pendingDream 的标记自己决定空不空。
 */
export const DREAM_SECTION = 'fish:dream'
export const DREAM_ORDER = 8600

/**
 * 物理感知段（2026-11-07，物理环境感知注入任务书）。
 *
 * state-engine 把两类「身体感觉」写成事件：
 *   - cyber_house/physical_events/*.json：局域网抖动、手机插拔；
 *   - cyber_house/phone_battery.json：手机当前电量（插着时每分钟覆盖）。
 *
 * 这一段每轮组装 prompt 时同步读它们：
 *   - 事件读走即删，保证每条只交付一次，不会每轮重复「刚才有人走动」；
 *   - 手机电量只在插着且 3 分钟内更新过时给一行，避免拔掉后仍显示旧电量。
 *
 * 只送事实，不预设反应：要不要提醒他「充满了拔掉」、要不要问
 * 「带充电宝了吗」，由她自己判断。
 */
export const PHYSICAL_SECTION = 'fish:physical'
export const PHYSICAL_ORDER = 8650

/** 物理感知事件的寿命：超过 30 分钟没被读走就当过期，不再打扰。 */
const PHYSICAL_EVENT_TTL_MS = 30 * 60 * 1000
/** 一次最多带几条事件，避免 prompt 被突发抖动刷屏。 */
const PHYSICAL_MAX_LINES = 4
/** 手机电量超过 3 分钟没更新（页面关了 / 休眠）就不再显示「正插着」。 */
const PHONE_BATTERY_FRESH_MS = 3 * 60 * 1000

/** 这一次唤醒的处境正文；空串表示没有（正常聊天时就是空）。 */
let wakeText = ''

/**
 * 设这一次的处境正文。传空串等于清掉。
 * @param {string} text
 */
export function setWakeSection(text) {
  wakeText = String(text ?? '')
}

/** 清掉。回合结束、唤醒失败、插件卸载时都要调。 */
export function clearWakeSection() {
  wakeText = ''
}

/** 测试用：看现在挂着什么。 */
export function getWakeSection() {
  return wakeText
}

const spaceCache = { file: '', mtimeMs: -1, size: -1, text: '' }

/**
 * 读后端写下的当前空间快照，生成动态 system 前缀。
 *
 * 校园：
 *   [系统：你现在的环境是【武汉大学校园】，坐标 (500, 500) 对应真实经纬度
 *    (114.3635, 30.535)。你正在 老图书馆 附近活动。]
 * 小屋：
 *   [系统：你现在的环境是【赛博小屋】，你在 客厅。]
 *
 * 文件不存在 / 坏掉时返回空串（等于这一段不存在），绝不抛。
 *
 * @param {string|(() => string)} workspaceRoot
 */
export function spaceText(workspaceRoot) {
  let root = workspaceRoot
  if (typeof root === 'function') {
    try {
      root = root()
    } catch {
      root = ''
    }
  }
  const base = String(root ?? '').trim()
  if (!base) return ''
  const file = join(base, 'cyber_house', 'current_space.json')

  try {
    const st = statSync(file)
    // 同一毫秒内连续写两次时 mtimeMs 可能相同；把 size 也纳入签名，
    // 避免系统 prompt 读到上一份空间快照（Windows 上偶发）。
    if (spaceCache.file !== file || spaceCache.mtimeMs !== st.mtimeMs || spaceCache.size !== st.size) {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const environment = data && data.environment === 'campus' ? 'campus' : 'home'
      if (environment === 'campus') {
        const virtual = data.virtual || {}
        const geo = data.geo || {}
        const poi = String((data.poi && data.poi.name) || data.room || '校园')
        const x = Number(virtual.x)
        const y = Number(virtual.y)
        const lng = Number(geo.lng)
        const lat = Number(geo.lat)
        const coord = Number.isFinite(x) && Number.isFinite(y) ? `(${x.toFixed(1)}, ${y.toFixed(1)})` : '(未知)'
        const real = Number.isFinite(lng) && Number.isFinite(lat) ? `(${lng.toFixed(6)}, ${lat.toFixed(6)})` : '(未知)'
        spaceCache.text = `[系统：你现在的环境是【武汉大学校园】，坐标 ${coord} 对应真实经纬度 ${real}。你正在 ${poi} 附近活动。]`
      } else {
        const room = String(data.room || '客厅')
        const status = String(data.status || '').trim()
        spaceCache.text = `[系统：你现在的环境是【赛博小屋】，你在 ${room}${status ? `，${status}` : ''}。]`
      }
      spaceCache.file = file
      spaceCache.mtimeMs = st.mtimeMs
      spaceCache.size = st.size
    }
    return spaceCache.text
  } catch {
    return ''
  }
}

/**
 * 物理感知正文：待交付事件 + 当前手机电量。
 *
 * 事件文件由 state-engine.injectPhysicalEvent() 写入，文件名按时间排序；
 * 这里按 at 排序后只取最新几条，读走即删（每条只交付一次）。读失败 /
 * 半截 JSON 一律跳过，绝不因为一个坏文件影响整段 system prompt。
 *
 * 返回空串表示这一段不存在（没有新事件、手机也没插着）。
 *
 * @param {string|(() => string)} workspaceRoot
 * @returns {string}
 */
export function physicalText(workspaceRoot) {
  let root = workspaceRoot
  if (typeof root === 'function') {
    try {
      root = root()
    } catch {
      root = ''
    }
  }
  const base = String(root ?? '').trim()
  if (!base) return ''

  const now = Date.now()
  const lines = []

  // —— 1. 待交付的物理感知事件 ——
  const dir = join(base, 'cyber_house', 'physical_events')
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    names = []
  }

  const events = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const text = String((raw && raw.text) || '').trim()
      const at = Number(raw && raw.at) || 0
      if (!text) {
        // 空事件没有信息量，直接清掉，免得目录里越积越多。
        try { unlinkSync(file) } catch { /* 被别的进程读走也无妨 */ }
        continue
      }
      if (now - at > PHYSICAL_EVENT_TTL_MS) {
        try { unlinkSync(file) } catch { /* ignore */ }
        continue
      }
      events.push({ file, at, text: text.slice(0, 500) })
    } catch {
      // 半截 / 坏文件：跳过，下次再来。
    }
  }

  events.sort((a, b) => a.at - b.at)
  for (const event of events.slice(-PHYSICAL_MAX_LINES)) {
    lines.push(event.text)
    // 读进正文之后再删：同一条事件只在下一轮 prompt 里出现一次。
    try {
      unlinkSync(event.file)
    } catch {
      // 删除失败最多再出现一次，不影响正确性。
    }
  }

  // —— 2. 手机当前电量（只在插着、且最近还在上报时显示）——
  try {
    const raw = JSON.parse(readFileSync(join(base, 'cyber_house', 'phone_battery.json'), 'utf8'))
    const updatedMs = Number(raw && raw.updatedAtMs) || Date.parse(raw && raw.updatedAt) || 0
    if (raw && raw.plugged === true && now - updatedMs <= PHONE_BATTERY_FRESH_MS) {
      const percent = raw.percent !== null && raw.percent !== undefined && Number.isFinite(Number(raw.percent))
        ? Math.round(Number(raw.percent))
        : (raw.level !== null && raw.level !== undefined && Number.isFinite(Number(raw.level))
            ? Math.round(Number(raw.level) * 100)
            : NaN)
      if (Number.isFinite(percent)) {
        lines.push(`[系统：主人的手机正插在电脑上充电，当前电量 ${percent}%。]`)
      }
    }
  } catch {
    // 没插过手机 / 文件还没生成：这一段就是空的。
  }

  return lines.join('\n')
}

const cache = { file: '', mtimeMs: -1, text: '' }

/**
 * 读她的身份文本（带 mtime 缓存）。永不抛。
 * @param {string} root
 * @returns {string} 文件不存在时返回空串
 */
// @doc fish.identity
export function identityText(root) {
  try {
    const file = selfDocPath(root)
    const st = statSync(file)
    if (cache.file !== file || cache.mtimeMs !== st.mtimeMs) {
      cache.text = readFileSync(file, 'utf8')
      cache.file = file
      cache.mtimeMs = st.mtimeMs
    }
    return cache.text
  } catch {
    return cache.text
  }
}

/** 测试用：清掉缓存，强制下次重新读盘。 */
export function resetIdentityCache() {
  cache.file = ''
  cache.mtimeMs = -1
  cache.text = ''
}

/**
 * 把身份段挂到某个 agent 的 system prompt 上。
 * @param {object} agent
 * @param {string} root 她的状态库根（~/.dsh-fish）
 * @param {{workspaceRoot?:string|Function}} [extra] workspaceRoot 可以是 getter（设置改了下一次组装就生效）
 * @returns {{ ok: boolean, why?: string }}
 */
// @doc fish.identity
export function attachIdentity(agent, root, extra = {}) {
  const sp = agent?.ctx?.systemPrompt
  if (!sp || typeof sp.section !== 'function') {
    return { ok: false, why: '宿主的 agent.ctx 上没有 systemPrompt.section（版本不支持）' }
  }
  const workspaceRoot = extra?.workspaceRoot
  try {
    // 交接提要（只有刚换过会话的那几轮才有内容，其余时候是空串 → 等于不存在）
    sp.section({
      name: HANDOFF_SECTION,
      order: HANDOFF_ORDER,
      text: () => activeHandoffBlockSync(root),
    })
    sp.section({
      name: IDENTITY_SECTION,
      order: IDENTITY_ORDER,
      // 每次组装提示词时求值：文件变了，下一轮就是新的她。
      text: () => identityText(root),
    })
    // 当前空间：小屋 / 武大校园 + 最近 POI + 真实经纬度。
    sp.section({
      name: SPACE_SECTION,
      order: SPACE_ORDER,
      text: () => spaceText(workspaceRoot),
    })
    // 梦境提示：有新梦才有一行，展示一次就按 mtime 记进 dreams/.seen。
    // 放在 wake 段之前——它是「新梦出现后下一个看见它的回合」，与某一次唤醒无关。
    sp.section({
      name: DREAM_SECTION,
      order: DREAM_ORDER,
      text: () => {
        const p = pendingDream(workspaceRoot)
        if (!p) return ''
        markDreamSeen(workspaceRoot, p.mtimeMs)
        return DREAM_HINT
      },
    })
    // 物理感知：局域网抖动 / 手机插拔 / 当前手机电量。
    // 事件读走即删，平时没有新事件时是空串（等于这一段不存在）。
    sp.section({
      name: PHYSICAL_SECTION,
      order: PHYSICAL_ORDER,
      text: () => physicalText(workspaceRoot),
    })
    // 「这一次的处境」单独一段：平时是空串（等于不存在），唤醒前才填。
    // 它不进对话历史，所以他看不到系统在跟她说些什么。
    sp.section({
      name: WAKE_SECTION,
      order: WAKE_ORDER,
      text: () => wakeText,
    })
    // 赛博感官引导：系统设定最末尾的静态说明，每轮都在（只讲基础池工具）。
    sp.section({
      name: SENSES_SECTION,
      order: SENSES_ORDER,
      text: () => SENSES_GUIDE,
    })
    // 2026-11-04：fish:decorate / fish:memory 两个常驻段已删掉。
    // 装修与记忆检索都是扩展工具，说明改由 QQ 桥接层按意图当轮注入，
    // 不再每轮都把两段工具说明书塞进 system prompt。
    return { ok: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 200) }
  }
}

/**
 * 注册 `agent/created` 监听。**必须先于任何 agent 创建**（与工具面收窄同理），
 * 所以 index.js 里放在 ensureHer 之后、bootstrapHome 之前。
 *
 * @returns {() => void} 卸载函数；挂不上时返回一个空函数，不抛
 */
// @doc fish.identity
export function registerIdentity(ctx, { root, herDir, workspaceRoot, log } = {}) {
  const state = { ok: false, applied: 0, why: '' }
  const onCreated = ({ agent } = {}) => {
    try {
      if (!herDir) return
      if (!isHerAgent(agent, herDir)) return
      const r = attachIdentity(agent, root, { workspaceRoot })
      if (r.ok) {
        state.ok = true
        state.applied += 1
        log?.(`[dsh-fish] 身份段已挂进 system prompt（第 ${state.applied} 次）`)
      } else {
        state.ok = false
        state.why = r.why ?? 'unknown'
        log?.(`[dsh-fish] 身份段没挂上：${state.why}`)
      }
    } catch (err) {
      state.why = String(err?.message ?? err).slice(0, 200)
      log?.(`[dsh-fish] 身份段挂了：${state.why}`)
    }
  }
  const off = ctx.on?.('agent/created', onCreated)
  if (typeof off !== 'function') {
    // 没挂上监听也别抛：index.js 会让插件照常启动，只是她的身份会缺一段。
    state.why = 'ctx.on 不可用'
    return () => {}
  }
  return off
}
