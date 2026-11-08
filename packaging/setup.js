#!/usr/bin/env node
'use strict'

/**
 * setup.js —— 把解压目录里的 config.json 写到系统真正读取的位置。
 *
 * 为什么需要这一步：
 *   - 大肥鱼的配置在 `~/.dsh-fish/config.json`（或 $DSH_FISH_HOME/config.json）；
 *   - QQ 桥接的用户设置在自己的 `$DSH_HOME/qq-bridge-settings.json`；
 *   - 直接改解压目录里的 config.json 不会生效，所以用这个脚本一次性写完。
 *
 * 用法：
 *   node setup.js            写入配置（旧文件自动备份）
 *   node setup.js --dry-run  只打印将要写什么，不落盘
 *   node setup.js --help     看帮助
 *
 * 安全：
 *   - 不联网、不上传任何东西；
 *   - 只写上面两个文件，不改插件代码；
 *   - 重复执行安全：每次覆盖前备份成 `*.bak-时间戳`。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = __dirname
const ARGV = process.argv.slice(2)
const DRY_RUN = ARGV.includes('--dry-run')

/** QQ 桥接里允许由模板写入的字段（与插件设置页的键保持一致）。 */
// @doc ops.config-write
const QQ_KEYS = [
  'qqNumber',
  'ownerQQ',
  'nicknames',
  'whitelist',
  'admins',
  'groupWhitelist',
  'onebotUrl',
  'onebotPort',
  'accessTokenEnv',
  'selfId',
  'replyMode',
  'replyWithQuote',
  'atOnlyInGroup',
  'stripMarkdown',
  'proactiveEnabled',
  'proactiveProbability',
  'proactiveDailyLimit',
  'proactiveIdleHours',
  'proactiveScanIntervalMinutes',
  'subsendEnabled',
  'subsendDailyLimit',
  'subsendCooldownSeconds',
  'idleTriggerEnabled',
  'idleTriggerScanIntervalMinutes',
  'idleTriggerMinIdleHours',
  'idleTriggerDailyMax',
  'idleTriggerWeightSilent',
  'idleTriggerWeightMessage',
  'idleTriggerWeightBrowse',
  'idleTriggerWeightDiary',
  'checklogNotifyMode',
  'checklogNotifyOnSuccess',
  'checklogNotifyDailyLimit',
  'checklogNotifyTarget',
  'envSensorEnabled',
  'envWeatherCity',
  'envSensorTime',
  'envMemoryThreshold',
  'workspaceRoot',
  'targetSessionId',
  'napcatInstallDir',
  'napcatVersion',
  'downloadProxy',
]

function showHelp() {
  console.log(`用法：node setup.js [--dry-run]

把当前目录的 config.json 写进系统位置：
  fish 段 -> ${fishConfigFile()}
  qq   段 -> ${qqSettingsFile()}

选项：
  --dry-run   只打印，不写文件
  --help      显示这段帮助`)
}

function fishHome() {
  return path.resolve(process.env.DSH_FISH_HOME || path.join(os.homedir(), '.dsh-fish'))
}

function dshHome() {
  return path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
}

// @doc ops.config-write
function fishConfigFile() {
  return path.join(fishHome(), 'config.json')
}

// @doc ops.config-write
function qqSettingsFile() {
  return path.join(dshHome(), 'qq-bridge-settings.json')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function isPlaceholder(value) {
  return typeof value === 'string' && /^YOUR_[A-Z0-9_]+_HERE$/.test(value.trim())
}

function isEmpty(value) {
  return value === undefined || value === null || value === '' || isPlaceholder(value)
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '')
}

function isQQ(value) {
  return /^\d{5,12}$/.test(String(value || ''))
}

