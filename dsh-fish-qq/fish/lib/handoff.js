/**
 * handoff.js —— 换会话时的「摘要交接」（2026-11-03 重写）
 *
 * ## 这次改了什么
 *
 * 2026-11-02 那版先试宿主 llm，失败再退回外部「打工 API」（Atria-Dawn / INTERN_API_KEY /
 * QQ 卡片里的 pipelineWorkerKey）。真机跑下来：宿主调用**总是返回空**，于是每次都掉进
 * 外部 API，一次 40–70 秒；慢的时候直接把 `handoffPending` 拖到 60 秒，新会话的第一条
 * 消息被 `waitHandoffReady()` 挡在那里，看起来就是「轮转卡死」。
 *
 * 现在**彻底删掉外部 API**，只走宿主自己的 LLM 服务（`ctx.get('llm').stream`），
 * 也就是大肥鱼聊天用的那条模型链路：
 *
 *   - 模型：`chat.handoff.provider/model` → 部署默认模型（agentDefaultModel.currentSelection()）
 *     → provider 列表里名字带 flash/mini/cheap 的；
 *   - 推理强度：显式选**最低**的一档（`resolveModelInfo().reasoning.efforts` 里
 *     none/off/minimal/low 优先）。这是「返回空」的根因——默认 high 推理会把
 *     maxTokens 全烧在思考上，正文一个字都没有；
 *   - 预算：第一次 2500 tokens，空正文且 finish 是 length/max-tokens 时再给一次 6000；
 *   - 硬超时：整次摘要 10 秒（home.js 里还有一层看门狗，见下）。
 *
 * 失败（超时 / 空 / 报错）不再抛给轮换：调用方拿 `ok:false`，用最近 4 轮原话兜底。
 *
 * ## 硬约束
 *
 *   1. **只读记忆文件**，摘要落在 home.json / home/handoff.md。
 *   2. **不许编**：模型失败就用原话兜底，再不行就明说「记忆交接失败」。
 *   3. 这里不碰任何外部凭证。
 *   4. 提要长度由 maxChars 夹住（默认 300）。
 */

import { readJson } from './store.js'
import { loadConfig } from './settings.js'
import { listMemoryFiles, loadRecords } from './memory.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 默认取多少轮对话来压缩。 */
export const HANDOFF_TURNS = 30
/** 提要默认字数上限（任务书要求 300 字左右）。 */
export const HANDOFF_MAX_CHARS = 300
/** 喂给模型的单条原话最多多少字。 */
export const TRANSCRIPT_LINE_CHARS = 400
/** 喂给模型的全文最多多少字。 */
export const TRANSCRIPT_MAX_CHARS = 9000
/** 摘要生成的硬上限（任务书要求 10 秒）。 */
// @doc fish.handoff
export const HANDOFF_TIMEOUT_MS = 10_000
/** 第一次请求的 token 预算；空正文且被截断时用 RETRY_MAX_TOKENS 再试一次。 */
export const FIRST_MAX_TOKENS = 2_500
export const RETRY_MAX_TOKENS = 6_000
/** 模型也不可用时的兜底正文。 */
export const FAILED_HANDOFF_TEXT = '记忆交接失败，请调用 fish_search_history 查找之前的记忆'
/** 兜底用多少轮原话。 */
// @doc fish.handoff
export const FALLBACK_TURNS = 4
/** 模型池单次请求的硬上限（与 qq 侧两条测试路由一致）。 */
export const MODEL_POOL_TIMEOUT_MS = 10_000
/** 模型池摘要请求的 token 预算（正文 300 字，800 够用）。 */
export const MODEL_POOL_MAX_TOKENS = 800
/** 给宿主原生 LLM 预留的兜底时间：模型池再慢，也要留出这一段。 */
export const HOST_FALLBACK_RESERVE_MS = 2_000

/** 固定 3 个槽位（与 qq 设置卡片、qq/index.js 的 normalizeModelPool 同形）。 */
export function normalizeModelPool(raw) {
  const rows = Array.isArray(raw) ? raw : []
  const out = []
  for (let i = 0; i < 3; i += 1) {
    const row = rows[i] && typeof rows[i] === 'object' ? rows[i] : {}
    out.push({
      enabled: row.enabled === true,
      apiUrl: String(row.apiUrl ?? '').trim(),
      apiKey: String(row.apiKey ?? '').trim(),
      modelName: String(row.modelName ?? '').trim(),
    })
  }
  return out
}

