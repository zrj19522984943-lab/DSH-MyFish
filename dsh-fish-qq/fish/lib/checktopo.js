/**
 * checktopo.js —— fish_check_topology
 *
 * 她的赛博小屋有了 A* 寻路之后，家具摆歪是有后果的：重叠的家具堵死走廊，
 * 越界的摆放在地图上会被默默钳回房间里。网页上画的墙 / 房间同样在
 * cyber_house.sqlite 的 features 表里，所以现在一次检查覆盖全部要素：
 *   - overlap        任意两个非门要素的几何重叠（有面积 / 线点相交）
 *   - out-of-bounds  家具摆出房间边界，或要素超出小屋世界边界
 *   - blocked-door   墙 / 家具把门洞堵死
 *
 * 检查算法直接 require 工作区 cyber_house/state-engine.js 的 checkTopology，
 * 和网页「拓扑检查」面板、A* 障碍栅格用同一份数据库和同一份实现——她看到的
 * 结果和网页上标红的永远是同一件事。
 *
 * 纯只读：不写数据库，不改任何状态。
 */

import { join } from 'node:path'
import { createRequire } from 'node:module'

import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { resolveWorkspaceRoot } from './workspace.js'

export const CHECK_TOPOLOGY_TOOL_NAME = 'fish_check_topology'

function failure(note) {
  return { ok: false, text: '', note }
}

function success(text) {
  return { ok: true, text, note: '' }
}

/**
 * 打开工作区的空间数据库并跑一次拓扑检查，返回给她的话。
 * @param {string|(() => string)} workspaceRoot 工作区根目录（可以是 getter）
 */
export function checkTopologyReport(workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (!root) return failure('还不知道工作区在哪，没法翻小屋数据库。')

  let engine
  try {
    const requireModule = createRequire(import.meta.url)
    const stateEngine = requireModule(join(root, 'cyber_house', 'state-engine.js'))
    engine = stateEngine.createStateEngine({ workspaceRoot: root, fresh: true })
  } catch (err) {
    return failure(`状态引擎找不到：${String(err?.message ?? err).slice(0, 120)}`)
  }
  if (!engine || typeof engine.checkTopology !== 'function') {
    return failure('状态引擎里没有 checkTopology。')
  }

  let errors
  let info
  try {
    errors = engine.checkTopology()
    info = engine.db && typeof engine.db.info === 'function' ? engine.db.info() : null
  } catch (err) {
    return failure(`空间数据库读不出来：${String(err?.message ?? err).slice(0, 120)}`)
  }

  const furnitureCount = info ? info.furnitureCount : 0
  const doorCount = info ? info.doorCount : 0
  const customCount = info ? info.customCount : 0
  const storage = info ? `SQLite/${info.driver}${info.spatialite ? ' + SpatiaLite' : ' + WKT-Turf'}` : ''
  const summary =
    `[空间检查：${furnitureCount} 件家具、${doorCount} 个门洞` +
    (customCount > 0 ? `、${customCount} 个网页要素` : '') +
    (storage ? `；${storage}` : '') +
    '，'

  if (errors.length === 0) {
    return success(summary + '没有重叠、越界，也没有堵门。]')
  }

  const lines = errors.map((error, index) => `${index + 1}. ${error.message}`)
  return success(
    summary +
    `发现 ${errors.length} 处冲突：\n` +
    lines.join('\n') +
    '\n要我帮忙挪一下的话说一声。]',
  )
}

export function registerCheckTopology(ctx, deps = {}) {
  return ctx.tools.register(
    defineTool({
      name: CHECK_TOPOLOGY_TOOL_NAME,
      description:
        '检查赛博小屋（SQLite 空间数据库）里的要素有没有空间冲突：家具 / 自建墙 / 自建房间' +
        '有没有互相重叠、有没有超出房间或世界边界、有没有把门洞堵死。' +
        '纯只读，不改动任何东西。装修完、或者觉得屋里哪里别扭时可以自己查一次；' +
        '查出来有问题就告诉对方，没问题就是没问题。',
      parameters: toJsonSchema({}),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '检查结果' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没查成：${out.note}` }],
      },
      async execute() {
        return checkTopologyReport(deps.workspaceRoot)
      },
    }),
  )
}
