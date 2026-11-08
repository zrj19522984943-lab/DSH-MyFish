// qq/shared/render-text.js
// @doc qq.outbound
//
// 桥接层自己拼的文本：指令回执（help / whitelist / admin / subsend / file）、
// 入站占位符回填（图片 / 表情包 / 文件）、收件箱与 list 报表、时间/文件名小工具。
// 宿主专属（client 不用），纯函数；依赖 node:fs 的只有 uniqueReceiveName（重名探测）。

import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { formatBytes } from './normalize.js'
import { truncateText } from './outbound-pure.js'
import { isOwnerSender, isAdminSender, senderRole } from './identity.js'
import { shortHash } from '../stickers.js'

/** 单条**入站**消息进模型上下文的上限（防有人贴一篇长文把上下文撑爆）。 */
export const MAX_INBOUND_CHARS = 4000

/** `receive` 指令回执里列最近几个文件。 */
export const RECEIVE_REPORT_LIMIT = 5

/** 单个文件的大小上限：50MB。再大既传得慢，也容易被 QQ 风控。 */
export const FILE_MAX_BYTES = 50 * 1024 * 1024

/** 文件段在正文里的占位符（被 `inlineFileNotes` 就地替换掉；与 `[图片]` 同一套口径）。 */
export const FILE_LABEL = '[文件]'

/** `list` 回执里每个目录最多列几行（防刷屏；超了只列最新的并在表头写明总数）。 */
export const LIST_REPORT_LIMIT = 20

/**
 * 可下载的表情包段（mface）在正文里的占位符。
 *
 * 与 `[图片]` 同一套思路：`mapOneBotMessage` 对**每个** mface 段（有没有 URL 都算）
 * 写下这个占位符并把 URL/摘要记进 `mfaces`；`handleInbound` 下载（与图片共用
 * `cacheImage`，落同一个 attachments 目录）后由 `inlineMfaceNotes` **就地**替换：
 * 成功 → `[表情包:<摘要> path=…]`；下不动 → `[表情包:<摘要>]：图片没取到` ——
 * 绝不静默丢弃（用户 2026-10-29 要求）；没带链接的（noUrl 槽位）→ 摘要写回、不报失败。
 *
 * string（CQ 码）形态的 `[CQ:mface]` 扣不到 url/summary，走 `labelForSegment`
 * 兜底成裸 `[表情包]`、没有槽位 —— `inlineMfaceNotes` 多出来的占位符原样保留，互不干扰。
 */
export const MFACE_LABEL = '[表情包]'

/**
 * 交给模型的路径一律写成正斜杠：Windows 反斜杠在 markdown 渲染与 fish 侧工具的
 * 路径处理里会取不到文件（fish/lib/posix.js 的实测结论，同一套规矩）。
 * 只用于**写进文本**的路径；内部读写文件继续用 node:path 原样。
 */
export function slashedPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

/**
 * subsend 指令注入给会话的那段说明（附在正常入站正文之后）。
 *
 * 写成「指令说明」而不是任务清单：目标 QQ 与原文照抄（模型不需要自己拆），
 * 但发什么、怎么说仍由她定（可以润色）。导出是为了可测试。
 */
// @doc qq.subsend
export function renderSubsendInstruction(sub, settings = {}) {
  const target = String(sub?.targetQQ ?? '').trim()
  const message = truncateText(String(sub?.message ?? ''), MAX_INBOUND_CHARS)
  const owner = String(settings?.ownerQQ ?? '').trim()
  return [
    `[系统：这是主人的 subsend 指令${owner !== '' ? `（主人 QQ：${owner}）` : ''}]`,
    `把下面这段话**私聊**发给 QQ ${target}：`,
    `「${message}」`,
    `做法：调用 \`qq_bridge_subsend\` 工具，参数 targetQQ="${target}"、message 写你要发的话（可以直接用上面这段，也可以按你的语气润色，但**不要改目标 QQ 号**）。`,
    '发送结果会回来给你，据实转告主人。这一通道**不受**回复标记块约束，不用写 [QQ] 块。',
  ].join('\n')
}

/**
 * whitelist 指令回给主人的那句话。导出是为了可测试。
 *
 * 三档各带号码：加成功 / 已经在名单里 / 写失败。失败时**只如实转告原因**，
 * 绝不说「加好了」。写失败不等于指令无效 —— 主人看到原因自会去设置界面手动加。
 */
