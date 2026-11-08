/**
 * restrict.js —— 只让她看见自己的工具（2026-10-24）
 *
 * ## 为什么要有这个
 *
 * 她的上下文里原本有 **37 个工具**，其中只有 6 个是本插件给的，另外 31 个是宿主
 * 标准工具集（shell、读写文件、联网搜索、定时任务、子代理、工作流……）。
 * 工具定义是每轮都要塞进上下文的东西，31 个用不上的定义意味着：
 *   ① 每轮白烧一大截 token；
 *   ② 她看得见"能跑命令""能写文件"，就真的可能去调 —— 这是"莫名调工具"的来源。
 *
 * ## 为什么走 tools.restrict，而不是 agentPreset
 *
 * `agentPreset` 那条路走过三次都失败（详见 docs/B-技术契约.md §24）：会话首行
 * 能写上 `agentPreset: fish-home`，但首轮 31 秒后宿主自己 append
 * `agent-preset/selected {agentPreset:'standard'}` 把它改回默认；把 preset 的
 * `plugins` 清空也仍然是 37 个工具。那条路是"全局组合"，不是"这个 agent 的视图"。
 *
 * `ctx.tools.restrict()` 才是对的那把刀。宿主自己的开发文档原话：
 *   「Hiding tools from one agent is `ctx.tools.restrict()` on that agent's
 *     context; it keeps schema presentation, lookup, and execution aligned.」
 *
 * 三个关键性质（都来自宿主源码，不是我猜的）：
 *   1. **必须有作用域**：`restrict()` 在无作用域的 ctx 上直接抛
 *      「requires a scoped context (agent.ctx): a context-global restriction
 *        would mask every agent」。→ 天然只影响那一个 agent，不碰用户自己的窗口。
 *   2. **只能减不能加**：`allow`/`deny` 编成 Set 后 append 到该 agent 的层上。
 *      所以"先给 6 个、真要再申请"做不到 —— 被挡掉的工具连名字都看不见。
 *      这正是我们想要的：她不需要"申请"，她本来就用不到那些。
 *   3. **名字必须存在**：`restrict()` 会拿 `restrictableNames` 校验，名字不认识
 *      就抛错（报错里还会列出全部已知工具名）。所以清单写死在这里，改错立刻炸，
 *      不会静默失效。
 *
 * ## 为什么留 read_image、又自己加了一个 image_look
 *
 * `bili_watch` 和 `/say` 的图片都只是**落一个文件路径**，真正"看见"要靠
 * 把图递进去。`read_image` 是宿主 `@deepseek-ai/dsh-tool-fs` 注册的，**只在
 * 持久 attachments 服务挂载时才注册**，别人的机器上不一定有——真机上她报过
 * 「unknown tool」（restrict 不认识这名字，它就被从白名单剔了下去，她连看图
 * 的手都没有）。所以 2026-10-27 起我们自己注册了 `image_look`：名字是我们
 * 自己登记的，一定在。`read_image` 仍然留着：宿主给得了就是多一只手。
 *
 * 同理 **不给 `skill`**：一旦有它，`~/.dsh/skills` 里任何未审过的第三方内容
 * 都能进她上下文。将来要她用什么，就包一个形状固定的专用工具（像 bili_watch），
 * 不开通用口。
 *
 * ## 2026-11-08：restrict 之上再加一层"会话级隔离"
 *
 * 只靠 `restrict` 有个漏：她的工具注册在插件 ctx 的 global 层，**别的会话也看得见**
 * （restrict 只作用于她那条会话）。真正的修法是先把工具挂进 `agent.ctx.tools`
 * 的 own 层（`fish/lib/scope.js`），再对她下 restrict。这样：
 *   - 用户写代码的工作区：global 层没有 fish_*，看不见；
 *   - 她那条会话：own 层的工具不受 restrict 影响，照常可见；
 *   - 旧版本/别的模块漏在 global 的插件工具：非她的会话用 `deny` 兜底摘掉。
 */

import { isHerAgent } from './scope.js'

// 兼容旧的 import 口：identity.js / history-logger.js 仍然从 restrict.js 拿它。
export { isHerAgent } from './scope.js'

/**
 * 插件自己产出的 20 个工具。
 *
 * 2026-11-08 起这些名字**不再注册进 global 层**：定义由 `fish/lib/scope.js` 收集，
 * `agent/created` 时挂进她那条会话的 own 层。这个数组仍然是**权威名单**：
 *   - 自检拿它核对"真的挂上了没有"；
 *   - 非她的会话用它做 deny 兜底；
 *   - 顺序无意义，但新增/改名时 `fish/lib/index.js` 的收集列表必须同步。
 */
