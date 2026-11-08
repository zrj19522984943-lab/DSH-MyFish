// qq/shared/outbound-pure.js
//
// 出站侧的纯函数：消息段拼接、QQ 标记块提取、分条校验、截断、去 Markdown。
// 宿主专属（client 不用），不引用宿主对象；唯一的模块内依赖是指令解析那边的
// at 目标归一化。

import { normalizeAtTargets } from './parse-commands.js'

export const MULTI_SEND_MAX = 3

/** 两条消息之间的随机停顿范围（毫秒），模拟打字节奏。 */
export const MULTI_SEND_GAP_MIN_MS = 500

export const MULTI_SEND_GAP_MAX_MS = 1000

/**
 * 把一段出站文本拼成 OneBot v11 消息段数组（at 段 + text 段）。
 *
 * 纯函数、无副作用，导出是为了让测试盯住「哪个 @ 该转、哪个不该转」。
 *
 * @param {unknown} text 要发的正文
 * @param {{atQQ?: unknown}} [options] `atQQ` = 工具显式指定的 at 目标
 * @returns {Array<{type:'at', data:{qq:string}} | {type:'text', data:{text:string}}>}
 */
export function buildMessageSegments(text, { atQQ } = {}) {
  const body = String(text ?? '')
  const parts = []
  const mentioned = new Set()
  // 每次新建正则：带 g 的 RegExp 有 lastIndex 状态，共用会在并发/嵌套调用里串味。
  const re = /@(\d{5,12})(?![0-9A-Za-z_.])/g
  let last = 0
  let match
  while ((match = re.exec(body)) !== null) {
    const prev = match.index > 0 ? body[match.index - 1] : ''
    // 前面紧贴字母/数字/下划线/点 → 邮箱、域名或 ID，不是提及
    if (prev !== '' && /[0-9A-Za-z_.]/.test(prev)) continue
    const before = body.slice(last, match.index)
    if (before !== '') parts.push({ type: 'text', data: { text: before } })
    parts.push({ type: 'at', data: { qq: match[1] } })
    mentioned.add(match[1])
    last = match.index + match[0].length
  }
  const tail = body.slice(last)
  if (tail !== '') parts.push({ type: 'text', data: { text: tail } })

  const head = normalizeAtTargets(atQQ)
    .filter((qq) => !mentioned.has(qq))
    .map((qq) => ({ type: 'at', data: { qq } }))
  return [...head, ...parts]
}

/**
 * 校验 `qq_bridge_send_multi` 的 messages 参数。导出是为了可测试。
 *
 * 判据：
 *   - 必须是数组，长度 1–3（空数组、超过 3 条都拒绝）；
 *   - 每一项必须是非空字符串（去完首尾空白后）；
 *   - 通过时返回**去掉首尾空白**的副本，后面按它逐条发。
 *
 * 失败返回 `{ ok:false, reason, message, index? }`，**不抛异常**——工具要把原因
 * 原样回给模型，让它自己改参数重试。
 *
 * @param {unknown} messages
 * @returns {{ok:true, messages:string[]} | {ok:false, reason:string, message:string, index?:number}}
 */
export function validateMultiSendMessages(messages) {
  if (!Array.isArray(messages)) {
    return { ok: false, reason: 'bad-messages', message: 'messages 必须是字符串数组。' }
  }
  if (messages.length === 0) {
    return { ok: false, reason: 'empty', message: 'messages 至少要有一条，空数组不发。' }
  }
  if (messages.length > MULTI_SEND_MAX) {
    return {
      ok: false,
      reason: 'too-many',
      message: `一次最多发 ${MULTI_SEND_MAX} 条，这次给了 ${messages.length} 条；请拆成几次调用。`,
    }
  }
  const out = []
  for (let i = 0; i < messages.length; i++) {
    if (typeof messages[i] !== 'string') {
      return { ok: false, reason: 'bad-item', index: i, message: `第 ${i + 1} 条不是字符串。` }
    }
    const body = messages[i].trim()
    if (body === '') {
      return { ok: false, reason: 'empty-item', index: i, message: `第 ${i + 1} 条是空的。` }
    }
    out.push(body)
  }
  return { ok: true, messages: out }
}

/**
 * 两条消息之间该停多久：在 500–1000ms 里随机取一个整数。导出是为了可测试。
 *
 * `random` 可注入（测试里给 0 / 0.999 / 0.5 就能盯住边界）；
 * 不在 [0,1) 的返回值按 0 处理，绝不产生 NaN 让 `setTimeout` 变成 0ms。
 */
export function multiSendGapMs(random = Math.random) {
  let r = 0
  try {
    r = Number(random())
  } catch {
    r = 0
  }
  if (!Number.isFinite(r)) r = 0
  r = Math.min(Math.max(r, 0), 0.999999)
  return MULTI_SEND_GAP_MIN_MS + Math.floor(r * (MULTI_SEND_GAP_MAX_MS - MULTI_SEND_GAP_MIN_MS + 1))
}

/**
 * 从整轮回复里抽出**要发到 QQ** 的内容：所有 `[QQ]…[/QQ]` 块，按出现顺序拼接。
 *
 * 没有块就返回空串 —— 默认什么都不发。这是刻意的：DSH 会话里大量内容
 * （技术说明、路径、思考过程）不该出现在 QQ 群里，宁可沉默也不要刷屏。
 * 导出是为了可测试。
 */
// @doc qq.outbound
export function extractQQReply(text) {
  const out = []
  // ⚠️ **开标记必须位于行首**（允许行首空白）。
  //
  // 为什么：正文里若**提到这个标记本身**（例如解释用法时写“把它放进 [QQ] 里”），
  // 那个孤立的开标记会被当成下一个块的开始，正则就会把**中间的整段正文**
  // 一路捕获到后面真正的闭标记 —— 真机上真的发生了，一大段给 DSH 看的正文被发进群。
  // 要求行首即可挡住行内提及，同时保留多行块的能力。
  for (const m of String(text ?? '').matchAll(/^[ \t]*\[QQ\]([\s\S]*?)\[\/QQ\]/gim)) {
    const piece = m[1].trim()
    if (piece !== '') out.push(piece)
  }
  return out.join('\n\n')
}

/**
 * 按字符数封顶，超长就截断并留个明确标记（不要静默丢内容）。
 * 导出是为了可测试。
 */
export function truncateText(text, max) {
  const s = String(text ?? '')
  if (!Number.isFinite(max) || max <= 0) return ''
  return s.length <= max ? s : `${s.slice(0, max)}…（已截断）`
}

/** 出站前把 Markdown 标记抹掉（QQ 不渲染，留着只是噪音）。 */
export function stripMarkdown(text) {
  return String(text)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body) => String(body).trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
    .trim()
}