// @doc qq.whitelist
export function whitelistReplyText({ targetQQ, already = false, failed = '' } = {}) {
  const qq = String(targetQQ ?? '').trim()
  if (failed !== '') return `白名单没写成：${failed}`
  if (already === true) return `QQ ${qq} 已经在私聊白名单里了，不用重复加。`
  return `已把 QQ ${qq} 加进私聊白名单，现在就能叫醒我了（不用重启）。`
}

/**
 * admin 指令回给主人的那句话。导出是为了可测试。
 *
 * 各档都如实说：加成功 / 已经在名单里 / 移除成功 / 不在名单里 / 名单内容 / 没写成。
 * 失败时**只如实转告原因**，绝不说「加好了」。
 */
// @doc qq.admin
export function adminReplyText({ op = '', targetQQ = '', already = false, missing = false, failed = '', list = null } = {}) {
  const qq = String(targetQQ ?? '').trim()
  if (failed !== '') return `管理员名单没写成：${failed}`
  if (op === 'add') {
    if (already === true) return `QQ ${qq} 已经在管理员名单里了，不用重复加。`
    return `已把 QQ ${qq} 加进管理员名单（不用重启，立刻生效）。`
  }
  if (op === 'del') {
    if (missing === true) return `QQ ${qq} 不在管理员名单里，不用减。`
    return `已把 QQ ${qq} 从管理员名单里移除（不用重启，立刻生效）。`
  }
  if (op === 'list') {
    const l = Array.isArray(list) ? list : []
    if (l.length === 0) return '管理员名单现在是空的。要加就用「admin add <QQ号>」（只有主人能改这份名单）。'
    return `管理员名单（${l.length} 人）：${l.join('、')}`
  }
  return ''
}

/**
 * fileget / filesend 指令注入给会话的那段说明（附在正常入站正文之后）。导出是为了可测试。
 *
 * 与 renderSubsendInstruction 同一套写法：路径与目标号照抄（模型不需要自己拆），
 * 但怎么说是她的事；边界规矩（路径锁在工作区里）写明，让她知道被拒时该怎么转告。
 *
 * 2026-10-29：`opts.senderId` 是谁，这段说明就按谁的口径写 ——
 * 主人下指令时目标「发给主人」、调 `qq_bridge_fileget`；
 * 管理员下指令时目标「发给这位管理员」、调 `qq_bridge_filesend`（fileget 工具
 * 的目标固定是 ownerQQ，管理员要文件得用 filesend 指定自己的号）。
 * 老调用处不传 senderId = 按主人算，文案一字不变。
 */
export function renderFileInstruction(cmd, settings = {}, opts = {}) {
  const owner = String(settings?.ownerQQ ?? '').trim()
  const path = String(cmd?.path ?? '')
  const boundary = '文件必须在工作区里：路径越界（..）、文件不存在、是目录、超过 50MB 都会被拒绝，把原因如实转告即可。'
  const senderId = String(opts?.senderId ?? '').trim()
  const fromAdmin =
    senderId !== '' && isAdminSender(senderId, settings?.admins) && !isOwnerSender(senderId, owner)
  if (fromAdmin) {
    const who = `管理员（QQ ${senderId}）`
    if (cmd?.kind === 'filesend') {
      const target = String(cmd?.targetQQ ?? '').trim()
      return [
        `[系统：这是${who}的 filesend 指令]`,
        `把工作区里的文件 \`${path}\` 通过 QQ **私聊**发给 QQ ${target}。`,
        `做法：调用 \`qq_bridge_filesend\` 工具，参数 targetQQ="${target}"、path 照抄 "${path}"。`,
        '**不要改目标 QQ 号**；这条通道独立于回复标记块，不用写 [QQ] 块。',
        boundary,
      ].join('\n')
    }
    return [
      `[系统：这是${who}的 fileget 指令]`,
      `把工作区里的文件 \`${path}\` 通过 QQ **私聊**发给这位管理员（QQ ${senderId}）。`,
      `做法：调用 \`qq_bridge_filesend\` 工具，参数 targetQQ="${senderId}"、path 照抄 "${path}"。`,
      '这条通道独立于回复标记块，不用写 [QQ] 块。',
      boundary,
    ].join('\n')
  }
  if (cmd?.kind === 'filesend') {
    const target = String(cmd?.targetQQ ?? '').trim()
    return [
      `[系统：这是主人的 filesend 指令${owner !== '' ? `（主人 QQ：${owner}）` : ''}]`,
      `把工作区里的文件 \`${path}\` 通过 QQ **私聊**发给 QQ ${target}。`,
      `做法：调用 \`qq_bridge_filesend\` 工具，参数 targetQQ="${target}"、path 照抄 "${path}"。`,
      '**不要改目标 QQ 号**；这条通道独立于回复标记块，不用写 [QQ] 块，也不用 qq_bridge_send。',
      boundary,
    ].join('\n')
  }
  return [
    `[系统：这是主人的 fileget 指令${owner !== '' ? `（主人 QQ：${owner}）` : ''}]`,
    `把工作区里的文件 \`${path}\` 通过 QQ **私聊**发给主人。`,
    `做法：调用 \`qq_bridge_fileget\` 工具，参数 path 照抄 "${path}"。`,
    '这条通道独立于回复标记块，不用写 [QQ] 块，也不用 qq_bridge_send。',
    boundary,
  ].join('\n')
}

