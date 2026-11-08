/**
 * restrict.test.mjs —— 工具面收窄的守门（2026-10-26 补）
 *
 * 背景：QQ 桥接的工具注册在同一个 ctx 上，`tools.restrict` 挡不住它们的**可见性**
 * （own 层），真正决定“她能不能调”的是兜底守卫的 `allowSet`。
 * 真机事故：`subsend` 指令已解析并唤醒，但 `qq_bridge_subsend` 不在清单里，
 * 守卫回了一句固定的「这件事我做不到。」，模型把这句当结论转述给了用户。
 *
 * 这个测试钉三件事：
 *   1. QQ 桥接的工具在允许清单里；
 *   2. 守卫放行它们、仍然挡住别的工具；
 *   3. 名字没登记（独立安装 dsh-fish）时，restrict 按已知交集收窄、不整条抛错。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FISH_TOOLS,
  HER_TOOLS,
  QQ_BRIDGE_TOOLS,
  registerToolRestrict,
  rememberKnownTools,
} from '../lib/restrict.js'

const GUARD_REFUSAL = '这件事我做不到。'

/** 造一个够用的假 ctx / agent；`known` = 宿主此刻“认得”的工具名。 */
function harness(known) {
  const handlers = new Map()
  const restrictCalls = []
  let guardFn = null

  const tools = {
    view: () => ({ restrictableNames: new Set(known) }),
    restrict({ allow }) {
      const unknown = allow.filter((n) => !known.includes(n))
      if (unknown.length > 0) {
        throw new Error(
          `tools.restrict() names unknown global tool "${unknown[0]}"; known global tools: ${known.join(', ')}`,
        )
      }
      restrictCalls.push(allow.slice())
      return () => {}
    },
    guard(fn) {
      guardFn = fn
      return () => {}
    },
  }

  const herDir = mkdtempSync(join(tmpdir(), 'dsh-fish-restrict-'))
  const agent = {
    session: { header: { cwd: herDir } },
    ctx: { tools, effect: () => {} },
  }
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn)
      return () => {}
    },
  }

  return {
    herDir,
    ctx,
    emit: () => handlers.get('agent/created')?.({ agent }),
    restrictCalls,
    guard: (name) => guardFn?.({ name }),
    cleanup: () => rmSync(herDir, { recursive: true, force: true }),
  }
}

test('QQ 桥接的七个工具都在允许清单里', () => {
  assert.deepEqual([...QQ_BRIDGE_TOOLS].sort(), [
    'qq_bridge_fileget',
    'qq_bridge_filesend',
    'qq_bridge_listen',
    'qq_bridge_send',
    'qq_bridge_send_multi',
    'qq_bridge_sticker',
    'qq_bridge_subsend',
  ])
  for (const n of QQ_BRIDGE_TOOLS) assert.ok(HER_TOOLS.includes(n), `${n} 必须在 HER_TOOLS 里`)
  for (const n of FISH_TOOLS) assert.ok(HER_TOOLS.includes(n), `${n} 必须在 HER_TOOLS 里`)
})

test('看图工具 image_look 在 FISH_TOOLS 里（自己的工具，不靠宿主）', () => {
  assert.ok(FISH_TOOLS.includes('image_look'), '白名单里少了 image_look')
  assert.ok(HER_TOOLS.includes('image_look'))
})

test('守卫放行 QQ 桥接工具（真机事故的回归）', () => {
  rememberKnownTools([])
  const h = harness([...FISH_TOOLS, ...QQ_BRIDGE_TOOLS, 'read_image', 'bash'])
  try {
    registerToolRestrict(h.ctx, { herDir: h.herDir })
    h.emit()

    // 放行名单 → undefined（= 不拦）；别的 → 固定话术
    for (const n of QQ_BRIDGE_TOOLS) {
      assert.equal(h.guard(n), undefined, `${n} 必须被放行`)
    }
    assert.equal(h.guard('bash'), GUARD_REFUSAL, '别的工具仍然要挡住')
    assert.equal(h.guard('grep'), GUARD_REFUSAL)
  } finally {
    h.cleanup()
  }
})

test('名字还没登记时不整条抛错（独立安装 dsh-fish 的情形）', () => {
  rememberKnownTools([])
  const known = [...FISH_TOOLS, 'read_image'] // 没有 QQ 桥接
  const h = harness(known)
  try {
    registerToolRestrict(h.ctx, { herDir: h.herDir })
    assert.doesNotThrow(() => h.emit())
    assert.equal(h.restrictCalls.length, 1, 'restrict 应该挂上（按已知交集）')
    // 已登记的名字全在，没登记的不在
    for (const n of known) assert.ok(h.restrictCalls[0].includes(n), `${n} 应被保留`)
    for (const n of QQ_BRIDGE_TOOLS) assert.ok(!h.restrictCalls[0].includes(n), `${n} 尚未登记，不应进 restrict`)
  } finally {
    h.cleanup()
  }
})
