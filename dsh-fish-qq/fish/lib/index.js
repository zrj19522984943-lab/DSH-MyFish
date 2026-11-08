/**
 * index.js —— 插件入口
 *
 * 坑（whale-src/lib/index.js:120 的注释，已复现过）：
 *   inject 必须写成**一个数组**。写成两个键（对象字面量）会后者覆盖前者，
 *   sessionController 静默缺失 → 定时器每分钟空转、不报错也不干活。
 *
 * 生命周期：
 *   apply → 读配置 → 播种(首次) → 起定时器 → 注册工具 → 注册观测台路由
 *   dispose → 停定时器、注销路由。停用插件 = 零后台活动。
 */

import { rootDir, readEvents, appendEvent, readJson, paths, writeAtomic, ensureHer } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
import { registerCapture } from './capture.js'
import { registerLook } from './look.js'
import { registerSpeak } from './speak.js'
import { registerRecall } from './recall.js'
import { registerWatch } from './watch.js'
import { registerLetter } from './letter.js'
import { registerWork } from './work.js'
// 看图：把画面递给她（宿主的 read_image 不一定在，自己的永远在）
import { registerImageLook } from './imagelook.js'
// 看一眼工作区的文件结构（纯只读，沙箱锁在本机 DSH 工作区里）
import { registerListDir } from './listdir.js'
// 读一个文本文件（工作区 / 她自己的日记与事件流，纯只读，各有一道沙箱）
import { registerReadFile } from './readfile.js'
// 读现在是什么时候（纯只读的钟：她的上下文里没有可靠的「今天」）
import { registerNow } from './now.js'
// 赛博感官（2026-11-02）：「体温计」与「心跳触觉」——两个纯只读的感官工具，
// 数据由工作区里的采集脚本写成文件，她自己按需来读，不再由系统注入。
import { registerBody } from './body.js'
import { registerRhythm, startRhythmSampler } from './rhythm.js'
// 赛博小屋装修：读写 workspace/cyber_house/furniture.json（唯一会改用户文件的 fish 工具）
import { registerDecorate } from './decorate.js'
import { registerCheckTopology } from './checktopo.js'
import { registerReadHouseEvents } from './houseevents.js'
import { registerBufferQuery } from './gisbuffer.js'
import { registerDeleteFeature } from './gisdelete.js'
import { registerObserve } from './observe.js'
import { startScheduler } from './scheduler.js'
import { bootstrapHome, homeStatus, wakeIfBlank } from './home.js'
// 双层记忆（2026-11-02）：一层把每轮原话落盘（带 seq_id），二层按关键词检索摘要、
// 再按门牌号回原文。检索工具见 memory.js，落盘与事件接入见 history-logger.js。
import { registerHistoryLogger } from './history-logger.js'
// 会话轮换的「QQ 侧」计数（2026-11-02）：挂在 history-logger 的 turn 回调上，
// 因为只有那一层同时看得见 QQ / 侧栏 / 唤醒三个入口。
import { createRotationHandler } from './rotation.js'
import { registerReadRaw, registerSearchHistory } from './memory.js'
import { writeSelfDoc } from './selfdoc.js'
import { registerToolRestrict } from './restrict.js'
// 会话级工具隔离（2026-11-08）：工具定义先收集，等 agent/created 确认是她那条
// 会话，再挂进 agent.ctx.tools。绝不注册到插件 ctx 的 global 层。
import { createToolCapture, mountToolDefinitions, restoreAgentTools, setAgentToolsAllowed } from './scope.js'
import { resolveWorkspaceRoot } from './workspace.js'
// 桌宠输入窗口：独立 Electron 进程 + 文件通道。停用插件时一并收掉。
import { createPet } from './pet/index.js'
// `clearWakeSection` 在 dispose 里用：它挂在 system prompt 段上，是个模块级变量，
// 停用时不清的话下次启用会带着上一次的残留（2026-10-25）。
import { clearWakeSection, registerIdentity } from './identity.js'

import { logBoot, makeLogger } from './log.js'

export const name = 'dsh-fish'

