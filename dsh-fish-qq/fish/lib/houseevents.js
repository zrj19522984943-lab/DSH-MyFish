/**
 * houseevents.js —— read_house_events：读最近家里发生的事
 *
 * 任务书 2：拟南芥和借手会在屋里聊天，对白写进 cyber_house.sqlite 的 events 表。
 * 给小鱼一只只读的眼睛，让她自己翻「刚才家里发生了什么」——而不是系统每轮
 * 把 NPC 的闲话硬塞进她的上下文。
 *
 * 纯只读：打开数据库、SELECT、关掉，不改任何东西。
 */

import { join } from 'node:path'
import { createRequire } from 'node:module'

import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { resolveWorkspaceRoot } from './workspace.js'

export const READ_HOUSE_EVENTS_TOOL_NAME = 'read_house_events'

function failure(note) {
  return { ok: false, text: '', note }
}

function success(text) {
  return { ok: true, text, note: '' }
}

function formatEventTime(at) {
  const date = new Date(String(at || ''))
  if (Number.isNaN(date.getTime())) return String(at || '')
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 读最近事件，返回给她的一句话。
 *
 * @param {string|(() => string)} workspaceRoot 工作区根（兼容 getter）
 * @param {{limit?:number, type?:string}} [options]
 */
export function readHouseEventsReport(workspaceRoot, options = {}) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (!root) return failure('还不知道工作区在哪，没法翻小屋的事件日志。')

  let store
  try {
    const requireModule = createRequire(import.meta.url)
    const dbModule = requireModule(join(root, 'cyber_house', 'db', 'index.js'))
    store = dbModule.openDatabase({ workspaceRoot: root, fresh: true })
  } catch (err) {
    return failure(`空间数据库打不开：${String(err?.message ?? err).slice(0, 120)}`)
  }

  try {
    const limit = Math.max(1, Math.min(50, Math.round(Number(options.limit) || 20)))
    const events = store.listEvents({ limit, type: options.type || undefined })
    if (!events || events.length === 0) {
      return success('[最近家里很安静，没有新事件。]')
    }

    const lines = events.map((event) => {
      const time = formatEventTime(event.at)
      const actor = String(event.actor || '').trim()
      const text = String(event.text || '').replace(/\s+/g, ' ').trim()
      const who = actor || (event.type === 'npc_dialogue' ? '屋里的人' : event.type || '事件')
      return `${time} ${who}：“${text}”`
    })
    return success(
      `[最近家里发生的事（${events.length} 条，只读）：\n${lines.join('\n')}\n]`,
    )
  } catch (err) {
    return failure(`事件日志读不出来：${String(err?.message ?? err).slice(0, 120)}`)
  } finally {
    try {
      store.close()
    } catch {
      // 关闭失败不影响结果。
    }
  }
}

export function registerReadHouseEvents(ctx, deps = {}) {
  return ctx.tools.register(
    defineTool({
      name: READ_HOUSE_EVENTS_TOOL_NAME,
      description:
        '读赛博小屋最近发生的事：拟南芥和借手在屋里说了什么、屋里有没有新动静。' +
        '纯只读，不打扰他们。想知道“刚才家里发生了什么”时自己翻一眼。',
      parameters: toJsonSchema({
        limit: {
          type: 'number',
          description: '最多看几条，1–50，默认 20。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '最近事件' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没翻到：${out.note}` }],
      },
      async execute(args = {}) {
        return readHouseEventsReport(deps.workspaceRoot, { limit: args.limit })
      },
    }),
  )
}
