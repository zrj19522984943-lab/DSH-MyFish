#!/usr/bin/env node
'use strict'

/**
 * pack-release.js —— 把 DSH-MyFish 打成可分发的「纯净版」zip。
 *
 * 用法（在 DSH-MyFish 目录下）：
 *   node pack-release.js                 生成 ../DSH-MyFish-Release.zip
 *   node pack-release.js --out D:\x.zip  指定输出路径
 *   node pack-release.js --keep-stage    保留 .release-stage（排查用）
 *   node pack-release.js --no-verify     跳过敏感信息扫描（不建议）
 *   node pack-release.js --help
 *
 * 依赖：
 *   archiver（仅打包用，不会进发布包）。仓库外层 node_modules 里已有；
 *   没有的话执行 `npm install archiver`（或在 packaging/ 里 npm install）。
 *
 * 它做四件事：
 *   1. 按黑名单复制文件树（记忆 / 日记 / 日志 / 数据库 / 备份 / 测试 / 本机脚本全部剔除）；
 *   2. 生成 config.example.json（从本机真实配置脱敏）、README-RELEASE.md、setup.js、
 *      根 package.json、sensors/README.md；
 *   3. 对全部文本做脱敏：API Key、QQ 号、B 站 Cookie、本机绝对路径；
 *   4. 扫描暂存目录，确认一个真实敏感值都不剩，再打 zip。
 *
 * 输出 zip 的根目录就是发布目录（cyber_house/、dsh-fish-qq/、README-RELEASE.md …），
 * Windows 的「全部解压」会自动得到名为 DSH-MyFish-Release 的文件夹。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PROJECT_ROOT = __dirname
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..')
const STAGE_DIR = path.join(PROJECT_ROOT, '.release-stage')
const DEFAULT_OUT = path.join(WORKSPACE_ROOT, 'DSH-MyFish-Release.zip')

const ARGV = process.argv.slice(2)
const OPTIONS = {
  out: readArg('--out') || DEFAULT_OUT,
  keepStage: ARGV.includes('--keep-stage'),
  verify: !ARGV.includes('--no-verify'),
  help: ARGV.includes('--help') || ARGV.includes('-h'),
}

const HOME = os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const FISH_HOME = process.env.DSH_FISH_HOME || path.join(HOME, '.dsh-fish')

/** 目录名黑名单：任何层级命中都跳过。 */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.release-stage',
  'packaging',
  'backups',
  'checklogs',
  '.headless',
  'logs',
  'rss',
  'scripts',
  'tools',
  'sensors',
  'dist',
  'history',
  'memory',
  'diary',
  'test',
  '.cache',
  // 物理感知运行时队列（手机插拔 / 网络抖动事件），不属于发布内容。
  'physical_events',
])

/** 文件名黑名单：私密数据、运行日志、数据库、本地缓存、测试。 */
const EXCLUDE_FILE_PATTERNS = [
  /^\./i, // .env / .gitignore / .dsh-web-url.json …
  /\.(log|sqlite|sqlite-wal|sqlite-shm|db|db-wal|db-shm)$/i,
  /^interaction-outbox\.jsonl$/i,
  /^events\.jsonl$/i,
  /^current_space\.json$/i,
  /^phone_battery\.json$/i,
  /^features\.json$/i,
  /^owner\.json$/i,
  /^config\.json$/i,
  /^pack-release\.js$/i,
  /^CHANGELOG\.md$/i,
  /^打开指令\.txt$/i,
  /^test-.*\.mjs$/i,
  /\.test\.mjs$/i,
  /\.(bak|orig|tmp|swp)$/i,
]

/** 需要逐行扫描的文本扩展名（二进制直接复制）。 */
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.markdown', '.html', '.htm',
  '.css', '.yml', '.yaml', '.txt', '.py', '.svg', '.geojson', '.sql',
  '.prj', '.cpg', '.qmd', '.bat', '.sh', '.ts',
])

/* ===========================================================================
 * 小工具
 * ======================================================================== */

function readArg(name) {
  const index = ARGV.indexOf(name)
  if (index < 0) return ''
  return ARGV[index + 1] || ''
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function walk(dir, callback, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    callback(full, relPath, entry)
    if (entry.isDirectory()) walk(full, callback, relPath)
  }
}

function countFiles(dir) {
  let count = 0
  walk(dir, (full, rel, entry) => {
    if (!entry.isDirectory()) count += 1
  })
  return count
}

