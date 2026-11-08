#!/usr/bin/env node
// scripts/build-bundle.mjs —— 合并 dsh-fish-qq 的浏览器半。
//
// 把 fish/lib/client.js 与 qq/client/client.js 各自拆成 __fishFactory /
// __qqFactory 两个普通函数，再套进一个 window.__ModuleLoader__.load({ id: 'dsh-fish-qq' })。
//
// 用法（在 DSH-MyFish 根目录）：
//   node scripts/build-bundle.mjs           重新生成 dsh-fish-qq/client.js
//   node scripts/build-bundle.mjs --check   只校验现有产物是否与源一致（CI/测试用）
//
// 约定：源文件里 factory 之外的内容（文件头注释等）不会进产物；
// factory 结束标记固定是结尾的 "  }," + "})" 两行。
//
// 设置字段：构建时读 qq/shared/settings-contract.js，把可序列化的字段描述
// （key/label/kind/group/options/hint/default）生成为 const __INJECTED_CONTRACT = [...]
// 注入到 __qqFactory 函数体最前面；浏览器半直接用它，不 import 任何东西。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_DIR = join(ROOT, 'dsh-fish-qq')
const OUT_FILE = join(PKG_DIR, 'client.js')
const CONTRACT_FILE = join(PKG_DIR, 'qq', 'shared', 'settings-contract.js')

const HEADER = "/**\n * dsh-fish-qq —— 浏览器半（一个 bundle 里同时装两边的设置页）\n *\n * 这个文件是**生成的**（见仓库根的 build-bundle.mjs）。别手改：\n * 改 fish/lib/client.js 或 qq/client/client.js，再重新构建。\n *\n * 为什么不是两个文件：DSH 一个包只有一个客户端入口，而且 bundle 的注册 id\n * 必须等于包名。所以这里把两边各自的 factory 拆成普通函数，\n * 再用**一个** load({ id: 'dsh-fish-qq' }) 装起来，由外层 apply 分发给两边的插件。\n */\nwindow.__ModuleLoader__.load({\n  id: 'dsh-fish-qq',\n  factory: (require) => {\n    // 告诉 QQ 半边「宿主给这个插件登记的 entry id」。\n    // 0.2.0 的插件配置页按 entry id 派发卡片，而 QQ 半边自己的 settings 命名空间还是\n    // qq-bridge；合并之后 entry id 变成 dsh-fish-qq，不说这一句它会按旧键注册\n    // → 设置页里一张卡片都不出现（2026-10-26 真机）。独立安装时这个全局不存在，\n    // QQ 半边回落成自己的命名空间，行为不变。\n    try { globalThis.__DSH_QQ_BRIDGE_HOST_ID__ = 'dsh-fish-qq' } catch { /* 非浏览器环境忽略 */ }\n\n    const fish = __fishFactory(require)\n    const qq = __qqFactory(require)\n\n    // 两边的 Cordis 插件形状合并：apply 依次调，inject 取并集。\n    // config 用 { fish: {...}, qq: {...} } 分槽，避免两个插件的键互相覆盖\n    // （比如 fish 的 root 和 qq 的 targetSessionId 都想要“顶层同名”这种位置）。\n    const inject = [...new Set([...(fish.inject ?? []), ...(qq.inject ?? [])])]\n\n    function apply(ctx, config) {\n      fish.apply?.(ctx, config?.fish)\n      qq.apply?.(ctx, config?.qq)\n    }\n\n    return { name: 'dsh-fish-qq', inject, apply }\n  },\n})\n\n// ─────────────────────────── 大肥鱼的设置页（原样搬运） ───────────────────────────\n"

const SEPARATOR_QQ = '// ─────────────────────────── QQ 桥接的设置页（原样搬运） ───────────────────────────\n'

/**
 * 取一个 client 源文件里 factory 的函数体。
 * 输入形如：
 *   window.__ModuleLoader__.load({
 *     id: '...',
 *     factory: (require) => {
 *       ...
 *     },
 *   })
 * 返回 factory 行之后、结尾 "  }," 之前的行（原样，去掉首尾换行）。
 */
export function factoryBody(src, file = '<client>') {
  const lines = src.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'factory: (require) => {')
  if (start === -1) throw new Error(`${file}: 找不到 factory: (require) => { 行`)
  const end = lines.length - 3
  if (lines[end].trim() !== '},' || lines[end + 1]?.trim() !== '})') {
    throw new Error(`${file}: 结尾不是预期的 "  }," + "})"`)
  }
  return lines.slice(start + 1, end).join('\n')
}

/**
 * 浏览器半需要的字段描述：只取可序列化的部分。
 * normalize / schema / secret 是宿主半的东西，不进 bundle。
 */
export async function contractFieldsForClient() {
  const { SETTINGS_CONTRACT } = await import(pathToFileURL(CONTRACT_FILE).href)
  if (!Array.isArray(SETTINGS_CONTRACT)) {
    throw new Error(`${CONTRACT_FILE}: 没有导出 SETTINGS_CONTRACT 数组`)
  }
  return SETTINGS_CONTRACT.map(({ key, label, kind, group, options, hint, default: defaultValue }) => ({
    key,
    label,
    kind,
    group,
    options,
    hint,
    default: defaultValue,
  }))
}

/** 生成注入到 __qqFactory 函数体最前面的常量声明。 */
function injectedContractLiteral(fields) {
  return `const __INJECTED_CONTRACT = ${JSON.stringify(fields, null, 2)}\n\n`
}

/** 生成 dsh-fish-qq/client.js 的完整文本（不写盘）。 */
export async function buildBundle() {
  const fish = factoryBody(readFileSync(join(PKG_DIR, 'fish/lib/client.js'), 'utf8'), 'fish/lib/client.js')
  const qq = factoryBody(readFileSync(join(PKG_DIR, 'qq/client/client.js'), 'utf8'), 'qq/client/client.js')
  const contract = await contractFieldsForClient()
  return (
    HEADER +
    'function __fishFactory(require) {\n\n' +
    fish +
    '\n}\n\n' +
    SEPARATOR_QQ +
    'function __qqFactory(require) {\n\n' +
    injectedContractLiteral(contract) +
    qq +
    '\n}\n'
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const next = await buildBundle()
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUT_FILE, 'utf8')
    if (current !== next) {
      console.error('dsh-fish-qq/client.js 与源不一致，请先运行 node scripts/build-bundle.mjs')
      process.exit(1)
    }
    console.log('dsh-fish-qq/client.js 已是最新')
  } else {
    writeFileSync(OUT_FILE, next, 'utf8')
    console.log(`wrote dsh-fish-qq/client.js (${next.length} chars)`)
  }
}
