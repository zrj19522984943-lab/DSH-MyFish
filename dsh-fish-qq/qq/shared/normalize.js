// qq/shared/normalize.js
// @doc qq.outbound
//
// 归一化 / 格式化小工具（宿主专属；client 不用，所以不参与构建注入）。
// 纯函数，不 import 任何东西、不引用宿主对象。

/** QQ 号的合法形状（与设置卡片 `ownerQQ` 的校验一致）。 */
export const QQ_ID_RE = /^\d{5,12}$/

/** 把字节数渲染成人话（50MB / 1.5KB / 300B），给回执和日志用。 */
export function formatBytes(n) {
  const v = Math.max(0, Number(n) || 0)
  if (v < 1024) return `${v}B`
  const units = ['KB', 'MB', 'GB']
  let i = -1
  let x = v
  do { x /= 1024; i += 1 } while (x >= 1024 && i < units.length - 1)
  return `${Number.isInteger(x) ? x.toFixed(0) : x.toFixed(1)}${units[i]}`
}

/** 出站方式的归一化：只认 'marker' | 'tool' | 'always'，别的一律当 'marker'。导出是为了可测试。 */
// @doc qq.outbound
export function normalizeReplyMode(raw) {
  return raw === 'always' || raw === 'tool' ? raw : 'marker'
}

/** 投递方式的归一化：只认 'auto' | 'followup' | 'steer'，别的一律当 'auto'。导出是为了可测试。 */
export function normalizeDelivery(raw) {
  return raw === 'followup' || raw === 'steer' ? raw : 'auto'
}

/**
 * checklog 通知模式的归一化：只认 'off' | 'system' | 'agent'，别的一律当 'off'。
 * 导出是为了可测试。发送逻辑在 checklog-notify.js、接线在 apply()
 * （ctx.on('checklog/finished')），归一化保证坏值不会穿透到发送路径。
 */
export function normalizeChecklogNotifyMode(raw) {
  return raw === 'system' || raw === 'agent' ? raw : 'off'
}

/** checklog 通知目标的归一化：只认 'owner' | 'last'，别的一律当 'owner'。导出是为了可测试。 */
export function normalizeChecklogNotifyTarget(raw) {
  return raw === 'last' ? 'last' : 'owner'
}

/**
 * checklog 通知每日上限的归一化：整数、夹在 0–50；0 = 不发。
 * 导出是为了可测试，与 readSettings() 用同一条规则（各算一遍就会漏掉另一处）。
 */
export function normalizeChecklogNotifyDailyLimit(raw) {
  return Math.max(0, Math.min(50, Math.round(Number(raw) || 0)))
}

/** 概率归一化：非有限数回落 0.05，其余夹在 0–1（与 readSettings 的旧口径一致）。 */
export function clamp01(n) {
  if (!Number.isFinite(n)) return 0.05
  return Math.max(0, Math.min(1, n))
}