/* ===========================================================================
 * 敏感值收集与脱敏
 * ======================================================================== */

function pathVariants(value) {
  const set = new Set([value, value.replace(/\\/g, '/'), value.replace(/\//g, '\\')])
  return [...set].filter(Boolean)
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function collectQqNumbers(source) {
  const found = new Set()
  const QQ_KEY = /(qq|owner|whitelist|admin|group|selfid)/i
  const visit = (value, key) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key)
      return
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(v, k)
      return
    }
    if (!QQ_KEY.test(key)) return
    const digits = String(value ?? '').replace(/\D/g, '')
    if (/^\d{5,12}$/.test(digits)) found.add(digits)
  }
  visit(source, '')
  return [...found]
}

function buildSensitiveContext() {
  const qqDoc = readJson(path.join(DSH_HOME, 'qq-bridge-settings.json'), null)
  const qqValues = qqDoc && qqDoc.values && typeof qqDoc.values === 'object' ? qqDoc.values : {}
  const owner = readJson(path.join(FISH_HOME, 'owner.json'), null)
  const liveFish = readJson(path.join(FISH_HOME, 'config.json'), null)

  /** @type {Array<{from:string,to:string}>} */
  const exact = []
  const seen = new Set()
  const addExact = (from, to) => {
    if (!from || typeof from !== 'string') return
    const value = from.trim()
    if (value.length < 4 || seen.has(value)) return
    seen.add(value)
    exact.push({ from: value, to })
  }

  // 路径：长路径先换，避免外层路径替换后留下半截子目录名。
  for (const variant of pathVariants(PROJECT_ROOT)) addExact(variant, '<RELEASE_ROOT>')
  for (const variant of pathVariants(WORKSPACE_ROOT)) addExact(variant, '<WORKSPACE>')
  for (const variant of pathVariants(HOME)) addExact(variant, '<HOME>')
  for (const variant of pathVariants('D:\\demo')) addExact(variant, '<WORKSPACE>')

  const userName = path.basename(HOME)
  if (userName && userName.length >= 2) addExact(userName, '<USER>')

  // QQ 号（主人 / 小号 / 白名单 / 群 / 管理员）
  for (const number of collectQqNumbers(qqValues)) addExact(number, 'YOUR_QQ_NUMBER_HERE')

  // API Key / B 站凭据
  addExact(qqValues.pipelineWorkerKey, 'YOUR_API_KEY_HERE')
  if (owner && typeof owner === 'object') {
    addExact(owner.mid, 'YOUR_BILI_MID_HERE')
    addExact(owner.nickname, '<BILI_NICKNAME>')
    const cookie = String(owner.cookie || '')
    if (cookie) addExact(cookie, 'YOUR_BILI_COOKIE_HERE')
    const sess = cookie.match(/SESSDATA=([^;]+)/)
    if (sess) addExact(sess[1], 'YOUR_BILI_SESSION_HERE')
    const csrf = cookie.match(/bili_jct=([^;]+)/)
    if (csrf) addExact(csrf[1], 'YOUR_BILI_CSRF_HERE')
  }

  // 环境变量里的真 Key（如果本机有）
  for (const name of ['DEEPSEEK_API_KEY', 'INTERN_API_KEY', 'SUB001_API_KEY']) {
    const value = process.env[name]
    if (value && value.length >= 8) addExact(value, 'YOUR_API_KEY_HERE')
  }

  // 配置里出现的 sk-... 也一并收集
  for (const source of [liveFish, qqValues]) {
    const text = JSON.stringify(source || {})
    for (const match of text.match(/sk-[A-Za-z0-9]{20,}/g) || []) addExact(match, 'YOUR_API_KEY_HERE')
  }

  // 长的先替换：路径 > 单个字段。
  exact.sort((a, b) => b.from.length - a.from.length)

  return {
    qqValues,
    owner,
    liveFish,
    exact,
    secretsForScan: exact
      .map((item) => item.from)
      .filter((value) => value.length >= 5),
  }
}

function sanitizeText(text, ctx) {
  let out = text
  for (const { from, to } of ctx.exact) {
    if (!from || !out.includes(from)) continue
    out = out.split(from).join(to)
  }

  // 兜底：其它机器路径 / 其它人留下的凭据。
  out = out.replace(/\bsk-[A-Za-z0-9]{24,}\b/g, 'YOUR_API_KEY_HERE')
  out = out.replace(/SESSDATA=[^;\s"'`]+/g, 'SESSDATA=YOUR_BILI_SESSION_HERE')
  out = out.replace(/bili_jct=[0-9a-f]{16,}/gi, 'bili_jct=YOUR_BILI_CSRF_HERE')
  out = out.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`<>]+/g, '<HOME>')
  out = out.replace(/[A-Za-z]:[\\/](?:WorkArea|WorkShop|Projects?|Work)[\\/][^\s"'`<>]*/g, '<WORKSPACE>')

  return out
}

/* ===========================================================================
 * 配置模板
 * ======================================================================== */

const DEFAULT_FISH_CONFIG = {
  growthDays: 30,
  wakesPerDay: 1,
  window: ['20:00', '23:00'],
  daily: { events: 5, questions: 3 },
  diary: { enabled: true, visible: false, keepDays: 0 },
  absenceAfterDays: 1,
  tools: { preset: '', restrict: true, allow: [] },
  avoid: { keywords: [], upMids: [], minDuration: 60 },
  browse: {
    enabled: true,
    perDay: 1,
    topN: 3,
    deepRead: 2,
    danmaku: 0,
    keywords: [],
    window: ['18:00', '23:00'],
    voices: true,
  },
  video: { enabled: true, perDay: 2, frames: 9 },
  notify: { enabled: false, lastShown: '' },
  comment: {
    enabled: true,
    perDay: 1,
    replyPerDay: 2,
    replyToReplies: true,
    scanEveryMin: 30,
    window: ['20:00', '23:00'],
    atOwner: true,
    lastScanAt: '',
  },
  chat: {
    rotateAfter: 39,
    handoff: { enabled: true, turns: 30, maxChars: 300, provider: '', model: '' },
    replyChars: 0,
  },
  memory: { docBudget: 1800, sleepEveryDays: 7, sleepKeep: 12, beliefsShown: 3 },
  rules: { offers: true, holdDays: 3, cooldownDays: 3 },
  work: { enabled: true, dir: 'YOUR_WORKSPACE_PATH_HERE', perDay: 10 },
  observe: { enabled: true, port: 0 },
  ui: { ownerHintDismissed: false },
  rssFeeds: [],
  newsPipeline: {
    maxItemsPerFeed: 15,
    feedTimeoutMs: 30000,
    modelTimeoutMs: 90000,
    interFeedDelayMs: 2000,
    interItemDelayMs: 1500,
    archiveMaxDays: 0,
    model: {
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  },
}

const QQ_TEMPLATE = {
  qqNumber: 'YOUR_BOT_QQ_NUMBER_HERE',
  ownerQQ: 'YOUR_QQ_NUMBER_HERE',
  nicknames: ['小鱼', '鱼小鱼'],
  whitelist: ['YOUR_QQ_NUMBER_HERE'],
  admins: [],
  groupWhitelist: [],
  workspaceRoot: 'YOUR_WORKSPACE_PATH_HERE',
  onebotUrl: 'ws://127.0.0.1:3001',
  onebotPort: 3001,
  accessTokenEnv: '',
  selfId: '',
  replyMode: 'marker',
  proactiveEnabled: false,
  proactiveIdleHours: 4,
  proactiveProbability: 0.15,
  proactiveDailyLimit: 3,
  proactiveScanIntervalMinutes: 30,
  subsendEnabled: true,
  subsendDailyLimit: 20,
  subsendCooldownSeconds: 20,
  idleTriggerEnabled: true,
  idleTriggerScanIntervalMinutes: 15,
  idleTriggerMinIdleHours: 1,
  idleTriggerDailyMax: 3,
  idleTriggerWeightSilent: 80,
  idleTriggerWeightMessage: 10,
  idleTriggerWeightBrowse: 5,
  idleTriggerWeightDiary: 5,
  checklogNotifyMode: 'off',
  checklogNotifyOnSuccess: false,
  checklogNotifyDailyLimit: 5,
  checklogNotifyTarget: 'owner',
  envSensorEnabled: false,
  envWeatherCity: '北京',
  envSensorTime: '0 9 * * *',
  envMemoryThreshold: 50,
  rssFeeds: '',
  pipelineWorkerApi: '',
  pipelineWorkerKey: 'YOUR_API_KEY_HERE',
}

function scrubConfigValues(value, key, ctx) {
  if (Array.isArray(value)) return value.map((item) => scrubConfigValues(item, key, ctx))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = scrubConfigValues(childValue, childKey, ctx)
    }
    return out
  }
  if (typeof value !== 'string') return value

  // 环境变量名不是密钥本身，保留；keywords 是关键词列表，别当成 key。
  if (/Env$/i.test(key) || /keywords$/i.test(key)) return value
  if (/key|token|secret|password|cookie/i.test(key) && value && !/^https?:|^wss?:/i.test(value)) {
    return 'YOUR_API_KEY_HERE'
  }
  return sanitizeText(value, ctx)
}