// @doc fish.tools
export const FISH_TOOLS = Object.freeze([
  'growth_commit', // 记下自己的想法（唯一的写入口）
  'her_recall', // 翻自己的旧事
  'her_leave', // 留一句话给他
  'bili_look', // 看 B 站的列表
  'bili_watch', // 看一条视频的画面
  'bili_speak', // 在评论区说话
  'work_request', // 把要动手做的事派到工作区（她没有写文件的手，只能派）
  'fish_list_dir', // 看一眼工作区的目录结构（纯只读，过不了沙箱就拒绝）
  'fish_read_file', // 读工作区 / 她自己状态库里的文本文件（纯只读，两份沙箱）
  'image_look', // 看一张图（把画面递给她，不只给路径）
  'fish_now', // 读现在是什么时候（纯只读的钟，不猜日期）
  'check_body', // 赛博感官·体温计：读工作区 sensors/status.md（纯只读）
  'read_user_rhythm', // 赛博感官·心跳触觉：读工作区 sensors/user_rhythm.md（纯只读）
  'fish_search_history', // 双层记忆：按关键词翻以前的对话，只给摘要 + 门牌号（纯只读）
  'fish_read_raw', // 双层记忆：按门牌号读回原话（纯只读）
  'fish_decorate_room', // 赛博小屋装修：添置 / 移动 / 收走家具
  'fish_check_topology', // 赛博小屋空间检查：家具重叠 / 越界（纯只读）
  'read_house_events', // 屋里最近发生的事：NPC 闲聊等（纯只读）
  'gis_buffer_query', // 赛博小屋空间查询：以小鱼为中心画圈看周围有什么（纯只读，动态解锁）
  'gis_delete_feature', // 赛博小屋空间编辑：删家具 / 要素并刷新 A* 栅格（动态解锁）
])

/**
 * QQ 桥接（`dsh-fish-qq` 合并包）里**她用来跟你说话**的 7 个工具。
 *
 * 2026-11-08 起这 7 个也走 scoped 挂载（QQ 侧的 `SCOPED_QQ_TOOLS` → 共享
 * `toolSink` → 她的 own 层），所以正常路径下它们**不在** global 层，`restrict`
 * 的 allow 里也不会出现。这里保留名单是为了：
 *   - 兜底守卫的放行集（否则 `subsend` 等会被误挡，她回一句「这件事我做不到。」）；
 *   - 非她的会话里万一漏在 global 层，deny 兜底能按名字摘掉。
 *
 * 另外 6 个管理/调试工具（status / proactive / idle / transport / simulate /
 * napcat）是**操作员工具**，不属于她：合并包里默认不注册到任何会话
 * （`debugToolsInWorkspace:false`），用户工作区因此保持原生工具面；要排障时
 * 把它打开，它们才会以 global 形式出现在工作区。
 */
// @doc fish.tools
export const QQ_BRIDGE_TOOLS = Object.freeze([
  'qq_bridge_send', // 出站（replyMode='tool' 时是唯一通道）
  'qq_bridge_send_multi', // 分条发送：一次把 1–3 段话按顺序发出去（2026-10-28）
  'qq_bridge_subsend', // 主人点名把一段话私聊给指定的人
  'qq_bridge_sticker', // 表情包：收藏 / 按情绪发
  'qq_bridge_listen', // 会话跟随窗口
  'qq_bridge_fileget', // 主人点名把工作区里的文件私聊发给主人（2026-10-27）
  'qq_bridge_filesend', // 主人点名把工作区里的文件私聊发给指定的人（2026-10-27）
])

/**
 * 她允许看见的工具。
 * 最后一个是宿主给的 `read_image`——它由宿主某个插件提供，别人的机器上不一定装；
 * 缺了不影响她说话写字，只是看不了图，所以自检里只当提示、不当失败。
 */
// @doc fish.tools
export const HER_TOOLS = Object.freeze([...FISH_TOOLS, ...QQ_BRIDGE_TOOLS, 'read_image'])

/**
 * 插件自己产出的工具名（不含宿主的 `read_image`）。
 * 这些名字**她独占**：非她的会话里出现任何一个都算污染，要在 agent/created 兜底 deny。
 */
