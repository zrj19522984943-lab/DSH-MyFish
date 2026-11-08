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

import { readFileSync, statSync } from 'node:fs'
import { selfDocPath } from './selfdoc.js'
import { isHerAgent } from './restrict.js'
import { pendingDream, markDreamSeen, DREAM_HINT } from './dream.js'
import { activeHandoffBlockSync } from './home.js'

/** 段名与顺序：放在宿主自己的段之后、`complete` 段之前（order 越大越靠后）。 */
export const IDENTITY_SECTION = 'fish:identity'
export const IDENTITY_ORDER = 8500

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
 * 这里是整个系统里唯一常驻的感官相关文本：三句话，说的是「有这些工具」，
 * 不说数据本身——天气、负载、节奏、梦境内容全部得她自己调用工具去看。
 */
export const SENSES_SECTION = 'fish:senses'
export const SENSES_ORDER = 8800

/**
 * 赛博小屋装修引导（2026-11-03）。
 *
 * 家具系统给了她一双会改工作区文件的手，但只在 identity 里说「有这间屋子」
 * 不够——她得知道这间屋子可以被她自己布置。放在感官段之后、记忆规矩之前，
 * 仍然属于「工具说明」，不混进她的人格。
 */
export const DECORATE_SECTION = 'fish:decorate'
export const DECORATE_ORDER = 8850
export const DECORATE_GUIDE =
  '你现在有一间赛博小屋（网页可视化）。如果你想让房间更舒服，可以调用 fish_decorate_room 添置或移动家具。比如在书房加个书架，或者在阳台加个摇椅，挑你喜欢的布置。'

/**
 * 记忆检索的规矩（2026-11-02，双层记忆任务书步骤 4）。
 *
 * 为什么必须写成常驻段，而不是只靠工具描述：
 *   `fish_search_history` 返回的是**现生成的摘要片段**，不是原话。模型很容易
 *   把一段残缺的摘要当成事实，接着往下推——那比失忆更糟（失忆她会去翻，
 *   失真她会笃定）。这段规矩把「摘要之后要回原文」变成一条硬性做法，
 *   并且明确禁止基于残片强行推理。
 *
 * 放在系统设定的最末尾（order 8900）：它是工具使用规矩，不是她的人格。
 * 人格与经历仍然只由 selfdoc 提供，这里不写一句关于「她是什么样的人」。
 */
export const MEMORY_SECTION = 'fish:memory'
export const MEMORY_ORDER = 8900

export const MEMORY_GUIDE = [
  '如果你想不起以前聊过什么，可以用 fish_search_history 按关键词翻一翻；它只给摘要片段和门牌号（seq_id），不是原文。',
  '如果你使用 fish_search_history 检索回忆，请记住：检索到的只是摘要片段，可能失真。',
  '如果发现逻辑不连贯，或涉及重要细节，请立刻调用 fish_read_raw 查阅原话，绝对不要基于残缺的摘要强行推理。',
].join('\n')

export const SENSES_GUIDE = [
  '你觉得机箱发热或想感知外界时，可调用 check_body 查看状态。',
  '你可以通过 read_user_rhythm 查看拟南芥今天的工作节奏。',
  '查看目录时，留意文件的修改时间，那是他在这片区域留下的指纹。',
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

const cache = { file: '', mtimeMs: -1, text: '' }

/**
 * 读她的身份文本（带 mtime 缓存）。永不抛。
 * @param {string} root
 * @returns {string} 文件不存在时返回空串
 */
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
    // 「这一次的处境」单独一段：平时是空串（等于不存在），唤醒前才填。
    // 它不进对话历史，所以他看不到系统在跟她说些什么。
    sp.section({
      name: WAKE_SECTION,
      order: WAKE_ORDER,
      text: () => wakeText,
    })
    // 赛博感官引导：系统设定最末尾的三句静态说明，每轮都在。
    sp.section({
      name: SENSES_SECTION,
      order: SENSES_ORDER,
      text: () => SENSES_GUIDE,
    })
    // 小屋装修引导：她有家具工具，但得知道自己可以动这间屋子。
    sp.section({
      name: DECORATE_SECTION,
      order: DECORATE_ORDER,
      text: () => DECORATE_GUIDE,
    })
    // 记忆检索的规矩：摘要只是门牌，重要的事回原文。静态、每轮都在。
    sp.section({
      name: MEMORY_SECTION,
      order: MEMORY_ORDER,
      text: () => MEMORY_GUIDE,
    })
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
