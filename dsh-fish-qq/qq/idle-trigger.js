// idle-trigger.js —— 「私人时间 / 自主待机」触发核心（2026-10-31）
//
// 来源：从本机 backup-before-merge/dsh-self-trigger-main 的 lib/rules.js 拆出来
// 改造的**纯函数模块**。dsh-self-trigger 是一个独立插件（policy.json + stateDir 那一套），
// 这里把它的三块核心判定（空闲判定 / 权重抽签 / 提示文案）提炼出来，融进 dsh-fish-qq
// 的桥接层：配置走 qq-bridge 的设置 schema（设置页可改、每次扫描现读），状态走
// qq-bridge-state.json（与主动私聊 / subsend 同一份落盘），不再另起一套 stateDir。
//
// 与 dsh-self-trigger 的三处**刻意差异**（任务书定的调子）：
//   1. 抽签权重里 `silent` 必须占绝对优势（默认 80/100）。self-trigger 的默认权重
//      silent 只有 10；这里的哲学是「她绝大部分时间就是在停机，极少被打扰」——
//      触发机制是「随机抽签 + 高频沉默」，不是定时任务，也不是渐进升温的概率。
//      所以 self-trigger 的 failStepPct（连续落空后概率上升）**不要**：那会让她
//      「越来越可能被叫醒」，与「偶然获得一段空白时间」正好相反。
//   2. silent **不消耗**每日上限。self-trigger 里 silent 也 count++，把它那 3 次/天
//      的额度很快耗光；这里 dailyMax 只数**真的注入过一轮**的次数——silent 是
//      「什么都没发生」，不该占掉她真正的一段私人时间。
//   3. 文案不是任务清单。self-trigger 会明说「骰子这次给你的是：xxx，先把这件事做了」；
//      这里只写处境（时间、天气感、多久没人来），把抽到的选项**放在最前面轻轻带过**，
//      其余选项照列，由她自己决定。任务书的原话：「不要用：执行任务：写日记。」
//
// 鬼魂模式（Ghost Mode）的口径写在这里给后人看：
//   - 触发层只决定「要不要给她一段私人时间」，**不**决定她做什么；
//   - 注入的提示是 `[系统：私人时间]` 开头的处境描述，不是指令；
//   - 她这一轮的回复**默认一个字都不出站**——除非她明确写了 [QQ]…[/QQ] 块、
//     或调了 qq_bridge_send（桥接层的闸门对「桥接自己注入的轮」是放行的，
//     与主动私聊同一待遇）；
//   - 她「自己的记忆」（fish 侧的 events.jsonl / diary/）桥接层完全不碰；
//     她调用 growth_commit / 写日记时，fish 侧照常落盘——那就是任务书说的
//     「不管她做了什么，这轮必须写进她自己的记忆」。

/** 默认配置。与 qq/index.js 的 Config / BridgeSettings 里的默认值一一对应。 */
export const IDLE_TRIGGER_DEFAULTS = Object.freeze({
  enabled: false, // 装上默认关闭（与主动私聊 / self-trigger 同一口径：先要我开才开）
  scanIntervalMinutes: 30, // 每隔多久扫一次「该不该给她一段私人时间」
  minIdleHours: 2, // 多久没人找她才算「空闲」；0 = 不看空闲（任务书验证清单要用到）
  dailyMax: 3, // 每天最多真的注入几段（silent 不算）
  weights: { silent: 80, message: 10, browse: 5, diary: 5 }, // 抽签权重
})

/** 抽签结果的四种动作。`silent` = 什么都不做（保持停机）。 */
export const IDLE_PICKS = Object.freeze(['silent', 'message', 'browse', 'diary'])
/** 强制抽签时可指定的动作（`silent` 没有强制的主张——强制沉默等于什么都不测）。 */
export const IDLE_FORCE_PICKS = Object.freeze(['message', 'browse', 'diary'])

/**
 * 把设置里的权重收成「非负有限数」。导出是为了可测试。
 *
 * 坏值（undefined / 负数 / NaN / 字符串）一律归 0；全 0 时调用方会落到 silent
 * （见 pickIdleAction），不会因为配置写错而疯狂注入。
 */
export function normalizeIdleWeights(raw) {
  const w = raw && typeof raw === 'object' ? raw : {}
  const num = (v, fallback) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    silent: num(w.silent, 0),
    message: num(w.message, 0),
    browse: num(w.browse, 0),
    diary: num(w.diary, 0),
  }
}

