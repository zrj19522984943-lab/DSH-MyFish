/**
 * dsh-fish-qq —— 宿主半（一个插件里跑两套东西）
 *
 *   fish/  = dsh-fish（大肥鱼：人格 / 事件流 / B 站 / 桌宠窗口）
 *   qq/    = dsh-qq-bridge（QQ 桥接：OneBot/NapCat 入站出站、认主、主动私聊）
 *
 * 为什么不是把两份代码真正揉成一份：它们本来就是两个独立服务，
 * 各自有自己的 ctx.inject、自己的 HTTP 路由、自己的状态库。
 * 揉进一个文件只会让升级时无法分辨“这行是谁的”。这里只做**装配**：
 *   - inject 取并集（宿主会等这些服务都就绪再调 apply）
 *   - apply 依次调两边的 apply，各自的清理照旧走 ctx.effect / ctx.on('dispose')
 *   - config 分槽：{ fish: {...}, qq: {...} }，互不串味
 *
 * 唯一一处**真的改动**在 qq/ 里：qq 的 targetSessionId 留空时会自动读
 * ~/.dsh-fish/home.json 拿到大肥鱼的会话 id —— 合并包才做得到这件事，
 * 独立安装时用户得手动把会话 id 抄过去。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { apply as applyFish, inject as fishInject } from './fish/lib/index.js'
import { apply as applyQQ, inject as qqInject } from './qq/index.js'

export const name = 'dsh-fish-qq'
export const VERSION = '1.4.0'

/** 两边的服务依赖取并集；缺一个宿主就不会调 apply（宁可不启动，也不要半残）。 */
export const inject = [...new Set([...fishInject, ...qqInject])]

/**
 * 从 QQ 桥接的设置里读「工作区根目录」。
 *
 * 为什么读文件而不是 import qq 的内部函数：qq/ 要保持能单独跑（它自己的测试
 * 直接 import 它），不想为一条设置引入循环依赖。文件位置与 qq/index.js 一致：
 * statePath 同目录下的 qq-bridge-settings.json。
 *
 * 返回的是值不是 getter；调用方包一层 getter，设置改完下一次调工具就生效。
 */
function readQqWorkspaceRoot(qqConfig = {}) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const statePath = qqConfig.statePath || join(home, 'qq-bridge-state.json')
    const settingsPath = join(dirname(statePath), 'qq-bridge-settings.json')
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const v = raw?.values?.workspaceRoot
    if (typeof v === 'string' && v.trim()) return v.trim()
  } catch {
    // 没有设置文件 / 还没配：回落到 composition config。
  }
  return String(qqConfig.workspaceRoot ?? '').trim()
}

export function apply(ctx, config = {}) {
  const disposers = []

  // ── 会话级工具隔离（2026-11-08）──────────────────────────────────────────
  //
  // 两边的工具定义都先收进这**同一个**数组，谁也不注册到插件 ctx 的 global 层。
  // fish 侧会在 agent/created 确认是她那条会话后，把它们挂进 agent.ctx.tools；
  // 用户写代码的工作区因此看不到任何 fish_* / qq_bridge_send 等她的工具。
  //
  // 只有 QQ 的管理/调试工具（status / proactive / napcat …）仍然 global：
  // 那是操作员在 DSH 工作区里排障用的，不属于"她的技能"。
  const herToolDefs = []

  // 大肥鱼先起：她负责建屋子（工作区 + 会话），
  // QQ 桥接默认要去读那条会话的 id —— 顺序反了第一次会读不到（读不到也有兜底，见 qq/index.js）。
  // workspaceRoot 走 getter：QQ 设置页里改完，fish_list_dir / work_request 下一次调用就用新值。
  try {
    const d = applyFish(ctx, {
      ...(config.fish ?? {}),
      workspaceRoot: () => readQqWorkspaceRoot(config.qq ?? {}),
      toolSink: herToolDefs,
    })
    if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
  } catch (error) {
    ctx.logger?.error?.('[dsh-fish-qq] 大肥鱼启动失败', error)
  }

  try {
    const d = applyQQ(ctx, { ...(config.qq ?? {}), toolSink: herToolDefs })
    if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
  } catch (error) {
    ctx.logger?.error?.('[dsh-fish-qq] QQ 桥接启动失败', error)
  }

  return {
    dispose() {
      for (const d of disposers.reverse()) {
        try { d() } catch { /* 卸载时任何一边出错都不该拦住另一边 */ }
      }
    },
  }
}
