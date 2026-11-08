/**
 * zip.js —— 只用 Node 内置模块解 ZIP。
 *
 * 为什么自己写：dsh-fish 的硬约束是零依赖。Electron 的发行包是 ZIP，
 * 而 Node 没有公开的 unzip API；这里只解析 Electron 官方包里用到的
 * store / deflate 两种方式，不追求做一个通用解压器。
 *
 * 安全：拒绝 `..` 与绝对路径；只往目标目录里写。CRC 不校验——
 * 调用方在解压前已经核对整个 ZIP 的 SHA256。
 */
import { promises as fs } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/** 读出中央目录里的条目（不写盘，测试也用它）。 */
export function listZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('ZIP 太短')
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('找不到 ZIP 目录结尾')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralOffset === 0xffffffff) throw new Error('不支持 ZIP64')

  const entries = []
  let p = centralOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error('ZIP 中央目录损坏')
    }
    const flags = buffer.readUInt16LE(p + 8)
    const method = buffer.readUInt16LE(p + 10)
    const compressedSize = buffer.readUInt32LE(p + 20)
    const uncompressedSize = buffer.readUInt32LE(p + 24)
    const nameLen = buffer.readUInt16LE(p + 28)
    const extraLen = buffer.readUInt16LE(p + 30)
    const commentLen = buffer.readUInt16LE(p + 32)
    const externalAttrs = buffer.readUInt32LE(p + 38)
    const localOffset = buffer.readUInt32LE(p + 42)
    const name = buffer.slice(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'utf8')
    entries.push({ name, method, compressedSize, uncompressedSize, externalAttrs, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function safeTarget(root, name) {
  const target = resolve(root, name)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`ZIP 条目跑出目标目录：${name}`)
  }
  return target
}

/**
 * 解压到 destDir。返回写出的文件数与字节数。
 * @param {Buffer} buffer
 * @param {string} destDir
 * @param {{log?:Function}} [options]
 */
export async function extractZipBuffer(buffer, destDir, { log } = {}) {
  const root = resolve(destDir)
  await fs.mkdir(root, { recursive: true })
  const entries = listZipEntries(buffer)
  let files = 0
  let bytes = 0

  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith('/')) continue
    const target = safeTarget(root, entry.name)
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}：${entry.name}`)
    }
    if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== SIG_LOCAL) {
      throw new Error(`ZIP 本地头损坏：${entry.name}`)
    }
    const nameLen = buffer.readUInt16LE(entry.localOffset + 26)
    const extraLen = buffer.readUInt16LE(entry.localOffset + 28)
    const start = entry.localOffset + 30 + nameLen + extraLen
    const end = start + entry.compressedSize
    if (end > buffer.length) throw new Error(`ZIP 数据越界：${entry.name}`)
    const raw = buffer.slice(start, end)
    const data = entry.method === 0 ? raw : inflateRawSync(raw)
    if (entry.uncompressedSize && data.length !== entry.uncompressedSize) {
      throw new Error(`ZIP 解压后大小不符：${entry.name}`)
    }

    await fs.mkdir(dirname(target), { recursive: true })

    const unixMode = (entry.externalAttrs >>> 16) & 0xffff
    const isSymlink = (unixMode & 0o170000) === 0o120000
    if (isSymlink) {
      // Electron 的 macOS 包里有符号链接；Windows 上创建符号链接需要权限，
      // 失败就跳过（Windows 的 Electron 包没有符号链接，不受影响）。
      try {
        await fs.symlink(data.toString('utf8'), target)
        log?.(`[dsh-fish] 已解压符号链接 ${entry.name}`)
      } catch (err) {
        log?.(`[dsh-fish] 符号链接跳过 ${entry.name}: ${String(err?.message ?? err)}`)
      }
      continue
    }

    let mode = unixMode & 0o777
    if (!mode) mode = 0o644
    const base = entry.name.split('/').pop() || ''
    if (base === 'electron' || base === 'Electron' || entry.name.includes('.app/Contents/MacOS/')) mode |= 0o111
    await fs.writeFile(target, data, { mode })
    files++
    bytes += data.length
  }

  return { files, bytes }
}

/** 从文件解压。 */
export async function extractZipFile(zipPath, destDir, options = {}) {
  const buffer = await fs.readFile(zipPath)
  return extractZipBuffer(buffer, destDir, options)
}
