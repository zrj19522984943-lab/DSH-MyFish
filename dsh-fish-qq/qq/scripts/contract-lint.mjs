#!/usr/bin/env node
// qq/scripts/contract-lint.mjs —— 设置 contract 的防回退检查（L1–L6）。
//
// 用法（在 dsh-fish-qq/qq 下）：
//   node scripts/contract-lint.mjs
//   npm run lint
//
// 退出码：有 fail → 1；否则 0。
//
// L1 契约结构：模块可加载、导出数组、规模 = 55 项。
// L2 必填字段：key/label/kind/group/hint/default/normalize/schema，以及枚举、
//    options / min / max / secret / check / compositionOnly / idleWeight 的形状。
// L3 唯一性：key 不重复；idleWeight 不重复。
// L4 patch 一致性：cordis.patch.yml 的 qq 槽与 contract 双向对齐
//    （contract 的键必须在 patch 里；patch 多出来的只能是已知装配键）。
// L5 生成物一致：dsh-fish-qq/client.js 里注入的 __INJECTED_CONTRACT
//    必须与 contract 的 key 顺序完全一致，且不含 normalize/schema 等宿主字段。
// L6 接线检查：client 源码只吃注入、不手写字段；build-bundle 注入 model-pool/protocol；
//    index.js 由 contract 生成 schema / readSettings。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const QQ_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_DIR = resolve(QQ_DIR, '..')
const REPO_DIR = resolve(PKG_DIR, '..')

const CONTRACT_FILE = join(QQ_DIR, 'shared', 'settings-contract.js')
const PATCH_FILE = join(PKG_DIR, 'cordis.patch.yml')
const BUNDLE_FILE = join(PKG_DIR, 'client.js')
const CLIENT_FILE = join(QQ_DIR, 'client', 'client.js')
const INDEX_FILE = join(QQ_DIR, 'index.js')
const BUILD_FILE = join(REPO_DIR, 'scripts', 'build-bundle.mjs')

const EXPECTED_COUNT = 55
const KINDS = new Set(['text', 'number', 'boolean', 'list', 'select', 'session', 'modelpool'])
const GROUPS = new Set(['core', 'wake', 'outbound', 'idle', 'infra', 'modelpool', 'pipeline', 'env'])
const SCHEMA_TYPES = new Set(['string', 'number', 'boolean', 'array'])
const ARRAY_ITEMS = new Set(['string', 'modelpool'])
const CHECK_RULES = new Set(['qq-number', 'credential-ref', 'cron-or-time'])
const IDLE_WEIGHTS = new Set(['silent', 'message', 'browse', 'diary'])
const COMPOSITION_ONLY = new Set(['targetSessionId', 'workspaceRoot', 'agentPreset'])
// patch 的 qq 槽里允许出现、但**不属于** contract 的装配键。
const PATCH_ONLY_KEYS = new Set([
  'targetSessionFromFish',
  'statePath',
  'debugTools',
  'debugToolsInWorkspace',
  'heartbeatTimeoutMs',
  'napcatAsset',
])

let failed = 0
function check(level, ok, message, detail = '') {
  if (ok) {
    console.log(`PASS  ${level}：${message}`)
  } else {
    failed += 1
    console.log(`FAIL  ${level}：${message}${detail ? `  ${detail}` : ''}`)
  }
}

// ── L1 契约结构 ───────────────────────────────────────────────────────────────
let contract = []
try {
  const mod = await import(new URL(`../shared/settings-contract.js?t=${Date.now()}`, import.meta.url))
  contract = mod.SETTINGS_CONTRACT
  check('L1', Array.isArray(contract), 'SETTINGS_CONTRACT 是数组')
} catch (error) {
  check('L1', false, 'SETTINGS_CONTRACT 可加载', String(error?.message ?? error))
}
check('L1', contract.length === EXPECTED_COUNT, `契约规模 = ${EXPECTED_COUNT}`, `实际 ${contract.length}`)

const keys = contract.map((f) => f.key)

// ── L2 必填字段与形状 ─────────────────────────────────────────────────────────
const REQUIRED = ['key', 'label', 'kind', 'group', 'hint', 'default', 'normalize', 'schema']
const badRequired = contract
  .filter((f) => REQUIRED.some((k) => f?.[k] === undefined || f?.[k] === null))
  .map((f) => f?.key ?? '<无 key>')
check('L2', badRequired.length === 0, '每项都有必填字段', badRequired.join(', '))

const badKey = contract.filter((f) => typeof f.key !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(f.key)).map((f) => f.key)
check('L2', badKey.length === 0, 'key 是合法标识符', badKey.join(', '))

const badString = contract
  .filter((f) => typeof f.label !== 'string' || typeof f.hint !== 'string' || f.label.trim() === '' || f.hint.trim() === '')
  .map((f) => f.key)
