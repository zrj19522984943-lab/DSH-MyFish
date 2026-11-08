// qq/shared/intent.js
//
// 工具面与意图路由：BASE_TOOLS / EXT_TOOLS / TOOL_INTENTS / routeToolIntent，
// 以及“某个工具该注册到哪儿”的 toolRegistrationTarget。
// 宿主专属（client 不用），纯数据 + 纯函数，不引用宿主对象。

/**
 * 她独占的 QQ 回复工具（2026-11-08）。
 *
 * 合并包（dsh-fish-qq）里这些定义不再注册到插件 ctx 的 global 层，而是交给
 * 外层共享的 `config.toolSink`，由 fish 侧在 `agent/created` 确认是她那条会话后，
 * 挂进 `agent.ctx.tools`。这样用户写代码的工作区里不会出现 qq_bridge_send 等工具。
 *
 * 管理/调试类工具（status / proactive / idle / transport / simulate / napcat）
 * 不在这里：它们是操作员在 DSH 工作区里排障用的，仍然走 global 注册。
 */
const SCOPED_QQ_TOOLS = new Set([
  'qq_bridge_send',
  'qq_bridge_send_multi',
  'qq_bridge_subsend',
  'qq_bridge_sticker',
  'qq_bridge_listen',
  'qq_bridge_fileget',
  'qq_bridge_filesend',
])

/**
 * 一个 QQ 工具定义该往哪儿走（导出给测试钉住，2026-11-08）。
 *
 * @param {string} name 工具名
 * @param {{hasSink?: boolean, debugToolsInWorkspace?: boolean}} [opts]
 *   `hasSink` = 合并包传了共享 toolSink（说明是 dsh-fish-qq 而不是独立安装）
 * @returns {'sink'|'drop'|'global'}
 *   sink   = 收进共享数组，由 fish 侧挂进她的会话；
 *   drop   = 合并包里默认不注册（操作员工具，避免污染用户工作区）；
 *   global = 老行为：注册到插件 ctx 的 global 层。
 */
export function toolRegistrationTarget(name, { hasSink = false, debugToolsInWorkspace = false } = {}) {
  if (!hasSink) return 'global'
  if (SCOPED_QQ_TOOLS.has(String(name ?? ''))) return 'sink'
  return debugToolsInWorkspace === true ? 'global' : 'drop'
}

export const BASE_TOOLS = Object.freeze([
  'growth_commit', // 记下她自己的想法（唯一的写入口）
  'her_recall', // 翻她自己的旧事
  'fish_now', // 读现在是什么时候
  'check_body', // 赛博体温计
  'fish_read_file', // 读工作区 / 自己状态库的文本文件
  'fish_list_dir', // 看工作区的目录结构
  'qq_bridge_send', // 回一句话（replyMode='tool' 时是唯一通道）
  // 2026-11-05 起常驻：表情包是她聊天的一部分（吐槽 / 安慰 / 存图），
  // 按意图临时放开反而让她在该用时看不见。引导句在 fish:senses 段。
  'qq_bridge_sticker', // 表情包：list / save / send
])

/** 重工具 / 高级工具：默认收起来，命中意图才在当轮放开。 */
export const EXT_TOOLS = Object.freeze([
  'work_request', // 把要动手做的事派到工作区
  'fish_decorate_room', // 赛博小屋装修
  'fish_check_topology', // 小屋空间检查
  'fish_search_history', // 双层记忆：按关键词翻摘要
  'fish_read_raw', // 双层记忆：按门牌号读原话
  'her_leave', // 留一句话给他
  'read_user_rhythm', // 看他今天的工作节奏
  'bili_look', // 看 B 站列表
  'bili_watch', // 看视频画面
  'bili_speak', // 在 B 站评论区说话
  'image_look', // 看一张图
  'qq_bridge_send_multi', // 分条发送
  'qq_bridge_subsend', // 主人点名私聊给指定的人
  'qq_bridge_listen', // 会话跟随窗口
  'qq_bridge_fileget', // 文件发给主人
  'qq_bridge_filesend', // 文件发给指定的人
  'qq_bridge_send_voice', // 预留给未来的语音工具（当前宿主没有）
  'gis_buffer_query', // 小屋空间查询：以小鱼为中心画圈看周围有什么（纯只读）
  'gis_delete_feature', // 小屋空间编辑：删家具 / 要素，同步刷新 A* 栅格
])

/**
 * 意图字典。顺序会影响 extraPrompt 的先后，不影响正确性。
 *
 * 正则刻意保持「宽进」：宁可多放开一个工具，也不要她明明该做却看不见。
 * 真正危险的工具（subsend / 发文件 / 派活）另有身份闸门或工作区沙箱兜底，
 * 这里只负责“这一轮让她看得见”。
 */