/** 第一个「已启用且填全」的槽位；没有就 null。 */
export function pickModelPoolSlot(raw) {
  for (const slot of normalizeModelPool(raw)) {
    if (slot.enabled && slot.apiUrl && slot.apiKey && slot.modelName) return slot
  }
  return null
}

function modelApiBase(apiUrl) {
  const raw = String(apiUrl ?? '').trim()
  if (raw === '') throw new Error('API 地址为空')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('API 地址不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('API 地址只支持 http / https')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export function chatEndpointOf(apiUrl) {
  const base = modelApiBase(apiUrl)
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

/**
 * 读取模型池配置。
 *
 * 优先用调用方直接传进来的数组（测试 / 以后别的调用点）；否则读
 * `$DSH_HOME/qq-bridge-settings.json` 的 `values.modelPool` —— 那就是 QQ 设置页
 * 卡片保存的位置。读不到/坏了都当没配，**绝不抛**。
 */
export async function loadModelPool(cfg = {}, opts = {}) {
  if (Array.isArray(opts.modelPool)) return normalizeModelPool(opts.modelPool)
  if (Array.isArray(cfg?.modelPool)) return normalizeModelPool(cfg.modelPool)
  if (Array.isArray(cfg?.chat?.handoff?.modelPool)) return normalizeModelPool(cfg.chat.handoff.modelPool)
  const file = opts.modelPoolFile
    ? String(opts.modelPoolFile)
    : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-settings.json')
  try {
    // 刻意不用 store.js 的 readJson：它遇到坏 JSON 会把文件改名成 .corrupt.*。
    // 这是 **qq 的设置文件**，不是鱼的；坏文件只该当“没配”，绝不能动它。
    const text = await readFile(file, 'utf8')
    const raw = JSON.parse(text)
    return normalizeModelPool(raw?.values?.modelPool)
  } catch {
    return normalizeModelPool([])
  }
}

/** 从 OpenAI 兼容错误体里抠一句能看的说明。 */
function providerErrorText(payload, fallback = '') {
  if (!payload || typeof payload !== 'object') return fallback
  if (typeof payload.error === 'string') return payload.error
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message
  if (typeof payload.message === 'string') return payload.message
  return fallback
}

function short(text, max = 160) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

function timeoutLabel(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms)} 毫秒`
}

/** 关闭思考的请求体变体（与 qq/index.js 的 antiThinkingVariants 同一套理由）。 */
function antiThinkingVariants(base) {
  return [
    { ...base, reasoning_effort: 'low', thinking: { type: 'disabled' }, enable_thinking: false },
    { ...base, reasoning_effort: 'low' },
    { ...base, thinking: { type: 'disabled' } },
    { ...base },
  ]
}

function contentOf(body) {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null
  const content = choice?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
  }
  return String(choice?.text ?? '')
}

/**
 * 用模型池里的一个槽位生成摘要。
 *
 * 硬约束：AbortController 10 秒（实际预算可能更短，见 generateHandoff），
 * 请求体强制带关闭思考参数；超时/HTTP 错误/空正文一律 `ok:false`，**不抛**。
 *
 * @returns {Promise<{ok:boolean, text?:string, model?:string, source?:string, why?:string}>}
 */
// @doc fish.handoff
export async function summarizeWithModelPool(slot, transcript, opts = {}) {
  if (!slot || typeof slot !== 'object') return { ok: false, text: '', why: '没有可用的模型池槽位' }
  const body = String(transcript ?? '').trim()
  if (!body) return { ok: false, text: '', why: '没有可压缩的对话' }
  let endpoint
  try {
    endpoint = chatEndpointOf(slot.apiUrl)
  } catch (error) {
    return { ok: false, text: '', why: short(error?.message ?? error) }
  }
  if (!slot.apiKey) return { ok: false, text: '', why: 'API Key 为空' }
  if (!slot.modelName) return { ok: false, text: '', why: '模型名为空' }

  const maxChars = Math.max(80, Math.min(800, Math.round(Number(opts.maxChars) || HANDOFF_MAX_CHARS)))
  const budgetMs = Math.max(500, Math.min(60_000, Number(opts.timeoutMs) || MODEL_POOL_TIMEOUT_MS))
  const deadline = Date.now() + budgetMs
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const base = {
    model: slot.modelName,
    messages: [{
      role: 'user',
      content: `${SYSTEM_PROMPT.replace('{MAX}', String(maxChars))}\n\n${body}`,
    }],
    max_tokens: Math.max(64, Math.min(4096, Number(opts.maxTokens) || MODEL_POOL_MAX_TOKENS)),
    stream: false,
  }

  let lastWhy = '未知原因'
  for (const payload of antiThinkingVariants(base)) {
    const left = deadline - Date.now()
    if (left < 300) {
      lastWhy = `硬超时（${timeoutLabel(budgetMs)}）`
      break
    }
    const ac = new AbortController()
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { ac.abort(new Error(`模型池超时（${timeoutLabel(budgetMs)}）`)) } catch { /* ignore */ }
        reject(new Error(`模型池超时（${timeoutLabel(budgetMs)}）`))
      }, left)
      timer.unref?.()
    })
    try {
      // 连“读正文”一起算在超时里：只 race fetch 的话，服务端先回头、
      // 正文一直不结束时仍会挂住。
      const work = (async () => {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${slot.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(payload),
          signal: ac.signal,
        })
        const text = await res.text()
        return { res, text }
      })()
      const { res, text } = await Promise.race([work, timeout])
      let parsed = null
      try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
      if (!res.ok) {
        const detail = providerErrorText(parsed, parsed ? '' : short(text))
        lastWhy = `HTTP ${res.status}${detail ? `：${detail}` : ''}`
        // 只有「参数不认识」才换一种关闭思考的写法；401/配额/地址错误重试没用。
        if ([400, 422].includes(res.status)) continue
        break
      }
      const summary = cleanSummary(contentOf(parsed), maxChars)
      if (summary) {
        log(`[dsh-fish] 模型池生成了交接提要（${summary.length} 字，${slot.modelName}）`)
        return { ok: true, text: summary, model: slot.modelName, source: `pool:${slot.modelName}` }
      }
      lastWhy = '模型返回空正文'
      break
    } catch (error) {
      lastWhy = ac.signal?.aborted
        ? `硬超时（${timeoutLabel(budgetMs)}）`
        : short(error?.message ?? error)
      break
    } finally {
      clearTimeout(timer)
    }
  }

  log(`[dsh-fish] 模型池没给出提要（${lastWhy}）`)
  return { ok: false, text: '', why: lastWhy }
}

const SYSTEM_PROMPT = [
  '你是一个记忆交接员。把下面这段对话压缩成一段《近期剧情提要》，不超过 {MAX} 字。',
  '只写：发生过什么、聊到了谁和什么事、哪些话还没说完。',
  '不要评价，不要分析心理，不要编造对话里没有的事，不要写"她感到……"这类推测。',
  '用"你"指代对话里被称作"你"的那一方，用"他"指代另一方。',
  '只输出提要正文，不要标题、不要引号、不要解释。',
].join('\n')

/** 推理强度从低到高的偏好顺序。 */
const EFFORT_ORDER = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'max']

function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 本地时间 YYYY-MM-DD HH:mm（提要是给人读的）。 */
export function handoffStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * 从 memory/raw_*.jsonl 里取最近 N 轮（user + assistant 算一轮）。
 *
 * 为什么从记忆文件取：`talkmem` 只留 4 轮；memory 是每轮原话按天落盘的唯一完整副本，
 * 且覆盖 QQ / 侧栏 / 定时唤醒三个入口。
 */
// @doc fish.handoff
export async function collectRecentTurns(root, limit = HANDOFF_TURNS) {
  const want = Math.max(1, Math.min(200, Math.round(Number(limit) || HANDOFF_TURNS)))
  const files = await listMemoryFiles(root) // 新 → 旧
  const records = []
  for (const file of files) {
    const rows = await loadRecords(file)
    records.unshift(...rows)
    if (records.length >= want * 2 + 40) break
  }
  records.sort((a, b) => {
    const ta = Date.parse(a.ts)
    const tb = Date.parse(b.ts)
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return a.seq_id - b.seq_id
  })

  const turns = []
  for (const rec of records) {
    if (rec.role === 'user') {
      turns.push({ ts: rec.ts, user: rec.text, assistant: '' })
    } else if (rec.role === 'assistant') {
      const last = turns[turns.length - 1]
      if (last && !last.assistant) last.assistant = rec.text
      else turns.push({ ts: rec.ts, user: '', assistant: rec.text })
    }
  }
  return turns.slice(-want)
}

/** 把几轮对话渲染成给摘要模型的正文。 */
export function renderTranscript(turns) {
  const lines = []
  for (const t of turns ?? []) {
    const stamp = String(t?.ts ?? '').slice(0, 16).replace('T', ' ')
    const head = stamp ? `[${stamp}] ` : ''
    if (t?.user) lines.push(`${head}他：${clip(t.user, TRANSCRIPT_LINE_CHARS)}`)
    if (t?.assistant) lines.push(`${head}你：${clip(t.assistant, TRANSCRIPT_LINE_CHARS)}`)
    if (lines.join('\n').length >= TRANSCRIPT_MAX_CHARS) break
  }
  const text = lines.join('\n')
  return text.length <= TRANSCRIPT_MAX_CHARS ? text : `${text.slice(0, TRANSCRIPT_MAX_CHARS - 1)}…`
}

/**
 * 模型输出 → 提要正文。
 *
 * 实测模型会自带一行标题 `《近期剧情提要》`、开头写「提要：」、或给整段加引号；
 * 不清掉就会在系统外壳里出现「这是你之前的记忆提要：《近期剧情提要》……」。
 */
export function cleanSummary(raw, maxChars = HANDOFF_MAX_CHARS) {
  let text = String(raw ?? '')
    .replace(/```[\s\S]*?\n|```/g, '')
    .replace(/^\s*[《【\[]?[^》】\]\n]{0,12}(?:剧情)?提要[^》】\]\n]{0,12}[》】\]]?\s*[:：]?\s*\n/u, '')
    .replace(/^(?:剧情提要|近期剧情提要|提要)[：:]\s*/u, '')
    .replace(/^\s*[《【\[]["“”'「『]*|["“”'」』]*[》】\]]\s*$/g, '')
    .replace(/^["“”'「『]+|["”'」』]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  text = text.replace(/[。.！!？?；;，,、]+$/u, '')
  const max = Math.max(80, Math.min(800, Math.round(Number(maxChars) || HANDOFF_MAX_CHARS)))
  if (text.length > max) text = `${text.slice(0, max - 1)}…`
  return text
}

/**
 * 从宿主 llm 服务里挑一个模型（只用宿主自己的 provider，不碰任何外部 API）。
 *
 * 顺序：`chat.handoff.provider/model` → 部署默认模型 → provider 列表里
 * 名字带 flash/mini/cheap 的第一个 → 第一个可用模型。
 */
export async function pickHostSelection(ctx, cfg = {}) {
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : ctx?.llm
  if (!llm || typeof llm.stream !== 'function') return null
  const want = cfg?.chat?.handoff ?? {}
  if (want.provider && want.model) {
    return { provider: String(want.provider), model: String(want.model) }
  }
  try {
    const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
  } catch { /* 没有这个服务就继续找 */ }
  try {
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    let fallback = null
    for (const p of providers ?? []) {
      let models = []
      try { models = await llm.listModels(p.id) } catch { models = [] }
      for (const m of models ?? []) {
        const id = String(m?.id ?? '')
        if (!id) continue
        const choice = { provider: String(p.id), model: id }
        if (/flash|mini|cheap|small|fast/i.test(id)) return choice
        fallback ??= choice
      }
    }
    return fallback
  } catch {
    return null
  }
}

/**
 * 问宿主模型「这个模型支持哪些推理强度」，挑最低的一档。
 *
 * 为什么必须挑低的：默认（尤其 high）会把 token 预算全花在思考上，
 * 正文返回空——这正是 2026-11-03 之前摘要一直失败的直接原因。
 * 拿不到模型信息就返回 undefined（不传这个字段，行为与旧版一致）。
 */
export async function pickLowestEffort(llm, selection) {
  if (!selection?.provider || !selection?.model) return undefined
  try {
    const info = await llm.resolveModelInfo?.(selection.provider, selection.model)
    const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
    const known = efforts.filter((e) => EFFORT_ORDER.includes(String(e?.id)))
    if (!known.length) return undefined
    known.sort((a, b) => EFFORT_ORDER.indexOf(String(a.id)) - EFFORT_ORDER.indexOf(String(b.id)))
    return String(known[0].id)
  } catch {
    return undefined
  }
}

/** 把一段流读完，收集正文与结束原因。 */
async function drainStream(stream) {
  let out = ''
  let finish = ''
  let failure = ''
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    if (chunk?.type === 'finish') {
      finish = String(chunk?.reason?.kind ?? '')
      if (chunk?.reason?.failure?.message) failure = String(chunk.reason.failure.message)
      break
    }
  }
  return { out, finish, failure }
}

/**
 * 用宿主 llm 跑一次摘要。**这是唯一一条摘要生成路径**（不再有外部 HTTP）。
 *
 * 两次尝试共用同一个 deadline：第一次 2500 tokens，空正文且被截断时给 6000。
 * 超时是硬性的：`Promise.race` 到点就返回失败，不再等模型。
 *
 * @returns {Promise<{ok:boolean, text:string, model?:string, source?:string, why?:string}>}
 */
// @doc fish.handoff
export async function summarizeWithLlm(llm, selection, transcript, opts = {}) {
  if (!llm || typeof llm.stream !== 'function') return { ok: false, text: '', why: '宿主没有 llm.stream' }
  if (!selection?.provider || !selection?.model) return { ok: false, text: '', why: '宿主没有可用模型' }
  const body = String(transcript ?? '').trim()
  if (!body) return { ok: false, text: '', why: '没有可压缩的对话' }

  const maxChars = Math.max(80, Math.min(800, Math.round(Number(opts.maxChars) || HANDOFF_MAX_CHARS)))
  const budgetMs = Math.max(1_000, Math.min(60_000, Number(opts.timeoutMs) || HANDOFF_TIMEOUT_MS))
  const deadline = Date.now() + budgetMs
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  let createUserMessage = null
  try { ({ createUserMessage } = await import('@deepseek-ai/dsh-llm')) } catch { /* 独立安装：退化成普通对象 */ }

  const effort = opts.reasoningEffort ?? (await pickLowestEffort(llm, selection))
  let lastWhy = '未知原因'

  for (const maxTokens of [opts.maxTokens ?? FIRST_MAX_TOKENS, RETRY_MAX_TOKENS]) {
    const left = deadline - Date.now()
    if (left <= 250) {
      lastWhy = `硬超时（${timeoutLabel(budgetMs)}）`
      break
    }
    const content = [{ type: 'text', text: `${SYSTEM_PROMPT.replace('{MAX}', String(maxChars))}\n\n${body}` }]
    const message = typeof createUserMessage === 'function'
      ? createUserMessage({ content, source: { kind: 'plugin', plugin: 'dsh-fish' } })
      : { role: 'user', content, source: { kind: 'plugin', plugin: 'dsh-fish' } }

    let timer = null
    const ac = new AbortController()
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        // 真的把这次请求掐掉：只 race 不 abort 的话，模型还会在后台继续烧 token。
        try { ac.abort(new Error(`摘要超时（${timeoutLabel(budgetMs)}）`)) } catch { /* ignore */ }
        resolve({ timedOut: true })
      }, left)
    })
    const run = (async () => {
      try {
        const stream = llm.stream({
          provider: selection.provider,
          model: selection.model,
          messages: [message],
          maxTokens,
          signal: ac.signal,
          ...(effort ? { reasoningEffort: effort } : {}),
        })
        return await drainStream(stream)
      } catch (err) {
        return { out: '', finish: 'error', failure: String(err?.message ?? err) }
      }
    })()

    const result = await Promise.race([run, timeout])
    clearTimeout(timer)
    if (result?.timedOut) {
      lastWhy = `硬超时（${timeoutLabel(budgetMs)}）`
      break
    }
    if (result.finish === 'error' || result.finish === 'aborted') {
      lastWhy = `模型返回 ${result.finish}${result.failure ? `：${result.failure}` : ''}`
      continue // 换更大预算再试一次
    }
    const text = cleanSummary(result.out, maxChars)
    if (text) {
      log(`[dsh-fish] 交接提要生成好了（${text.length} 字，${selection.provider}/${selection.model}，推理=${effort ?? '默认'}，${maxTokens} tokens 预算）`)
      return { ok: true, text, model: selection.model, source: `host:${selection.provider}/${selection.model}` }
    }
    lastWhy = `宿主模型返回空（finish=${result.finish || '?'}，${maxTokens} tokens 预算）`
    // 只有「预算被吃完」才值得加大预算再试；finish=stop 还空说明模型就是没给正文
    if (result.finish !== 'length' && result.finish !== 'max-tokens' && result.finish !== 'max_tokens') break
  }

  log(`[dsh-fish] 宿主模型没给出提要（${lastWhy}）`)
  return { ok: false, text: '', why: lastWhy }
}

/**
 * 模型失败时的兜底：最近几轮原话（不再调用任何模型）。
 * 没有对话就返回 `FAILED_HANDOFF_TEXT`（明说交接失败，让她自己去翻）。
 */
// @doc fish.handoff
export function fallbackHandoffText(turns, maxChars = HANDOFF_MAX_CHARS) {
  const rows = (turns ?? []).slice(-FALLBACK_TURNS)
  const lines = []
  for (const t of rows) {
    const user = String(t?.user ?? '')
      .replace(/（回 QQ 用[\s\S]*$/u, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (user) lines.push(`他：${clip(user, 100)}`)
    if (t?.assistant) lines.push(`你：${clip(t.assistant, 100)}`)
  }
  const text = cleanSummary(lines.join('；'), maxChars)
  return text || FAILED_HANDOFF_TEXT
}

/**
 * 一步做完：取最近 N 轮 → 调宿主模型 → 返回提要。永不抛。
 *
 * @returns {Promise<{ok:boolean, text:string, turns:number, model?:string, source?:string, why?:string}>}
 */
// @doc fish.handoff
export async function generateHandoff(root, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const turns = await collectRecentTurns(root, opts.turns ?? HANDOFF_TURNS).catch(() => [])
  const real = turns.filter((t) => t.user || t.assistant)
  if (!real.length) return { ok: false, text: '', turns: 0, why: '记忆里还没有对话' }

  let cfg = {}
  try { cfg = (await loadConfig(root)).config ?? {} } catch { cfg = {} }
  if (cfg?.chat?.handoff?.enabled === false) {
    return { ok: false, text: '', turns: real.length, why: 'chat.handoff.enabled=false' }
  }

  const transcript = renderTranscript(real)
  const totalBudget = Math.max(2_000, Math.min(60_000, Number(opts.timeoutMs) || HANDOFF_TIMEOUT_MS))
  const deadline = Date.now() + totalBudget

  // ---- 1) 模型池优先 ----
  // 给宿主 llm 预留 HOST_FALLBACK_RESERVE_MS：模型池再慢，也不会把整个摘要
  // 预算吃光、让回退路径一秒都不剩。槽位自身仍然是 10 秒硬上限。
  try {
    const pool = await loadModelPool(cfg, opts)
    const slot = pickModelPoolSlot(pool)
    if (slot) {
      const poolBudget = Math.max(
        1_000,
        Math.min(MODEL_POOL_TIMEOUT_MS, deadline - Date.now() - HOST_FALLBACK_RESERVE_MS),
      )
      const pooled = await summarizeWithModelPool(slot, transcript, {
        maxChars: opts.maxChars,
        timeoutMs: poolBudget,
        maxTokens: opts.maxTokens,
        log,
      })
      if (pooled.ok) {
        return {
          ok: true,
          text: pooled.text,
          turns: real.length,
          model: pooled.model,
          source: pooled.source,
        }
      }
      log(`[dsh-fish] 模型池没给出提要（${pooled.why}），回退宿主 llm`)
    }
  } catch (error) {
    log(`[dsh-fish] 模型池读取/调用失败（${String(error?.message ?? error).slice(0, 120)}），回退宿主 llm`)
  }

  // ---- 2) 宿主原生 llm 兜底 ----
  const selection = opts.selection ?? (await pickHostSelection(opts.ctx, cfg))
  if (!selection) return { ok: false, text: '', turns: real.length, why: '宿主没有可用的 llm 模型' }

  const llm = opts.ctx?.get?.('llm') ?? opts.llm
  const hostBudget = Math.max(1_000, deadline - Date.now())
  const r = await summarizeWithLlm(llm, selection, transcript, {
    maxChars: opts.maxChars,
    timeoutMs: hostBudget,
    reasoningEffort: opts.reasoningEffort,
    maxTokens: opts.maxTokens,
    log,
  })
  if (!r.ok) return { ok: false, text: '', turns: real.length, why: r.why }
  return { ok: true, text: r.text, turns: real.length, model: r.model, source: r.source }
}

/**
 * 提要注入时的外壳（任务书指定的格式）。
 * 提要是「系统」说的话——所以带 [系统：…] 前缀。
 */
// @doc fish.handoff
export function renderHandoff(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[。.]+$/u, '')
  if (!t) return ''
  return `[系统：你刚刚搬到了新房间，这是你之前的记忆提要：${t}。如果忘记更早的事，请调用 fish_search_history。]`
}

/** 读 home.json 里那条提要（轮换后还没过期才有）。测试与观测台用。 */
export async function readHandoffRecord(root) {
  const saved = await readJson(String(root) + '/home.json', null)
  const text = String(saved?.handoff ?? '').trim()
  return text ? { text, source: String(saved?.handoffSource ?? ''), at: String(saved?.rotatedAt ?? '') } : null
}
