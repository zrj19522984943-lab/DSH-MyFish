/**
 * pet/index.js —— 桌宠窗口的开关。
 *
 * 一次 start()：文件通道先就绪（窗口要拿 token），再把 Electron 窗口拉起来。
 * 首次没有 Electron 时会在后台下载；下载和解压都不阻塞插件启动，也不会
 * 改变她的任何事件。
 *
 * 停用插件 / DSH 退出 → dispose() 杀掉窗口进程；Host 意外退出时窗口自己
 * 通过 --host-pid 探活退出。不会在桌面上留孤儿窗口。
 */
import { createPetBridge } from './bridge.js'
import { isTestProcess, shouldStartPet, startPetWindow } from './electron.js'

/**
 * @param {object} options
 * @param {object} options.ctx DSH 插件 ctx
 * @param {string} options.root 状态库根目录
 * @param {Function} [options.log]
 * @param {object} [options.env]
 */
export function createPet({ ctx, root, log = () => {}, env = process.env } = {}) {
  let disposed = false
  let bridge = null
  let windowHandle = null
  const abort = new AbortController()

  async function start() {
    if (disposed) return status()
    if (isTestProcess({ env })) {
      // 测试进程不下载 Electron、不弹窗；桌宠相关的纯函数有单独的单测。
      return status()
    }
    if (!shouldStartPet({ env })) {
      log(`[dsh-fish] 桌宠窗口未启用（platform=${process.platform}, electron=${process.versions.electron ?? '无'}, DSH_PROFILE=${env.DSH_PROFILE ?? '无'}, DSH_FISH_PET=${env.DSH_FISH_PET ?? '无'}）`)
      return status()
    }

    bridge = createPetBridge({ ctx, root, log })
    try {
      await bridge.start()
    } catch (err) {
      log(`[dsh-fish] 桌宠文件通道没起来：${String(err?.message ?? err).slice(0, 160)}`)
    }
    if (disposed) return status()

    try {
      windowHandle = await startPetWindow({ root, log, env, signal: abort.signal })
    } catch (err) {
      log(`[dsh-fish] 桌宠窗口没起来：${String(err?.message ?? err).slice(0, 160)}`)
      windowHandle = null
    }
    if (disposed) {
      try { windowHandle?.dispose?.() } catch { /* ignore */ }
      windowHandle = null
    } else if (windowHandle?.running) {
      log(`[dsh-fish] 桌宠窗口在跑（pid ${windowHandle.pid ?? '?'}）`)
    }
    return status()
  }

  function dispose() {
    if (disposed) return
    disposed = true
    try { abort.abort() } catch { /* ignore */ }
    try { bridge?.stop?.() } catch { /* ignore */ }
    try { windowHandle?.dispose?.() } catch { /* ignore */ }
    bridge = null
    windowHandle = null
  }

  function status() {
    return {
      enabled: shouldStartPet({ env }),
      disposed,
      bridge: bridge?.status?.() ?? null,
      window: windowHandle?.status?.() ?? null,
    }
  }

  return {
    start,
    dispose,
    status,
  }
}