check('L2', badString.length === 0, 'label / hint 非空', badString.join(', '))

const badKind = contract.filter((f) => !KINDS.has(f.kind)).map((f) => `${f.key}:${f.kind}`)
check('L2', badKind.length === 0, 'kind 在枚举内', badKind.join(', '))

const badGroup = contract.filter((f) => !GROUPS.has(f.group)).map((f) => `${f.key}:${f.group}`)
check('L2', badGroup.length === 0, 'group 在 8 组内', badGroup.join(', '))

const badNormalize = contract.filter((f) => typeof f.normalize !== 'function').map((f) => f.key)
check('L2', badNormalize.length === 0, 'normalize 是函数', badNormalize.join(', '))

const badSchema = contract
  .filter((f) => {
    const s = f.schema
    if (!s || typeof s !== 'object' || !SCHEMA_TYPES.has(s.type)) return true
    if (s.type === 'array' && !ARRAY_ITEMS.has(s.items)) return true
    if (s.role !== undefined && typeof s.role !== 'string') return true
    return false
  })
  .map((f) => f.key)
check('L2', badSchema.length === 0, 'schema 类型合法', badSchema.join(', '))

const badOptions = contract
  .filter((f) => {
    if (f.kind !== 'select') return false
    if (!Array.isArray(f.options) || f.options.length === 0) return true
    const seen = new Set()
    for (const opt of f.options) {
      if (!Array.isArray(opt) || opt.length !== 2 || typeof opt[0] !== 'string' || typeof opt[1] !== 'string') return true
      if (seen.has(opt[0])) return true
      seen.add(opt[0])
    }
    return false
  })
  .map((f) => f.key)
check('L2', badOptions.length === 0, 'select 的 options 是唯一 [value,label] 对', badOptions.join(', '))

const badBounds = contract
  .filter((f) => {
    if (f.min !== undefined && (typeof f.min !== 'number' || !Number.isFinite(f.min))) return true
    if (f.max !== undefined && (typeof f.max !== 'number' || !Number.isFinite(f.max))) return true
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) return true
    return false
  })
  .map((f) => f.key)
check('L2', badBounds.length === 0, 'min / max 是有限数且 min ≤ max', badBounds.join(', '))

const badSecret = contract.filter((f) => f.secret !== undefined && typeof f.secret !== 'boolean').map((f) => f.key)
check('L2', badSecret.length === 0, 'secret 是布尔', badSecret.join(', '))

const badCheck = contract
  .filter((f) => {
    if (f.check === undefined) return false
    return (
      !f.check ||
      typeof f.check !== 'object' ||
      !CHECK_RULES.has(f.check.rule) ||
      typeof f.check.message !== 'string' ||
      f.check.message.trim() === ''
    )
  })
  .map((f) => f.key)
check('L2', badCheck.length === 0, 'check 是合法声明（rule + message）', badCheck.join(', '))

const badComp = contract.filter((f) => f.compositionOnly !== undefined && typeof f.compositionOnly !== 'boolean').map((f) => f.key)
check('L2', badComp.length === 0, 'compositionOnly 是布尔', badComp.join(', '))

const compKeys = contract.filter((f) => f.compositionOnly === true).map((f) => f.key)
const unexpectedComp = compKeys.filter((k) => !COMPOSITION_ONLY.has(k))
check('L2', unexpectedComp.length === 0, 'compositionOnly 只用在已知 3 个接线键', unexpectedComp.join(', '))

const badIdle = contract.filter((f) => f.idleWeight !== undefined && !IDLE_WEIGHTS.has(f.idleWeight)).map((f) => f.key)
check('L2', badIdle.length === 0, 'idleWeight 在 4 个枚举内', badIdle.join(', '))

// ── L3 唯一性 ─────────────────────────────────────────────────────────────────
const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i)
check('L3', dupKeys.length === 0, 'key 不重复', [...new Set(dupKeys)].join(', '))

const idleWeights = contract.filter((f) => f.idleWeight !== undefined).map((f) => f.idleWeight)
const dupIdle = idleWeights.filter((w, i) => idleWeights.indexOf(w) !== i)
check('L3', dupIdle.length === 0, 'idleWeight 不重复', [...new Set(dupIdle)].join(', '))
check('L3', idleWeights.length === IDLE_WEIGHTS.size, `idleWeight 恰好 ${IDLE_WEIGHTS.size} 项`, `实际 ${idleWeights.length}`)