/**
 * 把一个名字清理成「能当文件名」的形状。导出是为了可测试。
 *
 * 去掉路径分隔符与 Windows 非法字符（`<>:"/\|?*` 与控制字符）、去掉结尾的点和空格
 * （Windows 不允许）、按码点截到 `maxChars`（防 nickname / 文件名本身长到爆 255）。
 * 全清理空了就返回空串（调用方自己兜底「未知」/「未命名文件」）。
 */
// @doc qq.receive
export function sanitizeForFileName(name, maxChars = 80) {
  let s = String(name ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim()
  s = s.replace(/[\s.]+$/g, '')
  if (s === '') return ''
  const chars = [...s]
  return chars.length <= maxChars ? s : chars.slice(0, maxChars).join('')
}

/**
 * 按「发送人昵称_原文件名」生成 receive 目录里的目标路径；重名加序号（`_1`、`_2`…）。
 * 导出是为了可测试。@returns {string} 绝对路径（node:path 原样，写盘用）
 */
// @doc qq.receive
export function uniqueReceiveName(dir, nickname, fileName) {
  const base = String(dir ?? '.') || '.'
  const who = sanitizeForFileName(nickname, 40) || '未知'
  const clean = sanitizeForFileName(fileName, 120) || '未命名文件'
  const ext = extname(clean)
  const stem = ext ? clean.slice(0, clean.length - ext.length) : clean
  const first = join(base, `${who}_${clean}`)
  if (!existsSync(first)) return first
  // 同名按序号往后排；极端情况（同前缀同名已有一万个）退回时间戳，不死循环。
  for (let i = 1; ; i += 1) {
    const p = join(base, `${who}_${stem}_${i}${ext}`)
    if (!existsSync(p)) return p
    if (i > 9999) return join(base, `${who}_${stem}_${Date.now()}${ext}`)
  }
}

/**
 * 把正文里的 `[文件]` 占位符**就地**换成接收结果。导出是为了可测试。
 *
 * 与 `inlineMfaceNotes` 同一套逐位对齐口径：第 n 个槽位对应第 n 个占位符，
 * 多出来的占位符留原样（不往后顶位）。槽位形如
 * `{ ok, path?, size?, name?, from?, reason? }`：
 *   - 收到 → `[文件 path=<绝对路径> 大小=<大小> 来自=<昵称>]`（路径正斜杠，
 *     与 `[图片 path=…]` 同一套写法）；
 *   - 超过上限 / 下载失败 / 没带可下载地址 → `[文件:<名字>]：<原因>` ——
 *     明确写清为什么没有文件，**不静默丢弃**（用户 2026-10-30 要求）。
 */
// @doc qq.receive
export function inlineFileNotes(text, slots) {
  const list = Array.isArray(slots) ? slots : []
  let i = 0
  return String(text ?? '').replace(/\[文件\]/g, (m) => {
    if (i >= list.length) return m
    const slot = list[i]
    i += 1
    const name = String(slot?.name ?? '').trim()
    const head = name === '' ? '[文件' : `[文件:${name}`
    if (slot?.ok === true) {
      const path = slashedPath(slot?.path)
      const from = String(slot?.from ?? '').trim()
      const who = from === '' ? '' : ` 来自=${from}`
      return `${head} path=${path} 大小=${formatBytes(Number(slot?.size) || 0)}${who}]`
    }
    return `${head}]：${String(slot?.reason ?? '没收到').trim()}`
  })
}

/** receive 回执里的时间：`YYYY-MM-DD HH:mm`（本地时区）。导出是为了可测试。 */
export function formatReceiveTime(ms) {
  const v = Number(ms)
  if (!Number.isFinite(v) || v <= 0) return '未知时间'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '未知时间'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * `receive` 指令回给主人的那句话。导出是为了可测试。
 *
 * 内容：收件箱目录、总共几个文件、最近几个（`名字 · 大小 · 接收时间`，按接收时间
 * **从新到旧**）。目录没配（工作区根为空）与空目录都如实说，不编内容。
 * `files` 元素形如 `{ name, size, at }`（`listReceivedFiles()` 的形状）。
 */
// @doc qq.receive
export function buildReceiveReport({ dir = '', files = [], limit = RECEIVE_REPORT_LIMIT } = {}) {
  const root = String(dir ?? '').trim()
  if (root === '') {
    return '收件箱用不了：还没配工作区根目录（receive 目录挂在它下面），去设置里配上就能用了。'
  }
  const list = (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f === 'object')
    .slice()
    .sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0))
  if (list.length === 0) {
    return `收件箱（${slashedPath(root)}）现在是空的——有人发文件过来才会往里存。`
  }
  const n = Math.max(1, Math.min(Number(limit) || RECEIVE_REPORT_LIMIT, 50))
  const top = list.slice(0, n)
  const lines = [`收件箱（${slashedPath(root)}）共 ${list.length} 个文件，最近 ${top.length} 个：`]
  top.forEach((f, idx) => {
    lines.push(`${idx + 1}. ${f.name} · ${formatBytes(Number(f.size) || 0)} · ${formatReceiveTime(f.at)}`)
  })
  return lines.join('\n')
}

