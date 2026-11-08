/**
 * workspace.js —— 小鱼工作区根目录的唯一解析处
 *
 * 为什么要有这个文件：
 *   以前「她能看哪儿 / 能发哪儿的文件 / 派活去哪儿」写死成作者本机的
 *   `D:\demo\workspace`。装到别人机器上时，这三件事全指着一条不存在的路——
 *   工具只会回「没有这个目录 / 没有这个文件」，还让用户以为插件坏了。
 *
 * 现在的口径（优先级从高到低）：
 *   1. 显式传进来的值（设置页里的「工作区根目录」）—— 可以是字符串，也可以是
 *      一个 getter（设置改了之后下一次调用就生效，不用重启）；
 *   2. `DSH_FISH_WORKSPACE` 环境变量；
 *   3. 空串 —— 不猜。工具会如实说「还没说能看哪儿」。
 *
 * 2026-11-05 布局调整：小鱼的全部资产（dsh-fish-qq / cyber_house / sensors /
 * pipeline / rss / scripts / tools）收进了工作区下的 `DSH-MyFish/`，而设置页里
 * 记的仍是外层工作区根。这里做一次**向下探测**：如果配置的根下面有
 * `DSH-MyFish/`（且里面有 cyber_house 或 dsh-fish-qq），就把小鱼根切到它。
 * 这样老的 `workspaceRoot` 设置不用改，鱼也不会把 gateway / dist 这些
 * 不相关目录当成自己的家。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const FISH_HOME_DIR = 'DSH-MyFish'

/** 配置的根 -> 实际的小鱼根（兼容尚未调整布局的旧工作区）。 */
function resolveFishHome(value) {
  const s = String(value ?? '').trim()
  if (!s) return ''

  // 已经是 DSH-MyFish 本身（或旧布局）时直接用它。
  const nested = join(s, FISH_HOME_DIR)
  try {
    if (
      existsSync(join(nested, 'cyber_house'))
      || existsSync(join(nested, 'dsh-fish-qq'))
    ) {
      return nested
    }
  } catch {
    // 路径不可读时退回配置值，让下游给出更具体的错误。
  }
  return s
}

export function resolveWorkspaceRoot(value) {
  let v = value
  if (typeof v === 'function') {
    try {
      v = v()
    } catch {
      v = ''
    }
  }
  const s = resolveFishHome(v)
  if (s) return s
  return resolveFishHome(process.env.DSH_FISH_WORKSPACE)
}
