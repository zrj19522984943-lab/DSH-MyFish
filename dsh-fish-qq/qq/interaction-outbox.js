/**
 * interaction-outbox.js —— 消费赛博小屋的交互出站队列
 *
 * 状态引擎把「小鱼碰到了 X，触发对话」写成
 * `<工作区>/cyber_house/interaction-outbox.jsonl`，本模块只负责：
 *   1. 找到队列文件（和状态引擎同一路径口径）；
 *   2. 从上次字节偏移读完整行；
 *   3. 解析成 { message, featureName, text, at }。
 *
 * 真正的发送在 qq/index.js：用桥接已经建好的 OneBot 连接直发主人私聊。
 * 这里刻意不 import 宿主 / 传输层，方便单测。
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const INTERACTION_QUEUE_FILE = 'interaction-outbox.jsonl'

/** 队列路径：`<工作区>/cyber_house/interaction-outbox.jsonl`。 */
export function interactionQueuePath(root) {
  const base = String(root ?? '').trim()
  if (!base) return ''
  return join(base, 'cyber_house', INTERACTION_QUEUE_FILE)
}

/**
 * 从文件 Buffer 的 offset 开始，取出所有**完整行**。
 *
 * 返回值里的 `nextOffset` 只推进到最后一个换行之后；写到一半的行留到下次，
 * 不会因为 UTF-8 多字节被截断而解析出乱码。
 *
 * @param {Buffer} buffer 完整文件内容
 * @param {number} offset 上次消费到的字节偏移
 * @returns {{lines: Array<Buffer>, nextOffset: number}}
 */
export function takeCompleteLines(buffer, offset = 0) {
  const start = Math.max(0, Math.min(Number(offset) || 0, buffer.length))
  if (start >= buffer.length) return { lines: [], nextOffset: start }
  const slice = buffer.subarray(start)
  const lastNewline = slice.lastIndexOf(0x0a)
  if (lastNewline < 0) return { lines: [], nextOffset: start }
  const complete = slice.subarray(0, lastNewline)
  const lines = []
  let index = 0
  while (index <= complete.length) {
    const newline = complete.indexOf(0x0a, index)
    if (newline < 0) {
      lines.push(complete.subarray(index))
      break
    }
    lines.push(complete.subarray(index, newline))
    index = newline + 1
  }
  return { lines, nextOffset: start + lastNewline + 1 }
}

/**
 * 把一行 JSON 解析成可发送记录；坏行返回 null（调用方跳过并推进偏移）。
 * @param {string|Buffer} line
 */
export function parseInteractionLine(line) {
  const text = Buffer.isBuffer(line) ? line.toString('utf8') : String(line ?? '')
  if (!text.trim()) return null
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const message = String(raw.message ?? '').trim()
  if (!message) return null
  return {
    id: String(raw.id ?? ''),
    at: String(raw.at ?? ''),
    featureId: String(raw.featureId ?? ''),
    featureName: String(raw.featureName ?? ''),
    text: String(raw.text ?? ''),
    message: message.slice(0, 4000),
    atMs: Date.parse(raw.at) || 0,
  }
}

/**
 * 消费队列里所有完整的、尚未过期的记录。调用方提供真正的发送函数。
 *
 * 语义：
 *   - 坏行 / 过期行只推进偏移，不发送；
 *   - 发送失败**停在当前行**（offset 不前进），下次重试；
 *   - 返回值 offset 是下一次应该从哪个字节开始读。
 *
 * @param {{
 *   file:string,
 *   offset?:number,
 *   send:(record:object)=>Promise<any>,
 *   maxAgeMs?:number,
 *   now?:number|(()=>number),
 *   onSent?:(record:object)=>void,
 *   onSkipped?:(record:object, reason:string)=>void,
 * }} options
 * @returns {Promise<{offset:number, sent:number, skipped:number, stopped:boolean, error?:Error}>}
 */
export async function consumeInteractionQueue(options = {}) {
  const file = String(options.file ?? '').trim()
  let offset = Math.max(0, Number(options.offset) || 0)
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { offset, sent: 0, skipped: 0, stopped: false }
  }
  // 队列被清空 / 换文件 -> 从头读。
  if (stat.size < offset) offset = 0
  if (stat.size <= offset) return { offset, sent: 0, skipped: 0, stopped: false }

  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return { offset, sent: 0, skipped: 0, stopped: false }
  }
  const { lines } = takeCompleteLines(buffer, offset)
  const now = typeof options.now === 'function' ? Number(options.now()) || Date.now() : Number(options.now) || Date.now()
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs) || 0)
  const send = typeof options.send === 'function' ? options.send : null

  let cursor = offset
  let sent = 0
  let skipped = 0
  for (const line of lines) {
    const lineBytes = line.length + 1 // takeCompleteLines 只返回以 \n 结尾的整行
    const record = parseInteractionLine(line)
    if (!record) {
      cursor += lineBytes
      skipped += 1
      continue
    }
    if (maxAgeMs > 0 && record.atMs > 0 && now - record.atMs > maxAgeMs) {
      cursor += lineBytes
      skipped += 1
      try {
        options.onSkipped?.(record, 'stale')
      } catch {
        // 回调失败不影响消费。
      }
      continue
    }
    if (!send) {
      return { offset: cursor, sent, skipped, stopped: true, error: new Error('缺少发送函数') }
    }
    try {
      await send(record)
    } catch (error) {
      return { offset: cursor, sent, skipped, stopped: true, error }
    }
    cursor += lineBytes
    sent += 1
    try {
      options.onSent?.(record)
    } catch {
      // 台账失败不阻断后续发送。
    }
  }
  return { offset: cursor, sent, skipped, stopped: false }
}