/**
 * `list` 指令回给主人的那句话。导出是为了可测试。
 *
 * `results` 由 `listWorkspaceFiles()` 逐目录算好（`target` = null 时就是两个目录），
 * 本函数只管排版，不碰文件系统 —— 方便测试：
 *   - 每个目录一块：表头写**目录全路径**（正斜杠）与文件数，下面每行一个文件
 *     `名字 · 大小 · 修改时间`，按修改时间**从新到旧**；
 *   - 文件数超过 `LIST_REPORT_LIMIT`（20）→ 只列最新 20 个，表头写
 *     「共 N 个文件，只列最近 20 个」（用户 2026-10-30 定的防刷屏口径）；
 *   - 目录不存在 → 「…不存在。」；存在但空着 → 「…是空的。」；
 *   - 工作区根没配 → 整句如实说用不了（两个目录都挂在它下面），不编内容。
 *
 * @param {{root?: string, target?: string|null, results?: Array<object>}} args
 */
// @doc qq.list
export function buildListReport({ root = '', target = null, results = [] } = {}) {
  const base = String(root ?? '').trim()
  if (base === '') {
    return 'list 用不了：还没配工作区根目录（dist / managehub 都挂在它下面），去设置里配上就能用了。'
  }
  const list = (Array.isArray(results) ? results : []).filter((r) => r && typeof r === 'object')
  const blocks = []
  for (const r of list) {
    const head = slashedPath(r.dir)
    if (r.ok === true) {
      const sorted = r.files.slice().sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0))
      if (sorted.length === 0) {
        blocks.push(`${head} 是空的。`)
        continue
      }
      const n = Math.max(1, Math.min(Number(LIST_REPORT_LIMIT) || 20, 100))
      const top = sorted.slice(0, n)
      const title =
        sorted.length > top.length
          ? `${head}（共 ${sorted.length} 个文件，只列最近 ${top.length} 个）：`
          : `${head}（${sorted.length} 个文件）：`
      blocks.push(
        [title, ...top.map((f, idx) => `${idx + 1}. ${f.name} · ${formatBytes(Number(f.size) || 0)} · ${formatReceiveTime(f.at)}`)].join('\n'),
      )
      continue
    }
    if (r.reason === 'not-found') blocks.push(`${head} 不存在。`)
    else if (r.reason === 'unreadable') blocks.push(`${head} 读不了（权限或被占用），列不出来。`)
    else blocks.push(`${head} 列不出来（${String(r?.reason ?? '未知原因')}）。`)
  }
  return blocks.join('\n\n')
}

