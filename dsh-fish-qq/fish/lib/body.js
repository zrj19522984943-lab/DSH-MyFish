/**
 * body.js —— 她的「体温计」：check_body 工具
 *
 * 为什么要有这个（2026-11-02，赛博感官任务书模块 1）：
 *   原来环境状态是在唤醒她时由系统前置注入一段「系统环境反馈」——
 *   每一轮都把天气和内存占用塞进上下文，她不看也得看。
 *   现在改成纯文件驱动：采集脚本（pipeline/update_env.js）定时把一行状态
 *   覆盖写到工作区的 sensors/status.md，她想感知的时候自己来读。
 *   常驻的只有系统设定末尾那一句引导（identity.js 的 fish:senses 段），
 *   数据本身只在「她看的那一瞬间」进上下文。
 *
 * 两条硬约束（与 fish_read_file 同一套口径）：
 *   1. **绝对只读**。只用 readFileSync / statSync，没有任何写盘、删盘、子进程。
 *   2. **不猜、不定感受**：文件里是什么就报什么；数据旧了如实说「旧了」，
 *      但「旧了意味着什么」由她自己定夺——本工具不产出任何情绪或结论。
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { resolveWorkspaceRoot } from './workspace.js'

/** 状态文件相对工作区根的位置。采集脚本（pipeline/update_env.js）与这里必须认同一条路。 */
export const BODY_STATUS_REL = join('sensors', 'status.md')

/**
 * 多久算「数据旧了」。采集端默认每 15 分钟一次，留出 4 倍余量；
 * 超过这个岁数，返回的文本里会带一句「可能不准」，但不替她决定要不要理它。
 */
export const BODY_STALE_MS = 60 * 60 * 1000

/**
 * 把毫秒岁数说成人话。
 * @param {number} ageMs
 * @returns {string}
 */
function ageText(ageMs) {
  const min = Math.round(ageMs / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr} 小时前`
  return `${Math.round(hr / 24)} 天前`
}

/**
 * 读一次身体状态（纯函数：读盘只发生在这一处）。
 *
 * @param {string|Function} workspaceRoot 工作区根（可以是 getter，设置改了下一次调用就生效）
 * @returns {{ok:boolean, text:string, note:string}}
 */
export function readBodyStatus(workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (!root) return { ok: false, text: '', note: '还没说能看哪儿（工作区根目录没配），状态文件不知道在哪。' }

  const file = join(root, BODY_STATUS_REL)
  let st
  try {
    st = statSync(file)
  } catch {
    return { ok: false, text: '', note: '还没采过状态。打开设置里的环境传感器，采集脚本会定时把状态写进 sensors/status.md。' }
  }
  if (!st.isFile()) return { ok: false, text: '', note: 'sensors/status.md 不是普通文件，看不了。' }

  let body = ''
  try {
    body = readFileSync(file, 'utf8').trim()
  } catch (err) {
    return { ok: false, text: '', note: `状态文件读不了：${String(err?.message ?? err).slice(0, 80)}` }
  }
  if (body === '') return { ok: false, text: '', note: '状态文件是空的，采集脚本可能没跑成。' }

  const age = Date.now() - st.mtimeMs
  const updated = `（更新于 ${ageText(age)}）`
  const text = age <= BODY_STALE_MS
    ? `${body}\n${updated}`
    : `${body}\n${updated}，数据有点旧了，可能不准`
  return { ok: true, text, note: '' }
}

/**
 * 注册 check_body 工具。
 *
 * deps.workspaceRoot：用户工作区的根（设置页那条），可以是 getter。
 */
export function registerBody(ctx, deps = {}) {
  return ctx.tools.register(
    defineTool({
      name: 'check_body',
      description:
        '看一眼这台机器此刻的状态：内存占用、机箱负载、外面的天气。' +
        '数据在工作区的 sensors/status.md 里，只有一行标签，采集脚本每 15 分钟左右覆盖一次；' +
        '文件带着更新时间，太久没更新我会看出来。只读。',
      parameters: toJsonSchema({}),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '一行状态标签 + 更新时间' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没感觉到：${out.note}` }],
      },
      async execute() {
        return readBodyStatus(deps.workspaceRoot)
      },
    }),
  )
}
