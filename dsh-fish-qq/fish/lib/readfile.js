/**
 * readfile.js —— 她的另一只眼睛：fish_read_file 工具
 *
 * 为什么要有这个（2026-10-27 用户要的）：
 *   到这一刻她只能「看目录」（fish_list_dir），看清了有哪些文件却读不到里面写了什么。
 *   用户让她看看某份文档、某个配置、某段代码，她只能让人把内容贴过来。
 *   现在给她一只**只读**的眼睛：读工作区里的文本文件，也能读她自己的日记与事件流。
 *
 * 两条硬约束（改之前先读）：
 *   1. **绝对只读**。只用 fs.readFileSync / fs.statSync / fs.realpathSync。
 *      严禁引入 writeFile / unlink / rm / child_process —— 她没有任何修改能力。
 *   2. **两份沙箱，各自封死**：
 *      - scope='workspace'：根目录是设置页里的「工作区根目录」（或 DSH_FISH_WORKSPACE）。
 *      - scope='self'    ：根目录是她自己的状态库（~/.dsh-fish），**只放开白名单**里的东西
 *        （事件流、日记、报告、她的房间）。config.json / owner.json 这类参数与凭据不给她读——
 *        她自己读自己的配置，等于把「密码」摊在上下文里。
 *      两份都走：resolve 归一（吃掉 ..、绝对路径顶掉 base）→ 必须严格位于根之下 →
 *      realpath(.native，解析 junction) 再校验一遍 → stat 必须是普通文件、大小封顶。
 *      任何一步越界都返回一句中文原因，**不抛异常**——她那一轮不该被一个路径错误打断。
 *
 * 还有一条体验约束：**别把上下文撑爆**。默认只给 400 行、总共不超过 24000 字；
 * 不够就让她带 offset 接着读，而不是一次把整个文件塞进去。
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { resolveWorkspaceRoot } from './workspace.js'

/** 单次最多读多大的文件。超过就如实说「太大」，不试着读一半再报错。 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 默认给多少行。 */
export const DEFAULT_LINES = 400
/** 一次最多给多少行（她显式要更多也不给，免得一口气吃进整份日志）。 */
export const MAX_LINES = 2000
/** 单次最多返回多少字符（约合 1 万 token 以内）。 */
export const MAX_CHARS = 24_000
/** 判断二进制时看开头多少字节。 */
const BINARY_SNIFF = 8192

/**
 * scope='self' 时唯一能读的东西（相对她的状态库根）。
 *
 * 刻意用**白名单**而不是黑名单：以后状态库里新增什么文件，默认都是「不能读」，
 * 而不是「先读出来再说」。`config.json` / `owner.json` / `logs/` 都不在这里面。
 */
export const SELF_ALLOW = Object.freeze([
  'events.jsonl', // 她自己的事件流（也是她的记忆来源）
  'diary', // 日记
  'out', // 刷站报告
  'home', // 她自己的房间（身份文本等）
  'inbox.md', // 他留给她的话
  'talk-recent.json', // 最近聊天记忆
])

/** Windows 路径大小写不敏感，比对前缀时统一小写；其他平台原样。 */
function norm(p) {
  const s = String(p ?? '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

function isInside(root, resolved) {
  const r = norm(root)
  const v = norm(resolved)
  if (v === r) return true
  const prefix = r.endsWith(sep) ? r : r + sep
  return v.startsWith(prefix)
}

/** 与 listdir.js 同一个理由：Windows 上 realpathSync 不解析 junction，只有 .native 会。 */
function realpath(p) {
  return (realpathSync.native ?? realpathSync)(p)
}

/**
 * 把用户给的路径安全地解析成「沙箱里的一个普通文本文件」。
 *
 * @param {string} root 沙箱根（绝对路径）
 * @param {string} [relPath] 相对根的路径
 * @returns {{ok:boolean, resolved?:string, size?:number, reason?:string, note?:string}}
 */
export function resolveReadFile(root, relPath = '.') {
  const base = String(root ?? '').trim()
  if (!base) return { ok: false, reason: 'no-root', note: '还没说能看哪儿。' }
  let resolved
  try {
    resolved = resolve(base, String(relPath ?? '').trim() || '.')
  } catch (err) {
    return { ok: false, reason: 'bad-path', note: `路径说不通：${String(err?.message ?? err).slice(0, 80)}` }
  }
  if (!isInside(base, resolved)) {
    return { ok: false, reason: 'outside', note: '权限拒绝：只能读工作区里（或我自己的房间里）的文件。' }
  }
  try {
    // 第二道：按真实路径再判一次，沙箱里的符号链接 / junction 指到外面会在这里露馅。
    const real = realpath(resolved)
    const realRoot = realpath(base)
    if (!isInside(realRoot, real)) {
      return { ok: false, reason: 'outside', note: '权限拒绝：只能读工作区里（或我自己的房间里）的文件。' }
    }
    resolved = real
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: 'not-found', note: '没有这个文件。' }
    if (err?.code === 'ENOTDIR') return { ok: false, reason: 'not-found', note: '那不是文件。' }
    return { ok: false, reason: 'unreadable', note: `打不开：${String(err?.message ?? err).slice(0, 80)}` }
  }
  let st
  try {
    st = statSync(resolved)
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: 'not-found', note: '没有这个文件。' }
    return { ok: false, reason: 'unreadable', note: `读不了：${String(err?.message ?? err).slice(0, 80)}` }
  }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file', note: '那是个目录，不是文件。要看清里面有什么，用 fish_list_dir。' }
  if (st.size > MAX_FILE_BYTES) {
    return { ok: false, reason: 'too-big', note: `这个文件太大了（${Math.round(st.size / 1024)}KB），超过 2MB 我读不动。` }
  }
  return { ok: true, resolved, size: st.size }
}

