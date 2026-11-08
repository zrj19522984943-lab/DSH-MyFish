/**
 * paths.js —— 桌宠窗口与 dsh-fish 宿主共用的文件通道。
 *
 * 全部放在状态库里（默认 ~/.dsh-fish/pet/），不碰 events.jsonl、
 * 不碰 config.json，也不进她的记忆。窗口状态、请求、回执都是可丢的运行态。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { rootDir } from '../store.js'

export function petPaths(root = rootDir()) {
  const dir = join(root, 'pet')
  return {
    dir,
    request: join(dir, 'request.json'),
    // 一条请求一个回执文件：桌宠可能连续发几条，单文件会被下一条覆盖。
    repliesDir: join(dir, 'replies'),
    // 她说过的话（只放她说出口的那几类，不含日记/信）。窗口轮询它来显示返回框。
    messages: join(dir, 'messages.json'),
    bridge: join(dir, 'bridge.json'),
    window: join(dir, 'window.json'),
    status: join(dir, 'status.json'),
    electronStatus: join(dir, 'electron.json'),
    electronLog: join(dir, 'electron.log'),
  }
}

/** 建好 pet/ 并尽量收成只有当前用户可读（Windows 上 chmod 是尽力而为）。 */
export async function ensurePetDir(root = rootDir()) {
  const { dir, repliesDir } = petPaths(root)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.mkdir(repliesDir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700).catch(() => {})
  await fs.chmod(repliesDir, 0o700).catch(() => {})
  return dir
}

export async function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback
    return fallback
  }
}
