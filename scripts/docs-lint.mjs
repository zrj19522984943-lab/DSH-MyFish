#!/usr/bin/env node
/**
 * scripts/docs-lint.mjs —— T4 终版文档校验器（零依赖）
 *
 * L1  INDEX 每个 id 有对应 L1 文件                 缺失 → fail
 * L2  每个 L1 顶部有 owner / anchors / 版本核对     缺失 → fail
 * L3  owner id 正向推出的路径 = 本文件              不一致 → fail
 * L4  anchors 里每个 <文件> 存在                    不存在 → fail
 * L5  代码里 // @doc <id> 的 id 在 INDEX 里存在     不存在 → warn
 * L6  复述检测（fail）：
 *       `| 键 | 默认 |` 只允许 docs/domains/qq/settings.md
 *       `| id | 一句话 |` 只允许 docs/INDEX.md
 *       其他 L1 出现这两个表头 → fail
 * L7  归档检查（fail）：
 *       docs/archive/ 每个 .md 顶部有「已归档」头
 *       头里有「归档前原路径：」
 *       原路径有 stub（README-RELEASE / CHANGELOG 除外）
 *       stub 含 docs/archive/<归档名> 与 docs/INDEX.md
 * L8  原路径防回写（fail）：
 *       扫描仓库内所有 .md（排除 docs/、.git/、node_modules/），
 *       出现已知事实表头（设置表/状态字段表/验收表/排查表等）→ fail
 *
 * 用法：node scripts/docs-lint.mjs
 * 退出码：有 fail → 1；否则 0。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOMAINS = new Set(['fish', 'qq', 'house', 'merge', 'ops'])
const ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/
const L1_META_LINES = 15
const DOC_TAG_RE = /\/\/\s*@doc\s+([A-Za-z][A-Za-z0-9_.-]*)/
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.sh', '.css', '.scss'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.run', 'dist', 'backups', '.headless', 'docs', 'rss', 'CheckLogs', 'media', 'assets'])

const ARCHIVE_EXPECTED = [
  'DSH-MyFish__README.md',
  'cyber_house__API.md',
  'dsh-fish-qq__README.md',
  'dsh-fish-qq__对接文档.md',
  'dsh-fish-qq__功能文档.md',
  'dsh-fish__README.md',
  'dsh-qq-bridge__README.md',
  'dsh-qq-bridge__DESIGN.md',
  'dsh-qq-bridge__CHANGELOG.md',
]

const results = new Map()
function add(key, level, message) {
  if (!results.has(key)) results.set(key, { level, items: [] })
  results.get(key).items.push(message)
}

function idToPath(id) {
  const [domain, ...rest] = id.split('.')
  return `docs/domains/${domain}/${rest.join('-')}.md`
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      walk(full, out)
      continue
    }
    if (!ent.isFile()) continue
    const dot = ent.name.lastIndexOf('.')
    const ext = dot === -1 ? '' : ent.name.slice(dot).toLowerCase()
    if (!CODE_EXT.has(ext)) continue
    try {
      if (statSync(full).size > 5 * 1024 * 1024) continue
    } catch {
      continue
    }
    out.push(full)
  }
  return out
}

function walkMarkdownNonDocs(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (['docs', '.git', 'node_modules'].includes(ent.name)) continue
      walkMarkdownNonDocs(full, out)
      continue
    }
    if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

// ── INDEX ───────────────────────────────────────────────────────────────────
const indexRel = 'docs/INDEX.md'
const indexAbs = join(ROOT, indexRel)
if (!existsSync(indexAbs)) {
  console.error(`[fatal] 找不到 ${indexRel}`)
  process.exit(1)
}
const indexText = readFileSync(indexAbs, 'utf8')

const seen = new Set()
const ids = []
for (const line of indexText.split(/\r?\n/)) {
  if (!line.startsWith('|')) continue
  const cells = line.split('|')
  if (cells.length < 5) continue
  const first = cells[1].trim().replace(/^`|`$/g, '')
  if (!ID_RE.test(first)) continue
  if (!DOMAINS.has(first.split('.')[0])) continue
  if (seen.has(first)) {
    add('INDEX', 'fail', `重复 id：${first}`)
    continue
  }
  seen.add(first)
  ids.push(first)
}
if (ids.length === 0) {
  console.error('[fatal] INDEX 里没有解析到任何 id')
  process.exit(1)
}

// ── L1 / L2 / L3 / L4 / L6 ──────────────────────────────────────────────────
const l1Files = []
for (const id of ids) {
  const rel = idToPath(id)
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) {
    add('L1', 'fail', `缺少 L1：${id} → ${rel}`)
    continue
  }
  l1Files.push({ id, rel, abs })
}

for (const { id, rel, abs } of l1Files) {
  const source = readFileSync(abs, 'utf8')
  const head = source.split(/\r?\n/).slice(0, L1_META_LINES).join('\n')
  const owner = head.match(/^owner:\s*(.+)$/m)?.[1]?.trim()
  const anchors = head.match(/^anchors:\s*(.+)$/m)?.[1]?.trim()
  const version = head.match(/^版本核对:\s*(.+)$/m)?.[1]?.trim()

  if (!owner) add('L2', 'fail', `${rel}：顶部缺少 owner 行`)
  if (!anchors) add('L2', 'fail', `${rel}：顶部缺少 anchors 行`)
  if (!version) add('L2', 'fail', `${rel}：顶部缺少 版本核对 行`)

  if (owner) {
    const ownerId = owner.replace(/^`|`$/g, '').trim()
    const expected = ID_RE.test(ownerId) ? idToPath(ownerId) : ''
    if (!expected) add('L3', 'fail', `${rel}：owner 不是合法 id（${ownerId}）`)
    else if (expected !== rel) add('L3', 'fail', `${rel}：owner=${ownerId} 应映射到 ${expected}`)
  }

  if (anchors) {
    for (const raw of anchors.split(';')) {
      const anchor = raw.trim().replace(/^`|`$/g, '')
      if (!anchor) continue
      const filePart = anchor.split('#')[0].trim()
      if (!filePart) continue
      const target = resolve(ROOT, filePart)
      let ok = false
      try {
        ok = statSync(target).isFile()
      } catch {
        ok = false
      }
      if (!ok) add('L4', 'fail', `${rel}：anchor 文件不存在 → ${filePart}`)
    }
  }

  // L6：设置表/INDEX 表头只允许在白名单
  if (rel !== 'docs/domains/qq/settings.md' && /\|\s*键\s*\|\s*默认\s*\|/.test(source)) {
    add('L6', 'fail', `${rel}：出现 "| 键 | 默认 |"（只允许 qq/settings.md）`)
  }
  if (/\|\s*id\s*\|\s*一句话\s*\|/.test(source)) {
    add('L6', 'fail', `${rel}：出现 "| id | 一句话 |"（只允许 INDEX.md）`)
  }
}

// INDEX 也不能出现设置表头；id 表头允许
if (/\|\s*键\s*\|\s*默认\s*\|/.test(indexText)) {
  add('L6', 'fail', 'docs/INDEX.md：出现 "| 键 | 默认 |"（只允许 qq/settings.md）')
}

// ── L5：代码里的 // @doc <id> ────────────────────────────────────────────────
for (const file of walk(ROOT)) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (!text.includes('@doc')) continue
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
  text.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(DOC_TAG_RE)
    if (!m) return
    if (!seen.has(m[1])) add('L5', 'warn', `${rel}:${i + 1}：// @doc ${m[1]} 不在 INDEX 里`)
  })
}

// ── L7：归档 ────────────────────────────────────────────────────────────────
const archiveDir = join(ROOT, 'docs', 'archive')
const archiveFiles = existsSync(archiveDir)
  ? readdirSync(archiveDir).filter((n) => n.toLowerCase().endsWith('.md'))
  : []
for (const name of ARCHIVE_EXPECTED) {
  if (!archiveFiles.includes(name)) add('L7', 'fail', `缺少归档文件：docs/archive/${name}`)
}
for (const name of archiveFiles) {
  const abs = join(archiveDir, name)
  const text = readFileSync(abs, 'utf8')
  const head = text.split(/\r?\n/).slice(0, 10).join('\n')
  if (!head.includes('已归档')) add('L7', 'fail', `docs/archive/${name}：顶部缺少「已归档」头`)
  const original = head.match(/归档前原路径：(.+)/)?.[1]?.trim()
  if (!original) {
    add('L7', 'fail', `docs/archive/${name}：头里缺少「归档前原路径：」`)
    continue
  }
  if (/CHANGELOG\.md$/i.test(name) || original === 'README-RELEASE.md') continue
  const stubAbs = join(ROOT, original)
  if (!existsSync(stubAbs)) {
    add('L7', 'fail', `原路径缺少 stub：${original}（归档 ${name}）`)
    continue
  }
  const stub = readFileSync(stubAbs, 'utf8')
  if (!stub.includes(`docs/archive/${name}`)) add('L7', 'fail', `${original}：stub 未指向 docs/archive/${name}`)
  if (!stub.includes('docs/INDEX.md')) add('L7', 'fail', `${original}：stub 未指向 docs/INDEX.md`)
}
const releaseGuide = join(ROOT, 'README-RELEASE.md')
if (!existsSync(releaseGuide)) add('L7', 'fail', 'README-RELEASE.md 必须留在仓库根')
else {
  const head = readFileSync(releaseGuide, 'utf8').split(/\r?\n/).slice(0, 12).join('\n')
  if (!head.includes('保持原路径') || !head.includes('docs/INDEX.md')) {
    add('L7', 'fail', 'README-RELEASE.md：顶部缺少「保持原路径 / docs/INDEX.md」重定向头')
  }
}

// ── L8：原路径防回写（非 docs 的 .md 不得出现事实表头）──────────────────────
const FACT_TABLE_PATTERNS = [
  [/\|\s*键\s*\|\s*默认\s*\|/, '键/默认 设置表'],
  [/\|\s*id\s*\|\s*一句话\s*\|/, 'id/一句话 索引表'],
  [/\|\s*字段\s*\|\s*形状\s*\|/, '字段/形状 状态表'],
  [/\|\s*#\s*\|\s*检查\s*\|/, '验收表'],
  [/\|\s*症状\s*\|\s*先查\s*\|/, '排查表'],
]
for (const file of walkMarkdownNonDocs(ROOT)) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
  for (const [re, label] of FACT_TABLE_PATTERNS) {
    if (re.test(text)) add('L8', 'fail', `${rel}：出现事实表头（${label}）`)
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const fails = []
const warns = []
for (const [key, group] of results) {
  for (const message of group.items) {
    ;(group.level === 'fail' ? fails : warns).push({ key, message })
  }
}
const label = {
  INDEX: 'INDEX 索引',
  L1: 'L1  L1 文件缺失',
  L2: 'L2  三行头',
  L3: 'L3  owner 与路径',
  L4: 'L4  anchors 文件',
  L5: 'L5  @doc id',
  L6: 'L6  复述检测',
  L7: 'L7  归档检查',
  L8: 'L8  原路径防回写',
}
console.log(`docs-lint · ${ids.length} 个 id · ${l1Files.length} 个 L1 · ${archiveFiles.length} 个归档\n`)
if (fails.length) {
  console.log(`FAIL（${fails.length}）`)
  for (const key of ['INDEX', 'L1', 'L2', 'L3', 'L4', 'L6', 'L7', 'L8']) {
    const rows = fails.filter((f) => f.key === key)
    if (!rows.length) continue
    console.log(`  ${label[key]}`)
    for (const row of rows) console.log(`    - ${row.message}`)
  }
  console.log('')
}
if (warns.length) {
  console.log(`WARN（${warns.length}）`)
  for (const key of ['INDEX', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']) {
    const rows = warns.filter((w) => w.key === key)
    if (!rows.length) continue
    console.log(`  ${label[key]}`)
    for (const row of rows) console.log(`    - ${row.message}`)
  }
  console.log('')
}
for (const key of ['INDEX', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']) {
  const f = fails.filter((x) => x.key === key).length
  const w = warns.filter((x) => x.key === key).length
  console.log(`  ${label[key]}：fail ${f} / warn ${w}`)
}
console.log(`\n结果：${fails.length ? 'FAIL' : 'PASS'}（fail ${fails.length}，warn ${warns.length}）`)
process.exit(fails.length ? 1 : 0)
