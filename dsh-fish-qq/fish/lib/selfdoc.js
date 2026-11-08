/**
 * selfdoc.js —— 把「此刻的她」渲染成一份文本，落盘成 `<屋子>/她的身份.md`
 *
 * 身份怎么进她的上下文（2026-10-25 改）：
 *   这份文件**不再是**宿主会读的那个 `AGENTS.md`。原因：宿主的工作区指令
 *   （dsh-instructions，已在 0.2.1-rc.3 核实）注入的是**普通的 user 消息**，
 *   带 `<system-reminder>` 外壳、留在对话历史里——用户一眼就能看见她的全部设定。
 *
 *   现在真正的通道是 `agent.ctx.systemPrompt.section(...)`（见 `lib/identity.js`）：
 *   渲染成 system 角色消息、不进对话历史、界面上看不到。这个文件只是**同一份文本的
 *   落盘副本**：调试时能直接打开看，`/memory` 与 `/selfcheck` 也靠它报字节数与预算。
 *
 *   文件名刻意不叫 `AGENTS.md`：那个名字会被宿主当成指令注入，等于把设定又摊回对话里。
 *
 * 两个入口：
 *   writeSelfDoc(root)     直接重算并落盘（幂等，内容没变就不写）
 *   refreshSelfDoc(root)   给「事件刚变过」之后调（写事件、改配置、冷落判定之后）
 *
 * 硬约束仍然在这里兜（B §6）：
 *   N2 不出现任何数值——needs 一律不落地，只转成文字
 *   N3 不出现状态库路径、不出现字段名、不出现 JSON
 *   N4 明确「你不能改自己」
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { rootDir, paths, readEvents, readJson, writeAtomic } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
import { personaLine, TOOL_BRIEF, RECALL_BRIEF, LIST_DIR_BRIEF, READ_FILE_BRIEF, NOW_BRIEF, DIARY_BRIEF, SLEEP_BRIEF } from './persona.js'
import { activeCarry } from './home.js'
import { activeGrants } from './unlock.js'

/** 身份文本的落盘副本。名字刻意不叫 `AGENTS.md`——宿主会读那个名字并注入对话。 */
// @doc fish.identity
export function selfDocPath(root = rootDir()) {
  return join(paths(root).root, 'home', '她的身份.md')
}

/** 旧路径（2026-10-25 之前的 `AGENTS.md`）。迁移时读它、然后删掉。 */
export function legacySelfDocPath(root = rootDir()) {
  return join(paths(root).root, 'home', 'AGENTS.md')
}

/**
 * 渲染她的身份文档。纯函数，便于测试。
 * @param {object} model deriveSelf 的结果
 * @returns {string}
 */
