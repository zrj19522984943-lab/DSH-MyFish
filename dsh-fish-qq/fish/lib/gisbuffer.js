/**
 * gisbuffer.js —— gis_buffer_query
 *
 * 她在小屋里走动时，「周围有什么」是很自然的一问。这个工具以她当前的位置
 * 为圆心画一个缓冲圈，把圈内相交的家具 / 门 / 自定义要素按距离远近报给她。
 *
 * 算法和网页「缓冲区分析」面板完全同源：cyber_house/gis/analyze.js 的
 * analyzeBuffer（turf.circle 生成缓冲面 + booleanIntersects 检索相交），
 * 候选集合就是 state-engine 导出的整屋 GeoJSON。她和网页用户看到的
 * 永远是同一张地图、同一份命中。
 *
 * 纯只读：不碰任何文件，不改任何状态。
 *
 * 不在 BASE_TOOLS 里——由 qq/index.js 的 TOOL_INTENTS 在她问到「周围 /
 * 附近」时按轮解锁，下一轮自动失效（见 EXT_TOOLS / routeToolIntent）。
 */

import { join } from 'node:path'
import { createRequire } from 'node:module'

import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { resolveWorkspaceRoot } from './workspace.js'

export const GIS_BUFFER_QUERY_TOOL_NAME = 'gis_buffer_query'

const DEFAULT_RADIUS = 150

function failure(note) {
  return { ok: false, text: '', note }
}

function success(text) {
  return { ok: true, text, note: '' }
}

/**
 * 以小鱼当前位置为圆心做一次缓冲区查询。
 *
 * @param {string|(() => string} workspaceRoot 工作区根目录（可以是 getter）
 * @param {number} radius 半径（世界单位，analyzeBuffer 内部会钳到 5–500）
 * @returns {{ok:boolean,text:string,note:string}} 给她的话
 */
export function bufferQueryReport(workspaceRoot, radius) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (!root) return failure('还不知道工作区在哪，没法看地图。')

  const requireModule = createRequire(import.meta.url)
  let engineModule
  try {
    engineModule = requireModule(join(root, 'cyber_house', 'state-engine.js'))
  } catch (err) {
    return failure(`状态引擎找不到：${String(err?.message ?? err).slice(0, 120)}`)
  }
  if (typeof engineModule.createStateEngine !== 'function') return failure('状态引擎里没有 createStateEngine。')

  let analyzeBuffer
  try {
    analyzeBuffer = requireModule(join(root, 'cyber_house', 'gis', 'analyze.js')).analyzeBuffer
  } catch (err) {
    return failure(`缓冲区分析模块找不到：${String(err?.message ?? err).slice(0, 120)}`)
  }
  if (typeof analyzeBuffer !== 'function') return failure('gis/analyze.js 里没有 analyzeBuffer。')

  // getState() 会按当前时间算出小鱼的位置（不落盘，只读无副作用）。
  // 引擎每次都重读家具 / 要素文件，所以她和网页永远看同一份盘面。
  let state
  let features
  try {
    const engine = engineModule.createStateEngine({ workspaceRoot: root })
    state = engine.getState()
    features = engine.getHouseGeoJSON().features || []
  } catch (err) {
    return failure(`小屋状态读不出来：${String(err?.message ?? err).slice(0, 120)}`)
  }

  const x = Number(state && state.position && state.position.x)
  const y = Number(state && state.position && state.position.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return failure('小鱼现在的位置读不出来。')

  const asked = Number(radius)
  const useRadius = Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_RADIUS

  // 把小鱼自己和当前导航路线从结果里摘掉——它们不是「周围的东西」。
  const result = analyzeBuffer([x, y], useRadius, features, { excludeKinds: ['fish', 'route'] })
  const hits = Array.isArray(result.hits) ? result.hits : []

  const where = state.room ? state.room + '里' : '屋里'
  if (hits.length === 0) {
    return success(`[以我现在站的位置（${where}，${Math.round(x)}, ${Math.round(y)}）为圆心 ${result.radius} 单位内，没有家具也没有别的东西，是一片空地。]`)
  }

  const lines = hits.slice(0, 12).map((hit) => {
    const room = hit.room ? `（${hit.room}）` : ''
    return `${hit.name}${room} · ${hit.distance}`
  })
  const more = hits.length > 12 ? `\n…还有 ${hits.length - 12} 个` : ''
  return success(
    `[以我现在站的位置（${where}，${Math.round(x)}, ${Math.round(y)}）为圆心 ${result.radius} 单位内，` +
    `圈到 ${hits.length} 个东西，从近到远：\n${lines.join('\n')}${more}]`,
  )
}

export function registerBufferQuery(ctx, deps = {}) {
  return ctx.tools.register(
    defineTool({
      name: GIS_BUFFER_QUERY_TOOL_NAME,
      description:
        '查看小鱼周围有什么：以她当前站的位置为圆心、给定半径画个圈，' +
        '把圈内相交的家具、门、网页画进来的要素按距离远近列出来。' +
        'radius 是半径（世界单位，5–500，默认 150），不给就用 150。' +
        '纯只读，只看不动。',
      parameters: toJsonSchema({
        radius: { type: 'number', description: '缓冲圈半径，世界单位，5–500，默认 150' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '圈内要素名单' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没查成：${out.note}` }],
      },
      async execute(args) {
        return bufferQueryReport(deps.workspaceRoot, args && args.radius)
      },
    }),
  )
}