/**
 * 要发回 QQ 的指令列表。导出是为了可测试。
 *
 * 只列**真的能用**的：subsend 关着就不列它；工作区根没配就标明发文件用不了。
 * 文案按 QQ 的阅读习惯写（短句、一行一条、不加 Markdown 表格）。
 *
 * 2026-10-29：按**发送者的身份**给不同的一份（`opts.senderId` 决定档位）——
 *   - 主人：全部指令（含 admin / whitelist / subsend）；
 *   - 管理员：自己能用的那一份（fileget / filesend + 提醒可以派活），并写明哪些只有主人能用；
 *   - 普通人：只告诉他「能聊天」，其它的得主人来讲。
 * help 本身谁都能用（见 decide()），所以三份列表里都列着 help 自己。
 * 不传 senderId = 按主人那份（老调用处与旧纯函数测试的形状）。
 *
 * @param {object} settings readSettings() 的结果
 * @param {{senderId?: string}} [opts] 这条 help 是谁发的
 * @returns {string}
 */
// @doc qq.help
export function buildHelpText(settings = {}, { senderId = '' } = {}) {
  const s = settings ?? {}
  const owner = String(s.ownerQQ ?? '').trim()
  const who = String(senderId ?? '').trim()
  const role = who === '' ? 'owner' : senderRole(who, { ownerQQ: owner, admins: s.admins })
  const hasWorkspace = String(s.workspaceRoot ?? '').trim() !== ''
  const fileHint = (mine) => (hasWorkspace ? mine : `${mine}（工作区还没配，现在用不了）`)
  const blocks = []

  if (role === 'admin') {
    // 管理员那份：fileget / filesend / receive / list + help；再写清「可以派活」与「哪些只有主人能用」。
    blocks.push(['fileget <相对路径>', fileHint('把工作区里的文件私聊发给你')])
    blocks.push(['filesend <QQ号> <相对路径>', fileHint('把工作区里的文件私聊给指定的人')])
    blocks.push(['receive', '看看收件箱（工作区 receive/ 目录）里最近收到了哪些文件'])
    blocks.push(['list [dist|managehub]', '看看工作区里 dist/ 和 managehub/ 两个目录有哪些文件（不带参数就两个都列）'])
    blocks.push(['help', '发这一份列表'])
    const lines = ['你是管理员，能用的指令：', '']
    for (const [usage, desc] of blocks) {
      lines.push(usage)
      lines.push(`  ${desc}`)
      lines.push('')
    }
    lines.push('除了指令，你也可以直接跟她说要做什么，她会用 work_request 把活派到工作区里做。')
    lines.push('这些只有主人能用，你不能：subsend、whitelist、admin。')
    return lines.join('\n').trimEnd()
  }

  if (role === 'other') {
    // 普通人那份：能聊天；其它的得主人来讲。不列任何有副作用的指令。
    return [
      '你发的消息她会看到，但只能聊天。',
      '',
      'help',
      '  发这一份列表',
      '',
      '除了聊天之外的事（派活、发文件、加好友、改名单）都不行，得主人来讲。',
    ].join('\n').trimEnd()
  }

  // 主人那份：全部指令。
  if (s.subsendEnabled !== false) {
    blocks.push(['subsend <QQ号> <内容>', '把这段话私聊给指定的人'])
  }

  blocks.push(['fileget <相对路径>', fileHint('把工作区里的文件私聊发给我')])
  blocks.push(['filesend <QQ号> <相对路径>', fileHint('把工作区里的文件私聊给指定的人')])
  blocks.push(['receive', '看看收件箱（工作区 receive/ 目录）里最近收到了哪些文件'])
  blocks.push(['list [dist|managehub]', '看看工作区里 dist/ 和 managehub/ 两个目录有哪些文件（不带参数就两个都列）'])
  blocks.push(['whitelist <QQ号>', '把指定 QQ 直接加进私聊白名单（立刻生效，不用重启）'])
  blocks.push(['admin add <QQ号>', '把这个 QQ 加进管理员名单（管理员能派活、能用 fileget / filesend）'])
  blocks.push(['admin del <QQ号>', '把这个 QQ 从管理员名单里移除'])
  blocks.push(['admin list', '看看管理员名单里现在有谁'])
  blocks.push(['help', '发这一份列表'])

  const lines = ['大肥鱼能用的指令（只有主人发了才管用）', '']
  for (const [usage, desc] of blocks) {
    lines.push(usage)
    lines.push(`  ${desc}`)
    lines.push('')
  }
  lines.push('指令要写在消息开头，整条消息就是它，大小写都行。')
  lines.push('别的话都当普通聊天。')
  if (owner !== '') lines.push(`主人的 QQ：${owner}`)
  return lines.join('\n').trimEnd()
}

