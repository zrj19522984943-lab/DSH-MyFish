// qq/shared/idle-pure.js
//
// 主动私聊 / subsend / Cron 的纯判据与默认值。
// 宿主专属（client 不用）；私人时间的抽签判据仍在 idle-trigger.js。
// 纯数据 + 纯函数，不引用宿主对象。

export const PROACTIVE_DEFAULTS = Object.freeze({
  enabled: false,
  idleHours: 4,
  probability: 0.15,
  dailyLimit: 3,
  scanIntervalMinutes: 30,
})

/** 本地日期键（YYYY-MM-DD）。日界按本地时区，与 dsh-fish 的 dateKey 一致。 */
export function dayKeyOf(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 这一轮扫描该不该主动发。纯函数，`random` / `now` 可注入，便于复现。
 *
 * @returns {{fire:boolean, reason:string, count:number}}
 */
export function shouldProactivelyMessage({
  enabled = false,
  ownerQQ = '',
  idleHours = PROACTIVE_DEFAULTS.idleHours,
  probability = PROACTIVE_DEFAULTS.probability,
  dailyLimit = PROACTIVE_DEFAULTS.dailyLimit,
  scanIntervalMinutes = PROACTIVE_DEFAULTS.scanIntervalMinutes,
  lastActivityAt = 0,
  lastProactiveAt = 0,
  dayKey = '',
  todayKey = dayKeyOf(),
  usedCount = 0,
  transportOpen = true,
  random = Math.random,
  now = Date.now(),
} = {}) {
  if (enabled !== true) return { fire: false, reason: 'disabled', used: 0 }
  if (String(ownerQQ ?? '').trim() === '') return { fire: false, reason: 'no-owner', used: 0 }
  if (!transportOpen) return { fire: false, reason: 'not-connected', used: 0 }

  const limit = Math.max(0, Number(dailyLimit) || 0)
  if (limit <= 0) return { fire: false, reason: 'limit-zero', used: 0 }

  // 跨天：昨天的计数不算数
  const used = dayKey === todayKey ? Math.max(0, Number(usedCount) || 0) : 0
  if (used >= limit) return { fire: false, reason: 'daily-limit', used }

  const idleMs = Math.max(0, Number(idleHours) || 0) * 3_600_000
  if (!(Number(lastActivityAt) > 0)) return { fire: false, reason: 'no-activity-yet', used }
  if (now - Number(lastActivityAt) < idleMs) return { fire: false, reason: 'not-idle', used }

  // 同一扫描间隔内不重复触发（防止一次"空闲"被连续扫出好几条）
  const gapMs = Math.max(1, Number(scanIntervalMinutes) || PROACTIVE_DEFAULTS.scanIntervalMinutes) * 60_000
  if (Number(lastProactiveAt) > 0 && now - Number(lastProactiveAt) < gapMs) {
    return { fire: false, reason: 'cooldown', used }
  }

  if (random() >= Number(probability)) return { fire: false, reason: 'sampled-out', used }
  return { fire: true, reason: 'hit', used }
}

/** 主动私聊注入给会话的那句话。写成"处境"，不写成任务清单（和 dsh-fish 的口径一致）。 */
export function proactivePromptText(idleHours, now = Date.now()) {
  const h = Math.max(0, Number(idleHours) || 0)
  return [
    `[系统：距离上次对话已经超过 ${h} 小时了。他这会儿不在。]`,
    '',
    '你可以主动说点什么，也可以什么都不说。',
    '要说就只说给他一个人听——他会在 QQ 上收到；不用汇报，也不用解释为什么忽然开口。',
  ].join('\n')
}

export const SUBSEND_DEFAULTS = Object.freeze({
  enabled: true,
  dailyLimit: 20,
  cooldownSeconds: 20,
})

/**
 * 五段式 Cron（分 时 日 月 周）解析器。零依赖、够用为止：
 * 支持 `*`、单个数字、范围（`1-3`）、列表（`1,2,3`）、「`范围`/步长」
 * 的步进写法（如 `1-30/5`；`*`/15 = 每 15 分钟一次），
 * 周里 0 和 7 都算星期天；也接受 `HH:MM` 这种「每天几点」的简写。
 *
 * 语义按 Vixie cron：日（day-of-month）与周（day-of-week）**都**限定时，任一命中即命中
 * （与 schedule_create 同一套说法）；只有一边限定时看那一边。
 *
 * @param {string} expr Cron 表达式
 * @returns {{nextFrom(nowMs:number):number|null} | null} 解析失败返回 null；
 *   `nextFrom` 返回下一个命中时刻（毫秒），四年内都命中不了返回 null
 */
export function parseCron(expr) {
  const raw = String(expr ?? '').trim()
  if (raw === '') return null
  // HH:MM 简写 → 每天 HH:MM（例：08:00 → "0 8 * * *"）
  const hm = /^(\d{1,2}):(\d{2})$/.exec(raw)
  const canon = hm ? `${Number(hm[2])} ${Number(hm[1])} * * *` : raw
  const fields = canon.split(/\s+/)
  if (fields.length !== 5) return null
  const minute = parseCronField(fields[0], 0, 59)
  const hour = parseCronField(fields[1], 0, 23)
  const dom = parseCronField(fields[2], 1, 31)
  const month = parseCronField(fields[3], 1, 12)
  let dow = parseCronField(fields[4], 0, 7) // Vixie：7 也是星期天
  if (!minute || !hour || !dom || !month || !dow) return null
  if (dow.has(7)) dow.add(0)
  dow.delete(7) // 0 已经在集合里，去掉 7 这个别名

  return {
    nextFrom(nowMs) {
      const start = new Date(nowMs)
      // 从「下一分钟」的整分钟开始找——当前分钟已经过到一半了，不算。
      const t = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate(),
        start.getHours(),
        start.getMinutes() + 1,
        0,
        0,
      )
      const limit = nowMs + 4 * 366 * 24 * 60 * 60_000
      while (t.getTime() <= limit) {
        if (
          minute.has(t.getMinutes()) &&
          hour.has(t.getHours()) &&
          month.has(t.getMonth() + 1)
        ) {
          const domOk = dom.has(t.getDate())
          const dowOk = dow.has(t.getDay())
          const bothRestricted = fields[2] !== '*' && fields[4] !== '*'
          const dayOk = bothRestricted
            ? domOk || dowOk
            : fields[2] !== '*'
              ? domOk
              : fields[4] !== '*'
                ? dowOk
                : true
          if (dayOk) return t.getTime()
        }
        t.setMinutes(t.getMinutes() + 1)
      }
      return null
    },
  }
}