export const TOOL_INTENTS = Object.freeze([
  {
    id: 'decorate',
    re: /(装修|加个|摆个|挪一下|家具)/,
    tools: ['fish_decorate_room'],
    hint: '[系统：你已获得装修权限，可调用 fish_decorate_room 布置房间。]',
  },
  {
    id: 'work',
    re: /(写|代码|爬虫|跑一下|做个|修一下)/,
    tools: ['work_request'],
    hint: '[系统：你已获得派活权限，请用 work_request 把任务丢给工作区。]',
  },
  {
    id: 'recall',
    re: /(以前|记得|查一下|回忆|之前)/,
    tools: ['fish_search_history', 'fish_read_raw'],
    hint: '[系统：你可以使用记忆检索工具寻找过去的对话。摘要可能失真，重要细节请用 fish_read_raw 回原文核对，别基于残片硬推。]',
  },
  // 2026-11-05：原 media 规则（表情 / 语音 → qq_bridge_sticker）已整个删掉 ——
  // 表情包工具进了 BASE_TOOLS，每轮都在，不需要再靠意图开门。原来一并挂着的
  // qq_bridge_send_voice 目前宿主里根本没有注册，连同规则一起去掉不损失什么；
  // 等语音工具真上线了再单独写一条规则。
  {
    id: 'image',
    re: /(图片|照片|截图|看图|图像)/,
    tools: ['image_look'],
    hint: '[系统：你可以用 image_look 看这张图；file_path 照抄正文「[图片 path=…]」里的路径（正斜杠）。描述可能不准，路径指向的才是图。]',
  },
  {
    id: 'bili',
    re: /(b站|视频|bilibili|bv[0-9a-z]{10}|b23\.tv|弹幕|up主|刷站|封面)/i,
    tools: ['bili_look', 'bili_watch', 'bili_speak'],
    hint: '[系统：你可以用 bili_look 看列表、bili_watch 看视频画面；想在评论区说话再用 bili_speak。]',
  },
  {
    id: 'leave',
    re: /(留句话|留一句|留言|说给他|给他留)/,
    tools: ['her_leave'],
    hint: '[系统：你可以用 her_leave 留一句话给他。]',
  },
  {
    id: 'rhythm',
    re: /(节奏|作息|在干嘛|忙不忙|睡了没|在做什么)/,
    tools: ['read_user_rhythm'],
    hint: '[系统：你可以用 read_user_rhythm 看他今天的工作节奏。]',
  },
  {
    id: 'topology',
    re: /(堵住|堵了|重叠|撞到|摆歪|空间检查|检查.*(房间|布局))/,
    tools: ['fish_check_topology'],
    hint: '[系统：你可以用 fish_check_topology 检查家具是否重叠或堵路。]',
  },
  {
    id: 'gis-buffer',
    re: /(周围|附近|周围有什么|缓冲区|视野内|圈内)/,
    tools: ['gis_buffer_query'],
    hint: '[系统：你已获得空间查询权限，可调用 gis_buffer_query 查看周围范围。]',
  },
  {
    id: 'gis-delete',
    // 任务书正则是 (删掉|删除|清理|移除|拆掉)，但验收句是「把沙发删了」——
    // 「删了」不在里面。补上「删了」这个口语形式，其余 disbelief 保持原样。
    re: /(删掉|删除|清理|移除|拆掉|删了)/,
    tools: ['gis_delete_feature'],
    hint: '[系统：你已获得空间编辑权限，可调用 gis_delete_feature 清理家具或障碍物。]',
  },
  {
    id: 'multi',
    re: /(分条|分几句|多发几条|一条一条|几句话分)/,
    tools: ['qq_bridge_send_multi'],
    hint: '[系统：你可以用 qq_bridge_send_multi 分条发送（1–3 条）。调过它之后这一轮不要再写 [QQ] 块，否则整段会被丢弃（避免重复发送）。]',
  },
  {
    id: 'listen',
    re: /(听一会|听着|跟着聊|别插嘴|旁观)/,
    tools: ['qq_bridge_listen'],
    hint: '[系统：你可以用 qq_bridge_listen 开一段会话跟随（默认 5 分钟、上限 60 分钟）；话题结束或答完了就带 off:true 关掉，别无脑常开。]',
  },
  // ⚠️ subsend / fileget / filesend **不放这里**。它们不是“看关键词就开门”的意图：
  // 是否算指令由桥接层先判（主人/管理员、开关、解析成功），没通过就只是普通聊天。
  // 如果在这里按正文前缀匹配，群友打一句“subsend 123 ...”也会被解锁——
  // 那等于绕过出站闸门。它们由 handleInbound 在命令真的解析出来后单独添加。
])

/**
 * 根据一条 QQ 消息算出这一轮要放开的工具和附带的短说明。
 *
 * 纯函数：不碰宿主、不读设置，方便单测。`hasImages` 由调用方按**本条消息**
 * 是否带图传入（不要拿整段缓冲算，那会把上一条图的权限漏到这一轮）。
 *
 * 2026-11-05：`hasStickers` 入参已删 —— 表情包工具进了基础池，不再需要
 * 「检测到表情包就当轮强制挂载」这条特殊路径。
 *
 * @param {string} text 用户这一条消息的正文
 * @param {{ hasImages?: boolean }} [opts]
 * @returns {{ tools: string[], hints: string[], ids: string[], prompt: string }}
 */
export function routeToolIntent(text, { hasImages = false } = {}) {
  const raw = String(text ?? '')
  const tools = []
  const hints = []
  const ids = []
  const add = (name) => {
    if (!tools.includes(name)) tools.push(name)
  }
  for (const rule of TOOL_INTENTS) {
    if (!rule.re.test(raw)) continue
    ids.push(rule.id)
    for (const t of rule.tools) add(t)
    hints.push(rule.hint)
  }
  if (hasImages) {
    if (!ids.includes('image')) {
      ids.push('image')
      add('image_look')
      hints.push('[系统：你可以用 image_look 看这张图；file_path 照抄正文「[图片 path=…]」里的路径（正斜杠）。描述可能不准，路径指向的才是图。]')
    }
  }
  // 去重说明（同一条图既命中 image 正则又带图时只留一句）
  const uniqHints = [...new Set(hints)]
  return { tools, hints: uniqHints, ids, prompt: uniqHints.join('\n') }
}