/**
 * 把正文里的 `[图片]` 占位符**就地**换成 `[图片 path=… #<短哈希>]：描述`。导出是为了可测试。
 *
 * 为什么不再把描述另起一段附在消息末尾：模型会读到两段 —— 正文里的“[图片] 文字”，
 * 加上末尾的“[图片]：描述”。两段合起来会被读成“前面这张图没解析出来、
 * 后面又来了一张”。位置本身就是信息。（2026-10-01 用户真机反馈。）
 *
 * 为什么占位符里带短哈希：描述“可能不准”，而模型需要**指着一张具体的图**说话
 *（“把刚才那张存下来”）。短哈希是那张图在插件里唯一的稳定标识，模型能把它原样交给
 * `qq_bridge_sticker` 的 `save` / `send`。哈希取不到时退回不带 # 的 `[图片]`。
 *
 * 为什么从 2026-10-29 起占位符里还带 `path=`（用户要求）：目标会话的模型多半看不了图
 *（附件会被系统剥成 “image omitted”），多模态描述也可能失败或不准 ——
 * **落盘文件的路径才是这张图本身**。模型拿着路径调 `image_look` 就能亲眼看，
 * 不再只能复述一句可能不准的描述。路径一律正斜杠（fish 侧与 markdown 渲染都按它取文件）。
 * 落盘失败的图没有 path：占位符退回不带路径的写法，描述位写「（未描述）」。
 *
 * `noteById` 的值形如 `{ text, hash }`（也接受裸字符串 = 只有 text）。
 *
 * ⚠️ `images` 必须与正文里的占位符**逐位对齐**：第 n 个元素对应第 n 个占位符。
 * 元素为 `null` 表示那张图没有描述（落盘失败）—— 该占位符写成 `[图片]（未描述）`，
 * 并且**不占用**其它图片的描述（后面的图不得往前顶位）。
 * 多出来的占位符留原样。
 */
export function inlineImageNotes(text, images, noteById) {
  const list = Array.isArray(images) ? images : []
  const notes = noteById instanceof Map ? noteById : new Map()
  let i = 0
  return String(text ?? '').replace(/\[图片\]/g, (m) => {
    if (i >= list.length) return m
    const image = list[i]
    i += 1
    const path = slashedPath(image?.path)
    const head = path === '' ? '[图片' : `[图片 path=${path}`
    const raw = notes.get(image)
    if (raw === undefined || raw === null) return `${head}]（未描述）`
    const note = typeof raw === 'string' ? { text: raw } : raw
    const short = shortHash(note.hash ?? image?.hash)
    // 有 path 时短哈希前留个空格（`[图片 path=… #a1b2c3]`），没 path 时保持老写法 `[图片#a1b2c3]`。
    const tag = short === '' ? '' : path === '' ? `#${short}` : ` #${short}`
    return `${head}${tag}]：${note.text ?? ''}`
  })
}

/**
 * 把正文里的 `[表情包]` 占位符**就地**换成下载结果。导出是为了可测试。
 *
 * 与 `inlineImageNotes` 同一套逐位对齐口径：第 n 个槽位对应第 n 个占位符，
 * 多出来的占位符留原样。槽位形如 `{ path?, summary?, noUrl? }`：
 *   - 下载成功 → `[表情包:<摘要> path=<路径>]`（没摘要就不要那截 `:摘要`）；
 *   - 下载失败 → `[表情包:<摘要>]：图片没取到` —— 明确的占位提示，**不静默丢弃**；
 *   - `noUrl`（mface 本来就没带链接）→ 占位符照旧，不写「没取到」（那不是下载失败）。
 *
 * 表情包不挂多模态描述（它是个表情，不是要「读懂」的信息）；她要看就用
 * `image_look` 照抄 `path=` 后面那段。
 */
export function inlineMfaceNotes(text, slots) {
  const list = Array.isArray(slots) ? slots : []
  let i = 0
  return String(text ?? '').replace(/\[表情包\]/g, (m) => {
    if (i >= list.length) return m
    const slot = list[i]
    i += 1
    const summary = String(slot?.summary ?? '').trim()
    const head = summary === '' ? '[表情包' : `[表情包:${summary}`
    if (slot?.noUrl === true) return `${head}]`
    const path = slashedPath(slot?.path)
    if (path === '') return `${head}]：图片没取到`
    return `${head} path=${path}]`
  })
}
