/**
 * dsh-qq-bridge —— 浏览器半（client half）
 *
 * 作用：在 **设置 → 插件 → 插件配置** 里放一张名为“QQ 桥接”的卡片，
 * 用来改昵称、白名单、唤醒概率、目标会话这些设置 —— 也就是用户要的那个界面。
 *
 * 为什么这里的东西长得不像源码：
 *   DSH 的官方文档明确说，本仓库之外没有现成的 client 打包预设
 *   （`packages/client/tsdown.client.ts` 不发布），外部插件得自己复刻产物格式。
 *   好在格式很简单：`window.__ModuleLoader__.load({ id, factory })`，
 *   `factory(require)` 返回一个带 `apply` / `inject` 的 Cordis 插件。
 *   这里就是**手写**这个格式，不引入任何构建步骤。
 *   参考实现：第三方插件 `dshmarket` 的 `client/client.js`（同样是手写/预构建产物）。
 *
 * 与宿主半的约定：
 *   - `id` 必须等于包名 `dsh-qq-bridge`；
 *   - 卡片注册进 `settings.plugin.item`，**key 必须等于宿主注册的 settings 命名空间** `qq-bridge`，
 *     否则配置页那一栏里什么都不会出现（它按命名空间派发）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // react 是模块表里的 baseline 依赖，不用在 package.json 里声明 external。
    const react = require('react')
    const h = react.createElement

    /** settings 命名空间，必须与 index.js 里的 NS 一致。 */
    const NS = 'qq-bridge'

    /**
     * 宿主登记这个插件时用的**包名 / profile entry id**。
     *
     * 独立安装是空串（键位用 NS）；被合并包 vendored 时，合并包的 client.js 会在
     * 调用 factory 之前写进 `globalThis.__DSH_QQ_BRIDGE_HOST_ID__`。
     *
     * 为什么需要它：0.2.0 的插件配置页是按 **entry id** 派发卡片的，
     * 合并成 dsh-fish-qq 之后 entry id 变了，只注册 `qq-bridge` 会**一张卡片都不出现**
     * （2026-10-26 真机现象：设置 → 插件 里没有「QQ 桥接」）。
     */
    const HOST_ID = (() => {
      try {
        const v = globalThis.__DSH_QQ_BRIDGE_HOST_ID__
        return typeof v === 'string' ? v.trim() : ''
      } catch {
        return ''
      }
    })()

    /** 卡片键位候选：0.1.5 用 settings 命名空间，0.2.0 用 entry id。 */
    const CARD_KEYS = [...new Set([NS, HOST_ID].filter(Boolean))]

    // ── 模型池（2026-11-03）───────────────────────────────────────────────────
    // 固定 3 个槽位。存进设置的 `modelPool` 数组；fish 的 handoff.js 读同一个
    // qq-bridge-settings.json（values.modelPool），摘要优先用第一个启用的槽位。
    const MODEL_SLOTS = 3
    const MODEL_POOL_API = '/api/qq-bridge/fetch-models'
    const MODEL_TEST_API = '/api/qq-bridge/test-model'

    /** 把任意输入收敛成恰好 3 个槽位（与宿主半 normalizeModelPool 同形）。 */
    function normalizeModelPool(raw) {
      const rows = Array.isArray(raw) ? raw : []
      const out = []
      for (let i = 0; i < MODEL_SLOTS; i += 1) {
        const row = rows[i] && typeof rows[i] === 'object' ? rows[i] : {}
        out.push({
          enabled: row.enabled === true,
          apiUrl: String(row.apiUrl ?? '').trim(),
          apiKey: String(row.apiKey ?? '').trim(),
          modelName: String(row.modelName ?? '').trim(),
        })
      }
      return out
    }

    function updateSlot(list, index, patch) {
      const next = normalizeModelPool(list)
      next[index] = { ...next[index], ...patch }
      return next
    }

    // ── 表单描述 ──────────────────────────────────────────────────────────────
    // 加一个设置项 = 在这里加一行。kind: text | list | number | boolean | select；
    // group 见下面的 GROUPS —— 漏写 group 的字段**哪一组都不渲染**，界面上直接消失
    // （加载时会吼一嗓子，但界面仍然没有它，加完务必人工数一遍）。
    const FIELDS = [
      {
        key: 'targetSessionId',
        label: '目标会话',
        kind: 'session',
        group: 'core',
        hint: '要接管哪个会话 —— 按名字选就行，不用记 id。',
      },
      {
        key: 'nicknames',
        label: '昵称',
        kind: 'list',
        group: 'wake',
        hint: '被叫到这些名字必然唤醒；逗号分隔，例如：244, 小助手。',
      },
      {
        key: 'wakeProbability',
        label: '群聊唤醒概率',
        kind: 'number',
        group: 'wake',
        step: '0.01',
        hint: '群里既没被 @ 也没叫名字时的唤醒概率（0–1）。默认 0.05 = 5%；嫌吵就调小，0 = 只在被叫时说话。',
      },
      {
        key: 'privateWakeProbability',
        label: '私聊唤醒概率',
        kind: 'number',
        group: 'wake',
        step: '0.01',
        hint: '私聊里既没被 @ 也没叫名字时的唤醒概率（0–1）。默认 1 = 每条私聊都必回。',
      },
      {
        key: 'whitelist',
        label: '私聊白名单',
        kind: 'list',
        group: 'wake',
        hint: '允许唤醒的私聊 QQ 号；**空 = 谁都不能唤醒**。',
      },
      {
        key: 'groupWhitelist',
        label: '群白名单',
        kind: 'list',
        group: 'wake',
        hint: '允许唤醒的群号；**空 = 任何群都不唤醒**。',
      },
      {
        key: 'atOnlyInGroup',
        label: '群里只认 @',
        kind: 'boolean',
        group: 'wake',
        hint: '开启后，群里没被 @ 就完全不处理（比概率唤醒更严）。',
      },
      {
        key: 'replyMode',
        label: '出站方式',
        kind: 'select',
        group: 'outbound',
        options: [
          ['marker', '标记块（默认）'],
          ['tool', '工具调用'],
          ['always', '整轮都发'],
        ],
        hint: '标记块 = 只发块里的内容；工具调用 = 关掉标记块、改用 qq_bridge_send 发送（每轮多一次模型调用，但发不出去时有明确反馈）；整轮都发 = 技术内容也会进群，慎用。',
      },
      {
        key: 'delivery',
        label: '投递方式',
        kind: 'select',
        group: 'wake',
        options: [
          ['auto', '自动（忙时插话）'],
          ['followup', '排队'],
          ['steer', '总是插话'],
        ],
        hint: 'QQ 消息怎么进目标会话：自动 = 目标正忙就插话（在下一个 step 边界塞进去）、空闲时排队；排队 = 永远排成独立一轮（更稳）；总是插话 = 无论忙闲都插。',
      },
      { key: 'replyWithQuote', label: '引用原消息', kind: 'boolean', group: 'outbound', hint: '回复时引用触发的那条消息。' },
      { key: 'stripMarkdown', label: '去掉 Markdown', kind: 'boolean', group: 'outbound', hint: '出站前去掉 Markdown 标记（QQ 不渲染）。' },
      {
        key: 'replyMaxChars',
        label: '出站字数上限',
        kind: 'number',
        group: 'outbound',
        hint: '出站文本的字数上限；超过就不发送，请缩短后重发。',
      },
      {
        key: 'onebotUrl',
        label: 'OneBot 地址',
        kind: 'text',
        group: 'infra',
        hint: 'NapCat 的正向 WS 地址，如 ws://127.0.0.1:3001；留空 = 完全不启用传输。',
      },
      {
        key: 'accessTokenEnv',
        label: 'OneBot Token 凭据名',
        kind: 'text',
        group: 'infra',
        hint: '指 **NapCat / OneBot 的 access_token** 存在哪个环境变量里 —— 填「变量名」（如 NAPCAT_TOKEN），不是 token 本身；NapCat 没开 token 校验就留空。⚠️ 不是模型 API key（DeepSeek 等），两者无关，别填错。',
        check: (v) => {
          const s = String(v ?? '').trim()
          if (s === '') return null
          if (/^(sk-|Bearer\s)/i.test(s) || s.length > 64 || /[.\s]/.test(s)) {
            return '这看起来像一串 token —— 这一栏要填的是「存它的环境变量名」（如 NAPCAT_TOKEN），不是 token 本身。'
          }
          return null
        },
      },
      { key: 'selfId', label: '机器人 QQ', kind: 'text', group: 'infra', hint: '留空 = 连上后自动获取。' },
      // ↓ 这些键以前只在 Schema 里、卡片上没做输入框，等于“设了也改不了”（用户报的正是这个）
      {
        key: 'visionModel',
        label: '识图模型',
        kind: 'text',
        group: 'infra',
        hint: '给图片写描述的多模态模型，形如 provider/model（如 deepseek-official/deepseek-v4-flash-vision-exp）；留空 = 自动找（优先名字带 vision 的）。',
      },
      {
        key: 'agentPreset',
        label: 'Agent Preset',
        kind: 'text',
        group: 'core',
        hint: '恢复目标会话时挂载哪个 preset（决定它的人设/人格）；留空 = 沿用会话自己记着的那个。',
      },
      { key: 'attachRecentChat', label: '附带未唤醒记录', kind: 'boolean', group: 'wake', hint: '唤醒时是否把"未唤醒期间"的聊天记录一并附上。' },
      { key: 'recentChatLimit', label: '附带条数', kind: 'number', group: 'wake', hint: '上面那段摘要最多带最近几条（0–200）。' },
      { key: 'napcatInstallDir', label: 'NapCat 目录', kind: 'text', group: 'infra', hint: 'NapCat 安装目录；留空 = $DSH_HOME/napcat。' },
      { key: 'napcatVersion', label: 'NapCat 版本', kind: 'text', group: 'infra', hint: '要下载的版本 tag（如 v4.18.28）；留空 = 最新。' },
      { key: 'downloadProxy', label: '下载代理', kind: 'text', group: 'infra', hint: '下载 NapCat 用的 HTTP 代理（如 http://127.0.0.1:7890）；留空 = 读环境变量。' },
      { key: 'onebotPort', label: 'OneBot 端口', kind: 'number', group: 'infra', hint: '写进 NapCat 配置、并用来连的正向 WS 端口。' },
      { key: 'qqNumber', label: '快速登录 QQ', kind: 'text', group: 'infra', hint: '快速登录用的 QQ 号（需先成功登录过一次）。' },
      // ── 工作区（2026-10-27）──
      {
        key: 'workspaceRoot',
        label: '工作区根目录',
        kind: 'text',
        group: 'core',
        hint: '她派任务、看目录、发文件都限定在这片目录里。填绝对路径（如 D:\\demo\\我的项目）；留空 = 这些能力不可用。',
      },
      // ── 认主（2026-10-26）──
      {
        key: 'ownerQQ',
        label: '主人 QQ',
        kind: 'text',
        group: 'core',
        hint: '主人的 QQ 号。**只有这个号能派活**；其他人发来的消息也会进会话，但正文前会多一行「非主人」标记，只许聊天、不许调工具。留空 = 谁都不是主人（所有人都被贴标）。',
        check: (v) => {
          const s = String(v ?? '').trim()
          if (s === '') return null
          return /^\d{5,12}$/.test(s) ? null : 'QQ 号应该是 5–12 位数字。'
        },
      },
      // ── 管理员名单（2026-10-29）──
      {
        key: 'admins',
        label: '管理员名单',
        kind: 'list',
        group: 'core',
        hint: '管理员发来的消息贴「[来源：管理员用户]」标记：可以聊天、可以让她派活（work_request）、能用 fileget / filesend / receive（看收件箱）。subsend / whitelist / admin 仍然只有主人能下。QQ 上也可以用 `admin add/del <QQ号>` 改这份名单（只有主人能改）。空 = 没有管理员。',
      },
      // ── 不定时主动私聊（2026-10-26）──
      {
        key: 'proactiveEnabled',
        label: '主动私聊',
        kind: 'boolean',
        group: 'idle',
        hint: '打开后，空闲够久 + 随机命中时，她会主动给主人发一条 QQ 私聊（不是定时提醒，触发时刻不确定）。默认关。',
      },
      {
        key: 'proactiveIdleHours',
        label: '空闲多少小时',
        kind: 'number',
        group: 'idle',
        hint: '多久没有任何 QQ 往来才算「空闲」。默认 4。',
      },
      {
        key: 'proactiveProbability',
        label: '每次命中概率',
        kind: 'number',
        group: 'idle',
        hint: '每次扫描命中主动私聊的概率（0–1）。默认 0.15；调小更克制、调大更黏人。',
      },
      {
        key: 'proactiveDailyLimit',
        label: '每天上限',
        kind: 'number',
        group: 'idle',
        hint: '每天最多主动私聊几条（0 = 不发）。默认 3，建议别超过 3——发太多容易被 QQ 判定异常。',
      },
      {
        key: 'proactiveScanIntervalMinutes',
        label: '扫描间隔（分钟）',
        kind: 'number',
        group: 'idle',
        hint: '多久检查一次「该不该主动说话」。默认 30。',
      },
      // ── 私人时间 / 自主待机（2026-10-31）──
      {
        key: 'idleTriggerEnabled',
        label: '私人时间',
        kind: 'boolean',
        group: 'idle',
        hint: '打开后，很久没人找她时会随机抽签给她一段属于自己的时间——大概率什么都不发生（silent 权重最高），极少注入一段「私人时间」处境提示。注入的那一轮默认不出站：只有她明确写了 [QQ] 块或调了出站工具，消息才会到 QQ。默认关。',
      },
      {
        key: 'idleTriggerMinIdleHours',
        label: '空闲多少小时',
        kind: 'number',
        group: 'idle',
        hint: '多久没人找她（QQ 来人或 DSH 界面说话）才算「空闲」。默认 2；0 = 不看空闲（调试用）。',
      },
      {
        key: 'idleTriggerScanIntervalMinutes',
        label: '扫描间隔（分钟）',
        kind: 'number',
        group: 'idle',
        hint: '多久检查一次「该不该给她一段私人时间」。这只是判定周期，不是定时打扰。默认 30。',
      },
      {
        key: 'idleTriggerDailyMax',
        label: '每天上限',
        kind: 'number',
        group: 'idle',
        hint: '每天最多真的注入几段私人时间（抽到「什么都不做」不算）。默认 3；0 = 关闭。',
      },
      {
        key: 'idleTriggerWeightSilent',
        label: '权重·继续停机',
        kind: 'number',
        group: 'idle',
        hint: '抽签权重：什么都不做、继续停机。**必须占绝对优势**（默认 80）——她绝大部分时间就是在睡着，极少被打扰。',
      },
      {
        key: 'idleTriggerWeightMessage',
        label: '权重·想找他说',
        kind: 'number',
        group: 'idle',
        hint: '抽签权重：提示里把「给他发条消息」排在最前（仍由她自己选）。默认 10。',
      },
      {
        key: 'idleTriggerWeightBrowse',
        label: '权重·去 B 站',
        kind: 'number',
        group: 'idle',
        hint: '抽签权重：提示里把「去 B 站看看」排在最前。默认 5。',
      },
      {
        key: 'idleTriggerWeightDiary',
        label: '权重·写日记',
        kind: 'number',
        group: 'idle',
        hint: '抽签权重：提示里把「写写日记」排在最前。默认 5。',
      },
      // ── subsend：主人点名发给谁（2026-10-26）──
      {
        key: 'subsendEnabled',
        label: 'subsend 主动发消息',
        kind: 'boolean',
        group: 'outbound',
        hint: '主人发 `subsend <QQ号> <内容>` 时，把内容私聊给指定的人（她调 qq_bridge_subsend 工具发，可润色）。默认开。',
      },
      {
        key: 'subsendDailyLimit',
        label: 'subsend 每天上限',
        kind: 'number',
        group: 'outbound',
        hint: 'subsend 每天最多发几条（防刷屏 / 防 QQ 风控）。默认 20；0 = 禁用。',
      },
      {
        key: 'subsendCooldownSeconds',
        label: 'subsend 冷却（秒）',
        kind: 'number',
        group: 'outbound',
        hint: 'subsend 两次发送之间的最短间隔。默认 20。',
      },
      // ── 任务完成通知（CheckLogs，2026-10-28）──
      {
        key: 'checklogNotifyMode',
        label: '任务完成通知',
        kind: 'select',
        group: 'outbound',
        options: [
          ['off', '关（默认）'],
          ['system', '系统模板'],
          ['agent', '让她自己说'],
        ],
        hint: '她派出去的活儿有了结果（CheckLogs/ 里写成一条日志）后怎么通知你：关 = 什么都不说；系统模板 = 插件直接发一条「[任务通知] … 完成了 / 失败了：… / 超时了」；让她自己说 = 把结果投进她的会话，由她用自己的话跟你说一句（她一个字没说就退回模板，不会静默）。',
      },
      {
        key: 'checklogNotifyOnSuccess',
        label: '成功也说一声',
        kind: 'boolean',
        group: 'outbound',
        hint: '任务**成功**完成时也通知；默认关 = 失败 / 超时 / 异常结束才说（成功是本分，不打断你）。',
      },
      {
        key: 'checklogNotifyDailyLimit',
        label: '通知每天上限',
        kind: 'number',
        group: 'outbound',
        hint: '每天最多通知几条（0 = 一条都不发）。默认 5；两档（系统模板 / 让她自己说）共用这一个额度。',
      },
      {
        key: 'checklogNotifyTarget',
        label: '通知发给谁',
        kind: 'select',
        group: 'outbound',
        options: [
          ['owner', '主人（默认）'],
          ['last', '最近聊过的人'],
        ],
        hint: '主人 = 你的 QQ 私聊；最近聊过的人 = 最近一次有往来的目的地（私聊），最近是群或还没有往来时回落主人。',
      },
      // ── 模型池（2026-11-03）：3 个固定槽位，摘要优先用它，失败回退宿主 llm ──
      {
        key: 'modelPool',
        label: '模型池',
        kind: 'modelpool',
        group: 'modelpool',
        hint: '给摘要这类短任务用的备用模型。按 Slot 1 → 2 → 3 找第一个「已启用且填全」的；失败 / 超时 10 秒就回退宿主自己的模型。',
      },
      // ── 情报流水线（预留，2026-11-01）：先立字段，逻辑（RSS 抓取 / worker
      //     对接）由后面的任务接 —— 与 checklog 通知「任务书 1 只立字段」同一个
      //     口径：先保证能存能读、界面可见，默认全空 = 什么都不发生。──
      {
        key: 'rssFeeds',
        label: 'RSS 订阅源',
        kind: 'text',
        group: 'pipeline',
        hint: '逗号分隔的 RSS 链接，如 https://example.com/feed.xml, https://another.com/rss；先存着，等流水线接上就是定投给她看的消息源。',
      },
      {
        key: 'pipelineWorkerApi',
        label: '流水线 Worker 地址',
        kind: 'text',
        group: 'pipeline',
        hint: '跑情报流水线的 worker API 地址；留空 = 还没部署，这一组先当摆设。',
      },
      {
        key: 'pipelineWorkerKey',
        label: '流水线 Worker 密钥',
        kind: 'text',
        group: 'pipeline',
        hint: '调流水线 worker 时带的校验密钥；留空 = 不校验。',
      },
      // ── 环境传感器 / 赛博微状态（2026-11-01；2026-11-02 改为文件驱动）：
      //     定时抓天气 + 本机状态 → 工作区 sensors/status.md，
      //     她自己用 check_body 工具按需读，不再注入任何提示词。──
      {
        key: 'envSensorEnabled',
        label: '环境传感器',
        kind: 'boolean',
        group: 'env',
        hint: '打开后，按下面设的时间抓一次天气与本机硬件状态，写成工作区里的一行状态（sensors/status.md）。不再注入提示词——她想感知时自己调 check_body 查看。默认关。',
      },
      {
        key: 'envWeatherCity',
        label: '城市 / 经纬度',
        kind: 'text',
        group: 'env',
        hint: '城市名（wuhan 或 武汉）或「纬度,经度」（如 30.59,114.30）；留空 = 状态里只有本机，没有天气。数据源是 Open-Meteo（免费、不用 API key）。',
      },
      {
        key: 'envSensorTime',
        label: '采集时间（Cron）',
        kind: 'text',
        group: 'env',
        hint: '多久采一次并刷新状态：五段式 Cron（分 时 日 月 周，如 0 8 * * * = 每天早八点），也接受 HH:MM（如 08:00）。默认 */15 * * * *（每 15 分钟）。到点会跑一次工作区里的 pipeline/update_env.js。',
        check: (v) => {
          const s = String(v ?? '').trim()
          if (s === '') return null
          if (/^\d{1,2}:\d{2}$/.test(s)) return null
          if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(s)) return null
          return '看不懂这个时间：写五段式 Cron（如 0 8 * * *）或 HH:MM（如 08:00）。'
        },
      },
      {
        key: 'envMemoryThreshold',
        label: '内存报警阈值',
        kind: 'number',
        group: 'env',
        hint: '内存占用超过这个百分比（0–100，默认 80）时，状态里的 [机箱状态] 就是「高负载」。',
      },
    ]

    /**
     * 手风琴的分组：**按这里的固定顺序渲染**，组内按 FIELDS 里的出现顺序。
     *
     * ⚠️ group 只管显示：
     *   - 草稿 / 保存 / 撤销覆盖全都平铺遍历 FIELDS，与展开状态无关 ——
     *     折叠只是把控件藏起来，表单数据一个键都不会少，也不会把展开状态
     *     混进 scope.set；
     *   - 漏写 group 的字段**哪一组都进不去**（界面上直接消失），加载时验一遍。
     */
    const GROUPS = [
      { id: 'core', label: '核心与权限' },
      { id: 'wake', label: 'QQ 唤醒与投递' },
      { id: 'outbound', label: '出站与功能' },
      { id: 'idle', label: '私人时间与主动' },
      { id: 'infra', label: '底层基础设施' },
      { id: 'modelpool', label: '模型池' },
      { id: 'pipeline', label: '情报流水线' },
      { id: 'env', label: '环境传感器' },
    ]

    // 防错：某个字段漏了 group 时，它在任何组里都不渲染 —— 加载时吼一嗓子，
    // 免得到界面上去才发现少了一项（吼完界面仍然没有它，改完务必人工数一遍）。
    {
      const knownGroups = new Set(GROUPS.map((g) => g.id))
      const orphaned = FIELDS.filter((f) => !knownGroups.has(f.group)).map((f) => f.key)
      if (orphaned.length > 0 && typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`qq-bridge: 这些字段没有 group，设置卡片上不会显示：${orphaned.join('、')}`)
      }
    }

    function format(field, raw) {
      if (field.kind === 'modelpool') return normalizeModelPool(raw)
      if (field.kind === 'list') return Array.isArray(raw) ? raw.join(', ') : raw == null ? '' : String(raw)
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') return raw == null || raw === '' ? '' : String(raw)
      return raw == null ? '' : String(raw)
    }

    /** 表单值 → 要写进设置的 JSON；数字不合法返回 undefined（拦住保存）。 */
    function parse(field, raw) {
      if (field.kind === 'modelpool') return normalizeModelPool(raw)
      if (field.kind === 'list') {
        return String(raw == null ? '' : raw)
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter((s) => s !== '')
      }
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') {
        const n = Number(raw)
        return Number.isFinite(n) ? n : undefined
      }
      return String(raw == null ? '' : raw).trim()
    }

    function draftFrom(value) {
      const v = value && typeof value === 'object' ? value : {}
      const draft = {}
      for (const f of FIELDS) draft[f.key] = format(f, v[f.key])
      return draft
    }

    function same(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /**
     * 会话下拉的选项：真实的会话列表 + “不驱动”+ 一个兜底项。
     *
     * **归档的会话不列出来**（用户报的 bug：下拉里混进了一堆早就归档的会话）——
     * 归档集在 workspace 域：`ctx.workspaces.list.getSnapshot().archivedSessionIds`。
     *
     * ⚠️ **TODO（下次修）：子代理会话也会被列进来。**
     * `SessionSummary` 上有 `origin?: 'subagent'` 与 `parentId?: SessionId`
     * （见 `@deepseek-ai/dsh-api-session-controller` 的 `SessionSummary`），据此可以剔除。
     * 剔除之后同样要给**当前选中项**兜底，规则与下面的归档处理一致 ——
     * 否则子代理会话是当前目标时，一保存就把目标会话清空。
     * 退化做法也可接受：把它们折叠进一个“显示子代理会话”的展开项，别一次铺开一长串。
     *
     * 两个兜底项都是必要的：
     * - 配置里那个 id 可能**不在**列表里（别的工作区、宿主还没加载完）；
     * - 也可能**正好是归档的**（用户刚把它归档了）。
     * 两种都必须保留成选项，否则用户一保存就把目标会话清空了。
     */
    function sessionOptions(state, current, archivedIds) {
      const archived = new Set((Array.isArray(archivedIds) ? archivedIds : []).map((id) => String(id)))
      const out = [{ value: '', label: '（不驱动任何会话）' }]
      const ids = Array.isArray(state?.ids) ? state.ids : []
      const byId = state && typeof state.byId === 'object' && state.byId ? state.byId : {}
      const cur = String(current ?? '')
      const seen = new Set([''])
      for (const id of ids) {
        const key = String(id)
        const isArchived = archived.has(key)
        // 归档的一律不显示 —— 除非它就是当前选中的那个（不显示的话就没法保留/换掉了）
        if (isArchived && key !== cur) continue
        seen.add(key)
        const row = byId[id] ?? {}
        const title = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : key
        out.push({
          value: key,
          label: `${title}${row.running ? '（运行中）' : ''}${isArchived ? '（已归档）' : ''}`,
        })
      }
      if (cur !== '' && !seen.has(cur)) {
        out.push({ value: cur, label: `${cur}（${archived.has(cur) ? '已归档' : '不在会话列表里'}）` })
      }
      return out
    }

    /** 没有 sessions / workspaces 服务（或它们还没就绪）时用的稳定空快照 —— 必须稳定，否则 useSyncExternalStore 会死循环。 */
    const EMPTY_SESSION_LIST = { ids: [], byId: {} }
    const EMPTY_WORKSPACES = { archivedSessionIds: [] }

    // ── 样式（内联，跟随主题文字色） ──────────────────────────────────────────
    const BORDER = '1px solid rgba(127,127,127,0.35)'
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px' },
      head: { display: 'flex', flexDirection: 'column', gap: '2px' },
      title: { fontSize: '14px', fontWeight: 600 },
      sub: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: '8px 12px', alignItems: 'start' },
      label: { fontSize: '13px', paddingTop: '5px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 8px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
      },
      hint: { fontSize: '11px', opacity: 0.55, marginTop: '3px', lineHeight: 1.5 },
      check: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', paddingTop: '4px' },
      foot: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      btn: {
        padding: '5px 14px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
      },
      primary: { background: 'rgba(127,127,127,0.18)', fontWeight: 600 },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '8px 10px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
      },
      chevron: { marginLeft: 'auto', opacity: 0.6 },
      // 手风琴的组：组标题 +（展开时）原来的 label/控件网格。
      group: { display: 'flex', flexDirection: 'column', gap: '8px' },
      // 组标题：与卡片标题同一个交互（点整行切换），矮半号、不带副标题。
      groupHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 10px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
        fontWeight: 600,
        textAlign: 'left',
      },
      // 组标题右侧的「N 项」：字段折叠成组后，让人一眼知道
      // 这组里压着多少东西、值不值得点开。
      groupCount: { fontSize: '11px', fontWeight: 400, opacity: 0.55 },
      note: { fontSize: '12px', opacity: 0.7 },
      err: { fontSize: '12px', color: '#e5534b' },
      overridden: { fontSize: '11px', opacity: 0.5, marginLeft: '4px' },
      // “撤销覆盖”：与“·已覆盖”并排的小按钮。文案本身就是动作，不加图标。
      link: {
        marginLeft: '4px',
        padding: '0 4px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.75,
        textDecoration: 'underline',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '11px',
      },
      ops: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      // 模型池：3 个槽位竖排；每个槽位自己是一张小卡，按钮和状态都在里面。
      pool: { display: 'flex', flexDirection: 'column', gap: '10px' },
      slot: { border: BORDER, borderRadius: '8px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' },
      slotHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      slotTitle: { fontSize: '13px', fontWeight: 600 },
      slotGrid: { display: 'grid', gridTemplateColumns: 'minmax(90px, 130px) 1fr', gap: '6px 10px', alignItems: 'center' },
      slotLabel: { fontSize: '12px', opacity: 0.75 },
      slotRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      statusOk: { fontSize: '12px', color: '#2ea043' },
      statusErr: { fontSize: '12px', color: '#e5534b' },
      statusMuted: { fontSize: '11px', opacity: 0.55 },
    }

    function disabled(btn, off) {
      return off ? { ...btn, opacity: 0.5, cursor: 'default' } : btn
    }

    /** 浏览器侧也加一道硬超时：后端 10 秒，这里 12 秒兜底，绝不让按钮永远转圈。 */
    async function fetchWithTimeout(url, init = {}, timeoutMs = 12_000) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        return await fetch(url, { ...init, signal: ac.signal })
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * 模型池编辑器：固定 3 个槽位。
     *
     * 只负责“改值 + 调两个测试接口”；真正的保存仍走卡片底部的「保存」，
     * 由 Card 把 modelPool 一并写进设置（这样它和别的字段共用同一套脏检查）。
     */
    function ModelPoolEditor(props) {
      const value = normalizeModelPool(props.value)
      const disabledAll = props.disabled === true
      const [models, setModels] = react.useState(() => [[], [], []])
      const [busy, setBusy] = react.useState({ fetch: -1, test: -1 })
      const [status, setStatus] = react.useState(() => [{}, {}, {}])

      const setStatusAt = (index, next) => {
        setStatus((prev) => {
          const copy = prev.slice()
          copy[index] = next
          return copy
        })
      }
      const setModelsAt = (index, list) => {
        setModels((prev) => {
          const copy = prev.slice()
          copy[index] = Array.isArray(list) ? list : []
          return copy
        })
      }
      const change = (index, patch) => {
        if (disabledAll) return
        // 地址 / Key 变了，上一次拉到的模型列表与测试结果就作废了；
        // 不清掉的话下拉里会留着旧地址的模型，看着像“已经连通了”。
        if (Object.prototype.hasOwnProperty.call(patch, 'apiUrl') || Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
          setModelsAt(index, [])
          setStatusAt(index, {})
        }
        props.onChange(updateSlot(value, index, patch))
      }

      async function refresh(index) {
        const slot = value[index]
        setStatusAt(index, { kind: 'muted', text: '拉取中…' })
        setBusy({ fetch: index, test: -1 })
        try {
          if (!slot.apiUrl.trim()) throw new Error('先填 API 地址')
          if (!slot.apiKey.trim()) throw new Error('先填 API Key')
          const qs = new URLSearchParams({ apiUrl: slot.apiUrl, apiKey: slot.apiKey })
          const res = await fetchWithTimeout(`${MODEL_POOL_API}?${qs.toString()}`, { headers: { accept: 'application/json' } })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(String(body?.error || `HTTP ${res.status}`))
          const list = Array.isArray(body.models) ? body.models.map(String) : []
          if (list.length === 0) throw new Error('接口没返回任何模型')
          setModelsAt(index, list)
          const nextModel = list.includes(slot.modelName) ? slot.modelName : list[0]
          if (nextModel !== slot.modelName) change(index, { modelName: nextModel })
          setStatusAt(index, { kind: 'ok', text: `✅ 拉取到 ${list.length} 个模型` })
        } catch (error) {
          const message = error?.name === 'AbortError' ? '拉取超时（12 秒）' : String(error?.message ?? error)
          setStatusAt(index, { kind: 'err', text: `❌ ${message}` })
        } finally {
          setBusy({ fetch: -1, test: -1 })
        }
      }

      async function test(index) {
        const slot = value[index]
        setStatusAt(index, { kind: 'muted', text: '测试中…' })
        setBusy({ fetch: -1, test: index })
        const started = Date.now()
        try {
          if (!slot.apiUrl.trim()) throw new Error('先填 API 地址')
          if (!slot.apiKey.trim()) throw new Error('先填 API Key')
          if (!slot.modelName.trim()) throw new Error('先选/填模型名')
          const res = await fetchWithTimeout(MODEL_TEST_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiUrl: slot.apiUrl, apiKey: slot.apiKey, modelName: slot.modelName }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(String(body?.error || `HTTP ${res.status}`))
          const ms = Number.isFinite(Number(body.latencyMs)) ? Number(body.latencyMs) : Date.now() - started
          setStatusAt(index, { kind: 'ok', text: `✅ 成功 ${ms}ms` })
        } catch (error) {
          const message = error?.name === 'AbortError' ? '超时（12 秒）' : String(error?.message ?? error)
          setStatusAt(index, { kind: 'err', text: `❌ ${message}` })
        } finally {
          setBusy({ fetch: -1, test: -1 })
        }
      }

      const rows = value.map((slot, index) => {
        const list = models[index] ?? []
        const st = status[index] ?? {}
        const fetching = busy.fetch === index
        const testing = busy.test === index
        const controlDisabled = disabledAll || fetching || testing
        return h(
          'div',
          { key: `slot-${index}`, style: S.slot },
          h(
            'div',
            { style: S.slotHead },
            h('span', { style: S.slotTitle }, `Slot ${index + 1}`),
            h(
              'label',
              { style: S.check },
              h('input', {
                type: 'checkbox',
                checked: slot.enabled === true,
                disabled: controlDisabled,
                onChange: (event) => change(index, { enabled: event.target.checked }),
              }),
              '启用',
            ),
            h('span', { style: S.statusMuted }, slot.modelName ? `当前：${slot.modelName}` : '未选模型'),
          ),
          h(
            'div',
            { style: S.slotGrid },
            h('span', { style: S.slotLabel }, 'API 地址'),
            h('input', {
              type: 'text',
              style: S.input,
              value: slot.apiUrl,
              disabled: controlDisabled,
              placeholder: 'https://api.deepseek.com 或 …/v1',
              spellCheck: false,
              onChange: (event) => change(index, { apiUrl: event.target.value }),
            }),
            h('span', { style: S.slotLabel }, 'API Key'),
            h('input', {
              type: 'password',
              style: S.input,
              value: slot.apiKey,
              disabled: controlDisabled,
              placeholder: 'sk-…（只存本机设置文件）',
              autoComplete: 'off',
              spellCheck: false,
              onChange: (event) => change(index, { apiKey: event.target.value }),
            }),
            h('span', { style: S.slotLabel }, '模型'),
            list.length > 0
              ? h(
                  'select',
                  {
                    style: S.input,
                    value: slot.modelName,
                    disabled: controlDisabled,
                    onChange: (event) => change(index, { modelName: event.target.value }),
                  },
                  // 当前值不在列表里（例如手填后还没重新拉取）也要能显示，否则 select 会跳到第一项。
                  list.includes(slot.modelName) || slot.modelName === ''
                    ? null
                    : h('option', { value: slot.modelName }, `${slot.modelName}（手填）`),
                  list.map((model) => h('option', { key: model, value: model }, model)),
                )
              : h('input', {
                  type: 'text',
                  style: S.input,
                  value: slot.modelName,
                  disabled: controlDisabled,
                  placeholder: '先「刷新拉取」，或直接手填模型名',
                  spellCheck: false,
                  onChange: (event) => change(index, { modelName: event.target.value }),
                }),
          ),
          h(
            'div',
            { style: S.slotRow },
            h(
              'button',
              {
                type: 'button',
                style: disabled(S.btn, controlDisabled || !slot.apiUrl.trim() || !slot.apiKey.trim()),
                disabled: controlDisabled || !slot.apiUrl.trim() || !slot.apiKey.trim(),
                onClick: () => refresh(index),
              },
              fetching ? '拉取中…' : '刷新拉取模型',
            ),
            h(
              'button',
              {
                type: 'button',
                style: disabled(S.btn, controlDisabled || !slot.apiUrl.trim() || !slot.apiKey.trim() || !slot.modelName.trim()),
                disabled: controlDisabled || !slot.apiUrl.trim() || !slot.apiKey.trim() || !slot.modelName.trim(),
                onClick: () => test(index),
              },
              testing ? '测试中…' : '测试连通',
            ),
            st.text
              ? h('span', { style: st.kind === 'ok' ? S.statusOk : st.kind === 'err' ? S.statusErr : S.statusMuted }, st.text)
              : null,
          ),
        )
      })

      return h(
        'div',
        { style: S.pool },
        h(
          'div',
          { style: S.note },
          '按 Slot 1 → 2 → 3 取第一个「已启用且填全」的模型；失败 / 超时（10 秒）回退宿主 llm，不会卡住换房。',
        ),
        ...rows,
      )
    }

    // ── 卡片 ──────────────────────────────────────────────────────────────────

    function Card(props) {
      const scope = props.scope
      const subscribe = react.useCallback((cb) => scope.subscribe(cb), [scope])
      const getSnapshot = react.useCallback(() => scope.getSnapshot(), [scope])
      const snap = react.useSyncExternalStore(subscribe, getSnapshot)

      const [draft, setDraft] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [note, setNote] = react.useState('')
      // 折叠块：跟官方那几张卡片一致 —— 默认收起
      const [open, setOpen] = react.useState(false)
      // 组的展开状态（手风琴）：同样默认全部收起，且**只影响显示** ——
      // 草稿 / 保存 / 撤销覆盖一律平铺遍历 FIELDS，折叠既不丢改动，
      // 也绝不把展开状态混进表单数据 / scope.set（两套状态，互不通气）。
      const [openGroups, setOpenGroups] = react.useState({})
      // NapCat 的三个操作按钮：展开时拉一次接口；拿不到就保持 null（按钮禁用）。
      const [napcat, setNapcat] = react.useState(null)
      const [napcatBusy, setNapcatBusy] = react.useState('')

      const current = react.useMemo(() => draftFrom(snap.value), [snap.value])
      const shown = draft ?? current
      const dirty = draft !== null && !same(draft, current)
      const user = snap.user && typeof snap.user === 'object' ? snap.user : {}

      // ── 目标会话的下拉数据源 ──────────────────────────────────────────────
      // ctx.sessions.list 是客户端 SDK 暴露的会话列表快照（ObservableSnapshot）。
      // 取不到（这个部署没装 sessions 服务、或它还没就绪）就退回“只有兜底项”，
      // 卡片本身照常渲染 —— 宁可少一个下拉，也不要整张卡片消失。
      const sessions = props.sessionsOf ? props.sessionsOf() : undefined
      const listStore = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list : undefined
      const listSubscribe = react.useCallback((cb) => (listStore ? listStore.subscribe(cb) : () => {}), [listStore])
      const listGetSnapshot = react.useCallback(
        () => (listStore ? listStore.getSnapshot() : EMPTY_SESSION_LIST),
        [listStore],
      )
      const sessionList = react.useSyncExternalStore(listSubscribe, listGetSnapshot)
      react.useEffect(() => {
        // 进卡片时拉一次，免得显示的是很久以前的标题
        if (sessions && typeof sessions.refresh === 'function') Promise.resolve(sessions.refresh()).catch(() => {})
      }, [sessions])

      // 归档集在 workspace 域：ctx.workspaces.list 的快照里有 archivedSessionIds
      //（“Complete registry-global archive set”）。取不到就当作“没有归档的会话”——
      // 宁可多列几个，也别把用户能选的会话藏掉。
      const workspaces = props.workspacesOf ? props.workspacesOf() : undefined
      const wsStore =
        workspaces && workspaces.list && typeof workspaces.list.getSnapshot === 'function' ? workspaces.list : undefined
      const wsSubscribe = react.useCallback((cb) => (wsStore && typeof wsStore.subscribe === 'function' ? wsStore.subscribe(cb) : () => {}), [wsStore])
      const wsGetSnapshot = react.useCallback(() => {
        if (!wsStore) return EMPTY_WORKSPACES
        try {
          return wsStore.getSnapshot() ?? EMPTY_WORKSPACES
        } catch {
          return EMPTY_WORKSPACES
        }
      }, [wsStore])
      const workspaceSnapshot = react.useSyncExternalStore(wsSubscribe, wsGetSnapshot)

      /**
       * 拉一次 NapCat 状态（WebUI 地址 + 是否在运行）。
       * 没有 fetch 或响应不是 ok:true 时返回 undefined，调用方保持上一次的状态。
       */
      async function fetchNapcat() {
        if (typeof fetch !== 'function') return undefined
        const res = await fetch(NAPCAT_API, { headers: { accept: 'application/json' } })
        const body = await res.json().catch(() => ({}))
        return body && body.ok === true ? body : undefined
      }

      // 展开卡片时读一次 NapCat 状态，之后每 5 秒轮询一次。
      // 轮询用于识别外部启动：用户在别处手动跑了 bat 时，只有重新拉取才能把按钮改成“已在运行”。
      // 卡片收起或组件卸载时清掉定时器，不让它在后台一直跑。
      react.useEffect(() => {
        if (!open) return undefined
        let alive = true
        const pull = () => {
          fetchNapcat()
            .then((body) => {
              if (alive && body !== undefined) setNapcat(body)
            })
            .catch(() => {
              // 单次失败保留上一次的状态：轮询会再试，不给按钮闪一下禁用。
            })
        }
        pull()
        const timer = setInterval(pull, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [open])

      /** 两个 POST 按钮共用：动作没成（ok:false）也把宿主的 error 原文显示出来。 */
      async function postNapcat(action, okNote) {
        setNapcatBusy(action)
        setError('')
        setNote('')
        try {
          if (typeof fetch !== 'function') throw new Error('这个环境没有 fetch')
          // 显式声明 JSON：宿主接口对**带请求体**的 POST 只认 application/json。
          // 这两个动作本身没有请求体，服务端也放行无体的 POST —— 那条是给还没刷新的旧 bundle 兜底。
          const res = await fetch(`${NAPCAT_API}/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(String(body?.error || `HTTP ${res.status}`))
          setNote(String(body?.message || okNote))
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setNapcatBusy('')
          // 成功或失败都重拉一次：启动成功后按钮要立刻变“已在运行”，
          // 被宿主拒绝（例如已在运行）时也要把真实状态显示出来。
          try {
            const fresh = await fetchNapcat()
            if (fresh !== undefined) setNapcat(fresh)
          } catch {
            // 拉取失败时保留上一次的状态
          }
        }
      }

      function change(key) {
        return (event) => {
          const next = { ...shown }
          next[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
          setDraft(next)
          setNote('')
          setError('')
        }
      }

      /** 模型池整体替换：子编辑器已经做过归一化，这里只负责进草稿。 */
      function changeModelPool(next) {
        setDraft({ ...shown, modelPool: normalizeModelPool(next) })
        setNote('')
        setError('')
      }

      async function save() {
        setBusy(true)
        setError('')
        setNote('')
        try {
          const writes = []
          for (const f of FIELDS) {
            if (same(current[f.key], shown[f.key])) continue
            const next = parse(f, shown[f.key])
            if (next === undefined) throw new Error(`「${f.label}」不是合法数字`)
            writes.push([f.key, next])
          }
          for (const [key, value] of writes) await scope.set(key, value)
          setDraft(null)
          setNote(writes.length === 0 ? '没有改动' : `已保存 ${writes.length} 项`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      /**
       * 撤销一个字段的本机覆盖。
       *
       * 设置读取优先级是“设置文件 > composition config”。卡片只发 set 时，
       * 用户从插件配置页改的值会被设置文件里的旧值盖住，且没有地方撤销。
       * 这里走设置源的 unset：清掉那一项，该键回落到 composition config 的值，
       * 刷新后“·已覆盖”标记消失。
       */
      async function unsetOverride(key) {
        const field = FIELDS.find((f) => f.key === key)
        setBusy(true)
        setError('')
        setNote('')
        try {
          if (typeof scope.unset !== 'function') throw new Error('这个设置源不支持撤销覆盖')
          await scope.unset(key)
          setDraft(null)
          setNote(`已撤销「${field ? field.label : key}」的本机覆盖`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      if (snap.status === 'loading') {
        return h('div', { style: S.wrap }, h('div', { style: S.sub }, '载入设置中…'))
      }
      if (snap.status === 'unavailable') {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.title }, 'QQ 桥接'),
          h(
            'div',
            { style: S.sub },
            '这个部署没有为 qq-bridge 提供可写的设置服务（settings 提供者没挂载，或连接处于内存模式）。',
          ),
          h(
            'div',
            { style: S.hint },
            '宿主的两条设置通道都没拿到：插件配置表单（DSH 0.2.0 的 #677 迁移未完成）与本插件的本机设置接口。',
          ),
          h(
            'div',
            { style: S.hint },
            '先看诊断里「本机接口」那项：若宿主没有 webServer 服务，接口挂不上（此时仍可点右上角「打开配置文件」，改 profile 的 cordis.patch.yml 里 `- id: qq-bridge` 的 config 后重启）。',
          ),
          h(
            'div',
            { style: S.hint },
            `诊断：${typeof scope.detail === 'function' ? scope.detail() : '（无诊断信息）'}`,
          ),
        )
      }

      /**
       * 一个字段的两个网格格：标签格（含「·已覆盖」与「撤销覆盖」）+ 控件格。
       * 从原来那个平铺循环里原样抠出来 —— 组的渲染要反复调它，内容一字不改。
       */
      function fieldCells(f) {
        const value = shown[f.key]
        const overridden = Object.prototype.hasOwnProperty.call(user, f.key)
        let control
        if (f.kind === 'boolean') {
          control = h(
            'label',
            { style: S.check },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              disabled: !snap.writable || busy,
              onChange: change(f.key),
            }),
            h('span', null, f.hint || ''),
          )
        } else if (f.kind === 'select') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            (f.options || []).map(([v, text]) => h('option', { key: v, value: v }, text)),
          )
        } else if (f.kind === 'session') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            sessionOptions(sessionList, value, workspaceSnapshot?.archivedSessionIds).map((o) =>
              h('option', { key: o.value || '(none)', value: o.value }, o.label),
            ),
          )
        } else {
          control = h('input', {
            type: f.kind === 'number' ? 'number' : 'text',
            ...(f.step ? { step: f.step } : {}),
            style: S.input,
            value: String(value),
            disabled: !snap.writable || busy,
            onChange: change(f.key),
            spellCheck: false,
          })
        }
        const label = h(
          'div',
          { key: f.key, style: S.label },
          f.label,
          overridden ? h('span', { style: S.overridden }, '·已覆盖') : null,
          // 每个字段都有自己的标签格，所以逐字段放按钮对所有类型都成立 —— 不必只给一个统一按钮。
          overridden
            ? h(
                'button',
                {
                  type: 'button',
                  style: disabled(S.link, busy || !snap.writable),
                  disabled: busy || !snap.writable,
                  title: '清掉设置文件里的这一项，回落到 composition config 的值',
                  onClick: () => unsetOverride(f.key),
                },
                '撤销覆盖',
              )
            : null,
        )
        const ctl = h(
          'div',
          { key: `${f.key}-ctl` },
          control,
          f.kind !== 'boolean' && f.hint
            ? h(
                'div',
                { style: S.hint },
                // 会话下拉额外把真实 id 显示出来：看着名字选，但真要手抄/核对时 id 就在旁边
                (f.kind === 'session' && String(value) !== '' ? `${f.hint}当前：${value}` : f.hint) +
                  (typeof f.check === 'function' && f.check(value) ? `\n⚠️ ${f.check(value)}` : ''),
              )
            : null,
        )
        return [label, ctl]
      }

      // 手风琴：按 GROUPS 的固定顺序一组一块；点组标题切换展开，默认全部收起。
      // 展开时遍历该组字段、渲染原来的 label + control 网格（fieldCells 平铺进 grid）。
      const sections = GROUPS.map((g) => {
        const fields = FIELDS.filter((f) => f.group === g.id)
        const open = openGroups[g.id] === true
        const isPool = g.id === 'modelpool'
        return h(
          'div',
          { key: g.id, style: S.group },
          h(
            'button',
            {
              type: 'button',
              onClick: () => setOpenGroups((prev) => ({ ...prev, [g.id]: !prev[g.id] })),
              'aria-expanded': open,
              style: S.groupHead,
            },
            h('span', null, g.label),
            h('span', { style: S.groupCount }, `${fields.length} 项`),
            h('span', { style: S.chevron }, open ? '▴' : '▾'),
          ),
          // 收起的那组不渲染控件，但草稿照常保留 —— draft 与 openGroups 是两套状态。
          open
            ? isPool
              ? h(ModelPoolEditor, {
                  value: shown.modelPool,
                  disabled: !snap.writable || busy,
                  onChange: changeModelPool,
                })
              : h('div', { style: S.grid }, fields.flatMap((f) => fieldCells(f)))
            : null,
        )
      })

      // “打开 WebUI”只在真读到 webui.json 时可点 —— 地址里带着 token，不给猜的余地。
      const webuiUrl = napcat && typeof napcat.webuiUrl === 'string' ? napcat.webuiUrl : ''
      // 宿主报的 running 是权威判据（含外部启动的 NapCat）。拿不到状态时按未运行处理。
      const napcatRunning = napcat !== null && napcat.running === true
      const napcatOps = h(
        'div',
        { style: S.ops },
        h(
          'button',
          {
            type: 'button',
            style: disabled(S.btn, webuiUrl === '' || napcatBusy !== ''),
            disabled: webuiUrl === '' || napcatBusy !== '',
            onClick: () => {
              if (webuiUrl !== '') window.open(webuiUrl, '_blank', 'noopener')
            },
          },
          '打开 WebUI',
        ),
        h(
          'button',
          {
            type: 'button',
            style: disabled(S.btn, napcatRunning || napcatBusy !== ''),
            disabled: napcatRunning || napcatBusy !== '',
            onClick: () => postNapcat('launch', '已启动 NapCat'),
          },
          napcatRunning ? '已在运行' : napcatBusy === 'launch' ? '启动中…' : '启动 NapCat',
        ),
        h(
          'button',
          {
            type: 'button',
            style: disabled(S.btn, napcatBusy !== ''),
            disabled: napcatBusy !== '',
            onClick: () =>
              postNapcat('reveal', napcat && napcat.installDir ? `已打开文件夹：${napcat.installDir}` : '已打开文件夹'),
          },
          napcatBusy === 'reveal' ? '打开中…' : '打开文件夹',
        ),
        webuiUrl === '' ? h('span', { style: S.hint }, '没读到 webui.json') : null,
      )

      const header = h(
        'button',
        { type: 'button', onClick: () => setOpen(!open), 'aria-expanded': open, style: S.header },
        h('span', { style: S.title }, 'QQ 桥接'),
        h('span', { style: S.sub }, dirty ? '有未保存的改动' : '把固定的 DSH 会话接到 QQ'),
        h('span', { style: S.chevron }, open ? '▴' : '▾'),
      )
      // 默认收起：和官方那几张卡片一样，点标题才展开，免得一屏全是表单
      if (!open) return h('div', { style: S.wrap }, header)
      return h(
        'div',
        { style: S.wrap },
        header,
        // 手风琴：按 GROUPS 的固定顺序一组一块；展开哪组点哪组，保存 / 放弃 / 撤销覆盖的逻辑都不在组里
        sections,
        napcatOps,
        h(
          'div',
          { style: S.foot },
          h(
            'button',
            {
              type: 'button',
              style: disabled({ ...S.btn, ...S.primary }, !dirty || busy || !snap.writable),
              disabled: !dirty || busy || !snap.writable,
              onClick: save,
            },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, !dirty || busy),
              disabled: !dirty || busy,
              onClick: () => {
                setDraft(null)
                setError('')
                setNote('')
              },
            },
            '放弃修改',
          ),
          !snap.writable ? h('span', { style: S.note }, '（只读：这个连接不改宿主文档）') : null,
          error ? h('span', { style: S.err }, error) : null,
          !error && note ? h('span', { style: S.note }, note) : null,
        ),
      )
    }

    // ── 插件 ──────────────────────────────────────────────────────────────────

    /** 需要的浏览器服务：slots（注册卡片）；settingsScope 在 apply 里等它出现。 */
    const inject = ['slots']

    // TODO(0.2.0): 平台把第三方插件的设置桥接上之后（web-all / DSH 修完 #677 的迁移），
    // 可以砍掉多余候选 key 与卡片上那行“诊断”；`namespaces` / `detail()` 建议保留（排障用）。
    // 详见 docs/dsh-0.2.0-migration.md 的 TODO 节。
    /**
     * 绑一个**可写的**设置域。导出（经 __test）以便离线测试。
     *
     * 两代 DSH 对“这个插件的设置”用的 key 不一样：
     *   0.1.5-rc.3：settings 命名空间 —— `qq-bridge`（宿主半 register 出来的）；
     *   0.2.0     ：profile **entry id** —— `include:qq-bridge`（由插件自己的 Config 投影而来）。
     * 只绑前者的话，0.2.0 上永远拿到 `unavailable`，用户看到的就是“这个部署没有为 qq-bridge
     * 提供可写的设置服务”（2026-10-01 桌面端真机）。所以**两个都绑，谁 ready 用谁**。
     */
    /** 0.2.0 的兜底数据源：宿主自己挂的本机接口（见宿主半的 handleSettingsRequest）。 */
    const API_PATH = '/api/qq-bridge/settings'
    /** NapCat 操作接口（宿主半不受 legacy 门控，两代宿主都挂）。 */
    const NAPCAT_API = '/api/qq-bridge/napcat'
    /** 稳定引用：useSyncExternalStore 的 getSnapshot 每次返回新对象会死循环。 */
    const LOADING_SNAPSHOT = { status: 'loading' }
    const UNAVAILABLE_SNAPSHOT = { status: 'unavailable' }

    /**
     * 走宿主本机接口的设置域（0.2.0 用）。
     *
     * 为什么需要它：0.2.0 的 `webUiSettings` 桥对第三方插件永远返回 `unavailable`
     * （证据见 docs/dsh-0.2.0-migration.md）。范本：皮肤中心
     * `@linxin666/dsh-client-ui-skin-center` 就是自己 `inject: ["webServer"]` 挂
     * `/api/skin-center/...`，浏览器半直接 fetch 它，全程不碰宿主 settings 服务。
     *
     * 小 store：fetch 一次 → 缓存 snapshot → 通知订阅者；`set` 走 POST 再刷新。
     * 快照形状与宿主 scope 对齐（`status` / `value` / `user` / `writable`），卡片不用改。
     */
    function createApiScope() {
      const listeners = new Set()
      let snapshot = { status: 'idle' }
      let started = false
      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // 一个订阅者抛错不该影响别人
          }
        }
      }
      const accept = (body) => {
        const overridden = Array.isArray(body?.overridden) ? body.overridden : []
        publish({
          status: 'ready',
          value: body?.values && typeof body.values === 'object' ? body.values : {},
          user: Object.fromEntries(overridden.map((key) => [key, true])),
          writable: true,
        })
      }
      const load = async () => {
        if (typeof fetch !== 'function') {
          publish({ status: 'unavailable', reason: 'no-fetch' })
          return
        }
        publish({ status: 'loading' })
        try {
          const res = await fetch(API_PATH, { headers: { accept: 'application/json' } })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        } catch (error) {
          publish({ status: 'unavailable', reason: `api: ${error?.message ?? error}` })
        }
      }
      return {
        kind: 'api',
        getSnapshot: () => snapshot,
        start: () => {
          if (started) return
          started = true
          load()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: async (field, value) => {
          const res = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set: { [field]: value } }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        },
        /** 撤销一个字段的本机覆盖：接口本来就支持 `unset`，这里只是把它暴露给卡片。 */
        unset: async (field) => {
          if (typeof fetch !== 'function') throw new Error('qq-bridge: 这个环境没有 fetch')
          const res = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ unset: [field] }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        },
      }
    }

    /**
     * 绑一个**可写的**设置域。导出（经 __test）以便离线测试。
     *
     * 两代 DSH 对“这个插件的设置”用的 key 不一样：
     *   0.1.5-rc.3：settings 命名空间 —— `qq-bridge`（宿主半 register 出来的）；
     *   0.2.0     ：profile **entry id** —— `include:qq-bridge`（由插件自己的 Config 投影而来）。
     * 只绑前者的话，0.2.0 上永远拿到 `unavailable`，用户看到的就是“这个部署没有为 qq-bridge
     * 提供可写的设置服务”（2026-10-01 桌面端真机）。所以**两个都绑、谁 ready 用谁**；
     * **全都不 ready** 时再退到宿主自己的本机接口（0.2.0 的兜底，见 createApiScope）。
     */
    function bindSettings(service) {
      const unavailable = UNAVAILABLE_SNAPSHOT
      const candidates = []
      // 0.2.0 的表单 key 到底叫什么，源码里能看到的写法**全试一遍**（谁 ready 用谁）：
      // settings 命名空间 / profile entry id / 包名，以及带 include: 前缀的两种。
      //
      // ⚠️ 合并包（HOST_ID）**刻意不绑** `include:HOST_ID`：那个域对应的是合并包 entry 的
      // 整份 config，形状是 `{ fish: {...}, qq: {...} }`；卡片的字段是**平铺**的
      // （nicknames / ownerQQ…），绑上去会“显示正常但写到顶层”，比不显示更难查。
      // 合并态下让四个候选全部不 ready，自动回落到本机接口 /api/qq-bridge/settings。
      for (const namespace of [NS, `include:${NS}`, 'dsh-qq-bridge', 'include:dsh-qq-bridge']) {
        try {
          const scope = service.bind({ namespace })
          if (scope && typeof scope === 'object') candidates.push({ namespace, scope })
        } catch (error) {
          // 某个候选绑不上不影响另一个。
          console?.debug?.(`qq-bridge: bind(${namespace}) 失败：${error?.message ?? error}`)
        }
      }
      const snapshotOf = (candidate) => {
        try {
          return candidate.scope.getSnapshot?.() ?? unavailable
        } catch {
          return unavailable
        }
      }
      const readyScope = () => candidates.find((candidate) => snapshotOf(candidate).status === 'ready')
      const anyLoading = () => candidates.some((candidate) => snapshotOf(candidate).status === 'loading')
      const api = createApiScope()
      return {
        // 供排障/测试看：这次到底绑到了哪些 key
        namespaces: candidates.map((candidate) => candidate.namespace),
        /** 这次数据从哪来（排障/测试用）：'scope' | 'api' | 'none'。 */
        via: () => {
          if (readyScope()) return 'scope'
          return api.getSnapshot().status === 'ready' ? 'api' : 'none'
        },
        /**
         * 每个候选的当前状态。直接显示在卡片上 —— 0.2.0 的 key 叫什么，
         * 与其猜，不如让它自己报（2026-10-01 真机就是靠这个收敛的）。
         */
        detail: () => {
          const scopes =
            candidates.length === 0
              ? '一个候选都没绑上（webUiSettings.bind 全部抛错）'
              : candidates.map((candidate) => `${candidate.namespace}=${snapshotOf(candidate).status}`).join('、')
          const apiSnap = api.getSnapshot()
          return `${scopes}；本机接口=${apiSnap.status}${apiSnap.reason ? `（${apiSnap.reason}）` : ''}`
        },
        getSnapshot: () => {
          const candidate = readyScope()
          if (candidate) return snapshotOf(candidate)
          // scope 全不可用 → 退到宿主本机接口；第一次问就把它跑起来。
          if (!anyLoading()) api.start()
          const apiSnap = api.getSnapshot()
          if (apiSnap.status === 'ready') return apiSnap
          if (apiSnap.status === 'loading' || apiSnap.status === 'idle') return LOADING_SNAPSHOT
          return unavailable
        },
        subscribe: (listener) => {
          const offs = []
          for (const candidate of candidates) {
            try {
              const off = candidate.scope.subscribe?.(listener)
              if (typeof off === 'function') offs.push(off)
            } catch {
              // 订阅失败不影响其它候选
            }
          }
          offs.push(api.subscribe(listener))
          if (!readyScope() && !anyLoading()) api.start()
          return () => {
            for (const off of offs) off()
          }
        },
        set: (field, value) => {
          const candidate = readyScope()
          if (candidate && typeof candidate.scope.set === 'function') return candidate.scope.set(field, value)
          if (api.getSnapshot().status === 'ready') return api.set(field, value)
          throw new Error('qq-bridge: 没有可写的设置源')
        },
        /**
         * 撤销一个字段的本机覆盖。
         *
         * 优先用设置域自己的 `unset`（DSH 的 SettingsScope 有这个能力）；
         * 设置域没有它时走本机接口的 `unset`（宿主半的 handleSettingsRequest 本来就支持）。
         */
        unset: (field) => {
          const candidate = readyScope()
          if (candidate && typeof candidate.scope.unset === 'function') return candidate.scope.unset(field)
          return api.unset(field)
        },
      }
    }

    function apply(ctx) {
      // ⚠️ 两代 DSH 之间**两处都换了名字**（2026-10-01 用户指出第二处）：
      //   ① 客户端**设置服务**：0.1.5-rc.3（web-all 0.3.x）叫 `settingsScope`，
      //      0.2.0（web-all 0.4.x）叫 `webUiSettings`；
      //   ② 插件配置页的**挂载 slot**：0.1.5-rc.3 是 `settings.plugin.item`（按 settings 命名空间派发），
      //      0.2.0 是 `settings.plugins.tab`（插件自己是一个 tab）。
      //
      // 2026-10-26 补的第三处（合并包才发现）：0.2.0 的**派发键是 profile entry id**，
      // 不再是 settings 命名空间。合并成 dsh-fish-qq 之后 entry id 变了，
      // 只注册 `qq-bridge` 的结果是**一张卡片都不出现**（真机：设置 → 插件 里没有「QQ 桥接」）。
      //
      // 还有一处：原来把注册整段包在 `setup()` 里，而 setup 头一句就是
      // `if (!service) return` —— 这个部署没有设置服务时连卡片都不会挂。
      // 作者本来就写了「没有设置域就走本机 HTTP 接口」的兜底（createApiScope，
      // 对应宿主半的 /api/qq-bridge/settings），只是被那道服务门挡在门外了。现在不再挡。
      const service = (() => {
        try {
          return ctx.get?.('webUiSettings') ?? ctx.get?.('settingsScope') ?? null
        } catch {
          return null
        }
      })()
      // service 为 null 时一个候选都绑不上，getSnapshot 会自动回落到本机接口。
      const scope = bindSettings(service)

      // sessionsOf / workspacesOf 用“取的时候再解析”：这两个服务可能比插件晚出现，
      // 也可能这个部署根本没装 —— 那时卡片照常渲染，只是目标会话那一栏只有兜底项。
      const card = () =>
        h(Card, { scope, sessionsOf: () => ctx.get('sessions'), workspacesOf: () => ctx.get('workspaces') })

      const registerCard = (slot, options) => {
        try {
          // `slots.inject(slot, factory)` 只在那个 slot 存在时才跑 factory，多注入是安全的。
          ctx.slots.inject(slot, () => ctx.slots.register({ ...options, name: slot }, card))
        } catch (error) {
          // 这个版本的 DSH 没有这个 slot —— 忽略，另一个会生效。
          console?.debug?.(`qq-bridge: slot ${slot} unavailable (${error?.message ?? error})`)
        }
      }

      // `settings.plugin.item` 是**按 key 派发**的：多注册几个键，命中的那个才渲染。
      for (const key of CARD_KEYS) registerCard('settings.plugin.item', { key })
      // tab 槽是**按 id 各算一个 tab**：只注册一个，否则会出现两个「QQ 桥接」。
      registerCard('settings.plugins.tab', {
        id: HOST_ID || NS,
        order: 100,
        label: () => 'QQ 桥接',
      })
    }

    exports.apply = apply
    exports.inject = inject
    // 导出 name：Cordis 用它做插件标识，Slots inspect 里的 registrant 会显示成它
    // （不导的话那边显示的是产物里的 fallback 短名，排障时认不出是谁注册的卡片）。
    exports.name = 'dsh-qq-bridge'
    // 纯函数给离线测试用（test-smoke.mjs 会在假 ctx 里真跑这个 bundle）。
    // Cordis 只认 apply / inject / name / Config，多余的导出它不管。
    exports.__test = { sessionOptions, draftFrom, parse, fields: FIELDS, bindSettings, normalizeModelPool, ModelPoolEditor }
    return module.exports
  },
})