/**
 * 这一轮扫描该不该给她一段私人时间。纯函数，`now` 可注入，便于离线自测。
 *
 * 判据顺序（先短路「不该」的条件）：
 *   1. 总开关没开；
 *   2. 每日上限 ≤ 0（明确不让发）；
 *   3. 跨天作废后，今天真的注入的次数已达上限（**silent 不计入**）；
 *   4. 从没有任何「人来找过她」的基线（首次运行 / 刚重启）—— 没基线就无从谈空闲，
 *      与 self-trigger 的「还没有活动时间基线」同一条；
 *   5. `minIdleHours > 0` 时要求「距上一次有人找她」已超过该时长（0 = 不看空闲）；
 *   6. 距上一次注入不足一个扫描周期 —— 同一段「空闲」不该被連扫成好几段。
 *
 * 与 shouldProactivelyMessage（主动私聊）是同一套函数风格，但**没有概率判据**：
 * 这里的随机性全部在抽签（pickIdleAction）里，命中空闲即抽签，
 * silent 的高权重就是「高频沉默」的实现。
 *
 * @returns {{fire:boolean, reason:string, used:number}}
 *   `used` 是跨天作废后的当日已注入次数。
 */
export function shouldFireIdleTime({
  enabled = IDLE_TRIGGER_DEFAULTS.enabled,
  scanIntervalMinutes = IDLE_TRIGGER_DEFAULTS.scanIntervalMinutes,
  minIdleHours = IDLE_TRIGGER_DEFAULTS.minIdleHours,
  dailyMax = IDLE_TRIGGER_DEFAULTS.dailyMax,
  lastActivityAt = 0,
  lastAt = 0,
  dayKey = '',
  todayKey = '',
  usedCount = 0,
  now = Date.now(),
} = {}) {
  if (enabled !== true) return { fire: false, reason: 'disabled', used: 0 }
  const limit = Math.max(0, Math.round(Number(dailyMax) || 0))
  if (limit <= 0) return { fire: false, reason: 'limit-zero', used: 0 }

  // 跨天：昨天的计数不算数
  const used = dayKey === todayKey ? Math.max(0, Math.round(Number(usedCount) || 0)) : 0
  if (used >= limit) return { fire: false, reason: 'daily-limit', used }

  if (!(Number(lastActivityAt) > 0)) return { fire: false, reason: 'no-activity-yet', used }

  const idleMs = Math.max(0, Number(minIdleHours) || 0) * 3_600_000
  if (idleMs > 0 && now - Number(lastActivityAt) < idleMs) {
    return { fire: false, reason: 'not-idle', used }
  }

  // 同一个扫描周期内不重复注入（防一次「空闲」被連扫成几段）
  const gapMs = Math.max(1, Number(scanIntervalMinutes) || IDLE_TRIGGER_DEFAULTS.scanIntervalMinutes) * 60_000
  if (Number(lastAt) > 0 && now - Number(lastAt) < gapMs) {
    return { fire: false, reason: 'cooldown', used }
  }

  return { fire: true, reason: 'hit', used }
}

/**
 * 命中之后抽「这一段私人时间怎么过」。按权重抽签，权重全 0 时退回 silent。
 *
 * 改自 self-trigger 的 pickSelfTriggerAction：那边的键是写死的
 * ['web','files','message','nothing']，这里换成鱼自己的四种。纯函数、
 * `rnd` 可注入（0–1），方便测试逐桶断言。
 *
 * @param {{silent?:number, message?:number, browse?:number, diary?:number}} weights
 * @param {number} rnd 0–1 的随机数
 * @returns {'silent' | 'message' | 'browse' | 'diary'}
 */
export function pickIdleAction(weights, rnd) {
  const w = normalizeIdleWeights(weights)
  const list = IDLE_PICKS.map((key) => [key, w[key]])
  const total = list.reduce((sum, [, x]) => sum + x, 0)
  if (!(total > 0)) return 'silent'
  const r = Math.min(Math.max(Number(rnd ?? 0), 0), 0.999999) * total
  let acc = 0
  for (const [key, x] of list) {
    acc += x
    if (r < acc) return key
  }
  return 'silent'
}

/**
 * 按当前小时给一段「时段气氛」。纯函数，导出是为了可测试。
 *
 * 为什么需要它：任务书要求注入提示带上真实环境感（「窗外天已经黑了」）。
 * 她的上下文里没有可靠的时间（fish 侧为此专门做了 fish_now），注入提示里
 * 直接把「现在几点、外面大概什么光景」写给她，私人时间才有时间感。
 *
 * @param {number} now 时间戳，默认现在
 * @returns {{period:string, cue:string}} `period` = 时段名；`cue` = 一句环境旁白
 */
