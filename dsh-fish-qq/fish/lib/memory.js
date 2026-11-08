/**
 * memory.js —— 双层记忆的第二层：摘要检索 + 原文溯源（2026-11-02）
 *
 * 第一层是 history-logger.js：每轮原话按天落进 memory/raw_*.jsonl，带 seq_id。
 * 这一层给她两个工具：
 *
 *   fish_search_history(keyword, limit=3)
 *     关键词检索。**只返回摘要片段 + 门牌号（seq_id）**，每段 ≤100 字。
 *     为什么只给摘要：原文一次全倒进上下文，等于把「回忆」变成「读档」，
 *     几分钟就把窗口撑爆——那正是这次要解决的问题。
 *
 *   fish_read_raw(seq_id | seq_id[])
 *     按门牌号读回**完整原文**（带角色与时间）。摘要可能失真，重要的事
 *     必须回到原话，见 identity.js 里 fish:memory 段的那条规矩。
 *
 * 设计上的硬约束：
 *   - 只读。两个工具都不写任何东西。
 *   - 检索不扫 events.jsonl，只扫 memory/ 下的原始对话——两套记忆不混。
 *   - 输出封顶：摘要每次最多 limit 段（夹 1–10），溯源一次最多 10 条。
 *   - 读盘按 (mtime, size) 缓存解析结果：她连着翻同一批文件时不用反复解析。
 *
 * 守门测试：test/memory.test.mjs。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { defineTool } from './tool.js'
import { toJsonSchema } from './toolschema.js'
import { rootDir } from './store.js'
import { tokensOf } from './recall.js'
import { memoryDir } from './history-logger.js'

/** 工具名（与 restrict.js 的 FISH_TOOLS 保持一致）。 */
export const SEARCH_TOOL_NAME = 'fish_search_history'
export const RAW_TOOL_NAME = 'fish_read_raw'

/** 默认返回几段摘要 / 一次最多几段。 */
export const SEARCH_LIMIT = 3
export const SEARCH_LIMIT_MAX = 10
/** 每段摘要最多多少字（spec 要求 100 字以内）。 */
export const SNIPPET_CHARS = 100
/** 一次最多溯源几条，防止把整个窗口灌满。 */
export const RAW_MAX_IDS = 10

const RAW_RE = /^raw_\d{4}-\d{2}-\d{2}\.jsonl$/

// 解析缓存：file -> { mtimeMs, size, records }
const fileCache = new Map()

/** 列出记忆文件，新的在前。 */
export async function listMemoryFiles(root = rootDir()) {
  try {
    const names = await fs.readdir(memoryDir(root))
    return names
      .filter((n) => RAW_RE.test(n))
      .sort()
      .reverse()
      .map((n) => join(memoryDir(root), n))
  } catch {
    return []
  }
}

/** 读一个文件里的记录。坏行跳过；按 (mtime,size) 缓存。 */
export async function loadRecords(file) {
  let st
  try {
    st = await fs.stat(file)
  } catch {
    return []
  }
  const hit = fileCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.records

  let raw = ''
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const records = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const rec = JSON.parse(s)
      const seq = Number(rec?.seq_id)
      if (!Number.isInteger(seq) || seq <= 0) continue
      if (typeof rec?.text !== 'string' || !rec.text) continue
      const role = rec.role === 'assistant' ? 'assistant' : 'user'
      records.push({ seq_id: seq, ts: String(rec.ts ?? ''), role, text: rec.text })
    } catch {
      /* 半行 / 坏行：跳过，不阻塞整份记忆 */
    }
  }
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, records })
  return records
}

