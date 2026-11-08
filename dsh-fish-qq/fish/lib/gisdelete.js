/**
 * gisdelete.js —— gis_delete_feature
 *
 * 她在 QQ 里说「把沙发删了」的时候，手里只有一个名字，没有 id。这个工具
 * 收下 id 或名字，在统一空间数据库里找到那件东西再删：
 *   - 网页画进来的自定义要素（id 形如 feat-mw2z5xl7-98volj）
 *   - 家具（id 形如 living-sofa，名字形如「沙发」）
 *
 * 删除走 state-engine 的 removeFeatureById——和网页属性表 🗑️ / 地图右键
 * 删除是同一个入口，删完立刻作废 A* 寻路栅格：被挡住的格子下一轮恢复可通行。
 *
 * 会改动 cyber_house.sqlite（并刷新兼容镜像 JSON），api-router 每轮从数据库
 * 取快照，网页下一次刷新就看到东西没了。
 *
 * 不在 BASE_TOOLS 里——由 qq/index.js 的 TOOL_INTENTS 在她说到「删掉 /
 * 清理 / 移除 / 拆掉」时按轮解锁，下一轮自动失效。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { resolveWorkspaceRoot } from './workspace.js'

export const GIS_DELETE_FEATURE_TOOL_NAME = 'gis_delete_feature'

function failure(note) {
  return { ok: false, text: '', note }
}

function success(text) {
  return { ok: true, text, note: '' }
}

/**
 * 按名字模糊找候选：自定义要素的 name/type、家具的 type 都算「名字」。
 * 先全等，再包含；只接受唯一命中——命中多个就把候选列出来让她带上 id 再说。
 *
 * @param {object} data {furniture, features} 直接读盘的原文
 * @param {string} query 名字片段
 * @returns {Array<{id:string, name:string, room:string, source:string}>}
 */
function findCandidatesByName(data, query) {
  const q = String(query || '').trim()
  if (!q) return []
  const out = []

  const rooms = (data.furniture && data.furniture.rooms) || {}
  for (const roomName of Object.keys(rooms)) {
    const items = rooms[roomName] && Array.isArray(rooms[roomName].items) ? rooms[roomName].items : []
    for (const item of items) {
      const name = String((item && item.type) || (item && item.id) || '')
      if (name === q || name.includes(q) || q.includes(name)) {
        out.push({ id: String(item.id), name, room: roomName, source: 'furniture' })
      }
    }
  }

  const features = (data.features && Array.isArray(data.features.features)) ? data.features.features : []
  for (const feature of features) {
    if (!feature || !feature.id) continue
    const props = feature.properties || {}
    const name = String(props.name || props.type || feature.id)
    if (name === q || name.includes(q)) {
      out.push({ id: String(feature.id), name, room: String(props.room || ''), source: 'features' })
    }
  }

  // 名字完全相等的优先（她说「沙发」，不能顺手把「沙发垫」也匹配进来）。
  const exact = out.filter((c) => c.name === q)
  return exact.length > 0 ? exact : out
}

/**
 * 读盘面 → 找到要素 → 删除 → 刷新 A* 栅格。
 *
 * @param {string|(() => string} workspaceRoot 工作区根目录（可以是 getter）
 * @param {string} idOrName 要素 id 或名字
 * @returns {{ok:boolean,text:string,note:string}} 给她的话
 */
export function deleteFeatureByIdOrName(workspaceRoot, idOrName) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (!root) return failure('还不知道工作区在哪，没法动手。')

  const query = String(idOrName ?? '').trim()
  if (!query) return failure('要删东西得告诉我删哪个——可以给 id，也可以给名字（比如「沙发」）。')

  const furnitureFile = join(root, 'cyber_house', 'furniture.json')
  const featuresFile = join(root, 'cyber_house', 'features.json')
  if (!existsSync(furnitureFile) && !existsSync(featuresFile)) {
    return failure('屋里还没有任何要素文件，没东西可删。')
  }

  const requireModule = createRequire(import.meta.url)
  let engine
  try {
    const engineModule = requireModule(join(root, 'cyber_house', 'state-engine.js'))
    engine = engineModule.createStateEngine({ workspaceRoot: root })
  } catch (err) {
    return failure(`状态引擎找不到：${String(err?.message ?? err).slice(0, 120)}`)
  }
  if (typeof engine.removeFeatureById !== 'function') return failure('状态引擎里没有 removeFeatureById。')

  // 先按 id 直接删；id 不命中再按名字找。
  let target = query
  let resolvedByName = false
  let direct = null
  try {
    direct = engine.removeFeatureById(query)
  } catch (err) {
    return failure(`删除时出错了：${String(err?.message ?? err).slice(0, 120)}`)
  }
  if (!direct || direct.ok !== true) {
    // 优先让状态引擎在空间数据库里按名字找；老工作区没有 searchFeatures
    // 时再退回读兼容镜像 JSON。
    let candidates = []
    if (typeof engine.searchFeatures === 'function') {
      candidates = engine.searchFeatures(query)
    } else {
      const data = {}
      if (existsSync(furnitureFile)) {
        try { data.furniture = JSON.parse(readFileSync(furnitureFile, 'utf8')) } catch { data.furniture = null }
      }
      if (existsSync(featuresFile)) {
        try { data.features = JSON.parse(readFileSync(featuresFile, 'utf8')) } catch { data.features = null }
      }
      candidates = findCandidatesByName(data, query)
    }
    if (candidates.length === 0) {
      return failure(`屋里没有叫「${query}」的东西（家具和网页画的要素里都没找到）。`)
    }
    if (candidates.length > 1) {
      const list = candidates.slice(0, 6).map((c) => `${c.name}（${c.id}${c.room ? '，在' + c.room : ''}）`).join('、')
      return failure(`叫「${query}」的不止一个：${list}。带上具体 id 再说，免得删错。`)
    }
    target = candidates[0].id
    resolvedByName = true
    try {
      direct = engine.removeFeatureById(target)
    } catch (err) {
      return failure(`删除时出错了：${String(err?.message ?? err).slice(0, 120)}`)
    }
    if (!direct || direct.ok !== true) {
      return failure(`找到了「${query}」但没删掉：${(direct && direct.error) || '未知原因'}`)
    }
  }

  const result = direct
  const where = result.target ? `（${result.target}）` : ''
  return success(
    `[已收走：${result.name}${where}。A* 寻路栅格已经刷新，被它挡住的格子现在能走了。` +
    (resolvedByName ? `「${query}」是按名字找到的，id 是 ${result.id}。` : '') + ']',
  )
}
export function registerDeleteFeature(ctx, deps = {}) {
  return ctx.tools.register(
    defineTool({
      name: GIS_DELETE_FEATURE_TOOL_NAME,
      description:
        '从赛博小屋里删掉一件东西：可以给 id（网页画的要素形如 feat-xxx，家具形如 living-sofa），' +
        '也可以直接给名字（比如「沙发」「测试墙」），名字会自动匹配。' +
        '家具和计入 A* 障碍的墙删掉后，小鱼就能穿过原来的位置。删之前最好先说一声要删哪个。',
      parameters: toJsonSchema({
        id: { type: 'string', required: true, description: '要素 id 或名字（名字会自动匹配，多个同名时需要换 id 再试）' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '删除结果' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `没删成：${out.note}` }],
      },
      async execute(args) {
        return deleteFeatureByIdOrName(deps.workspaceRoot, args && args.id)
      },
    }),
  )
}