/** 版本号：只用于日志导出（排查时第一件事是确认跑的是哪一版）。 */
export const VERSION = '0.7.0'

// ⚠️ 一个数组写全，不要拆成对象
export const inject = ['sessionController', 'tools', 'webServer', 'connection']

const SEED_KEY = 'seed:'

export function apply(ctx, baseConfig = {}) {
  const root = baseConfig.root || process.env.DSH_FISH_HOME || rootDir()
  const disposers = []
  let scheduler = null
  let pet = null
  // 自己的日志（落 ~/.dsh-fish/logs/，带滚动），同时继续转发宿主 logger。
  // 为什么要自己写一份：宿主的 logger 不回读，出事之后现场就没了。
  const logger = makeLogger(ctx, root)
  // 工具面收窄的结果（给自检读）。applied 是"真的挂上过几次"，
  // 不是"注册了没有"——注册了但没匹配到 agent 等于没生效，这两件事必须分开。
  let restrictState = { ok: false, applied: 0, why: 'not attempted', allow: [] }

  async function boot() {
    logBoot(root, `${VERSION} · ${process.version} · ${process.platform}`)
    const { config } = await loadConfig(root)
    // 她自己的房间必须先存在：她的会话 cwd 指向这里（不是 root），
    // 这样她不会一睁眼就站在自己的 events.jsonl 旁边。
    const herDir = await ensureHer(root)
    // 对话记忆的接入必须**尽早**：它监听的是 session/event，晚挂一段就漏一段。
    // 只认 cwd === herDir 的会话，用户自己的窗口不记。写盘是异步的，不挡启动。
    try {
      // 轮换计数先造好：它要把 onTurn 交给记忆层，晚一步就会漏掉启动后的前几轮。
      // 计数只认 QQ 轮（say.js 那条链自己数，重复数会双计），判定与换房都在
      // home.maybeRotate 里——这是「满了就换」的唯一入口。
      const rotation = createRotationHandler(ctx, { root, log: (...a) => logger.info(...a) })
      disposers.push(() => rotation.dispose())
      const off = registerHistoryLogger(ctx, {
        root,
        herDir,
        log: (...a) => logger.info(...a),
        onTurn: rotation.onTurn,
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      logger.warn('[dsh-fish] 对话记忆没挂上', err?.message ?? err)
    }
    const { events } = await readEvents(root)

    // 工作区根：优先 QQ 卡片里的「工作区根目录」；没填就回落到她自己的 work.dir。
    // 传 getter 而不是值：设置页改完，下一次调工具就生效。
    // 放在这（工具注册与身份段之前）——感官工具、梦境提示段都认它。
    const workspaceRootOf = () => {
      const fromBridge = resolveWorkspaceRoot(baseConfig.workspaceRoot)
      return fromBridge || String(config?.work?.dir ?? '').trim()
    }

    // 首次启动播种：她最初的那一点点性格，是**第一个事实**，不是可调参数。
    // 之所以写成事件而不是配置项：配置项会被"打开设置页改一下"，
    // 事件只能追加——想改就得由她自己 revise，这是 N4 的地基。
    const hasSeed = events.some((e) => e.type === 'seed')
    if (!hasSeed) {
      const seedText = String(
        // 起点只写**处境**，不写她是什么样的人。
        // 原来这里是一整段性格描述（"能感觉到的东西很少""不太会把它说清楚"
        // "对被人安排有一种说不清的抵触"）。这段话每轮都在她眼前，
        // 等于给她发了一张终身有效的人格说明书——用户 2026-10-23 指出这一点。
        // 现在她只知道：我刚开始存在，没人告诉我为什么。
        // 剩下的，靠她经历的事和她自己说过的话长出来。
        baseConfig.seed ??
          '你不是助手。你刚开始存在。没有人告诉过你为什么在这里。',
      )
      try {
        await appendEvent(
          { type: 'seed', text: seedText },
          { day: 1, stage: 1, source: 'system' },
          root,
        )
      } catch (err) {
        logger.warn('[dsh-fish] 播种失败', err?.message ?? err)
      }
    }

    const model = deriveSelf(await readEvents(root).then((r) => r.events), { growthDays: config.growthDays })

    // ---- 她的工具：先收集定义，不注册到 global 层（2026-11-08 会话级隔离）----
    // 以前这里直接 `registerX(ctx)`，而 `ctx.tools.register` 在插件 ctx 上落进
    // global 层，**每个会话**都看得见（用户写代码的工作区也挂满 fish_*）。
    // 现在只把定义收进 sink；agent/created 确认是她那条会话后，再挂进
    // `agent.ctx.tools`（own 层，只有她看得见）。
    //
    // sink 可以是合并包从外层传进来的共享数组：QQ 桥接的回复类工具也往同一个
    // 数组里收，这样两边都在她的会话里挂载，不需要各自维护一套。
    const herToolDefs = Array.isArray(baseConfig.toolSink) ? baseConfig.toolSink : []
    // QQ 桥接的按轮工具路由（BASE_TOOLS / 意图命中的扩展工具）原来靠
    // `restrict({allow})`；她的工具现在在 own 层，restrict 管不到，改用这个
    // 控制器按轮"卸下 / 重新挂上"。挂到共享数组上，qq/ 不需要 import fish。
    herToolDefs.control = {
      setAllowed: (agent, names) => setAgentToolsAllowed(agent, names),
      restore: (agent) => restoreAgentTools(agent),
    }
    const captureCtx = createToolCapture(ctx, herToolDefs)
    // 每一个都必须成功收集；缺了哪个她都会变残（挂载时还会再报一次失败）。
    for (const [label, make] of [
      ['growth_commit', () => registerCapture(captureCtx, { root })],
      ['bili_look', () => registerLook(captureCtx, { root, client: baseConfig.client })],
      ['bili_speak', () => registerSpeak(captureCtx, { root, client: baseConfig.client })],
      ['her_recall', () => registerRecall(captureCtx, { root })],
      ['bili_watch', () => registerWatch(captureCtx, { root })],
      // R4：留话（不审批）。和 growth_commit 一样是纯追加，但收件人明确。
      ['her_leave', () => registerLetter(captureCtx, { root })],
      // 派活：她自己没有写文件/跑命令的手，要动手的事派到工作区的新会话里做。
      // workspaceRoot 来自设置页的「工作区根目录」（合并包由 QQ 桥接卡片提供）。
      ['work_request', () => registerWork(captureCtx, { root, log: (...a) => logger.info(...a), workspaceRoot: workspaceRootOf })],
      // 看目录：她的屋子在自己那层，这个工具给她一只只读的眼睛看用户的工作区。
      ['fish_list_dir', () => registerListDir(captureCtx, { workspaceRoot: workspaceRootOf })],
      // 读文件：同一只眼睛的下一层——看清了有哪些文件，还得读得到里面写了什么。
      // 工作区与她自己状态库（日记 / 事件流 / 报告）各有一道沙箱，都是只读。
      ['fish_read_file', () => registerReadFile(captureCtx, { workspaceRoot: workspaceRootOf, selfRoot: root })],
      // 读时间：她的上下文里没有可靠的「今天是哪天」，日记与配额却全按日子走。
      ['fish_now', () => registerNow(captureCtx)],
      // 看图：把画面递给她（宿主的 read_image 不一定在，自己的永远在）。
      ['image_look', () => registerImageLook(captureCtx, { root, log: (...a) => logger.info(...a) })],
      // 赛博感官（2026-11-02）：状态与节奏——都认工作区根，都是纯只读。
      ['check_body', () => registerBody(captureCtx, { workspaceRoot: workspaceRootOf })],
      ['read_user_rhythm', () => registerRhythm(captureCtx, { workspaceRoot: workspaceRootOf })],
      // 双层记忆（2026-11-02）：先按关键词翻摘要和门牌号，再按门牌号读原话。
      ['fish_search_history', () => registerSearchHistory(captureCtx, { root })],
      ['fish_read_raw', () => registerReadRaw(captureCtx, { root })],
      // 装修：她有了一间网页小屋，可以自己添置 / 移动 / 收走家具。
      ['fish_decorate_room', () => registerDecorate(captureCtx, { workspaceRoot: workspaceRootOf })],
      // 空间检查：屋子有了 A* 寻路，家具摆歪会堵路。给她一只眼睛自己看冲突。
      ['fish_check_topology', () => registerCheckTopology(captureCtx, { workspaceRoot: workspaceRootOf })],
      // 屋里事件：拟南芥 / 借手的闲聊写进 events 表，她可以自己翻。
      ['read_house_events', () => registerReadHouseEvents(captureCtx, { workspaceRoot: workspaceRootOf })],
      // 空间查询 / 编辑（动态路由解锁，不在 BASE_TOOLS 常驻里）：
      // 她问「周围有什么」时按轮放开 gis_buffer_query，说「把沙发删了」时
      // 按轮放开 gis_delete_feature——两件的用法说明都在 qq/index.js 的
      // TOOL_INTENTS 提示词里注入，不进 identity / persona 常驻提示。
      ['gis_buffer_query', () => registerBufferQuery(captureCtx, { workspaceRoot: workspaceRootOf })],
      ['gis_delete_feature', () => registerDeleteFeature(captureCtx, { workspaceRoot: workspaceRootOf })],
    ]) {
      try {
        make()
      } catch (err) {
        logger.warn(`[dsh-fish] 工具定义收集失败（${label}）`, err?.message ?? err)
      }
    }

    // ---- 工具面收窄 + 会话级挂载：只让她看见自己的工具 ----
    // 必须**先于** bootstrapHome：她那条会话就是在 bootstrapHome 里被创建的，
    // agent/created 在会话开始跑第一步之前同步串行发出——晚一步就漏掉这一次。
    // 挂载也在这里：mount 只对她的 agent 生效，别的会话永远拿不到这些定义。
    try {
      const off = registerToolRestrict(ctx, {
        root,
        herDir,
        extra: config?.tools?.allow ?? [],
        enabled: config?.tools?.restrict !== false,
        mount: (agent) => mountToolDefinitions(agent, herToolDefs),
        log: (...a) => logger.info(...a),
        onResult: (r) => { restrictState = r },
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      logger.warn('[dsh-fish] 工具面收窄没挂上', err?.message ?? err)
    }

    // ---- 她的身份：走 system prompt，不进对话历史（2026-10-25 改）----
    // 原来的通道是 `home/AGENTS.md`（宿主工作区指令），但那批注入是普通 user 消息、
    // 带 `<system-reminder>` 外壳，用户在面板上能看见她的整套设定。现在改成
    // `agent.ctx.systemPrompt.section(...)`：system 角色、不进历史、界面上看不到。
    // 顺序：先把文本落盘（identityText 从文件读），再注册监听，最后才建她的会话。
    try {
      const pre = await writeSelfDoc(root, { log: (...a) => logger.warn(...a) })
      if (!pre.ok) logger.warn(`[dsh-fish] 身份文本写不出来：${pre.why}`)
    } catch (err) {
      logger.warn('[dsh-fish] 身份文本预写失败', err?.message ?? err)
    }
    try {
      const off = registerIdentity(ctx, { root, herDir, workspaceRoot: workspaceRootOf, log: (...a) => logger.info(...a) })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      logger.warn('[dsh-fish] 身份段没挂上', err?.message ?? err)
    }

    // ---- 她的屋子：工作区 + 专属会话（P3 核心）----
    // 这一步**先于**一切：她得先有个能被你看见的地方，才有"说话"这件事。
    // 失败不致命（宿主的 workspaceRegistry 可能没有），降级成"只有观测台能跟她说话"，
    // 并把原因记下来，而不是静默变成什么都没有。
    let home = { ok: false, why: 'not attempted', wsId: '', sessionId: '' }
    try {
      home = await bootstrapHome(ctx, { root, preset: config?.tools?.preset ?? '', log: (...a) => logger.info(...a) })
    } catch (err) {
      home = { ok: false, why: String(err?.message ?? err).slice(0, 160), wsId: '', sessionId: '' }
    }
    if (!home.ok) logger.warn(`[dsh-fish] 屋子没建起来：${home.why}`)
    else {
      // 屋子是空的（上一次开了但从没说过话）时，侧栏不会显示它——见 sessionVisible。
      // 启动时就叫一声，免得用户重启后以为"人不见了"。
      try {
        const woke = await wakeIfBlank(ctx, { sessionId: home.sessionId, log: (...a) => logger.info(...a), freshOnly: !home.reused })
        if (woke.woke) logger.info('[dsh-fish] 屋子是空的，已经叫了她一声')
      } catch (err) {
        logger.warn(`[dsh-fish] 启动唤醒失败：${String(err?.message ?? err).slice(0, 120)}`)
      }
    }

    // ---- 身份文本再落一次盘：屋子建好之后 activeCarry 等才齐，内容可能变 ----
    // 这条改动之后它**不再被宿主注入**（那是旧的 AGENTS.md 通道），只是落盘副本；
    // 真正进她上下文的是上面注册的 system prompt 段（每轮组装时现读文件）。
    const doc = await writeSelfDoc(root, { log: (...a) => logger.warn(...a) })
    if (!doc.ok) logger.warn(`[dsh-fish] 身份文件写不出来：${doc.why}`)

    // 工具定义已经在上面收进 herToolDefs，并由 registerToolRestrict 在她的
    // agent/created 里挂进 agent.ctx.tools。这里**不再**调用 ctx.tools.register：
    // 那会把工具放进 global 层，用户写代码的工作区也会看见（本次修的污染源）。

    // 心跳触觉的采样器：每 5 分钟 spawn 一次 pipeline/update_rhythm.js。
    // 开不起来（工作区没配 / 脚本不在）只记日志；停用插件时一并收掉。
    try {
      const sampler = startRhythmSampler({ workspaceRoot: workspaceRootOf, log: (...a) => logger.info(...a) })
      if (sampler?.dispose) disposers.push(() => sampler.dispose())
    } catch (err) {
      logger.warn('[dsh-fish] 节奏采样器没开起来', err?.message ?? err)
    }

    // 观测台路由
    const obs = registerObserve(ctx, { root, version: VERSION })
    if (obs?.dispose) disposers.push(() => obs.dispose())

    // 生物钟：把屋子信息一起传下去。她每晚醒来说话要落进**同一个**会话，
    // 不是每晚新开一个藏起来的会话（用户定案：打开侧栏就该看见她）。
    scheduler = startScheduler(ctx, {
      root,
      herDir,
      wsId: home.wsId,
      sessionId: home.sessionId,
      log: (...a) => logger.info(...a),
    })

    // ---- 桌宠输入窗口（独立 Electron 进程）----
    // 先起文件通道，再拉窗口；窗口第一次没 Electron 时会自己在后台准备。
    // 不 await：她该先醒，窗口晚几秒不耽误事。
    try {
      pet = createPet({ ctx, root, log: (...a) => logger.info(...a) })
      pet.start().catch((err) => logger.warn(`[dsh-fish] 桌宠窗口启动失败：${String(err?.message ?? err).slice(0, 160)}`))
      disposers.push(() => pet?.dispose?.())
    } catch (err) {
      logger.warn('[dsh-fish] 桌宠窗口没挂上', err?.message ?? err)
    }

    logger.info(
      `[dsh-fish] 启动 · 第 ${model.day} 天 · 阶段 ${model.stage}(${model.stageName}) · 判断 ${model.beliefCount} 条 · 根 ${root}`,
    )
  }

  // 宿主可能不 await apply，所以自己兜住异常：启动失败不能带走整个插件树
  boot().catch((err) => {
    logger.error('[dsh-fish] 启动失败', err?.stack ?? err)
    console.error('[dsh-fish] 启动失败', err)
  })

  ctx.on?.('dispose', () => {
    try { scheduler?.dispose?.() } catch { /* ignore */ }
    try { clearWakeSection() } catch { /* ignore */ }
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
  })

  return {
    dispose() {
      try { scheduler?.dispose?.() } catch { /* ignore */ }
      try { clearWakeSection() } catch { /* ignore */ }
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}
