/**
 * rotation.js —— 让「聊满 N 轮换新会话」对 QQ 也成立（2026-11-02）
 *
 * ## 原来的漏洞
 *
 * 轮换写在 say.js 里，只有「设置页 /say」和「桌宠输入」那条链路会走 sayToHer。
 * QQ 桥接是另一条路：`ensureTargetAgent()` → `agent.followup/steer`，完全不经过
 * say.js。结果是在 QQ 里聊一整晚，home.json 的 `turns` 一直是 0，永远到不了
 * `chat.rotateAfter`。用户看到的「自动轮换不生效」有一半是这件事。
 *
 * ## 为什么挂在这里
 *
 * `history-logger.js` 是唯一同时看得见 **QQ / 侧栏 / 定时唤醒** 三个入口的地方
 * （它按 `cwd === herDir` 认她的会话）。它现在每记完一轮会调 `onTurn({userText,
 * assistantText, time})`，这里只做三件事：
 *
 *   1. 认出这是 QQ 轮（正文带 `[QQ · …]` 前缀）；
 *   2. 原话进 talkmem（否则换会话后的 carry 永远是空的——QQ 聊的话从来没被记过）；
 *   3. 轮数 +1，然后立刻把判定交给 home.maybeRotate。
 *
 * ## 为什么**不**防抖（2026-11-02 当天改过一次）
 *
 * 最初这里排队 1.5 秒再判定，想合并「连发几条」。但那正好毁掉了验收场景：
 * 第 3 句结束 → 排队 1.5 秒 → 第 4 句已经到了 → 它还是被投给旧会话。
 * 现在每轮结束**立刻**判定（判定本身只是读一次 config + home.json，很便宜），
 * 换房在下一句到达之前完成；提要慢慢生成，由 `handoffPending` 占位挡住
 * 「新房间第一条消息」，见 home.js 的 maybeRotate / waitHandoffReady。
 *
 * ## 边界
 *
 *   - 只认 QQ 轮。say.js 那条链自己会 bump，也在这里再数一遍就会双计。
 *   - 唤醒轮（系统叫醒）不算「聊了一轮」：那是她自己的作息，不是对话。
 *   - 任何失败都只记日志：计数坏掉最多是不换会话，不能影响她回话。
 */

import { rootDir } from './store.js'
import { addExchange } from './talkmem.js'
import { bumpTurns, maybeRotate } from './home.js'

/** QQ 入站正文的前缀（qq/index.js renderInbound 生成，形状是稳定的）。 */
export const QQ_INBOUND_MARK = '[QQ · '

/**
 * 造一个「她这一轮说完了」的处理函数，交给 registerHistoryLogger 的 onTurn。
 *
 * @param {object} ctx 宿主 ctx（maybeRotate 需要 sessionController）
 * @param {{root?:string, log?:Function, wake?:boolean}} deps
 * @returns {{onTurn:Function, flush:Function, dispose:Function}}
 */
// @doc fish.handoff
export function createRotationHandler(ctx, { root = rootDir(), log, wake = false } = {}) {
  /** 还没跑完的轮次（flush 用；正常运行时它们自己会结束）。 */
  const inflight = new Set()

  function onTurn(turn) {
    const userText = String(turn?.userText ?? '')
    if (!userText.includes(QQ_INBOUND_MARK)) return
    const assistantText = String(turn?.assistantText ?? '')

    const job = (async () => {
      // 1) 原话留档：换房间后 carry 能接上「上次说到这」
      await addExchange(root, { me: userText, her: assistantText }).catch(() => {})
      // 2) 轮数 +1（与 say.js 用的是同一个计数器）
      const turns = await bumpTurns(root, 1)
      log?.(`[dsh-fish] QQ 轮 +1 → ${turns} 轮`)
      // 3) 立刻判定：到点就换（换房是毫秒级的；提要随后生成）
      const r = await maybeRotate(ctx, { root, log, wake })
      if (r?.rotated) log?.(`[dsh-fish] QQ 会话轮换：${r.old || '（无）'} → ${r.sessionId}`)
    })().catch((err) => {
      log?.(`[dsh-fish] QQ 轮计数失败：${String(err?.message ?? err).slice(0, 160)}`)
    })

    inflight.add(job)
    void job.finally(() => inflight.delete(job))
  }

  /** 测试 / 卸载时等排队的那几轮跑完。 */
  function flush() {
    return Promise.all([...inflight])
  }

  function dispose() {
    inflight.clear()
  }

  return { onTurn, flush, dispose }
}

/**
 * 兼容入口：只要回调，不关心 flush/dispose 的调用方用这个。
 * @returns {Function} onTurn
 */
export function registerRotation(ctx, deps = {}) {
  return createRotationHandler(ctx, deps).onTurn
}