function buildConfigExample(ctx) {
  const live = ctx.liveFish && typeof ctx.liveFish === 'object' && !Array.isArray(ctx.liveFish)
    ? liveFishClone()
    : deepClone(DEFAULT_FISH_CONFIG)

  delete live._说明
  delete live.qq

  live.work = Object.assign({}, live.work || {})
  live.work.enabled = live.work.enabled !== false
  live.work.dir = 'YOUR_WORKSPACE_PATH_HERE'

  if (live.notify && typeof live.notify === 'object') live.notify.lastShown = ''
  if (live.comment && typeof live.comment === 'object') live.comment.lastScanAt = ''
  if (live.ui && typeof live.ui === 'object') live.ui.ownerHintDismissed = false

  live.rssFeeds = []
  live.newsPipeline = Object.assign({}, live.newsPipeline || {}, {
    model: {
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  })

  const scrubbedFish = scrubConfigValues(live, '', ctx)
  const qq = scrubConfigValues(deepClone(QQ_TEMPLATE), '', ctx)

  const doc = {
    _说明:
      '这是配置模板：复制成 config.json → 填好 qq.ownerQQ / qq.whitelist → 运行 node setup.js。' +
      '除 qq 以外的字段会写入 ~/.dsh-fish/config.json，qq 段会写入 ~/.dsh/qq-bridge-settings.json。' +
      '不要把这个文件直接放进插件目录，也不要把填好的 config.json 分享给别人。',
    ...scrubbedFish,
    qq,
  }
  return doc
}

function liveFishClone() {
  return deepClone(readJson(path.join(FISH_HOME, 'config.json'), {}))
}

/* ===========================================================================
 * 复制文件树
 * ======================================================================== */

function isExcluded(relPath, entry) {
  const name = entry.name
  if (entry.isDirectory()) {
    return EXCLUDE_DIRS.has(name.toLowerCase())
  }
  if (relPath === 'README.md') return true // 发布包用 README-RELEASE.md，不混入开发 README
  return EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

function isTextFile(name) {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())
}

const stats = {
  copied: 0,
  skipped: 0,
  bytes: 0,
}

function copyTree(sourceDir, targetDir, ctx, relBase = '') {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name
    if (isExcluded(relPath, entry)) {
      stats.skipped += 1
      if (entry.isDirectory()) {
        // 被整目录排除时只记一条，不用把每个文件都算进去。
        continue
      }
      continue
    }

    const from = path.join(sourceDir, entry.name)
    const to = path.join(targetDir, entry.name)

    if (entry.isDirectory()) {
      ensureDir(to)
      copyTree(from, to, ctx, relPath)
      continue
    }

    if (entry.isSymbolicLink()) {
      stats.skipped += 1
      continue
    }

    ensureDir(path.dirname(to))
    if (isTextFile(entry.name)) {
      const text = fs.readFileSync(from, 'utf8')
      fs.writeFileSync(to, sanitizeText(text, ctx), 'utf8')
    } else {
      fs.copyFileSync(from, to)
    }
    stats.copied += 1
    stats.bytes += fs.statSync(to).size
  }
}

