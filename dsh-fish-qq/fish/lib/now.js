/**
 * now.js —— 她的时钟：fish_now 工具
 *
 * ## 为什么要有这个（2026-10-30）
 *
 * 她的上下文里**没有**可靠的「今天是哪天」：
 *   - 身份文档只写「你存在了 N 天」，没有日期；
 *   - 模型自己对「今天」的印象来自训练数据，问她今天是星期几她会编一个；
 *   - 而她的整套生活是按日子过的——日记按日期落盘（diary/YYYY-MM-DD）、
 *     刷站 / 派活按天限额、报告按天写（out/YYYY-MM-DD.md）。
 *
 * 以前她要写日记时的「今天」全靠猜。现在给她一只只读的钟：
 * 调一次，回当前**本机**的日期、星期、时间。
 *
 * ## 三条硬约束（改之前先读）
 *
 *   1. **绝对只读、零副作用**。不看盘、不联网、不写任何东西——
 *      这只钟唯一的作用是回答「现在几点」。
 *   2. **无参数**。她不需要配置时区或格式，也不接受传入时间戳
 *      （那只是换了个地方猜）。时区跟着机器走，回执里写明偏移量，
 *      免得她把本机时间当成别处的时间。
 *   3. **不教她怎么用**。工具说明里只写「能读什么时候」，
 *      不写「每天写日记前必须调它」——那会把一只钟变成一项任务。
 */

import { defineTool } from './tool.js'

/** 工具名（与 restrict.js 的 FISH_TOOLS 保持一致）。 */
export const NOW_TOOL_NAME = 'fish_now'

/** 星期：`getDay()` 的 0–6 直接映成「日一二三四五六」。 */
export const WEEKDAY_NAMES = Object.freeze(['日', '一', '二', '三', '四', '五', '六'])

/** 补两位：`17:05` 而不是 `17:5`。 */
function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * 把 UTC 偏移量（分钟）渲染成 `+08:00` / `-05:30`。
 *
 * 注意方向：JS 的 `getTimezoneOffset()` 是「本地 - UTC」（东八区返回 -480），
 * 所以显示要取反。
 */
export function formatUtcOffset(offsetMinutes) {
  const v = Number(offsetMinutes)
  if (!Number.isFinite(v)) return ''
  const mins = Math.abs(v)
  const sign = v >= 0 ? '+' : '-'
  return `${sign}${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`
}

/**
 * 把一个时间渲染成她读得懂的一行。纯函数，导出是为了可测试。
 *
 * 格式（固定，测试会盯着它）：
 * ```
 * 2026-10-30 星期五 17:25（UTC+08:00）
 * Unix 时间戳（秒）1793352317
 * ```
 *
 * - 日期 / 星期 / 时分走**本机时区**，偏移量写在括号里（她能据此分清
 *   「机器上的时候」和「他在别处的时候」）；
 * - 第二行给 Unix 秒（「时间戳」本身）：算「多少天以后」这类事时用得上，
 *   不需要她自己换算。
 *
 * @param {number|Date} [now] 时间戳或 Date；不传 = 当前时间（方便测试注入）
 * @returns {string} 两行文本，永不为空
 */
export function formatNow(now) {
  const d = now instanceof Date ? now : new Date(Number(now) || Date.now())
  const weekday = WEEKDAY_NAMES[d.getDay()] ?? '?'
  const offset = formatUtcOffset(-d.getTimezoneOffset())
  const line1 = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 星期${weekday} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const line2 = `Unix 时间戳（秒）${Math.floor(d.getTime() / 1000)}`
  return offset === '' ? `${line1}\n${line2}` : `${line1}（UTC${offset}）\n${line2}`
}

/**
 * 读一次现在（纯函数：取时间只发生在这一处，方便测试注入）。
 * @param {number|Date} [now]
 * @returns {{ok:boolean, text:string, note:string}}
 */
export function readNow(now) {
  return { ok: true, text: formatNow(now), note: '' }
}

/**
 * 注册 fish_now 工具。
 *
 * deps 不需要任何东西——这只钟不读盘、不读配置、不联网。
 * 参数留着是为了与其他 register* 签名一致。
 */
export function registerNow(ctx, _deps = {}) {
  return ctx.tools.register(
    defineTool({
      name: NOW_TOOL_NAME,
      description:
        '读现在是什么时候：返回当前本机的日期、星期、时间（例如 2026-10-30 星期五 17:25），' +
        '外加 Unix 时间戳。没有参数。写日记、需要说「今天」是哪天、或者算多少天以后的时候调它。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '现在的日期、星期、时间与 Unix 时间戳' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没读到：${out.note}` }],
      },
      async execute() {
        return readNow(Date.now())
      },
    }),
  )
}