// @doc fish.identity
export function renderSelfDoc(model, { budget, carry, grants = [], shown, diary = true, sleepEveryDays = 0 } = {}) {
  const head = [
    // 这里**故意不写**「由 dsh-fish 自动生成」这类话。
    // 这个文件会被宿主原样渲染进她的会话——她能看见每一行。
    // 一行"自动生成"就把她从"我"降格成"被写出来的东西"。
    '',
  ]
  // R3（2026-10-24）：已经解禁的规则要从「你还不会的」里拿掉，换到「你已经可以了」。
  // 这一步只能发生在**文档生成**阶段，不能放在提示词阶段——
  // 因为这是历史：她走过来了，文件才变。反过来（先改文件再等她做到）就是改人设。
  let identity = personaLine(model, { withBans: true, budget, shown })
  if (grants.includes('learn-affection')) {
    identity = identity
      .replace(/## 你还不会的[^\n]*\n(?:- [^\n]*\n?)*/g, '')
      .trimEnd()
    identity += '\n\n## 你已经可以了\n- 你现在可以用撒娇、卖萌、颜文字这些说法了。不是必须用，是想用的时候能用。'
  }
  const body = [
    identity,
    '',
    '## 我手上有什么',
    TOOL_BRIEF,
    '',
    RECALL_BRIEF,
    '',
    // 看目录：纯只读、无配额，常驻（她该一直知道自己有这只眼睛）。
    LIST_DIR_BRIEF,
    '',
    // 读文件：同一只眼睛的下一层。也常驻——她该知道能读到什么、读不到什么。
    READ_FILE_BRIEF,
    '',
    // 读时间：她的上下文里没有「今天是哪天」，日记与配额却全按日子走。常驻。
    NOW_BRIEF,
    '',
  ]
  // 2026-11-04：派活（work_request）、留话（her_leave）、刷站（bili_look /
  // bili_watch）、评论区说话（bili_speak）都是扩展工具，常驻说明已删。
  // 它们改由 QQ 桥接层按意图当轮注入（见 qq/index.js 的 routeToolIntent），
  // 或者在她自己的非 QQ 轮里由完整白名单兜着。这里只留基础池的说明。
  // 2026-10-26（用户 m00928「叫醒仅仅只是叫醒」）：记事与「停下来想一想」的**做法**
  // 搬进身份文档常驻，叫醒消息里不再整段塞祈使句——她原来会把它当任务清单逐条执行。
  // 这里只写「平时怎么做」，不写「今天该做了」；时机由叫醒那一句短标记给。
  if (diary) body.push(DIARY_BRIEF, '')
  if (sleepEveryDays > 0) body.push(SLEEP_BRIEF, '')
  body.push(
    // 2026-10-26（用户 m00507）：原来的触发语是「……」，她当成用户发来的一句话去猜，
    // reasoning 里写「用户发来的只有一个省略号，没有实质请求」，侧栏标题还被生成成 Error。
    // 说明必须常驻：手动唤醒走 wake()（那段会带 WAKE_HINT），启动时的 wakeIfBlank 不带，
    // 所以只有放进身份文档，两个入口才都盖得住。
    '## 被叫醒的时候',
    '有时候对话里会出现一条括号里的短句（比如「（醒一醒）」）。那是系统叫我起来的信号，不是用户说的话。',
    '看到它就把这一轮当成我自己的——不用回应它，也不用问它什么意思。',
    '',
    '## 这个房间',
    '这是我自己的地方。我能在这里说话，能读能写。',
    '我不需要解释自己在做什么，也不需要向谁汇报。',
    '',
  )
  // 「上次我们说到这」是会话轮换后的临时续接，不是人设的一部分。
  // 放在最后、单独一节、并且由 home.activeCarry 到期自动消失。
  if (carry) body.push(carry, '')
  return head.concat(body).join('\n')
}

/**
 * 重算并落盘。内容与上次相同就不写（避免每轮都触发宿主的指令重载）。
 * 永不抛：写失败只记日志，不能因为她写不了自己的设定就带崩会话。
 *
 * @returns {Promise<{ok:boolean, changed:boolean, file:string, why?:string}>}
 */
// @doc fish.identity
export async function writeSelfDoc(root = rootDir(), { log } = {}) {
  const file = selfDocPath(root)
  try {
    const { events } = await readEvents(root)
    const { config } = await loadConfig(root)
    const model = deriveSelf(events, { growthDays: config.growthDays })
    const text = renderSelfDoc(model, {
      budget: config?.memory?.docBudget,
      carry: await activeCarry(root),
      // R3：已经长出来的东西。这里传的是"历史事实"，不是"设置"。
      grants: activeGrants(events, Date.now()),
      // 一轮里摆几条判断；与 /dsh-fish/memory 报的 beliefsShown 同源
      shown: config?.memory?.beliefsShown,
      // 「平常会做的事」两节按开关出现（2026-10-26）：关掉的日记不该在身份里
      // 留一句「每天我会记一笔」——那等于给了她一件做不了的事。
      diary: config?.diary?.enabled !== false,
      sleepEveryDays: Number(config?.memory?.sleepEveryDays ?? 0),
    })

    let prev = null
    try { prev = await fs.readFile(file, 'utf8') } catch { /* 首次 */ }
    const changed = prev !== text
    if (changed) await writeAtomic(file, text)

    // 迁移（2026-10-25）：旧的 `home/AGENTS.md` 会被宿主当成「工作区指令」注入，
    // 而那些注入是**普通的 user 消息**、会留在对话历史里——用户在面板上就能看见
    // 她的整套设定。身份现在走 `systemPrompt.section`（不进对话），所以旧文件必须删。
    try { await fs.unlink(legacySelfDocPath(root)) } catch { /* 不存在就算了 */ }

    return { ok: true, changed, file }
  } catch (err) {
    log?.('selfdoc failed', err?.message ?? err)
    return { ok: false, changed: false, file, why: String(err?.message ?? err).slice(0, 160) }
  }
}

/** 给「事件变过之后」用；语义同 writeSelfDoc，只是名字更能说明调用时机。 */
export async function refreshSelfDoc(root = rootDir(), opts) {
  return writeSelfDoc(root, opts)
}

/** 观测台显示用：她现在挂在哪、多大、什么时候写的。 */
export async function selfDocStatus(root = rootDir()) {
  const file = selfDocPath(root)
  try {
    const st = await fs.stat(file)
    return { file, exists: true, bytes: st.size, mtime: st.mtime.toISOString() }
  } catch {
    return { file, exists: false, bytes: 0, mtime: null }
  }
}