/* ===========================================================================
 * 生成发布专用文件
 * ======================================================================== */

function writeStaged(relPath, content) {
  const file = path.join(STAGE_DIR, relPath)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, content, 'utf8')
}

function buildRootPackage() {
  const pluginPkg = readJson(path.join(PROJECT_ROOT, 'dsh-fish-qq', 'package.json'), {})
  return {
    name: 'dsh-myfish-release',
    version: pluginPkg.version || '1.0.0',
    private: true,
    description: 'DSH-MyFish 纯净版：大肥鱼 + QQ 桥接 + 赛博小屋。解压后按 README-RELEASE.md 安装。',
    scripts: {
      setup: 'node setup.js',
      start: 'node cyber_house/api-router.js',
      'db:status': 'node cyber_house/db/migrate.js --status',
    },
    dependencies: {
      '@turf/turf': '^7.4.0',
      // 物理感知的网络延迟探测；缺失时 hardware-sensor.js 会自动退回系统 ping。
      ping: '^1.0.0',
    },
    optionalDependencies: {
      'better-sqlite3': '^13.0.3',
    },
    engines: {
      node: '>=22',
    },
  }
}

const SENSORS_README = `# sensors/

环境采集脚本（\`pipeline/update_env.js\`）会把一行状态写进 \`status.md\`，
把按小时聚合的节奏写进 \`user_rhythm.md\`。

首次安装时这个目录是空的，属于正常现象：她只会看到「还没采过状态」。
需要的话按插件设置里的定时任务运行采集脚本即可。

这个目录里的文件是**运行时数据**，不要提交、不要分享。
`