// @doc fish.tools
export const PLUGIN_TOOLS = Object.freeze([...FISH_TOOLS, ...QQ_BRIDGE_TOOLS])

/**
 * 注册限制，并把她的工具**只挂到她自己的会话**上。
 *
 * 必须在任何 agent 被创建之前调用（`agent/created` 是同步串行监听，在会话开始跑
 * 第一步之前完成），所以 index.js 里放在 ensureHer 之后、bootstrapHome 之前。
 *
 * 2026-11-08 起这里分成三件事：
 *   1. **挂工具**：`mount(agent)` 把收集好的定义注册进 `agent.ctx.tools`（own 层，
 *      只有她这条会话看得见）。工具不再注册到插件 ctx 的 global 层。
 *   2. **收窄她**：`restrict({ allow })` 只留下宿主的少量工具；她自己的工具在
 *      own 层，本来就不受 allow/deny 影响。
 *   3. **挡住别人**：非她的会话里，如果还有本插件的工具漏在 global 层（防御性
 *      兜底，比如旧版本或别的模块误注册），用 `restrict({ deny })` 按名字摘掉。
 *      正常路径下 fish 工具根本不在 global 层，这一条是第二道锁。
 *
 * @param {object} ctx    插件 context
 * @param {object} opts
 * @param {string} [opts.root]    状态库根（含 home.json）；不给就从 herDir 推
 * @param {string} opts.herDir    她的屋子（会话 cwd）
 * @param {string[]} [opts.extra] 用户在设置页额外放行的工具名
 * @param {boolean} [opts.enabled=true] 是否收窄她的宿主工具面（关掉不影响挂工具）
 * @param {(agent: object) => {mounted?: string[], failed?: string[]}} [opts.mount]
 * @param {(msg: string, err?: unknown) => void} [opts.log]
 * @param {(info: object) => void} [opts.onResult] 记录"这次真的挂上没有"（给自检用）
 */