// ── L4 cordis.patch.yml 的 qq 槽 ─────────────────────────────────────────────
/** 极简 YAML 取键：只认 qq: 槽下 10 空格缩进的顶层键。 */
function parseQqPatch(text) {
  const out = []
  let inQq = false
  for (const line of text.split('\n')) {
    if (/^ {8}qq:\s*$/.test(line)) {
      inQq = true
      continue
    }
    if (!inQq) continue
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const indent = line.match(/^\s*/)[0].length
    if (indent < 10) break
    if (indent !== 10) continue
    const m = line.match(/^ {10}([A-Za-z_][A-Za-z0-9_]*):/)
    if (m) out.push(m[1])
  }
  return out
}

let patchKeys = []
try {
  patchKeys = parseQqPatch(readFileSync(PATCH_FILE, 'utf8'))
  check('L4', patchKeys.length > 0, 'cordis.patch.yml 找到 qq 槽')
} catch (error) {
  check('L4', false, 'cordis.patch.yml 可读', String(error?.message ?? error))
}

const dupPatch = patchKeys.filter((k, i) => patchKeys.indexOf(k) !== i)
check('L4', dupPatch.length === 0, 'patch 的 qq 槽没有重复键', [...new Set(dupPatch)].join(', '))

const missingInPatch = keys.filter((k) => !patchKeys.includes(k))
check('L4', missingInPatch.length === 0, 'contract 的每个键都在 patch 的 qq 槽里', missingInPatch.join(', '))

const unknownPatch = patchKeys.filter((k) => !keys.includes(k) && !PATCH_ONLY_KEYS.has(k))
check('L4', unknownPatch.length === 0, 'patch 多出来的键只能是已知装配键', unknownPatch.join(', '))

// ── L5 生成物里的 __INJECTED_CONTRACT ─────────────────────────────────────────
let injected = null
try {
  const bundle = readFileSync(BUNDLE_FILE, 'utf8')
  const m = bundle.match(/const __INJECTED_CONTRACT = (\[[\s\S]*?\n\])/)
  check('L5', Boolean(m), 'client.js 里有 __INJECTED_CONTRACT')
  if (m) injected = JSON.parse(m[1])
} catch (error) {
  check('L5', false, 'client.js 可读且注入块可解析', String(error?.message ?? error))
}

if (Array.isArray(injected)) {
  const injectedKeys = injected.map((f) => f.key)
  check(
    'L5',
    JSON.stringify(injectedKeys) === JSON.stringify(keys),
    '注入的 key 顺序与 contract 完全一致',
    `bundle ${injectedKeys.length} / contract ${keys.length}`,
  )
  const hostOnly = ['normalize', 'schema', 'compositionOnly', 'idleWeight']
  const leaked = injected.filter((f) => hostOnly.some((k) => Object.prototype.hasOwnProperty.call(f, k))).map((f) => f.key)
  check('L5', leaked.length === 0, '注入里不含 normalize / schema / compositionOnly / idleWeight', leaked.join(', '))
  const missingProps = injected.filter((f) => ['key', 'label', 'kind', 'group', 'hint'].some((k) => !f[k])).map((f) => f.key)
  check('L5', missingProps.length === 0, '注入的每项有展示字段', missingProps.join(', '))
} else {
  check('L5', false, '注入的 __INJECTED_CONTRACT 可解析')
}

// ── L6 接线检查 ───────────────────────────────────────────────────────────────
let clientSrc = ''
let indexSrc = ''
let buildSrc = ''
try {
  clientSrc = readFileSync(CLIENT_FILE, 'utf8')
  indexSrc = readFileSync(INDEX_FILE, 'utf8')
  buildSrc = readFileSync(BUILD_FILE, 'utf8')
  check('L6', true, 'client / index / build-bundle 可读')
} catch (error) {
  check('L6', false, 'client / index / build-bundle 可读', String(error?.message ?? error))
}

check('L6', clientSrc.includes('__INJECTED_CONTRACT'), 'client 源码使用注入的 __INJECTED_CONTRACT')
check('L6', !clientSrc.includes('function normalizeModelPool('), 'client 源码不再自带 normalizeModelPool')
check(
  'L6',
  buildSrc.includes('sharedModuleForClient(MODEL_POOL_FILE)') && buildSrc.includes('sharedModuleForClient(PROTOCOL_FILE)'),
  'build-bundle 注入 model-pool 与 protocol',
)
check('L6', indexSrc.includes("from './shared/settings-contract.js'"), 'index.js 从 shared 导入 contract')
check('L6', indexSrc.includes('buildSchemaFromContract'), 'index.js 用 contract 生成 Schema')
check('L6', indexSrc.includes('for (const f of SETTINGS_CONTRACT)'), 'index.js 用 contract 循环生成 readSettings')

console.log(failed === 0 ? '\n结果：PASS（fail 0）' : `\n结果：FAIL（fail ${failed}）`)
process.exit(failed === 0 ? 0 : 1)