function generateFiles(ctx) {
  const readme = fs.readFileSync(path.join(PROJECT_ROOT, 'README-RELEASE.md'), 'utf8')
  writeStaged('README-RELEASE.md', sanitizeText(readme, ctx))

  const setup = fs.readFileSync(path.join(PROJECT_ROOT, 'packaging', 'setup.js'), 'utf8')
  writeStaged('setup.js', sanitizeText(setup, ctx))

  writeStaged('config.example.json', `${JSON.stringify(buildConfigExample(ctx), null, 2)}\n`)
  writeStaged('package.json', `${JSON.stringify(buildRootPackage(), null, 2)}\n`)
  writeStaged('sensors/README.md', SENSORS_README)
}

/* ===========================================================================
 * 二次脱敏 + 敏感信息扫描
 * ======================================================================== */

function sanitizeStage(ctx) {
  walk(STAGE_DIR, (full, rel, entry) => {
    if (entry.isDirectory() || !isTextFile(entry.name)) return
    const text = fs.readFileSync(full, 'utf8')
    const clean = sanitizeText(text, ctx)
    if (clean !== text) fs.writeFileSync(full, clean, 'utf8')
  })
}

const VERIFY_PATTERNS = [
  { name: '疑似 API Key（sk-…）', re: /\bsk-[A-Za-z0-9]{24,}\b/g },
  { name: 'B 站 Cookie（SESSDATA）', re: /SESSDATA=(?!YOUR_)[A-Za-z0-9%*._-]{10,}/g },
  { name: 'B 站 Cookie（bili_jct）', re: /bili_jct=[0-9a-f]{16,}/gi },
  { name: 'Windows 用户目录', re: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`<>]+/g },
  { name: '本机工作区路径', re: /[A-Za-z]:[\\/]WorkArea[\\/][^\s"'`<>]*/g },
]

function verifyStage(ctx) {
  const hits = []
  const secrets = ctx.secretsForScan

  walk(STAGE_DIR, (full, rel, entry) => {
    if (entry.isDirectory() || !isTextFile(entry.name)) return
    const text = fs.readFileSync(full, 'utf8')
    const lines = text.split(/\r?\n/)

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      for (const secret of secrets) {
        if (line.includes(secret)) {
          hits.push({ file: rel, line: index + 1, reason: '命中真实敏感值', sample: line.trim().slice(0, 160) })
        }
      }
      for (const pattern of VERIFY_PATTERNS) {
        pattern.re.lastIndex = 0
        const match = pattern.re.exec(line)
        if (match) {
          hits.push({ file: rel, line: index + 1, reason: pattern.name, sample: line.trim().slice(0, 160) })
        }
      }
    }
  })

  // 去重（同一行可能命中多个规则）
  const unique = new Map()
  for (const hit of hits) unique.set(`${hit.file}:${hit.line}:${hit.reason}`, hit)
  return [...unique.values()]
}

function printHits(hits) {
  console.error('')
  console.error(`✖ 敏感信息扫描失败：发现 ${hits.length} 处可疑内容，已中止打包。`)
  console.error('')
  for (const hit of hits.slice(0, 40)) {
    console.error(`  ${hit.file}:${hit.line}  [${hit.reason}]`)
    console.error(`    ${hit.sample}`)
  }
  if (hits.length > 40) console.error(`  … 还有 ${hits.length - 40} 处`)
  console.error('')
  console.error('处理办法：把对应内容加进 pack-release.js 的 EXCLUDE 规则，或在源文件里改成占位符。')
  console.error('')
}

/* ===========================================================================
 * zip
 * ======================================================================== */

