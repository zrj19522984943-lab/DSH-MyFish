/**
 * test-tool-routing.mjs —— 动态工具路由（2026-11-04）
 *
 * 只测纯函数 `routeToolIntent`：桥接层在投递前按这一条消息算“这一轮放开哪些工具”。
 * 真的挂 restrict 需要宿主 agent，放不进这个无宿主测试；这里守住的是**意图 → 工具**
 * 的映射与“不命中就什么都不给”的默认。
 */

import assert from 'node:assert/strict'

import { BASE_TOOLS, EXT_TOOLS, routeToolIntent, toolRegistrationTarget } from './index.js'

let pass = 0
function ok(name, cond, detail = '') {
  if (!cond) {
    console.error(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
    process.exitCode = 1
    return
  }
  pass += 1
  console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`)
}

ok('基础池就是任务书那七个 + 表情包', BASE_TOOLS.length === 8 && BASE_TOOLS.includes('qq_bridge_send') && BASE_TOOLS.includes('qq_bridge_sticker'))
ok('表情包已常驻：不在扩展池里', !EXT_TOOLS.includes('qq_bridge_sticker'))
ok('扩展池里有派活与装修', EXT_TOOLS.includes('work_request') && EXT_TOOLS.includes('fish_decorate_room'))
ok('GIS 两个工具在扩展池里、不在基础池里',
  EXT_TOOLS.includes('gis_buffer_query') && EXT_TOOLS.includes('gis_delete_feature') &&
  !BASE_TOOLS.includes('gis_buffer_query') && !BASE_TOOLS.includes('gis_delete_feature'))

const cases = [
  ['今天天气好热', [], '闲聊不放开任何扩展工具'],
  ['在客厅加个地毯', ['fish_decorate_room'], '装修'],
  ['帮我写个 Python 爬虫', ['work_request'], '派活'],
  ['以前我们说的暗号是什么', ['fish_search_history', 'fish_read_raw'], '回忆'],
  // 表情包已常驻（BASE_TOOLS），说「发个表情」不再靠意图解锁任何扩展工具
  ['发个表情', [], '表情包已常驻，不靠意图解锁'],
  ['发个语音', [], '语音工具未注册，media 规则已删'],
  ['你在干嘛', ['read_user_rhythm'], '节奏'],
  ['留句话给他', ['her_leave'], '留话'],
  ['看看这个 BV1xx411c7mD', ['bili_look', 'bili_watch', 'bili_speak'], 'B 站'],
  // 空间查询：任务书正则 /(周围|附近|周围有什么|缓冲区|视野内|圈内)/
  ['你周围有什么', ['gis_buffer_query'], '空间查询·周围有什么'],
  ['附近有没有沙发', ['gis_buffer_query'], '空间查询·附近'],
  ['以你为圆心 200 圈内都有啥', ['gis_buffer_query'], '空间查询·圈内'],
  // 空间删除：任务书正则 (删掉|删除|清理|移除|拆掉) + 补的口语「删了」
  ['把沙发删了', ['gis_delete_feature'], '空间删除·删了'],
  ['帮我把那堵墙移除掉', ['gis_delete_feature'], '空间删除·移除'],
  ['客厅太挤了，清理一下', ['gis_delete_feature'], '空间删除·清理'],
]

for (const [text, want, why] of cases) {
  const got = routeToolIntent(text)
  assert.deepEqual(got.tools.slice(0, want.length), want)
  ok(why, want.every((t) => got.tools.includes(t)), got.tools.join(','))
}

// 任务书钦定的两句提示词必须原样注入，fish 靠它们知道自己拿到了什么权限。
{
  const r = routeToolIntent('你周围有什么')
  ok('空间查询提示词原样注入',
    r.hints.includes('[系统：你已获得空间查询权限，可调用 gis_buffer_query 查看周围范围。]'),
    JSON.stringify(r.hints))
}
{
  const r = routeToolIntent('把沙发删了')
  ok('空间删除提示词原样注入',
    r.hints.includes('[系统：你已获得空间编辑权限，可调用 gis_delete_feature 清理家具或障碍物。]'),
    JSON.stringify(r.hints))
}
// 一句话又问周围又要删 → 两个工具都放开，两句提示都在
{
  const r = routeToolIntent('你周围有什么？把沙发删了')
  ok('查询+删除同时命中',
    r.tools.includes('gis_buffer_query') && r.tools.includes('gis_delete_feature') &&
    r.hints.filter((h) => h.includes('gis_')).length === 2,
    r.tools.join(','))
}
// 说「删掉」时不得顺手放开查询工具（反之亦然），意图之间各开各的门
{
  const r = routeToolIntent('把沙发删了')
  ok('删除意图不放开查询工具', !r.tools.includes('gis_buffer_query'))
  const q = routeToolIntent('你周围有什么')
  ok('查询意图不放开删除工具', !q.tools.includes('gis_delete_feature'))
}

// 安全边界：subsend / 发文件不是“关键词开门”的意图。是否算指令由桥接层先判
// （主人/管理员、开关、解析成功）；纯函数这里绝不能因为正文前缀就解锁。
for (const text of ['subsend 123456 你好', 'fileget qq/README.md', 'filesend 123456 a.txt']) {
  const got = routeToolIntent(text)
  ok(`命令文字不绕过闸门：${text}`, !got.tools.some((t) => t.startsWith('qq_bridge_subsend') || t.startsWith('qq_bridge_file')))
}

{
  const r = routeToolIntent('今天天气好热')
  ok('不命中意图时 extraPrompt 为空', r.prompt === '', JSON.stringify(r.prompt))
}
{
  const r = routeToolIntent('', { hasImages: true })
  ok('带图消息自动放开 image_look', r.tools.includes('image_look'))
}
// 2026-11-05：hasStickers 路径已删。表情包消息不再在这里解锁任何工具 ——
// 它在 BASE_TOOLS 里，每轮都在，用不着特殊挂载。
{
  const r = routeToolIntent('', {})
  ok('纯文本不命中意图时 tools 为空（表情包不属于路由结果）', r.tools.length === 0)
}
{
  const r = routeToolIntent('帮我写个代码，顺便装修一下')
  ok('一条消息命中多个意图时并集放开', r.tools.includes('work_request') && r.tools.includes('fish_decorate_room'))
}

// 2026-11-08：工具注册分流（会话级隔离）。
{
  const scoped = [
    'qq_bridge_send', 'qq_bridge_send_multi', 'qq_bridge_subsend',
    'qq_bridge_sticker', 'qq_bridge_listen', 'qq_bridge_fileget', 'qq_bridge_filesend',
  ]
  for (const name of scoped) {
    ok(`合并包：${name} 走 scoped sink`, toolRegistrationTarget(name, { hasSink: true }) === 'sink')
  }
  const admin = ['qq_bridge_status', 'qq_bridge_proactive', 'qq_bridge_idle', 'qq_bridge_transport', 'qq_bridge_simulate', 'qq_bridge_napcat']
  for (const name of admin) {
    ok(`合并包默认：${name} 不注册（工作区保持干净）`, toolRegistrationTarget(name, { hasSink: true }) === 'drop')
    ok(`合并包 opt-in：${name} 仍可 global 注册`, toolRegistrationTarget(name, { hasSink: true, debugToolsInWorkspace: true }) === 'global')
  }
  ok('独立安装：回复工具仍然 global（行为不变）', toolRegistrationTarget('qq_bridge_send', { hasSink: false }) === 'global')
  ok('独立安装：管理工具仍然 global（行为不变）', toolRegistrationTarget('qq_bridge_status', { hasSink: false }) === 'global')
}

console.log(`\n${pass} 项通过`)
