// qq/shared/protocol.js
//
// 设置接口 `/api/qq-bridge/settings` 的**请求 / 响应形状**：
//   - 宿主半 handleSettingsRequest 用 validatePatch() 解 POST 体；
//   - 浏览器半 createApiScope 用 buildSettingsSetBody / buildSettingsUnsetBody 造请求体、
//     用 parseSettingsGetResponse 解响应体。
//
// 浏览器半不能写 ESM import（bundle 是 classic script），所以 client.js 里不 import
// 这个文件 —— scripts/build-bundle.mjs 会在构建时把本文件源码注入到 __qqFactory
// 函数体最前面，client.js 直接用同名函数。
//
// 纯数据整形，不引用任何宿主对象，也不 import 任何东西。

/**
 * 解 GET / POST 的设置响应：
 * 形如 `{ ok:true, values:{...}, overridden:['key', ...] }`。
 * 缺字段 / 类型不对时收敛成空值，绝不抛错（卡片宁可显示空，也不要整张消失）。
 *
 * @param {unknown} body
 * @returns {{values: object, overridden: string[]}}
 */
export function parseSettingsGetResponse(body) {
  const values = body?.values && typeof body.values === 'object' ? body.values : {}
  const overridden = Array.isArray(body?.overridden) ? body.overridden.map(String) : []
  return { values, overridden }
}

/**
 * 造「设置一个键」的 POST 体：`{ set: { [field]: value } }`。
 * @param {string} field
 * @param {unknown} value
 */
export function buildSettingsSetBody(field, value) {
  return { set: { [field]: value } }
}

/**
 * 造「撤销一个键的本机覆盖」的 POST 体：`{ unset: [field] }`。
 * @param {string} field
 */
export function buildSettingsUnsetBody(field) {
  return { unset: [field] }
}

/**
 * 解 POST 设置体，返回 `{ patch, unset, error }`：
 *   - `patch`  = `{ key: value }` 或 null；
 *   - `unset`  = 要清掉的键（字符串数组）；
 *   - `error`  = 给用户看的错误（null = 通过）。
 *
 * 判据与旧代码一致：`set` 只要是对象就当 patch（数组也算，最终只会命中自有键）；
 * `unset` 不是数组就当空；两样都空 → 400。
 *
 * @param {unknown} payload
 * @returns {{patch: object|null, unset: string[], error: string|null}}
 */
export function validatePatch(payload) {
  const patch = payload?.set && typeof payload.set === 'object' ? payload.set : null
  const unset = Array.isArray(payload?.unset) ? payload.unset.map(String) : []
  if (!patch && unset.length === 0) {
    return {
      patch: null,
      unset: [],
      error: '请求里缺少 set 或 unset 字段。请给出 set（要改的键值）或 unset（要清掉的键）。',
    }
  }
  return { patch, unset, error: null }
}