function loadArchiver() {
  const candidates = [
    'archiver',
    path.join(PROJECT_ROOT, 'packaging', 'node_modules', 'archiver'),
    path.join(WORKSPACE_ROOT, 'node_modules', 'archiver'),
  ]
  for (const candidate of candidates) {
    try {
      const mod = require(candidate)
      // archiver 7.x 导出工厂函数；8.x 改成 ESM，导出 ZipArchive 类。
      if (typeof mod === 'function') return (options) => mod('zip', options)
      if (mod && typeof mod.ZipArchive === 'function') return (options) => new mod.ZipArchive(options)
    } catch {
      // 继续找下一个
    }
  }
  console.error('✖ 缺少打包依赖 archiver。')
  console.error('  在 DSH-MyFish 目录执行：npm install archiver')
  console.error('  或在 packaging/ 目录执行：npm install')
  process.exit(1)
}

function zipStage(outFile) {
  const createArchive = loadArchiver()
  const tmpFile = `${outFile}.tmp`

  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(outFile))
    const output = fs.createWriteStream(tmpFile)
    const archive = createArchive({ zlib: { level: 9 } })

    output.on('close', () => resolve(tmpFile))
    output.on('error', reject)
    archive.on('warning', (error) => {
      if (error.code === 'ENOENT') console.warn(`[zip] 警告：${error.message}`)
      else reject(error)
    })
    archive.on('error', reject)

    archive.pipe(output)
    // 不在 zip 里再套一层 DSH-MyFish-Release/：Windows「全部解压」会用 zip 名
    // 自动建文件夹，再套一层会变成 DSH-MyFish-Release\DSH-MyFish-Release\。
    archive.directory(STAGE_DIR, false)
    archive.finalize()
  })
}

/* ===========================================================================
 * 主流程
 * ======================================================================== */

async function main() {
  if (OPTIONS.help) {
    console.log('用法：node pack-release.js [--out <zip 路径>] [--keep-stage] [--no-verify]')
    console.log('默认输出：' + DEFAULT_OUT)
    return
  }

  const startedAt = Date.now()
  const ctx = buildSensitiveContext()

  console.log('')
  console.log('DSH-MyFish 发布打包')
  console.log('────────────────────')
  console.log(`源目录：${PROJECT_ROOT}`)
  console.log(`输出：  ${OPTIONS.out}`)
  console.log(`脱敏项：${ctx.exact.length} 条（路径 / QQ / Key / Cookie）`)
  console.log('')

  fs.rmSync(STAGE_DIR, { recursive: true, force: true })
  ensureDir(STAGE_DIR)

  // 1. 遍历整个 DSH-MyFish，靠黑名单剔除私密数据与无关目录。
  //    顶层 README.md / pack-release.js / packaging/ / sensors/ 等都会被规则跳过。
  copyTree(PROJECT_ROOT, STAGE_DIR, ctx, '')

  // 2. 生成发布专用文件
  generateFiles(ctx)

  // 3. 二次脱敏（兜住生成文件里漏网的路径）
  sanitizeStage(ctx)

  // 4. 扫描
  if (OPTIONS.verify) {
    const hits = verifyStage(ctx)
    if (hits.length > 0) {
      printHits(hits)
      if (!OPTIONS.keepStage) fs.rmSync(STAGE_DIR, { recursive: true, force: true })
      process.exitCode = 1
      return
    }
    console.log('✔ 敏感信息扫描通过：0 处命中')
  } else {
    console.log('⚠ 已跳过敏感信息扫描（--no-verify）')
  }

  // 5. 打 zip
  const fileCount = countFiles(STAGE_DIR)
  const tmpZip = await zipStage(OPTIONS.out)
  fs.rmSync(OPTIONS.out, { force: true })
  fs.renameSync(tmpZip, OPTIONS.out)

  const size = fs.statSync(OPTIONS.out).size
  const sha = hashFile(OPTIONS.out)
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

  console.log('')
  console.log('✔ 打包完成')
  console.log(`  文件：${OPTIONS.out}`)
  console.log(`  大小：${formatBytes(size)}`)
  console.log(`  SHA256：${sha}`)
  console.log(`  文件数：${fileCount}（跳过 ${stats.skipped} 个目录/文件）`)
  console.log(`  耗时：${seconds}s`)
  console.log('')

  if (!OPTIONS.keepStage) {
    fs.rmSync(STAGE_DIR, { recursive: true, force: true })
  } else {
    console.log(`暂存目录保留在：${STAGE_DIR}`)
  }
}

main().catch((error) => {
  console.error('')
  console.error(`✖ 打包失败：${error?.stack || error}`)
  process.exitCode = 1
})