// @doc fish.tools
export function registerToolRestrict(
  ctx,
  { root = '', herDir, extra = [], enabled = true, log, onResult, mount } = {},
) {
  // 无论调用方传不传 onResult，模块级单例都要更新——自检读的是它。
  const __raw = onResult
  onResult = (r) => { report(r); try { __raw?.(r) } catch { /* ignore */ } }
  const say = log ?? (() => {})

  const allow = [...new Set([...HER_TOOLS, ...extra.map((s) => String(s).trim()).filter(Boolean)])]
  let applied = 0
  let failed = ''
  let mountFailed = []

  // 每个 agent 只挂一次 / 只收窄一次；插件热重载后已有 agent 重新进这里时靠它去重。
  const mountedAgents = new WeakSet()
  const restrictedAgents = new WeakSet()
  const deniedAgents = new WeakSet()

  /** 记一份全局（inherited）工具名快照，给 restrict 校验和白名单输入框用。 */
  const rememberGlobalNames = (agent) => {
    try {
      let set = null
      try { set = agent?.ctx?.tools?.view?.(agent)?.restrictableNames } catch { set = null }
      if (!set || typeof set[Symbol.iterator] !== 'function' || set.size === 0) {
        // 兜底：拿不到 agent 视角就退回 global view（至少还有插件自己那几个）
        try { set = agent?.ctx?.tools?.view?.()?.restrictableNames } catch { set = null }
      }
      if (set && typeof set[Symbol.iterator] === 'function') {
        const names = [...set].map((x) => String(x)).sort()
        if (names.length) lastKnownTools = names
        return new Set(names)
      }
    } catch { /* 拿不到就算了，界面会退回只查拼写 */ }
    return null
  }

  /**
   * 非她的会话：把本插件漏在 global 层的工具名摘掉。
   * 只 deny 已经登记过的名字——`restrict()` 遇到不存在的名字会整条抛错。
   */
  const denyPluginTools = (agent) => {
    if (!agent || deniedAgents.has(agent)) return
    deniedAgents.add(agent)
    const tools = agent?.ctx?.tools
    if (typeof tools?.restrict !== 'function') return
    let known = null
    try { known = tools.view?.(agent)?.restrictableNames } catch { known = null }
    if (!known || typeof known.has !== 'function') return
    const deny = PLUGIN_TOOLS.filter((name) => known.has(name))
    if (deny.length === 0) return
    try {
      const dispose = tools.restrict({ deny })
      try { agent.ctx.effect?.(() => dispose) } catch { /* 靠父级回滚 */ }
      say(`[dsh-fish] 会话隔离：这个会话不是她的，摘掉 ${deny.length} 个插件工具`)
    } catch (err) {
      say(`[dsh-fish] 会话隔离：非她的会话里摘工具失败（不影响她那边）：${String(err?.message ?? err).slice(0, 160)}`)
    }
  }

  const onCreated = ({ agent } = {}) => {
    // ---- 不是她的会话：只做防御性摘除，绝不挂载任何她的工具 ----
    if (!isHerAgent(agent, herDir, root)) {
      denyPluginTools(agent)
      return
    }

    // 只从**她**的视角记全局名字：不同 preset 的祖先层不一样，拿别人的快照
    // 去筛她的 allow 名单会误判。
    const knownSet = rememberGlobalNames(agent)

    // ---- 1) 把她的工具挂进这个 agent 自己的层 ----
    // 这一步**不受 enabled 影响**：enabled 只管"她能不能看见宿主的标准工具"，
    // 不应该把她自己的工具也一起关掉。
    let mounted = []
    if (typeof mount === 'function' && !mountedAgents.has(agent)) {
      mountedAgents.add(agent)
      mountFailed = []
      try {
        const r = mount(agent)
        // 工具的注册生命挂在 agent.ctx 上；插件卸载时 agent 可能还活着，
        // 这里再挂一道插件级的回收，避免热重载后同名工具重复注册。
        if (r?.control && typeof ctx.effect === 'function') {
          try { ctx.effect(() => () => { try { r.control.disposeAll?.() } catch { /* ignore */ } }) } catch { /* ignore */ }
        }
        if (Array.isArray(r?.mounted)) mounted = r.mounted.map((x) => String(x))
        if (Array.isArray(r?.failed) && r.failed.length) {
          mountFailed = r.failed.map((x) => String(x))
          say(`[dsh-fish] 有 ${mountFailed.length} 个工具没挂到她的会话上：${mountFailed.join('；').slice(0, 300)}`)
        }
      } catch (err) {
        mountFailed = [String(err?.message ?? err).slice(0, 240)]
        say(`[dsh-fish] 把工具挂到她的会话上失败：${mountFailed[0]}`)
      }
    }
    const mountedSet = new Set(mounted)
    if (mounted.length) say(`[dsh-fish] 会话隔离：她的 ${mounted.length} 个工具只挂在她这条会话上`)

    if (restrictedAgents.has(agent)) return
    restrictedAgents.add(agent)

    if (!enabled) {
      say('[dsh-fish] 工具面收窄：关闭（配置里关掉了）')
      onResult?.({ ok: true, applied: 0, why: 'disabled', allow, mounted: [...mountedSet], mountFailed })
      return
    }

    try {
      const scopedTools = agent?.ctx?.tools
      if (!scopedTools?.restrict) {
        failed = '宿主的 agent.ctx 上没有 tools.restrict（版本不支持）'
        say(`[dsh-fish] 工具面收窄失败：${failed}`)
        onResult?.({ ok: false, applied, failed, why: 'failed', allow, mounted: [...mountedSet], mountFailed })
        return
      }

      // 当前全局视角里真正登记过的名字。scoped 工具不在这里——它们在 own 层，
      // 本来就不需要、也不能写进 restrict 的 allow（写了会被判 unknown）。
      const knownNow = knownSet ?? new Set(lastKnownTools ?? [])

      // ---- 兜底的一道 guard ----
      //
      // restrict 挡不住「注册在 agent 自己作用域里的工具」。宿主源码原话：
      //   if (own !== void 0) for (const [name, definition] of own.tools.entries()) {
      //     knownNames.add(name); visible.set(name, definition)   // ← 不过 admits
      //   }
      // 也就是说 inherited（全局/祖先）里的工具会被掩码，而 own 层的不受 allow/deny 约束。
      // 她自己那些工具现在正是 own 层——所以要显式放进 guard 的放行集，否则会被误挡。
      //
      // 顺序：先挂 guard、再下 restrict。restrict 因名字表没就绪抛错时，守卫已经在了。
      const guardSet = new Set([...allow].filter((n) => mountedSet.has(n) || knownNow.has(n)))
      let blocked = 0
      let guardOk = typeof scopedTools.guard === 'function'
      if (guardOk) {
        try {
          const disposeGuard = scopedTools.guard((exec) => {
            const name = exec?.name
            if (!name || guardSet.has(name)) return undefined
            if (blocked < 20) {
              blocked += 1
              say(`[dsh-fish] 挡住了一次不该有的调用：${name}`)
            }
            // 话术刻意不带「权限/禁止/违规」这类系统词——她要以为是自己做不了，
            // 不是以为背后有个管理员在拦她。
            return '这件事我做不到。'
          })
          try {
            agent.ctx.effect?.(() => disposeGuard)
          } catch {
            /* 同上 */
          }
        } catch (err) {
          guardOk = false
          say(`[dsh-fish] 兜底守卫没挂上（restrict 仍然生效）：${String(err?.message ?? err).slice(0, 160)}`)
        }
      } else {
        say('[dsh-fish] 这个宿主版本没有 tools.guard，只能靠 restrict')
      }

      // ---- 主刀：restrict ----
      // 只写 allow。**只留全局层里、而且不是她 scoped 工具的名字**：
      //   - QQ 回复类工具已改成 scoped，不在这里；
      //   - read_image / 用户在设置页额外放行的宿主工具在这里，保留；
      //   - 宿主的标准工具（bash / write / 联网…）不在 allow 里，全部看不见。
      // knownNow 为空（宿主没给视角）时传空 allow：宁可只留她自己的工具，
      // 也不要把一个拼错的名字塞进去导致整条收窄失效。
      const restrictAllow = knownNow.size > 0
        ? allow.filter((n) => knownNow.has(n) && !mountedSet.has(n))
        : []

      const applyRestrict = (names) => {
        const dispose = scopedTools.restrict({ allow: names })
        // 文档要求：把这把刀挂到 agent 自己的生命周期上，agent 销毁时自动收回。
        try { agent.ctx.effect?.(() => dispose) } catch { /* 拿不到 effect 就靠父级回滚，不致命 */ }
      }
      try {
        applyRestrict(restrictAllow)
        applied += 1
      } catch (err) {
        // 0.2.1-rc.3 真机：名字表还没就绪时会抛「names unknown global tools …」。
        // 从报错里捡回真名单，按交集再收一次——不认识的名字本来也调不到。
        const msg = String(err?.message ?? err)
        const healed = adoptKnownFromError(msg)
        const known = new Set(lastKnownTools ?? [])
        const usable = restrictAllow.filter((n) => known.has(n))
        if (!healed) throw err
        applyRestrict(usable)
        applied += 1
        say(`[dsh-fish] 工具面收窄：有 ${restrictAllow.length - usable.length} 个名字宿主还没登记，先按认识的 ${usable.length} 个收窄`)
      }

      say(
        `[dsh-fish] 工具面收窄：她这条会话只留 ${restrictAllow.length} 个全局工具` +
          `${mountedSet.size ? ` + 她自己的 ${mountedSet.size} 个` : ''}${guardOk ? '，另有兜底守卫' : ''}`,
      )
      // 真的挂上了才算数——"注册了"和"生效了"必须分开报，否则自检会说谎。
      onResult?.({
        ok: true,
        applied,
        failed,
        why: 'applied',
        allow,
        restrictAllow,
        mounted: [...mountedSet],
        mountFailed,
        guard: guardOk,
      })
    } catch (err) {
      failed = String(err?.message ?? err).slice(0, 300)
      // 宿主的报错里带着「known global tools: a, b, c」全量名单（0.2.1-rc.3 实测）。
      if (adoptKnownFromError(failed)) say('[dsh-fish] 从报错里捡回了工具名单，白名单校验以后能查真名了')
      say(`[dsh-fish] 工具面收窄失败：${failed}`)
      onResult?.({ ok: false, applied, failed, why: 'failed', allow, mounted: [...mountedSet], mountFailed })
    }
  }

  const off = ctx.on?.('agent/created', onCreated)

  // 立刻把结论报一次（给自检和设置页读）。
  // 注意：onCreated 是之后才跑的，所以这里报的是"已注册"，不是"已生效"。
  onResult?.({ ok: true, applied: 0, why: 'registered', allow, mounted: [] })

  // 插件热重载时，已经活着的 agent 不会再发 agent/created：补一遍，
  // 让她的会话重新挂上工具、让非她的会话把漏出来的插件工具摘掉。
  // 放在初始上报之后：补挂的结果会再报一次，不能被"registered"覆盖掉。
  try {
    const registry = ctx.get?.('agents') ?? ctx.agents
    const live = registry?.list?.() ?? []
    for (const agent of live) onCreated({ agent })
  } catch { /* 拿不到 agent 列表就算了，新会话仍走监听 */ }

  return () => {
    try { off?.() } catch { /* ignore */ }
  }
}