/** 测试用：清缓存（换 root 时不会串，因为 key 是完整路径）。 */
export function resetMemoryCache() {
  fileCache.clear()
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 把记录里的 ts 变成 Date（ISO 串 / epoch ms / Date 都认）。 */
function toDate(ts) {
  if (ts instanceof Date) return ts
  if (typeof ts === 'number') return new Date(ts)
  return new Date(String(ts ?? ''))
}

/** 本地时间 `MM-DD HH:mm`（摘要用这个口径）。 */
export function formatMemoryTime(ts) {
  const d = toDate(ts)
  if (!Number.isFinite(d.getTime())) return ''
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 本地时间 `YYYY-MM-DD HH:mm`（原文溯源用完整日期，方便她分清是哪天）。 */
export function formatMemoryStamp(ts) {
  const d = toDate(ts)
  if (!Number.isFinite(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 本地日期 `MM-DD`。 */
function formatMemoryDay(ts) {
  const full = formatMemoryTime(ts)
  return full ? full.slice(0, 5) : ''
}

function roleLabel(role) {
  return role === 'assistant' ? '你' : '他'
}

/** 压成一行：摘要是用来扫的，不保留换行。 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 截断并加省略号（总长度不超过 max）。 */
function clip(text, max) {
  const t = String(text ?? '')
  if (t.length <= max) return t
  return t.slice(0, Math.max(1, max - 1)) + '…'
}

/** 从命中位置附近截一段，保证关键词尽量还在片段里。 */
function shortenAround(text, max, keyword) {
  const t = oneLine(text)
  if (t.length <= max) return t
  const kw = oneLine(keyword).toLowerCase()
  const idx = kw ? t.toLowerCase().indexOf(kw) : -1
  if (idx < 0) return clip(t, max)
  const before = Math.max(0, Math.min(idx - Math.floor(max / 3), t.length - max))
  const body = t.slice(before, before + max)
  return `${before > 0 ? '…' : ''}${body}${before + max < t.length ? '…' : ''}`
}

/**
 * 一段摘要：命中记录 + 前后各 1 条，组合后 ≤100 字。
 * 每条都带角色（他 / 你），让片段读起来像对话而不是一堆字。
 */
// @doc fish.memory
export function buildSnippet(records, hitIndex, keyword) {
  const parts = []
  const hit = records[hitIndex]
  if (!hit) return ''
  if (hitIndex > 0) {
    const prev = records[hitIndex - 1]
    parts.push(`${roleLabel(prev.role)}：${clip(oneLine(prev.text), 16)}`)
  }
  parts.push(`${roleLabel(hit.role)}：${shortenAround(hit.text, 58, keyword)}`)
  if (hitIndex + 1 < records.length) {
    const next = records[hitIndex + 1]
    parts.push(`${roleLabel(next.role)}：${clip(oneLine(next.text), 16)}`)
  }
  return clip(parts.join(' / '), SNIPPET_CHARS)
}

/**
 * 在全部原始对话里按关键词找，返回带门牌的摘要片段。
 *
 * 纯读；不抛。排序：先按相关度（token 权重 + 整串命中加成），再按时间新。
 * 相邻命中会共享同一个窗口，已经覆盖过的门牌不再重复成第二段。
 *
 * @returns {Promise<{ok:boolean, segments:Array<{text:string, seqIds:number[], ts:string}>, keyword:string}>}
 */
// @doc fish.memory
export async function searchHistory(root, keyword, opts = {}) {
  const query = String(keyword ?? '').trim()
  const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.round(Number(opts.limit) || SEARCH_LIMIT)))
  if (!query) return { ok: false, segments: [], keyword: query }

  const tokens = tokensOf(query)
  if (!tokens.length) return { ok: true, segments: [], keyword: query }

  const files = await listMemoryFiles(root)
  const segments = []
  const covered = new Set()

  for (const file of files) {
    const records = await loadRecords(file)
    if (!records.length) continue

    // 命中打分。新→旧收集；分数相同时新的在前。
    const hits = []
    for (let i = records.length - 1; i >= 0; i--) {
      const text = records[i].text.toLowerCase()
      let score = 0
      for (const tok of tokens) {
        if (!text.includes(tok)) continue
        score += tok.length >= 3 ? tok.length : 1
      }
      if (score <= 0) continue
      // 整串原样命中：比零散 token 更可信，给一个明显的加成
      if (text.includes(query.toLowerCase())) score += 20
      hits.push({ i, score })
    }
    hits.sort((a, b) => b.score - a.score || b.i - a.i)

    for (const h of hits) {
      const from = Math.max(0, h.i - 1)
      const to = Math.min(records.length - 1, h.i + 1)
      const window = records.slice(from, to + 1)
      const seqIds = window.map((r) => r.seq_id)
      // 这个窗口已经（部分）被前一段摘要吃掉了：跳过，别给她两段重复的
      if (seqIds.some((id) => covered.has(id))) continue
      for (const id of seqIds) covered.add(id)
      segments.push({
        text: buildSnippet(records, h.i, query),
        seqIds,
        ts: records[h.i].ts,
      })
      if (segments.length >= limit) return { ok: true, segments, keyword: query }
    }
  }

  return { ok: true, segments, keyword: query }
}

/** 渲染检索结果（给模型看的纯文本，不是 JSON）。 */
export function renderSearch(result) {
  const segments = result?.segments ?? []
  const keyword = result?.keyword ?? ''
  if (!result?.ok) return '没给关键词，翻不了。'
  if (!segments.length) {
    return `没翻到和「${keyword}」有关的回忆。也许你没记下来，也许当时用的是别的说法。`
  }
  const lines = ['[检索到以下相关回忆]']
  for (const seg of segments) {
    const day = formatMemoryDay(seg.ts)
    const when = day ? `${day} ` : ''
    lines.push(`- ${when}${seg.text} (来源seq_id: ${seg.seqIds.join(', ')})`)
  }
  lines.push('[如果觉得记忆不连贯，请调用 fish_read_raw 查看原话]')
  return lines.join('\n')
}

/** 把 seq_id 参数归一化成数字数组（去重保序）。 */
// @doc fish.memory
export function normalizeSeqIds(input) {
  // 模型偶尔会把数组写成 "1024, 1025" 这种字符串：顺手接住，不报错。
  const raw = typeof input === 'string' ? input.split(/[,\s，、]+/).filter(Boolean) : input
  const list = Array.isArray(raw) ? raw : [raw]
  const out = []
  const seen = new Set()
  for (const v of list) {
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/**
 * 按门牌号找回原话。
 *
 * @returns {Promise<{ok:boolean, text:string, found:number[], missing:number[]}>}
 */
// @doc fish.memory
export async function readRaw(root, seqInput) {
  const ids = normalizeSeqIds(seqInput)
  if (!ids.length) return { ok: false, text: '没给门牌号，读不了。', found: [], missing: [] }

  const wanted = ids.slice(0, RAW_MAX_IDS)
  const extra = ids.slice(RAW_MAX_IDS)
  const byId = new Map()

  for (const file of await listMemoryFiles(root)) {
    const records = await loadRecords(file)
    for (const rec of records) {
      if (wanted.includes(rec.seq_id) && !byId.has(rec.seq_id)) byId.set(rec.seq_id, rec)
    }
    if (byId.size === wanted.length) break
  }

  const lines = []
  const found = []
  const missing = []
  for (const id of wanted) {
    const rec = byId.get(id)
    if (!rec) {
      missing.push(id)
      continue
    }
    found.push(id)
    const when = formatMemoryStamp(rec.ts)
    const stamp = when ? `[${when}]` : '[时间不明]'
    lines.push(`${stamp} ${roleLabel(rec.role)}：${rec.text}`)
  }

  if (!lines.length) {
    return {
      ok: false,
      text: `没找到这些原话：${wanted.join(', ')}。可能本来就没记下来。`,
      found,
      missing,
    }
  }

  let text = lines.join('\n\n')
  if (missing.length) text += `\n\n（${missing.join(', ')} 这些门牌号没找到。可能本来就没记下来。）`
  if (extra.length) text += `\n\n（一次最多读 ${RAW_MAX_IDS} 条，后面的 ${extra.join(', ')} 没读。）`
  return { ok: true, text, found, missing }
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

/** fish_search_history：摘要 + 门牌号。 */
// @doc fish.memory
export function registerSearchHistory(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: SEARCH_TOOL_NAME,
      description:
        '翻你自己以前的对话。只记得大概、想不起原话时，用一个关键词来翻。' +
        '它只给你几段摘要和门牌号（seq_id），不会把整段对话倒给你。',
      parameters: toJsonSchema({
        keyword: {
          type: 'string',
          required: true,
          description: '要找什么，一两个词就够（比如「暗号」「香蕉」），别把整句话塞进来。',
        },
        limit: {
          type: 'number',
          required: false,
          description: `最多返回几段摘要，默认 ${SEARCH_LIMIT}，最多 ${SEARCH_LIMIT_MAX}。`,
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['found', 'text'],
        },
        render: (_args, out) => [{ type: 'text', text: out.text }],
      },
      async execute(args) {
        try {
          const result = await searchHistory(root, args?.keyword, { limit: args?.limit })
          return { found: result.segments.length > 0, text: renderSearch(result) }
        } catch {
          return { found: false, text: '你翻了，没翻到。' }
        }
      },
    }),
  )
}

/** fish_read_raw：按门牌号读原文。 */
// @doc fish.memory
export function registerReadRaw(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: RAW_TOOL_NAME,
      description:
        '按门牌号（seq_id）读回原话。摘要可能失真；涉及重要细节、或者前后对不上时，用这个读全文。' +
        `一次最多读 ${RAW_MAX_IDS} 条。`,
      // seq_id 要同时接受数字和数字数组。这里手写标准 JSON Schema，
      // 不走 toJsonSchema：它的简写 DSL 会给没有 type 的 oneOf 补一个 type:'string'。
      parameters: {
        type: 'object',
        properties: {
          seq_id: {
            description: '一个门牌号，或一组门牌号（数组）。',
            oneOf: [
              { type: 'number' },
              { type: 'array', items: { type: 'number' } },
            ],
          },
        },
        required: ['seq_id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['found', 'text'],
        },
        render: (_args, out) => [{ type: 'text', text: out.text }],
      },
      async execute(args) {
        try {
          const r = await readRaw(root, args?.seq_id)
          return { found: r.found.length > 0, text: r.text }
        } catch {
          // 读不动就说读不动，不要装作记得
          return { found: false, text: '这些原话读不出来。' }
        }
      },
    }),
  )
}