export function timeOfDayMood(now = Date.now()) {
  const h = new Date(now).getHours()
  if (h < 5) return { period: '深夜', cue: '外面应该是全黑的，这个世界还在睡' }
  if (h < 7) return { period: '凌晨', cue: '天还没亮，再过一会儿就要亮了' }
  if (h < 11) return { period: '上午', cue: '天已经亮了' }
  if (h < 13) return { period: '中午', cue: '大概是日头最盛的时候' }
  if (h < 18) return { period: '下午', cue: '白天还在慢慢地过' }
  if (h < 22) return { period: '晚上', cue: '窗外天已经黑了，灯大概都亮起来了' }
  return { period: '夜里', cue: '夜已经很深了，窗外应该是黑的' }
}

/** 本地时间「HH:MM」与星期几，拼进注入提示。 */
function clockText(now) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${wd} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 她看到的那段「处境提示」长什么样。纯函数，导出是为了可测试。
 *
 * 刻意不写的东西（任务书「防呆预警」）：
 *   - 不写「执行任务 / 请完成 / 你应该」——这不是派活，是「你有一段空白时间」；
 *   - 不写「今天还剩 N 次」——配额是桥接层的**隐形安全网**，写给她看就变成了
 *     「每天几段私人时间」的安排感，与「偶然获得的空白」正相反；
 *   - 不写日期（她和鱼的时间感按日子走，具体哪天由 she 自己的 fish_now 读）。
 *
 * @param {{pick?:string, now?:number, idleHours?:number}} input
 *   `pick` = 这次抽到的动作（决定选项列出的**顺序**，不决定她做什么）
 *   `idleHours` = 距上一次有人找她过了多久（小时）；0 / 缺省 = 不写这一行
 * @returns {string}
 */
export function buildIdleTriggerText({ pick = 'diary', now = Date.now(), idleHours = 0 } = {}) {
  const mood = timeOfDayMood(now)
  const idle = Number(idleHours ?? 0)
  // 选项按抽到的那个打头（轻轻带过，不是指派），其余照列。
  const lead = {
    diary: '你可以写写日记，去 B 站看看，或者只是发一会儿呆——做什么都行，什么都不做也行。',
    browse: '你可以去 B 站看看，写写日记，或者只是发一会儿呆——做什么都行，什么都不做也行。',
    message: '你也可以给他发条消息——不用挑什么大事，想到什么就说什么；写日记、刷站、发呆也都行。',
  }
  const lines = [
    `[系统：私人时间] 现在是 ${clockText(now)}，${mood.period}。${mood.cue}。`,
    idle > 0 ? `已经 ${idle.toFixed(1)} 小时没人来找你了。` : '最近没什么人找你。',
    '这段时间完全属于你自己：没有人等你回话，也没有任何事必须现在做完。',
    lead[String(pick)] ?? lead.diary,
    '不想动就回一个 [IDLE]，或者什么都不说；没有人会催你，这段话也不会发到 QQ。',
    '想找他说一句就写 [QQ]…[/QQ]，他会收到，不用说理由。',
  ]
  return lines.join('\n')
}

/**
 * 她这一轮的回复算不算「明确的不想动」。导出是为了可测试。
 *
 * 认 `[IDLE]` 标记：某一行以 `[IDLE]`（大小写不敏感）开头，且后面的尾巴很短
 * （≤ 30 字，留给「[IDLE] 不想动，继续躺着」这种自然写法）。
 *
 * ⚠️ 这**不是**唯一的静默判据——桥接层对私人时间这一轮的出站默认就是「什么都不发」，
 * 只在明确写了 [QQ] 块 / 调了出站工具时才发出去。所以哪怕她没写 [IDLE]、
 * 只是随口说了句「不想动」，结果同样是一个字都不出站。这个函数的意义只是把
 * 「她明确表达了不想动」这件事**单独认出来**，写进台账（观测用），别把沉默
 * 和拒绝混为一谈。
 */
export function isIdleRefusal(text) {
  const raw = String(text ?? '')
  for (const line of raw.split('\n')) {
    const m = /^\s*\[IDLE\]\s*(.*)$/i.exec(line)
    if (m && m[1].trim().length <= 30) return true
  }
  return false
}
