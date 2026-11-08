/**
 * history-logger.js —— 底层对话持久化（双层记忆的第一层，2026-11-02）
 *
 * ## 为什么要有这个
 *
 * 她换一个新窗口就「失忆」：会话上下文一旦滚动/轮换，之前聊过的原话就只剩
 * 摘要与几条判断。`her_recall` 翻的是事件流（她自己写下的想法），不是对话本身；
 * `talkmem` 只留最近 4 轮。于是用户说「我们刚才聊的暗号是什么」时，她只能编。
 *
 * 这一层只做一件事：把**每一轮他和她的原话**按天追加进
 *   <状态库>/memory/raw_YYYY-MM-DD.jsonl
 * 一行一条，带一个单调自增的 `seq_id`（门牌号）。摘要检索与原文溯源
 * （fish_search_history / fish_read_raw，见 memory.js）都靠这个门牌号对回原话。
 *
 * ## 硬约束（改之前先读）
 *
 *   1. **不碰 events.jsonl**。那份事件流是她的「认知」，只能由 growth_commit 写；
 *      这里记的是「对话原文」，是另一份东西。两边都不许互相改写。
 *   2. **按天分文件、只追加**。一天一个文件，坏了只坏一天；不做压缩、不做摘要——
 *      摘要由 memory.js 每次检索时现生成，落盘的永远是原话。
 *   3. **门牌号先预留、再写正文**。顺序反了就会在崩溃后出现重复 seq_id；
 *      反过来最多留一个空号（无害）。seq 状态在 memory/seq.json。
 *   4. **只存自然语言**。工具调用的 JSON、宿主的 runtime context、以及
 *      say.js 包在正文外面的那句「你想回就回」都不进记忆，见 cleanUserText()。
 *   5. **单条超 2000 字截断**。记忆是给人翻的，不是第二份上下文。
 *
 * ## 接入方式
 *
 * `registerHistoryLogger(ctx, { root, herDir })` 在 `session/event` 上按轮攒
 * user / assistant 的纯文本，`turn/end` 时调 `recordTurn()`。只认**她的会话**
 * （cwd === herDir，与 restrict.js 同一判据）——用户自己的窗口不记。
 *
 * 为什么不放在 qq/index.js：QQ 桥接的 `session/event` 只看 targetSessionId
 * 那一条会话，她在 DSH 侧栏里直接说的话会被漏掉；而且独立安装 dsh-fish
 * （不带 QQ 桥接）时那条链路根本不存在。放在 fish 侧是唯一能覆盖
 * 「侧栏直聊 / QQ / 定时唤醒」三个入口、又不会双写的位置。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { rootDir, writeAtomic } from './store.js'
import { isHerAgent } from './restrict.js'

/** 记忆目录名（状态库根下）。 */
export const MEMORY_DIRNAME = 'memory'
/** 一天一个文件：raw_YYYY-MM-DD.jsonl */
export const RAW_PREFIX = 'raw_'
export const RAW_SUFFIX = '.jsonl'
/** 单条最多存多少字。超出截断，不报错。 */
// @doc fish.memory
export const MAX_TEXT_CHARS = 2000
/** seq 状态的落盘文件。 */
export const SEQ_FILENAME = 'seq.json'

const RAW_RE = /^raw_(\d{4}-\d{2}-\d{2})\.jsonl$/

/** 记忆目录。 */
export function memoryDir(root = rootDir()) {
  return join(root, MEMORY_DIRNAME)
}

/** 某一天的原始对话文件。 */
export function rawFileFor(root, day) {
  return join(memoryDir(root), `${RAW_PREFIX}${day}${RAW_SUFFIX}`)
}

/** seq 状态文件。 */
export function seqFileFor(root) {
  return join(memoryDir(root), SEQ_FILENAME)
}

/** 本地日期键（与 settings.dateKey 同一个口径：按**本机**的日历分天）。 */
export function dayKeyOf(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (!Number.isFinite(d.getTime())) return dayKeyOf(new Date())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 时间戳归一化：Date / epoch ms / ISO 串都能吃，坏值退回「现在」。 */
export function toDate(timestamp) {
  if (timestamp instanceof Date && Number.isFinite(timestamp.getTime())) return timestamp
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return new Date(timestamp)
  if (typeof timestamp === 'string') {
    const t = Date.parse(timestamp)
    if (Number.isFinite(t)) return new Date(t)
  }
  return new Date()
}

/**
 * 存盘前的文本整形：统一换行、去掉首尾空白、折叠过多的空行、截断。
 * 故意**不**做内容清洗（那是调用方的事）——这里只保证一行 JSON 不会太大。
 */
export function clampText(text, max = MAX_TEXT_CHARS) {
  const t = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!t) return ''
  if (t.length <= max) return t
  return t.slice(0, Math.max(1, max - 1)) + '…'
}