/** Cron 单个字段 → 允许值集合。解析失败返回 null（非法值不许穿透成「每分钟都行」）。 */
function parseCronField(field, min, max) {
  const out = new Set()
  for (const part of String(field ?? '').split(',')) {
    let range = part
    let step = 1
    const slash = part.indexOf('/')
    if (slash >= 0) {
      range = part.slice(0, slash)
      step = Number(part.slice(slash + 1))
      if (!Number.isInteger(step) || step < 1) return null
    }
    let lo = min
    let hi = max
    if (range !== '*') {
      const dash = range.indexOf('-')
      if (dash >= 0) {
        lo = Number(range.slice(0, dash))
        hi = Number(range.slice(dash + 1))
      } else {
        lo = Number(range)
        hi = lo
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max) return null
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size > 0 ? out : null
}

/**
 * 这一次 subsend 该不该发。纯函数，`now` 可注入，便于复现。
 *
 * 与 `shouldProactivelyMessage` 同一套口径（跨天作废 / 每日上限 / 冷却），
 * 但**没有概率与空闲**判据 —— 主人点名要发就发，限流只为防循环刷屏。
 * @returns {{allow:boolean, reason:string, used:number, retryInMs?:number}}
 */
// @doc qq.subsend
export function shouldSubsend({
  enabled = SUBSEND_DEFAULTS.enabled,
  dailyLimit = SUBSEND_DEFAULTS.dailyLimit,
  cooldownSeconds = SUBSEND_DEFAULTS.cooldownSeconds,
  dayKey = '',
  todayKey = dayKeyOf(),
  usedCount = 0,
  lastAt = 0,
  now = Date.now(),
} = {}) {
  if (enabled !== true) return { allow: false, reason: 'disabled', used: 0 }
  const limit = Math.max(0, Number(dailyLimit) || 0)
  if (limit <= 0) return { allow: false, reason: 'limit-zero', used: 0 }

  // 跨天：昨天的计数不算数
  const used = dayKey === todayKey ? Math.max(0, Number(usedCount) || 0) : 0
  if (used >= limit) return { allow: false, reason: 'daily-limit', used }

  // 冷却：两次发送之间的最短间隔。模型陷入死循环时会反复调工具，
  // 冷却把这种循环卡住，而不是靠每日上限事后补救。
  const cooldownMs = Math.max(0, Number(cooldownSeconds) || 0) * 1000
  if (cooldownMs > 0 && Number(lastAt) > 0 && now - Number(lastAt) < cooldownMs) {
    return { allow: false, reason: 'cooldown', used, retryInMs: cooldownMs - (now - Number(lastAt)) }
  }
  return { allow: true, reason: 'ok', used }
}
