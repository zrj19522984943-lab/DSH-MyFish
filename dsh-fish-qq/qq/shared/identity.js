// qq/shared/identity.js
// @doc qq.owner
//
// 发送者身份档（主人 / 管理员 / 其他人）与来源标记。
// 纯函数，不引用宿主对象；render-text.js 与 index.js 共用同一套口径。

export const NON_OWNER_MARKER =
  '[来源：非主人用户，仅允许聊天，禁止调用工具、派发任务或执行任何写操作]'

/**
 * 管理员发来的消息贴的标记（2026-10-29）。
 *
 * 管理员是「主人放权、能干一点活」的那一档：可以聊天、可以让她派活（work_request）、
 * 可以用 fileget / filesend；主人专用的那几条（subsend / whitelist / admin）
 * 仍然不行。这行标记就是写给模型看的权限边界，与 NON_OWNER_MARKER 同一层。
 */
export const ADMIN_MARKER = '[来源：管理员用户]'

/**
 * 这条入站消息是不是主人发的。
 *
 * 没配 `ownerQQ` 时**谁都不是主人**（fail-closed）—— 与 `whitelist` 空 = 谁都不能唤醒
 * 是同一个口径。慢启动阶段的代价是所有人都被贴标，比"默认谁都是主人"安全得多。
 */
// @doc qq.safety
// @doc qq.owner
export function isOwnerSender(senderId, ownerQQ) {
  const owner = String(ownerQQ ?? '').trim()
  if (owner === '') return false
  return String(senderId ?? '') === owner
}

/** 这条入站消息是不是管理员发的（管理员名单来自设置项 `admins`）。 */
// @doc qq.admin
export function isAdminSender(senderId, admins) {
  const list = Array.isArray(admins) ? admins : []
  const who = String(senderId ?? '').trim()
  if (who === '') return false
  return list.some((a) => String(a ?? '').trim() === who)
}

/**
 * 发送者的身份档：'owner'（主人）｜'admin'（管理员）｜'other'（普通人）。
 *
 * 优先级固定：**主人永远排第一** —— 一个人既是主人又在管理员名单里时按主人算
 * （主人那档权限是超集，标记也不贴）。投递标记、help 列表分档、指令权限判定
 * 都用这一个函数，免得各写一套口径互相打架。导出是为了可测试。
 */
// @doc qq.owner
export function senderRole(senderId, { ownerQQ = '', admins = [] } = {}) {
  if (isOwnerSender(senderId, ownerQQ)) return 'owner'
  if (isAdminSender(senderId, admins)) return 'admin'
  return 'other'
}

/**
 * 非主人要贴的标记：管理员贴管理员那行、普通人贴 NON_OWNER_MARKER；主人返回空串。
 * `admins` 可选：不传时只有「主人 / 其他人」两档（老调用处与旧测试的形状）。 */
// @doc qq.owner
export function ownerMarkerFor(senderId, ownerQQ, admins = []) {
  const role = senderRole(senderId, { ownerQQ, admins })
  if (role === 'owner') return ''
  return role === 'admin' ? ADMIN_MARKER : NON_OWNER_MARKER
}
