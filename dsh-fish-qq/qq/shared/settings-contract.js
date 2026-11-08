// qq/shared/settings-contract.js
//
// QQ 桥接设置的**唯一清单**（一份清单生成多处）：
//   - 宿主半 qq/index.js：readSettings 的归一化 + knownSettingKeys 的键集合；
//   - 浏览器半 qq/client/client.js：设置卡片的字段（由 scripts/build-bundle.mjs
//     在构建时序列化注入成 __INJECTED_CONTRACT，见该脚本）。
//
// 这里只放**能同时被 Node 和构建脚本消费**的纯数据 + 纯函数：
// 不要 import 任何东西，也不要引用宿主对象。
//
// 目前只搬了 3 个 select 字段（replyMode / delivery / checklogNotifyMode）；
// 其余键仍在 index.js 的 BridgeSettings / Config 里，后续再迁。

export const SETTINGS_CONTRACT = [
  {
    key: 'replyMode',
    group: 'outbound',
    kind: 'select',
    label: '出站方式',
    options: [['marker', '标记块（默认）'], ['tool', '工具调用'], ['always', '整轮都发']],
    hint: '标记块 = 只发块里的内容；工具调用 = 用 qq_bridge_send 发（每轮多一次模型调用）；整轮都发 = 技术内容也会进群，慎用。',
    default: 'marker',
    normalize: (v) => (v === 'always' || v === 'tool' ? v : 'marker'),
    schema: { type: 'string' },
    secret: false,
  },
  {
    key: 'delivery',
    group: 'wake',
    kind: 'select',
    label: '投递方式',
    options: [['auto', '自动（忙时插话）'], ['followup', '排队'], ['steer', '总是插话']],
    hint: 'QQ 消息怎么进目标会话：自动 = 目标正忙就插话、空闲时排队；排队 = 永远排成独立一轮；总是插话 = 无论忙闲都插。',
    default: 'auto',
    normalize: (v) => (v === 'followup' || v === 'steer' ? v : 'auto'),
    schema: { type: 'string' },
    secret: false,
  },
  {
    key: 'checklogNotifyMode',
    group: 'outbound',
    kind: 'select',
    label: '任务完成通知',
    options: [['off', '关（默认）'], ['system', '系统模板'], ['agent', '让她自己说']],
    hint: 'CheckLogs/ 里写了任务完成日志后怎么通知：关 = 什么都不说；系统模板 = 插件直接发一条；让她自己说 = 投进她的会话，让她用自己的话说。',
    default: 'off',
    normalize: (v) => (v === 'system' || v === 'agent' ? v : 'off'),
    schema: { type: 'string' },
    secret: false,
  },
]