/**
 * 从一条消息里取纯文本（只认 text 块；图片、工具调用一律不进记忆）。
 * 兼容 `{ message: {...} }` 与消息本体两种事件形状。
 */
export function textOfMessage(input) {
  const msg = input?.message ?? input
  const content = msg?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 把宿主注入 / 渠道包装从 user 文本里剥掉，只留下「人说的话」。
 *
 * 处理四类东西：
 *   - 宿主的 `<system-reminder>` 与每轮开头的 `Current runtime context…`（不是人话）；
 *   - say.js 的包装：`## 这次` + `## 他跟你说话了` + 正文 + 一堆括号提示；
 *   - 「（醒一醒）」这类叫醒触发语（不是人说的，是场面）；
 *   - QQ 入站 `[QQ · 昵称] …` **原样保留**——那是真人的话，只是带了来源标注。
 *
 * 永不抛；剥完是空串就返回空串（调用方据此不落盘）。
 */
// @doc fish.memory
export function cleanUserText(raw) {
  let t = String(raw ?? '').replace(/\r\n?/g, '\n')
  // 宿主的 runtime context（英文开头，可能很长）：整段不要
  if (/^\s*Current runtime context\b/i.test(t)) return ''
  // 工具结果的 JSON（有些宿主会把它塞成 user 角色）：不是人话
  if (/^\s*\{\s*"type"\s*:\s*"tool_result"/.test(t)) return ''
  // system-reminder 外壳（可能出现在任意位置）
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
  // 剥掉外壳之后如果露出 runtime context，同样不是人话
  if (/^\s*Current runtime context\b/i.test(t)) return ''

  // say.js 的包装：从这里往后才是他真正说的话
  const marker = '## 他跟你说话了'
  const at = t.indexOf(marker)
  if (at >= 0) t = t.slice(at + marker.length)
  // 去掉包装的标题行
  t = t.replace(/^\s*##\s*这次\s*$/m, '')

  // 括号里的操作提示不是对话内容
  const dropLine = /^\s*[（(](?:你想回就回|看不看、说不说|图里如果写着|你要看就用 image_look)/u
  t = t
    .split('\n')
    .filter((line) => !dropLine.test(line))
    .join('\n')

  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!t) return ''
  // 纯括号触发语：（醒一醒）（叫醒）……
  if (/^[（(][^）)]{1,12}[）)]$/u.test(t)) return ''
  return t
}

/**
 * assistant 文本的整形：去掉出站协议标记（`[QQ]` / `[/QQ]` / `[IDLE]`），
 * 保留她原来说的每一个字。
 */
// @doc fish.memory
export function cleanAssistantText(raw) {
  let t = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  t = t.replace(/\[\/?QQ\]/gi, '').replace(/\[IDLE\]/gi, '')
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

/** 目录归一化（Windows 大小写不敏感），只用于比对。 */
function normDir(p) {
  if (!p) return ''
  let s = String(p).replace(/[\\/]+$/, '')
  try {
    s = join(s)
  } catch {
    /* 保持原样 */
  }
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 这条会话是不是她住的屋子。 */
export function sessionIsHers(session, herDir) {
  const want = normDir(herDir)
  if (!want) return false
  const got = session?.header?.cwd ?? session?.cwd ?? ''
  return normDir(got) === want
}

// ---------------------------------------------------------------------------
// 写入队列：同一个状态库的写串行化，避免两轮几乎同时结束时互相抢 seq。
// 队列自身永不进入 rejected —— 否则一次失败会把后面所有写都带走。
// ---------------------------------------------------------------------------
const queues = new Map()

function enqueue(root, task) {
  const key = String(root)
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev.then(task, task)
  queues.set(key, run.then(() => {}, () => {}))
  return run
}

/**
 * 现在的下一个门牌号。优先读 seq.json；没有就扫一遍记忆文件取最大值 + 1。
 *
 * 扫文件只在「seq.json 丢了 / 第一次升级到这一版」时发生一次，
 * 之后每次只读一个几十字节的小文件。
 */
// @doc fish.memory
export async function nextSeq(root = rootDir()) {
  try {
    const raw = JSON.parse(await fs.readFile(seqFileFor(root), 'utf8'))
    const n = Number(raw?.next)
    if (Number.isInteger(n) && n > 0) return n
  } catch {
    /* 没有 / 坏了：退回扫盘 */
  }
  return (await maxSeqOnDisk(root)) + 1
}

/** 扫所有记忆文件，返回最大的 seq_id（没有文件时 0）。 */
export async function maxSeqOnDisk(root = rootDir()) {
  let names = []
  try {
    names = await fs.readdir(memoryDir(root))
  } catch {
    return 0
  }
  // 全部扫一遍再取最大值：事件时间可能比当前文件晚/早（补写的旧档、时钟偏移），
  // 「最新的文件里一定有最大号」这个假设不成立。只在 seq.json 丢了时走这里。
  let max = 0
  for (const name of names.filter((n) => RAW_RE.test(n))) {
    let raw = ''
    try {
      raw = await fs.readFile(join(memoryDir(root), name), 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const n = Number(JSON.parse(s)?.seq_id)
        if (Number.isInteger(n) && n > max) max = n
      } catch {
        /* 半行 / 坏行：跳过 */
      }
    }
  }
  return max
}

/** 文件最后一个字节是不是换行（上次崩在半行时，下次要补一个）。 */
async function endsWithNewline(file) {
  let fh = null
  try {
    const st = await fs.stat(file)
    if (st.size === 0) return true
    fh = await fs.open(file, 'r')
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, st.size - 1)
    return buf[0] === 0x0a
  } catch {
    return true // 文件还不存在：不用补
  } finally {
    try { await fh?.close() } catch { /* ignore */ }
  }
}

/**
 * 记一轮对话。这是 spec 里那个 `recordTurn(userText, assistantText, timestamp)`；
 * 第四个参数 root 是可选的（测试与多状态库用）。
 *
 * 空文本不落盘（"他没说话" 不占一行；她没回也一样）。
 *
 * @param {string} userText 他说的（已清洗）
 * @param {string} assistantText 她说的（已清洗）
 * @param {Date|number|string} [timestamp]
 * @param {string} [root]
 * @returns {Promise<{ok:boolean, seq_ids:number[], file:string}>}
 */
// @doc fish.memory
export function recordTurn(userText, assistantText, timestamp = new Date(), root = rootDir()) {
  const when = toDate(timestamp)
  const day = dayKeyOf(when)
  const ts = when.toISOString()
  const rows = []
  const user = clampText(userText)
  if (user) rows.push({ role: 'user', text: user })
  const assistant = clampText(assistantText)
  if (assistant) rows.push({ role: 'assistant', text: assistant })

  const file = rawFileFor(root, day)
  if (!rows.length) return Promise.resolve({ ok: true, seq_ids: [], file })

  return enqueue(root, async () => {
    const start = await nextSeq(root)
    // 先预留号、再写正文：崩在中间最多留空号，不会出现重复门牌。
    await writeAtomic(seqFileFor(root), JSON.stringify({ next: start + rows.length, updatedAt: ts }, null, 2))
    const records = rows.map((row, i) => ({
      seq_id: start + i,
      ts,
      role: row.role,
      text: row.text,
    }))
    // 上次崩在半行时，先补一个换行，免得新记录粘在坏行后面一起报废。
    const prefix = (await endsWithNewline(file)) ? '' : '\n'
    await fs.appendFile(file, prefix + records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    return { ok: true, seq_ids: records.map((r) => r.seq_id), file }
  })
}

// ---------------------------------------------------------------------------
// 宿主事件接入
// ---------------------------------------------------------------------------

/** event.time 可能是 ISO 串、epoch ms，也可能没有。 */
function eventTime(event) {
  const v = event?.time
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v)
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return new Date(t)
  }
  return new Date()
}

/**
 * 把 `session/event` 接成「按轮攒、轮末落盘」。
 *
 * 每个会话一份草稿；`turn/start` 清空，`user/message` 与 `assistant/message`
 * 往里追加，`turn/end` 交给 recordTurn。只认她的会话。
 *
 * @param {object} ctx
 * @param {{root?:string, herDir?:string, log?:Function, onTurn?:Function}} deps
 *   `onTurn`（2026-11-02 加）：每记下她一輪，就把**清洗后的原话**交给它一份：
 *   `{ sessionId, userText, assistantText, time }`。轮换计数（rotation.js）靠它
 *   拿到 QQ 轮次——放在这里是因为只有这一层同时看得见 QQ / 侧栏 / 唤醒三个入口。
 *   它不许 await、不许抛：记日志不能因为计数或摘要失败而断掉。
 * @returns {() => void} 卸载函数
 */
// @doc fish.memory
export function registerHistoryLogger(ctx, { root = rootDir(), herDir = '', log, onTurn } = {}) {
  /** agent/created 见过的她的会话 id（cwd 判断失效时的第二道判据）。 */
  const herSessions = new Set()
  /** sessionId -> { user: string[], assistant: string } */
  const drafts = new Map()

  const onAgentCreated = ({ agent } = {}) => {
    try {
      if (!herDir || !isHerAgent(agent, herDir)) return
      const sid = agent?.session?.header?.id ?? agent?.session?.id ?? agent?.header?.id ?? ''
      if (sid) herSessions.add(String(sid))
    } catch {
      /* 判断失败只影响这一次登记，不影响日志 */
    }
  }

  const onEvent = (session, event) => {
    try {
      const sid = String(session?.header?.id ?? session?.id ?? '')
      if (!sid) return
      if (!herSessions.has(sid) && !sessionIsHers(session, herDir)) return
      const data = event?.data ?? {}

      if (event?.type === 'turn/start') {
        // 新一轮：丢开上一轮的草稿（正常情况上一轮已在 turn/end 落盘）
        drafts.set(sid, { user: [], assistant: '' })
        return
      }

      if (event?.type === 'user/message') {
        // 宿主的 runtime context 是 plugin 来源，不是人说的话
        const msg = data.message ?? data
        const kind = String(msg?.source?.kind ?? '')
        if (kind.startsWith('plugin:@deepseek-ai/')) return
        // 工具结果不是对话（有些宿主会把它塞成 user 角色）
        if (kind === 'tool' || kind.startsWith('tool:')) return
        const text = cleanUserText(textOfMessage(msg))
        if (!text) return
        const draft = drafts.get(sid) ?? { user: [], assistant: '' }
        // 同一条消息可能以 user/message 重复到达：只在和上一条不同时追加
        if (draft.user[draft.user.length - 1] !== text) draft.user.push(text)
        drafts.set(sid, draft)
        return
      }

      if (event?.type === 'assistant/message') {
        const text = textOfMessage(data.message ?? data)
        if (!text) return
        const draft = drafts.get(sid) ?? { user: [], assistant: '' }
        // surfaceOp 不是 append 时表示整段替换，继续累加会重复
        const replace = event?.surfaceOp && event.surfaceOp !== 'append'
        draft.assistant = replace
          ? text
          : draft.assistant
            ? `${draft.assistant}\n${text}`
            : text
        drafts.set(sid, draft)
        return
      }

      if (event?.type === 'turn/end') {
        const draft = drafts.get(sid)
        drafts.delete(sid)
        if (!draft) return
        const userText = cleanUserText(draft.user.join('\n'))
        const assistantText = cleanAssistantText(draft.assistant)
        if (!userText && !assistantText) return
        const time = eventTime(event)
        void recordTurn(userText, assistantText, time, root).catch((err) => {
          log?.(`[dsh-fish] 对话记忆没写进去：${String(err?.message ?? err).slice(0, 160)}`)
        })
        // 交给轮换计数：同步调用、任何异常都吞掉——计数失败不影响记忆，更不影响对话。
        if (typeof onTurn === 'function') {
          try {
            onTurn({ sessionId: sid, userText, assistantText, time })
          } catch (err) {
            log?.(`[dsh-fish] 轮次回调失败：${String(err?.message ?? err).slice(0, 160)}`)
          }
        }
      }
    } catch (err) {
      // 记日志失败不能影响她的对话本身
      log?.(`[dsh-fish] 对话记忆处理失败：${String(err?.message ?? err).slice(0, 160)}`)
    }
  }

  const offAgent = ctx.on?.('agent/created', onAgentCreated)
  const offEvent = ctx.on?.('session/event', onEvent)
  return () => {
    try { offAgent?.() } catch { /* ignore */ }
    try { offEvent?.() } catch { /* ignore */ }
    drafts.clear()
  }
}