/** 给自检/观测台用的一句话结论。 */
export function describeRestrict({ applied = 0, failed = '' } = {}) {
  if (failed) return `没挂上：${failed}`
  if (applied > 0) return `已收窄（她自己的工具只挂在她那条会话）`
  return '已注册，等她的会话下一次启动'
}


/**
 * 全局可见的工具名（不含定义），给白名单校验用。
 *
 * 为什么用 `ctx.tools.view()` 不带参数：宿主注释原文「the viewing scope (the agent),
 * or undefined for the global view」——不带 = 全局视角，`restrictableNames` 就是
 * `restrict()` 认的那批名字（inherited 层）。
 *
 * 拿不到就返回 null（调用方只做形状校验，不许把「不知道」当成「不存在」）。
 * 已知边界：preset/own 层的工具可能不在这里，别人机器上会存在「真工具被判未知」，
 * 所以界面不提供强制保存出口，文档写清「名字必须与宿主工具名完全一致」。
 */
export function knownToolNames(ctx) {
  // 有快照就用快照（那是真正会被 restrict() 认可的名字）；
  // 没有就返回 null —— 让调用方只查拼写，别把「还没见过」说成「不存在」。
  if (lastKnownTools && lastKnownTools.length) return lastKnownTools.slice()
  return null
}

