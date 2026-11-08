/**
 * dream.js —— 她的「第六感」：梦境碎片的一次性提示
 *
 * 为什么要有这个（2026-11-02，赛博感官任务书模块 4）：
 *   夜间打工流水线（pipeline/fetch_news.js 末尾新增的一步）会让免费打工模型
 *   用「昨天看过的词 + 当日天气 + 一个随机数」写一句 50 字以内、毫无逻辑的梦境碎片，
 *   落到工作区 dreams/tonight.md。她想看就自己去读，不想看就当没这回事。
 *
 *   本文件只管提示词那一侧最薄的一层：在她**下一次**组装系统提示词时，
 *   挂上一句极短的提示（fish:dream 段），告诉她梦的碎片在哪个文件里。
 *   一旦展示过一次（用旁边一个标记文件按 mtime 认），同一段梦就不再提示——
 *   提示不是每轮常驻，梦也不是任务。
 *
 * 硬约束：
 *   1. 只有 statSync / readFileSync / writeFileSync，不调模型、不上网；
 *   2. 永不抛：读不到 / 写不了标记都只是「这次不提示」，不能带崩提示词组装；
 *   3. 提示文本里只写相对路径的说明，不把碎片内容搬进提示词（内容只在她读文件时进上下文）。
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveWorkspaceRoot } from './workspace.js'

/** 梦境碎片文件相对工作区根的位置。pipeline/dream.js 与这里必须认同一条路。 */
export const DREAM_FILE_REL = join('dreams', 'tonight.md')

/** 「这段梦已经提示过了」的标记文件（写当前碎片的 mtimeMs）。 */
export const DREAM_SEEN_REL = join('dreams', '.seen')

/** 展示给她的那一句（任务书原文）。路径是相对工作区根的写法。 */
export const DREAM_HINT = '[系统：你昨晚做了一个梦，梦的碎片在 workspace/dreams/tonight.md]'

/**
 * 有没有一段「还没告诉她」的新梦。
 *
 * 判据只看一样东西：碎片的 mtime（梦境每晚会覆盖一次，mtime 变了就是新的一段）
 * 是否等于标记文件里记下的那一次。文件不存在 / 读不到 / 标记读不到，
 * 都视为「没有新梦」，返回空串。
 *
 * 纯读，不做标记——标记由调用方在真正展示之后写（见 markDreamSeen），
 * 这样测试可以脱离提示词组装单独验。
 *
 * @param {string|Function} workspaceRoot 工作区根（可以是 getter）
 * @returns {{file:string, mtimeMs:number} | null} 没有新梦返回 null
 */
export function pendingDream(workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (!root) return null
  const file = join(root, DREAM_FILE_REL)
  let st
  try {
    st = statSync(file)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  const key = String(st.mtimeMs)
  let seen = ''
  try {
    seen = readFileSync(join(root, DREAM_SEEN_REL), 'utf8').trim()
  } catch {
    seen = ''
  }
  if (seen === key) return null
  return { file, mtimeMs: st.mtimeMs }
}

/**
 * 展示之后写下标记。写失败不抛、不报错——最坏结果是下一段提示重复一次，
 * 不能因为标记文件写不进去把提示词组装带崩。
 *
 * @param {string|Function} workspaceRoot
 * @param {number} mtimeMs 当前碎片的 mtime（pendingDream 给的）
 */
export function markDreamSeen(workspaceRoot, mtimeMs) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (!root) return
  try {
    writeFileSync(join(root, DREAM_SEEN_REL), String(mtimeMs), 'utf8')
  } catch {
    /* 下次提示可能重复一次，仅此而已 */
  }
}

/**
 * 组装系统提示词时用的那一行：有新梦就给提示，没有就给空串。
 *
 * 注意：**调用方展示后要自己调 markDreamSeen**（identity.js 的 fish:dream 段），
 * 这层函数只负责读。
 *
 * @param {string|Function} workspaceRoot
 * @returns {string} 提示文本或空串
 */
export function dreamHintText(workspaceRoot) {
  const p = pendingDream(workspaceRoot)
  return p ? DREAM_HINT : ''
}