/** 去掉 UTF-8 BOM。别让她在正文最前面读到一截看不见的怪字符。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 字节 → 文本。UTF-8 优先，失败了试 GB18030（中文用户的老 txt 常见），
 * 都不行就老实说不是文本。二进制用 NUL 先粗筛。
 */
export function decodeText(buf) {
  if (!buf || buf.length === 0) return { ok: true, text: '', encoding: 'utf8' }
  const head = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF))
  if (head.includes(0)) return { ok: false, reason: 'binary', note: '这是二进制文件，不是文本，我看不了。' }
  try {
    return { ok: true, text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(buf)), encoding: 'utf8' }
  } catch {
    /* 继续试 GB18030 */
  }
  try {
    return { ok: true, text: stripBom(new TextDecoder('gb18030', { fatal: true }).decode(buf)), encoding: 'gb18030' }
  } catch {
    return { ok: false, reason: 'not-text', note: '这不是能读的文本文件（编码认不出来）。' }
  }
}

/**
 * 读一个文件，按行切一段返回。
 *
 * @param {string} root 沙箱根
 * @param {string} [relPath]
 * @param {{offset?:number, limit?:number}} [opts] offset 从 1 开始
 * @returns {{ok:boolean, text:string, note:string}}
 */
export function readTextFile(root, relPath, opts = {}) {
  const r = resolveReadFile(root, relPath)
  if (!r.ok) return { ok: false, text: '', note: r.note ?? '读不了。' }
  if (r.size === 0) return { ok: true, text: `${r.resolved}（空文件）`, note: '' }

  let buf
  try {
    buf = readFileSync(r.resolved)
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return { ok: false, text: '', note: '这个文件打不开。' }
    return { ok: false, text: '', note: '读不了。' }
  }
  const decoded = decodeText(buf)
  if (!decoded.ok) return { ok: false, text: '', note: decoded.note }

  // 统一换行后再按行切：Windows 的 CRLF 与 Linux 的 LF 得到同一个行号。
  const lines = decoded.text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const total = lines.length

  const offset = Math.max(1, Math.trunc(Number(opts.offset)) || 1)
  const limit = Math.min(MAX_LINES, Math.max(1, Math.trunc(Number(opts.limit)) || DEFAULT_LINES))
  if (offset > total) return { ok: false, text: '', note: `这个文件只有 ${total} 行，没有第 ${offset} 行。` }

  const start = offset - 1
  const picked = lines.slice(start, start + limit)

  // 按字符预算逐行装：宁可少给几行并说清楚，也不要把整段截成半句。
  let body = ''
  let shown = 0
  for (const line of picked) {
    const add = (shown > 0 ? 1 : 0) + line.length
    if (body.length + add > MAX_CHARS) break
    body += shown > 0 ? `\n${line}` : line
    shown += 1
  }
  // 极端情况：单行就超过预算。截断它，别返回空正文。
  if (shown === 0 && picked.length > 0) {
    body = `${picked[0].slice(0, MAX_CHARS)}…`
    shown = 1
  }

  const endLine = start + shown
  const enc = decoded.encoding === 'utf8' ? '' : `，按 ${decoded.encoding} 解码`
  const head = `${r.resolved}（第 ${start + 1}–${endLine} 行 / 共 ${total} 行${enc}）`

  const notes = []
  if (shown < picked.length) notes.push(`这一段太长，只显示到第 ${endLine} 行；用 offset=${endLine + 1} 接着读。`)
  else if (endLine < total) notes.push(`还有 ${total - endLine} 行没显示；用 offset=${endLine + 1} 接着读。`)

  return { ok: true, text: `${head}\n\n${body}`, note: notes.join('') }
}