function maskQQ(value) {
  const s = digits(value)
  if (!isQQ(s)) return '（未配置）'
  if (s.length <= 6) return `${s.slice(0, 2)}****`
  return `${s.slice(0, 3)}****${s.slice(-2)}`
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function backup(file) {
  if (!fs.existsSync(file)) return null
  const target = `${file}.bak-${timestamp()}`
  fs.copyFileSync(file, target)
  return target
}

// @doc ops.config-write
function writeJson(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  try {
    fs.chmodSync(tmp, mode)
  } catch {
    // Windows 上 chmod 基本是空操作，忽略。
  }
  fs.renameSync(tmp, file)
}

function pickNonEmpty(source, keys) {
  const out = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

function stripStringPlaceholders(obj) {
  if (Array.isArray(obj)) return obj.filter((item) => !isPlaceholder(item))
  if (!obj || typeof obj !== 'object') return obj
  for (const key of Object.keys(obj)) {
    if (isPlaceholder(obj[key])) {
      delete obj[key]
    } else if (obj[key] && typeof obj[key] === 'object') {
      obj[key] = stripStringPlaceholders(obj[key])
    }
  }
  return obj
}

function normalizeQqList(value) {
  const list = Array.isArray(value) ? value : []
  return [...new Set(list.map(digits).filter(isQQ))]
}

// @doc ops.config-write
function main() {
  if (ARGV.includes('--help') || ARGV.includes('-h')) {
    showHelp()
    return
  }

  const configPath = path.join(ROOT, 'config.json')
  if (!fs.existsSync(configPath)) {
    console.error('')
    console.error('✖ 没找到 config.json。')
    console.error('  先把 config.example.json 复制一份，重命名为 config.json，再运行本脚本。')
    console.error(`  当前目录：${ROOT}`)
    console.error('')
    process.exitCode = 1
    return
  }

  let template
  try {
    template = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    console.error(`✖ config.json 不是合法 JSON：${error.message}`)
    console.error('  常见原因：中文引号、末尾多了逗号、漏了引号。')
    process.exitCode = 1
    return
  }

  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    console.error('✖ config.json 的最外层必须是一个对象（{ ... }）。')
    process.exitCode = 1
    return
  }

  /* ── fish 段 ─────────────────────────────────────────────────────────── */
  const fish = JSON.parse(JSON.stringify(template))
  delete fish._说明
  delete fish.qq

  fish.work = Object.assign({}, fish.work || {})
  fish.work.enabled = fish.work.enabled !== false
  fish.work.dir = ROOT

  // 运行态字段不要从模板继承
  if (fish.notify && typeof fish.notify === 'object') fish.notify.lastShown = ''
  if (fish.comment && typeof fish.comment === 'object') fish.comment.lastScanAt = ''
  if (fish.ui && typeof fish.ui === 'object') fish.ui.ownerHintDismissed = false

  stripStringPlaceholders(fish)

  /* ── qq 段 ───────────────────────────────────────────────────────────── */
  const qqRaw = template.qq && typeof template.qq === 'object' && !Array.isArray(template.qq)
    ? template.qq
    : {}
  const qq = pickNonEmpty(qqRaw, QQ_KEYS)

  const ownerQQ = digits(qq.ownerQQ)
  const botQQ = digits(qq.qqNumber)
  qq.ownerQQ = isQQ(ownerQQ) ? ownerQQ : ''
  qq.qqNumber = isQQ(botQQ) ? botQQ : ''
  if (!qq.ownerQQ) delete qq.ownerQQ
  if (!qq.qqNumber) delete qq.qqNumber

  let whitelist = normalizeQqList(qq.whitelist)
  if (qq.ownerQQ && !whitelist.includes(qq.ownerQQ)) whitelist.unshift(qq.ownerQQ)
  qq.whitelist = whitelist
  qq.admins = normalizeQqList(qq.admins).filter((id) => id !== qq.ownerQQ)
  qq.groupWhitelist = normalizeQqList(qq.groupWhitelist)

  qq.workspaceRoot = ROOT

  if (qq.envWeatherCity && isPlaceholder(qq.envWeatherCity)) qq.envWeatherCity = '北京'
  if (isEmpty(qq.pipelineWorkerApi)) delete qq.pipelineWorkerApi
  if (isEmpty(qq.pipelineWorkerKey)) delete qq.pipelineWorkerKey
  if (isEmpty(qq.targetSessionId)) delete qq.targetSessionId
  if (isEmpty(qq.napcatInstallDir)) delete qq.napcatInstallDir
  if (isEmpty(qq.accessTokenEnv)) qq.accessTokenEnv = ''

  // 空的 onebotUrl 保留空串，表示「不启用传输」；不要写成占位符。
  if (qq.onebotUrl && isPlaceholder(qq.onebotUrl)) delete qq.onebotUrl

  /* ── 预览 / 写入 ─────────────────────────────────────────────────────── */
  const fishTarget = fishConfigFile()
  const qqTarget = qqSettingsFile()

  console.log('')
  console.log('DSH-MyFish 配置写入')
  console.log('────────────────────')
  console.log(`工作区根目录：${ROOT}`)
  console.log(`主人 QQ：${maskQQ(qq.ownerQQ)}`)
  console.log(`机器人 QQ：${maskQQ(qq.qqNumber)}`)
  console.log(`白名单：${qq.whitelist.length > 0 ? qq.whitelist.map(maskQQ).join('、') : '（空，QQ 不会唤醒）'}`)
  console.log(`fish 配置 → ${fishTarget}`)
  console.log(`QQ 配置   → ${qqTarget}`)
  console.log('')

  if (!qq.ownerQQ) {
    console.log('⚠ 没有填 qq.ownerQQ（或不是 5–12 位数字）：QQ 桥接仍能启动，但不会认主。')
    console.log('  只接小屋、不接 QQ 的话可以忽略；要接 QQ 就回到 config.json 补上再跑一次。')
    console.log('')
  }

  if (DRY_RUN) {
    console.log('[dry-run] fish 配置预览：')
    console.log(JSON.stringify(fish, null, 2))
    console.log('[dry-run] qq 配置预览：')
    console.log(JSON.stringify(qq, null, 2))
    console.log('[dry-run] 没有写任何文件。去掉 --dry-run 再执行即可写入。')
    return
  }

  const fishBackup = backup(fishTarget)
  writeJson(fishTarget, fish, 0o600)

  const existingDoc = readJson(qqTarget, null)
  const existingValues = existingDoc && existingDoc.values && typeof existingDoc.values === 'object'
    ? existingDoc.values
    : {}

  // 没填主人时只补 workspaceRoot，避免把已有设置清空。
  const qqWrite = qq.ownerQQ ? { ...existingValues, ...qq } : { ...existingValues, workspaceRoot: ROOT }

  const qqBackup = backup(qqTarget)
  writeJson(qqTarget, { version: 1, values: qqWrite }, 0o600)

  console.log('✔ 配置已写入')
  if (fishBackup) console.log(`  fish 旧文件已备份：${fishBackup}`)
  if (qqBackup) console.log(`  QQ   旧文件已备份：${qqBackup}`)
  console.log('')
  console.log('下一步：')
  console.log('  1. 打开 DSH → 插件中心 → 从本地导入插件 → 选择 dsh-fish-qq 文件夹')
  console.log('  2. 完全退出 DSH 再打开')
  console.log('  3. 新开一个终端：node cyber_house/api-router.js')
  console.log('')
}

try {
  main()
} catch (error) {
  console.error(`✖ 写入失败：${error?.message || error}`)
  process.exitCode = 1
}
