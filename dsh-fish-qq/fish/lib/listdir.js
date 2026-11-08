/**
 * listdir.js —— 她的眼睛往屋外看一眼：fish_list_dir 工具
 *
 * 为什么要有这个：
 *   她的会话 cwd 是自己的屋子（~/.dsh-fish/home），用户的工作区对她完全不可见。
 *   用户跟她聊「当前项目」时，她只能靠猜。这个工具让她能**看一眼**工作区的文件结构——
 *   仅此而已。
 *
 * 三条硬约束（改之前先读）：
 *   1. **绝对只读**。只用 fs.readdirSync / fs.realpathSync 读目录，
 *      严禁引入 writeFile / unlink / rm / child_process。她没有任何修改能力。
 *   2. **路径沙箱**。根目录来自设置页的「工作区根目录」（或 DSH_FISH_WORKSPACE），
 *      不再写死；没配时工具会说「还没说能看哪儿」，不猜目录。
 *      用户传的 dirPath 先 path.resolve 规范化（.. 和绝对路径都会被归一），
 *      再校验是否严格位于根之下（含根本身）；realpath 再校验一遍，
 *      把「沙箱里的符号链接指向外面」这类逃逸也拦住。越界一律返回权限拒绝，不抛异常。
 *   3. **过滤噪音**。.git / node_modules / __pycache__ 这类庞大又无意义的条目直接不列，
 *      免得把她那点上下文撑爆。条目数也封顶。
 */

import { readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { resolveWorkspaceRoot } from './workspace.js'

/**
 * 沙箱根目录不再写死。
 *
 * 口径：设置页里的「工作区根目录」就是用户当前干活的那个目录。她自己的屋子在
 * 别处（~/.dsh-fish/home），这里给她的是**看用户工作区**的权限。
 * 没配时返回空串，工具如实说「还没说能看哪儿」——猜一个目录比报错更糟。
 */

/**
 * 不列出来的条目：要么庞大（.git / node_modules / __pycache__），
 * 要么纯系统噪音。名字精确匹配，不递归、不模糊匹配。
 */
export const HIDDEN_ENTRIES = Object.freeze([
  '.git', '.svn', '.hg',
  'node_modules', '__pycache__',
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
])
const HIDDEN = new Set(HIDDEN_ENTRIES)

/** 一次最多列几条。多了她看不过来，也白白占上下文。 */
export const MAX_ENTRIES = 200

/** Windows 路径大小写不敏感，比对前缀时统一小写；其他平台原样。 */
function norm(p) {
  const s = String(p ?? '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 判断 resolved 是否位于 root 之下（含 root 本身）。
 * root 必须先补上目录分隔符，否则 D:\x\abc 会被 D:\x 错认为前缀。
 */
function isInside(root, resolved) {
  const r = norm(root)
  const v = norm(resolved)
  if (v === r) return true
  const prefix = r.endsWith(sep) ? r : r + sep
  return v.startsWith(prefix)
}

/**
 * 解析真实路径。
 *
 * ⚠️ Windows 上 `fs.realpathSync` **不解析 junction**（2026-10-26 实测：
 * 对指向别处的 junction 调用它，原样返回 junction 自己的路径，lstat 也
 * 说它不是符号链接）。只有 `.native` 版本会把 junction 解析到真实目标。
 * 所以这里必须走 .native，否则「沙箱里的 junction 指到外面」就漏过去了。
 */
function realpath(p) {
  return (realpathSync.native ?? realpathSync)(p)
}

/**
 * 把用户给的路径安全地解析进沙箱。
 *
 * 步骤：path.resolve 规范化 → 必须位于根之下 → realpath 再校验一遍
 * （符号链接 / junction 把沙箱里的某条路径指到外面，在这一步被拦下）。
 * 任何一步越界都返回拒绝，**不抛异常**——她那一轮不该被一个路径错误打断。
 *
 * @param {string} root 沙箱根（绝对路径）
 * @param {string} [dirPath] 用户给的路径，默认 '.'
 * @returns {{ok:boolean, resolved?:string, reason?:string}}
 */
export function resolveInside(root, dirPath = '.') {
  const base = String(root ?? '').trim()
  if (!base) return { ok: false, reason: '还没说能看哪儿。' }
  let resolved
  try {
    // resolve 自带归一：'..' 会被消化掉，绝对路径直接顶掉 base。
    // 所以校验落在**归一之后**的结果上，绕不开。
    resolved = resolve(base, String(dirPath ?? '.').trim() || '.')
  } catch (err) {
    return { ok: false, reason: `路径说不通：${String(err?.message ?? err).slice(0, 80)}` }
  }
  if (!isInside(base, resolved)) {
    return { ok: false, reason: '权限拒绝：只能查看工作区内的目录。' }
  }
  try {
    // 第二道：按真实路径再判一次。沙箱里某个目录若是指向外面的符号链接/junction，
    // resolve 阶段看不出来（按名字它还在沙箱里），realpath 一解析就露馅。
    const realRoot = realpath(base)
    const real = realpath(resolved)
    if (!isInside(realRoot, real)) {
      return { ok: false, reason: '权限拒绝：只能查看工作区内的目录。' }
    }
    return { ok: true, resolved: real }
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: '没有这个目录。' }
    if (err?.code === 'ENOTDIR') return { ok: false, reason: '那不是目录。' }
    return { ok: false, reason: '打不开。' }
  }
}

/**
 * 把一条 mtime（epoch 毫秒）格式化成 `2026-11-02 03:14:00` 的本地时间。
 * 不是数字（读不到 / 传错了）就返回空串——那一行就不带修改时间，照样列出来。
 * @param {number|null} ms
 * @returns {string}
 */
export function formatMtime(ms) {
  // null / undefined 显式拦掉：Number(null) === 0 是合法数字，会把「没有时间」
  // 渲染成 1970 年。
  if (ms === null || ms === undefined) return ''
  const n = Number(ms)
  if (!Number.isFinite(n)) return ''
  const d = new Date(n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 把目录条目渲染成她容易读的一段。
 *
 * 格式：第一行是目录的绝对路径（让她知道自己站在哪），
 * 然后 `[DIR] src/`、`[FILE] index.js [最后修改: 2026-11-02 03:14:00]`，
 * 目录在前、文件在后，各自按名字排。
 * 目录带尾斜杠，模型解析时不容易把目录当文件；文件带最后修改时间（2026-11-02，
 * 赛博感官任务书模块 3：「那是他在这片区域留下的指纹」）。目录不带修改时间——
 * 目录的 mtime 随增删文件跳动，说的不是「这份东西最后改过」。
 * 条目没有 mtimeMs（比如旧调用方）就退回不带时间的旧行。
 *
 * @param {string} absPath 目录的绝对路径
 * @param {{name:string, isDirectory:() => boolean, mtimeMs?:number}[]} entries Dirent 或同形对象
 * @param {number} [max] 最多列几条
 */
export function renderListing(absPath, entries = [], max = MAX_ENTRIES) {
  const lines = [String(absPath ?? '')]
  const dirs = entries.filter((e) => e?.isDirectory?.()).map((e) => e.name).sort()
  const files = entries
    .filter((e) => !e?.isDirectory?.())
    .map((e) => ({ name: e.name, when: formatMtime(e?.mtimeMs ?? null) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const rows = [
    ...dirs.map((d) => `[DIR] ${d}/`),
    ...files.map((f) => (f.when ? `[FILE] ${f.name} [最后修改: ${f.when}]` : `[FILE] ${f.name}`)),
  ]
  const shown = rows.slice(0, Math.max(1, max))
  lines.push(...shown)
  const more = rows.length - shown.length
  if (more > 0) lines.push(`（还有 ${more} 项没列出）`)
  return lines.filter(Boolean).join('\n')
}

/**
 * 列一个目录（纯函数：读盘只发生在这一处）。
 *
 * @param {string} root 沙箱根
 * @param {string} [dirPath]
 * @returns {{ok:boolean, text:string, note:string}}
 */
export function listDirectory(root, dirPath = '.') {
  const r = resolveInside(root, dirPath)
  if (!r.ok) return { ok: false, text: '', note: r.reason }
  try {
    // withFileTypes：一次 readdir 就能分清目录和文件；mtime 给每个文件单独
    // statSync 一次（条目数有上限，最多 200 次 stat，同一盘上可忽略）。
    // stat 失败（并发删除之类）只是那一行不带时间，不挡列表。
    const entries = readdirSync(r.resolved, { withFileTypes: true })
      .filter((e) => e && typeof e.name === 'string' && !HIDDEN.has(e.name))
      .map((e) => {
        if (e.isDirectory()) return e
        let mtimeMs = null
        try {
          mtimeMs = statSync(join(r.resolved, e.name)).mtimeMs
        } catch {
          /* 这一文件的修改时间读不到，列出来但不带时间 */
        }
        return { name: e.name, isDirectory: () => false, mtimeMs }
      })
    return { ok: true, text: renderListing(r.resolved, entries), note: '' }
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, text: '', note: '没有这个目录。' }
    if (err?.code === 'ENOTDIR') return { ok: false, text: '', note: '那不是目录。' }
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return { ok: false, text: '', note: '这个目录打不开。' }
    return { ok: false, text: '', note: '打不开。' }
  }
}

/**
 * 注册 fish_list_dir 工具。
 *
 * deps.workspaceRoot 是用户工作区的根（设置页里填的那个），可以是字符串，
 * 也可以是 getter（改完设置下一次调用就生效）。注意它和 deps.root（她的状态库
 * ~/.dsh-fish）是两回事；没传就回落到 DSH_FISH_WORKSPACE，再没有就是空串。
 */
export function registerListDir(ctx, deps = {}) {
  return ctx.tools.register(
    defineTool({
      name: 'fish_list_dir',
      description:
        '看一眼当前工作区里有哪些文件和目录：根目录是用户干活的那个 DSH 工作区，' +
        '返回 [DIR] 目录名/ 和 [FILE] 文件名（带最后修改时间）这种列表。只读——你只有查看权限，' +
        '没有任何修改文件的权限。想知道项目结构、或者他提到某个目录时，调它看一看；' +
        '参数留空 = 工作区根目录。',
      parameters: toJsonSchema({
        dirPath: {
          type: 'string',
          required: false,
          description: '要看哪个目录，相对工作区根目录写（比如 src）。留空 = 工作区根目录。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '目录列表' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没看到：${out.note}` }],
      },
      async execute(args) {
        return listDirectory(resolveWorkspaceRoot(deps.workspaceRoot), args?.dirPath)
      },
    }),
  )
}
