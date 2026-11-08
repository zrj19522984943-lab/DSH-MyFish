// qq/shared/parse-commands.js
//
// 指令解析的纯函数 + 指令词常量（宿主专属；client 不用）。
// 判据全部在这里：前缀必须锚定开头、QQ 号 5–12 位、整条消息形状匹配；
// 解析不出来一律返回 null，调用方按普通聊天处理（不报错、不丢消息）。
//
// 纯函数，不引用宿主对象；唯一的模块内依赖是 QQ 号正则。

import { QQ_ID_RE } from './normalize.js'

/** 把正则元字符转义，前缀来自配置时可安全拼接。 */
function escapeRegExp(literal) {
  return String(literal ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const SUBSEND_PREFIX = 'subsend'

export const WHITELIST_PREFIX = 'whitelist'

export const ADMIN_PREFIX = 'admin'

export const FILEGET_PREFIX = 'fileget'

export const FILESEND_PREFIX = 'filesend'

/** 收件箱查询指令的指令词。 */
export const RECEIVE_PREFIX = 'receive'

/** `list` 指令的指令词。 */
export const LIST_COMMAND = 'list'

/** `list` 能看的两个目录（相对工作区根的名字；只有这两个，不开放任意目录）。 */
export const LIST_DIR_NAMES = Object.freeze(['dist', 'managehub'])

export const HELP_COMMAND = 'help'

/** 认得的写法（整条消息必须**恰好**是其中一个，大小写不敏感）。 */
export const HELP_WORDS = Object.freeze(['help', '/help', '帮助', '指令'])

/** 显式 at 目标：接受单个号、逗号/空格分隔的一串、或数组；只留 5–12 位数字。 */
export function normalizeAtTargets(value) {
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    if (item === null || item === undefined) continue
    for (const piece of String(item).split(/[\s,，、;；]+/)) {
      const id = piece.startsWith('@') ? piece.slice(1) : piece
      if (QQ_ID_RE.test(id) && !out.includes(id)) out.push(id)
    }
  }
  return out
}

/**
 * 解析「subsend <QQ号> <内容>」指令。导出是为了可测试。
 *
 * 判据：
 *   - 前缀必须在**开头**（忽略大小写与首尾空白）；消息中间提到 subsend 不算指令。
 *   - 前缀后必须是 5–12 位数字（QQ 号），再接至少一个字符的正文。
 *   - 解析不出来返回 null —— 调用方按**普通聊天**处理，不要报错、不要丢消息。
 *
 * 为什么不让模型自己从正文里拆：前缀解析是**安全判据**（是不是主人下了指令），
 * 交给模型拆就等于把「这条算不算指令」的决定权交了出去，群友伪造一段
 * 「subsend 10000 广告」也能被当成指令。解析放在桥接层，模型只负责润色与发送。
 *
 * @returns {{targetQQ: string, message: string} | null}
 */
// @doc qq.subsend
export function parseSubsendCommand(text, { prefix = SUBSEND_PREFIX } = {}) {
  const head = String(prefix ?? '').trim()
  if (head === '') return null
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const re = new RegExp(`^${escapeRegExp(head)}\\s+(\\d{5,12})\\s+([\\s\\S]+)$`, 'i')
  const m = re.exec(raw)
  if (!m) return null
  const message = m[2].trim()
  if (message === '') return null
  return { targetQQ: m[1], message }
}

/**
 * 解析「whitelist <QQ号>」指令。导出是为了可测试。
 *
 * 判据（与 parseSubsendCommand 同一套）：
 *   - 前缀必须在**开头**（忽略大小写与首尾空白）；消息中间提到 whitelist 不算指令。
 *   - 前缀后必须是 5–12 位数字（QQ 号的合法形状，与 QQ_ID_RE 一致），且**整条消息
 *     到那儿为止** —— `whitelist 10001 你好` 不是指令，按普通聊天处理。
 *     位数限制刻意不放宽成 `\d+`：`whitelist 12` 这种聊天碎片不该被当成指令，
 *     真号都是 5–12 位（与主人给的判据 `^whitelist\s+(\d+)$` 同一意图，按现有QQ号形状收窄）。
 *   - 解析不出来返回 null —— 调用方按**普通聊天**处理：不报错、不丢消息、不回复任何话。
 *
 * @returns {{targetQQ: string} | null}
 */
// @doc qq.whitelist
export function parseWhitelistCommand(text, { prefix = WHITELIST_PREFIX } = {}) {
  const head = String(prefix ?? '').trim()
  if (head === '') return null
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const re = new RegExp(`^${escapeRegExp(head)}\\s+(\\d{5,12})$`, 'i')
  const m = re.exec(raw)
  if (!m) return null
  return { targetQQ: m[1] }
}

/**
 * 解析「admin add <QQ号>」/「admin del <QQ号>」/「admin list」。导出是为了可测试。
 *
 * 判据（与 parseWhitelistCommand 同一套）：
 *   - 前缀必须在**开头**（忽略大小写与首尾空白）；消息中间提到 admin 不算指令。
 *   - QQ 号必须是 5–12 位数字（与 QQ_ID_RE 一致），且**整条消息到那儿为止** ——
 *     `admin add 10001 你好` 不是指令，按普通聊天处理。
 *   - 操作词只认 add / del / list 三个（大小写不敏感）；del 的语义就是「移除」。
 *   - 解析不出来返回 null —— 调用方按**普通聊天**处理：不报错、不丢消息、不回复任何话。
 *
 * @returns {{op:'add', targetQQ:string} | {op:'del', targetQQ:string} | {op:'list'} | null
 */
// @doc qq.admin
export function parseAdminCommand(text, { prefix = ADMIN_PREFIX } = {}) {
  const head = String(prefix ?? '').trim()
  if (head === '') return null
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const mutateRe = new RegExp(`^${escapeRegExp(head)}\\s+(add|del)\\s+(\\d{5,12})$`, 'i')
  const m = mutateRe.exec(raw)
  if (m) return { op: m[1].toLowerCase() === 'add' ? 'add' : 'del', targetQQ: m[2] }
  const listRe = new RegExp(`^${escapeRegExp(head)}\\s+(list|列表)$`, 'i')
  const m2 = listRe.exec(raw)
  if (m2) return { op: 'list' }
  return null
}

/**
 * 解析「fileget <路径>」/「filesend <QQ号> <路径>」指令。导出是为了可测试。
 *
 * 判据（与 parseSubsendCommand 同一套口径）：
 *   - 前缀必须在**开头**（忽略大小写与首尾空白）；消息中间提到 fileget 不算指令。
 *   - filesend 的 QQ 号必须是 5–12 位数字；路径取**其余全部字符**（路径里可以有空格）。
 *   - 解析不出来返回 null —— 调用方按**普通聊天**处理，不要报错、不要丢消息。
 *
 * @returns {{kind:'fileget', path:string} | {kind:'filesend', targetQQ:string, path:string} | null}
 */
export function parseFileCommand(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  // filesend 先判：两个前缀都锚定行首，不会互相吞，但长前缀先试更直白。
  const sendRe = new RegExp(`^${escapeRegExp(FILESEND_PREFIX)}\\s+(\\d{5,12})\\s+([\\s\\S]+)$`, 'i')
  const m1 = sendRe.exec(raw)
  if (m1) {
    const path = m1[2].trim()
    if (path === '') return null
    return { kind: 'filesend', targetQQ: m1[1], path }
  }
  const getRe = new RegExp(`^${escapeRegExp(FILEGET_PREFIX)}\\s+([\\s\\S]+)$`, 'i')
  const m2 = getRe.exec(raw)
  if (m2) {
    const path = m2[1].trim()
    if (path === '') return null
    return { kind: 'fileget', path }
  }
  return null
}

/**
 * 解析「receive」指令。导出是为了可测试。
 *
 * 判据（与 parseHelpCommand 同一套「整条消息恰好是它」的口径）：
 *   - 整条消息（去掉首尾空白）**恰好**等于 receive，大小写不敏感；
 *   - 「receive 一下」「帮我 receive」都不算 —— 那是在聊天，不是在查收件箱；
 *   - 解析不出来返回 null —— 调用方按**普通聊天**处理：不报错、不丢消息、不回话。
 *
 * 权限在 decide() 里判（只有主人 / 管理员才进 `receive` 分支），这里只管文本形状。
 * @returns {{command:string} | null}
 */
// @doc qq.safety
// @doc qq.receive
export function parseReceiveCommand(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  return raw.toLowerCase() === RECEIVE_PREFIX ? { command: RECEIVE_PREFIX } : null
}

/**
 * 解析「list」/「list dist」/「list managehub」指令。导出是为了可测试。
 *
 * 判据（与 parseReceiveCommand 同一套「整条消息恰好是指令」的口径，多个可选参数）：
 *   - 整条消息（去掉首尾空白）恰好是 `list`，或 `list` + 一个**白名单里的目录名**，
 *     大小写不敏感（`LIST DIST` 也认）；参数与指令之间空白随便几个；
 *   - `list 一下`、`帮我 list`、`list dist managehub`、`list 别的目录` 都不算 ——
 *     那是在聊天，不是在列目录；解析不出来返回 null，调用方按**普通聊天**处理
 *     （不报错、不丢消息、不回话）。
 *   - 目录名**只有 dist / managehub 两个**（LIST_DIR_NAMES）：看哪个目录是写死的
 *     白名单，不是开放参数 —— `list receive` 也不认（那是另一条指令）。
 *
 * 权限在 decide() 里判（只有主人 / 管理员才进 `list` 分支），这里只管文本形状。
 * @returns {{command:string, target:string|null} | null} target = null = 两个都列
 */
// @doc qq.safety
// @doc qq.list
export function parseListCommand(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const m = /^list(?:\s+([^\s]+))?$/i.exec(raw)
  if (!m) return null
  const target = m[1] === undefined ? '' : m[1].toLowerCase()
  if (target !== '' && !LIST_DIR_NAMES.includes(target)) return null
  return { command: LIST_COMMAND, target: target === '' ? null : target }
}

/**
 * 解析「help」指令。导出是为了可测试。
 *
 * 判据：
 *   - 整条消息（去掉首尾空白）**恰好**等于 help / /help / 帮助 / 指令；大小写不敏感。
 *   - 「帮我看看这个 help 文档」「help me」都不算 —— 那是在聊天，不是在要列表。
 *   - 返回 null 时调用方按普通聊天处理，不报错、不丢消息。
 *
 * @returns {{command:string} | null}
 */
// @doc qq.safety
// @doc qq.help
export function parseHelpCommand(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  return HELP_WORDS.includes(raw.toLowerCase()) ? { command: HELP_COMMAND } : null
}