/**
 * scope='self' 的再一道闸：只认白名单里的那几样。
 * 在 realpath 之后判，所以绕不过（符号链接解析完再对白名单）。
 */
export function selfAllowed(selfRoot, resolved) {
  let rel
  try {
    rel = relative(selfRoot, resolved)
  } catch {
    return false
  }
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return false
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return false
  const top = norm(parts[0])
  return SELF_ALLOW.some((allowed) => norm(allowed) === top)
}

/**
 * 按 scope 分发。deps 里的两个根都可以是 getter（设置改了下一次调用就生效）。
 *
 * @param {{workspaceRoot?:string|Function, selfRoot?:string|Function}} deps
 * @param {{path?:string, scope?:string, offset?:number, limit?:number}} args
 */
export function readForHer(deps = {}, args = {}) {
  const scope = String(args?.scope ?? 'workspace').trim().toLowerCase() || 'workspace'
  const path = String(args?.path ?? '').trim()
  if (!path) return { ok: false, text: '', note: '要读哪个文件？把路径写上。' }

  if (scope === 'workspace') {
    const root = resolveWorkspaceRoot(deps.workspaceRoot)
    if (!root) return { ok: false, text: '', note: '还没说能看哪儿（工作区根目录没配）。' }
    return readTextFile(root, path, args)
  }

  if (scope === 'self') {
    const rootValue = typeof deps.selfRoot === 'function' ? deps.selfRoot() : deps.selfRoot
    const root = String(rootValue ?? '').trim()
    if (!root) return { ok: false, text: '', note: '找不到我自己的房间。' }
    const r = resolveReadFile(root, path)
    if (!r.ok) return { ok: false, text: '', note: r.note }
    // 白名单对**真实根**比对：状态库自己可能是 junction（这里就是），
    // 拿没解析的 root 去 relative() 会算出一串 ..，把所有文件都误拒。
    let realRoot = root
    try { realRoot = realpath(root) } catch { /* 根不存在时上面的 resolve 已经报过错了 */ }
    if (!selfAllowed(realRoot, r.resolved)) {
      return { ok: false, text: '', note: '这个我读不了——我自己的参数和凭据不该进上下文。日记、报告、事件流都能读。' }
    }
    return readTextFile(root, path, args)
  }

  return { ok: false, text: '', note: `没有 ${scope} 这个范围；只能是 workspace（工作区）或 self（我自己的东西）。` }
}

/**
 * 注册 fish_read_file。
 *
 * deps.workspaceRoot：用户工作区的根（设置页那条），可以是 getter。
 * deps.selfRoot     ：她的状态库根（~/.dsh-fish），由 index.js 传进来。
 */
export function registerReadFile(ctx, deps = {}) {
  return ctx.tools.register(
    defineTool({
      name: 'fish_read_file',
      description:
        '读一个文本文件的内容。scope 默认 workspace = 用户干活的那个 DSH 工作区；' +
        'scope 写 self = 我自己的东西（日记、事件流、报告、我的房间）。' +
        '只读。文件太长就用 offset / limit 分几段读，' +
        '别一次把整份日志塞进上下文；要看目录结构用 fish_list_dir。',
      parameters: toJsonSchema({
        path: {
          type: 'string',
          required: true,
          description: '要读的文件，相对根目录写（例如 src/index.js、dsh-fish-qq/README.md）；scope=self 时例如 diary/2026-10-26.md。',
        },
        scope: {
          type: 'string',
          enum: ['workspace', 'self'],
          required: false,
          description: "workspace = 用户的工作区（默认）；self = 我自己的状态库（只放开日记、报告、事件流、我的房间）。",
        },
        offset: {
          type: 'number',
          required: false,
          description: '从第几行开始（从 1 数）；不填 = 第 1 行。',
        },
        limit: {
          type: 'number',
          required: false,
          description: `最多读多少行；不填 = ${DEFAULT_LINES}，最多 ${MAX_LINES}。`,
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '文件内容（带一行路径与行号范围）' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没读到：${out.note}` }],
      },
      async execute(args) {
        return readForHer(deps, args)
      },
    }),
  )
}
