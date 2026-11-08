// qq/shared/model-pool.js
//
// 模型池的**纯数据形状**：宿主半（index.js）与浏览器半（client/client.js）共用。
// 浏览器半不能写 ESM import（bundle 是 classic script），所以 client.js 里不 import
// 这个文件 —— scripts/build-bundle.mjs 会在构建时把本文件的源码注入到 __qqFactory
// 函数体最前面，client.js 直接用同名函数。
//
// 这里只放纯函数/常量，不要 import 任何东西，也不要引用宿主对象。

/** 固定 3 个槽位。 */
export const MODEL_POOL_SLOTS = 3

/** 模型池单次网络请求的硬性上限。 */
export const MODEL_POOL_TIMEOUT_MS = 10_000

/** 一个空槽位。 */
export function emptyModelSlot() {
  return { enabled: false, apiUrl: '', apiKey: '', modelName: '' }
}

/**
 * 把任意输入收敛成**恰好 3 个**形状固定的槽位。
 *
 * 为什么要收敛而不是原样返回：槽位数量是界面契约（Slot 1/2/3），少一个会让
 * 卡片在数组下标上炸掉；多一个则会被静默保存成第 4 个永远看不见的槽。
 */
export function normalizeModelPool(raw) {
  const rows = Array.isArray(raw) ? raw : []
  const out = []
  for (let i = 0; i < MODEL_POOL_SLOTS; i += 1) {
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