/** 测试用：直接塞一份名字快照（真机上由 agent/created 时取到）。 */
export function rememberKnownTools(names) {
  const list = Array.isArray(names) ? names.map((x) => String(x)).sort() : []
  lastKnownTools = list.length ? list : null
}

/**
 * 从宿主 `restrict()` 的报错文本里捡回全量工具名（0.2.1-rc.3 实测可用）。
 *
 * 报错长这样：
 *   tools.restrict() names unknown global tool "web_serch"; known global tools: a, b, c
 * 白名单输入框正缺这份名单——捡回来之后，同一个进程里再校验就不用猜了。
 * 拿不到就什么都不做（永不抛）。
 */
export function adoptKnownFromError(message) {
  try {
    const text = String(message ?? '')
    const i = text.indexOf('known global tools:')
    if (i < 0) return false
    const tail = text.slice(i + 'known global tools:'.length).trim()
    if (!tail || tail === '(none)') return false
    const names = tail.split(',').map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9_-]*$/.test(s))
    if (!names.length) return false
    lastKnownTools = [...new Set(names)].sort()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 进程内共享的「最近一次结论」。
//
// 为什么要模块级变量：`/selfcheck` 是另一条调用链（observe.js），拿不到 index.js
// 里的闭包。硬把状态塞进 ctx 当服务用属于滥用（ctx.get 是给真服务的），
// 而这里要的只是"本进程里那把刀到底挂上没有"——一个模块级单例正好。
// ---------------------------------------------------------------------------
let lastState = {
  ok: false,
  applied: 0,
  why: 'not attempted',
  allow: HER_TOOLS.slice(),
  restrictAllow: [],
  mounted: [],
  mountFailed: [],
  failed: '',
  guard: false,
}

// 「宿主全局认得哪些工具名」的最近一份快照（进程内）。
// 只有拿到过某个 agent 的全局视角才有值；plugin 自己的 view() 只看得到本插件注册的那几个，
// 拿它校验会把 `skill` 这类宿主工具判成不存在，所以**不用它兜底**。
let lastKnownTools = null

/** 读最近一次收窄结论（自检用）。 */
export function readRestrictState() {
  return { ...lastState }
}

/** 内部：登记一次结论。字段缺省时保留上一次的值（"registered" 不该抹掉已挂上的工具）。 */
function report(r) {
  const prev = lastState
  lastState = {
    ok: Boolean(r?.ok),
    applied: Number(r?.applied ?? prev.applied ?? 0),
    why: String(r?.why ?? ''),
    allow: r?.allow ?? prev.allow ?? HER_TOOLS.slice(),
    restrictAllow: Array.isArray(r?.restrictAllow) ? r.restrictAllow.slice() : prev.restrictAllow,
    mounted: Array.isArray(r?.mounted) ? r.mounted.slice() : prev.mounted,
    mountFailed: Array.isArray(r?.mountFailed) ? r.mountFailed.slice() : prev.mountFailed,
    failed: r?.failed ? String(r.failed) : '',
    guard: r?.guard === undefined ? Boolean(prev.guard) : Boolean(r.guard),
  }
}
