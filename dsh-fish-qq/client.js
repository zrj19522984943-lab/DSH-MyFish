/**
 * dsh-fish-qq —— 浏览器半（一个 bundle 里同时装两边的设置页）
 *
 * 这个文件是**生成的**（见仓库根的 build-bundle.mjs）。别手改：
 * 改 fish/lib/client.js 或 qq/client/client.js，再重新构建。
 *
 * 为什么不是两个文件：DSH 一个包只有一个客户端入口，而且 bundle 的注册 id
 * 必须等于包名。所以这里把两边各自的 factory 拆成普通函数，
 * 再用**一个** load({ id: 'dsh-fish-qq' }) 装起来，由外层 apply 分发给两边的插件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fish-qq',
  factory: (require) => {
    // 告诉 QQ 半边「宿主给这个插件登记的 entry id」。
    // 0.2.0 的插件配置页按 entry id 派发卡片，而 QQ 半边自己的 settings 命名空间还是
    // qq-bridge；合并之后 entry id 变成 dsh-fish-qq，不说这一句它会按旧键注册
    // → 设置页里一张卡片都不出现（2026-10-26 真机）。独立安装时这个全局不存在，
    // QQ 半边回落成自己的命名空间，行为不变。
    try { globalThis.__DSH_QQ_BRIDGE_HOST_ID__ = 'dsh-fish-qq' } catch { /* 非浏览器环境忽略 */ }

    const fish = __fishFactory(require)
    const qq = __qqFactory(require)

    // 两边的 Cordis 插件形状合并：apply 依次调，inject 取并集。
    // config 用 { fish: {...}, qq: {...} } 分槽，避免两个插件的键互相覆盖
    // （比如 fish 的 root 和 qq 的 targetSessionId 都想要“顶层同名”这种位置）。
    const inject = [...new Set([...(fish.inject ?? []), ...(qq.inject ?? [])])]

    function apply(ctx, config) {
      fish.apply?.(ctx, config?.fish)
      qq.apply?.(ctx, config?.qq)
    }

    return { name: 'dsh-fish-qq', inject, apply }
  },
})

// ─────────────────────────── 大肥鱼的设置页（原样搬运） ───────────────────────────
function __fishFactory(require) {

    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const API = '/dsh-fish'
    const NS = 'fish'

    // ------------------------------------------------- 工具名白名单（2026-10-24）
    // 客户端就地实现一份，规则与 lib/settings.js 的 validateToolNames 一致
    // （那份是 node 模块，这边只能 require('react')，拿不到）。
    // 真正的拦截在服务端 /config：拼错的名字连盘都写不进去。
    const TOOL_NAME_RE = /^[a-z][a-z0-9_-]*$/
    function parseToolNames(input) {
      // 与 lib/settings.js 同一份规则：数组里夹带逗号也要再拆一次
      const raw = (Array.isArray(input) ? input : [input]).flatMap((x) => String(x ?? '').split(/[,，\s]+/))
      const seen = new Set()
      const out = []
      for (const x of raw) {
        const s = x.trim()
        if (!s || seen.has(s)) continue
        seen.add(s)
        out.push(s)
      }
      return out
    }
    function checkToolNames(input, known) {
      const names = parseToolNames(input)
      const set = Array.isArray(known) && known.length ? new Set(known.map(String)) : null
      const unknown = names.filter((n) => !TOOL_NAME_RE.test(n) || (set && !set.has(n)))
      return { ok: unknown.length === 0, names, unknown, checked: Boolean(set) }
    }

    // ---------------------------------------------------------------- 样式
    const CSS_TAG = 'dsh-fish/section.css'
    const CSS = [
      '.dfish{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}',
      '.dfish h2{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dfish .sub{color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:19px;margin:0}',
      '.dfish .card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px}',
      '.dfish .card>h3{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);text-transform:uppercase}',
      '.dfish .kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:13px;line-height:19px}',
      '.dfish .kv b{color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.dfish ul{margin:0;padding-left:17px;font-size:13px;line-height:20px}',
      '.dfish li{margin:3px 0}',
      '.dfish .tag{display:inline-block;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px}',
      '.dfish pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);font-family:ui-monospace,Consolas,monospace}',
      '.dfish .empty{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0}',
      '.dfish .dim{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dfish .err{color:#e5484d;font-size:12.5px;white-space:pre-wrap}',
      '.dfish .ok{color:#30a46c;font-size:12.5px;white-space:pre-wrap}',
      '.dfish .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.dfish .form{display:flex;flex-direction:column;gap:9px;font-size:13px}',
      '.dfish .form label{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dfish input[type=number]{width:62px;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:26px;padding:0 7px;outline:none}',
      '.dfish input[type=text]{flex:1;min-width:200px;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:26px;padding:0 7px;outline:none}',
      '.dfish button{background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 12px;cursor:pointer}',
      '.dfish button:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dfish button:disabled{opacity:.5;cursor:default}',
      '.dfish textarea{width:100%;box-sizing:border-box;min-height:66px;resize:vertical;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:8px 10px;outline:none}',
      '.dfish .said{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:21px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px;margin:6px 0}',
      '.dfish .badge{display:inline-block;min-width:16px;text-align:center;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:10.5px;line-height:16px;margin-left:6px}',
      '.dfish .tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:5px;background:rgba(128,128,128,.06)}',
      '.dfish .tab{background:transparent;border:.5px solid transparent;border-radius:7px;height:28px;padding:0 11px;font-size:12.5px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));cursor:pointer}',
      '.dfish .tab:hover{color:var(--dsw-alias-label-primary);background:rgba(128,128,128,.12)}',
      // 选中态踩过两次坑（2026-10-25 用户真机截图暴露）：
      // ① 最初写死 color:#fff —— 深色主题下白字压白底，整片看不见；
      // ② 改成 brand-primary 当底色 —— 那其实是「正文墨色」（浅色 #0f1115 近黑 / 深色 #f9fafb 近白），
      //    于是浅色主题出现黑块、深色主题出现白块，仍然难看。
      // 正确做法：底色只用中性的浅罩层，强调靠 state-business-primary 的字色和描边。
      '.dfish .tab.on{background:rgba(128,128,128,.18);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-state-business-primary);font-weight:500}',
      '.dfish .tab.on:hover{color:var(--dsw-alias-state-business-primary);background:rgba(128,128,128,.24)}',
      '.dfish .tabs .grow{flex:1}',
      '.dfish .tabhint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:-6px 0 0}',
      '.dfish .page{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;align-items:start}',
      '.dfish .page>.card{min-width:0}',
      '.dfish .card.full{grid-column:1 / -1}',
      '.dfish .grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 18px}',
      '.dfish .fld{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.dfish .fl{display:flex;flex-direction:column;gap:2px}',
      '.dfish .flabel{font-size:13px;line-height:19px}',
      '.dfish .fhint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dfish .hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin:0}',
      '.dfish .warn{font-size:12px;line-height:18px;color:#b8860b;margin:6px 0}',
      // 下拉框（2026-10-25 用户真机反馈：暗色下「只有一个白条」，字全看不见）。
      // 根因：select 背景写的是 transparent，原生控件在深色主题里会用 UA 白底绘制，
      // 而字色是 label-primary（深色主题下接近白）——白底白字。option 弹层同理。
      // 修法：底色改成主题的不透明层色，option 显式给同一组底色/字色，
      // color-scheme 继承 <html> 上宿主设的 dark/light（原生弹层跟着切换）。
      '.dfish select{height:28px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background-color:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,CanvasText);color-scheme:inherit;font-size:12.5px;padding:0 8px;outline:none;cursor:pointer;max-width:240px}',
      '.dfish select option{background-color:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,CanvasText)}',
      '.dfish input[type=time]{height:28px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background-color:var(--dsw-alias-bg-layer-1,Field);color:var(--dsw-alias-label-primary,CanvasText);color-scheme:inherit;font-size:12.5px;padding:0 6px;outline:none}',
      '.dfish .step{width:26px;height:26px;padding:0;border-radius:6px;font-size:14px;line-height:1}',
      // 日记翻页条（2026-10-26）：日期多于一天才出现，一行放得下三个元素就够。
      '.dfish .pager{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 8px}',
      '.dfish .pager button{height:24px;padding:0 10px;font-size:12px;border-radius:6px}',
      '.dfish .pager .dim{font-size:12px;font-variant-numeric:tabular-nums}',
      '.dfish .sw{position:relative;width:40px;height:22px;padding:0;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:rgba(128,128,128,.18);cursor:pointer;transition:background .15s}',
      '.dfish .sw .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}',
      '.dfish .sw.on{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
      '.dfish .sw.on .knob{left:20px}',
      '.dfish .savebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:4px}',
      '.dfish button.primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,#fff)}',
      '.dfish button.primary:hover:not(:disabled){opacity:.9;color:var(--dsw-alias-label-primary-inverted,#fff)}',
      // GitHub 链接（2026-10-25 用户要求）：商标小图 + 文字，点开新窗口。
      // 用 inline-flex 让 icon 和文字基线对齐；hover 只换颜色不动位置。
      '.dfish .ghlink{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-decoration:none;border-radius:6px;padding:2px 4px;margin-left:-4px}',
      '.dfish .ghlink:hover{color:var(--dsw-alias-state-business-primary);background:rgba(128,128,128,.1)}',
      '.dfish .ghlink svg{flex:0 0 auto}',
    ].join('\n')

    function useStyleOnce() {
      useEffect(() => {
        if (document.querySelector(`style[data-tag="${CSS_TAG}"]`)) return
        const el = document.createElement('style')
        el.setAttribute('data-tag', CSS_TAG)
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    // ---------------------------------------------------------------- 工具
    const esc = (s) => String(s == null ? '' : s)

    /**
     * 把质量指标渲染成两位小数。
     *
     * 为什么要有这个函数（2026-10-23，观测台空白页的根因）：
     *   宿主那边 `/state` 的 quality 不是数字，是带样本量的结构体
     *   `{ stability: { score, sample, worst }, consistency: { score, pairs }, novelty: { score, recent, older } }`
     *   （样本太少时故意不报裸分数，避免"看数字调性格"）。
     *   而这里原来写的是 `s.quality.stability.toFixed(2)` —— 对一个对象调 toFixed，
     *   React 渲染抛 TypeError，整节被错误边界吞掉，用户看到的就是**设置页一片空白**。
     *   所以这里同时接受数字和 `{score}` 两种形态，取不到就给 em dash，绝不再抛。
     */
    function q2(v) {
      const n = typeof v === 'number' ? v : Number(v && v.score)
      return Number.isFinite(n) ? n.toFixed(2) : '—'
    }

    async function jget(path) {
      const r = await fetch(API + path, { headers: { accept: 'application/json' } })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        const hint = r.status === 401 || r.status === 403 ? '（被信任栅栏拒绝：请在 App 内打开这一页）' : ''
        throw new Error(`HTTP ${r.status}${hint} ${j.error || ''}`.trim())
      }
      return j
    }

    async function jpost(path, body) {
      const r = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body == null ? {} : body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      return j
    }

    // ---------------------------------------------------------------- 组件
    function FishSection() {
      useStyleOnce()
      const [state, setState] = useState(null)
      const [beliefs, setBeliefs] = useState(null)
      const [events, setEvents] = useState([])
      const [diary, setDiary] = useState(null)
      const [browse, setBrowse] = useState(null)
      const [reports, setReports] = useState({ dates: [], date: null, md: '' })
      const [inbox, setInbox] = useState(null)
      const [home, setHome] = useState(null)
      const [mem, setMem] = useState(null)
      // 规则与解禁（R3，2026-10-24）：四层规则 + 她提上来的那一张申请
      const [rules, setRules] = useState(null)
      const [st, setSt] = useState(null)
      const [rotateAfter, setRotateAfter] = useState(40)
      const [docBudget, setDocBudget] = useState(1800)
      const [beliefsShown, setBeliefsShown] = useState(3)
      const [toolsAllowText, setToolsAllowText] = useState('')
      const [toolsRestrict, setToolsRestrict] = useState(true)
      // 白名单草稿态（2026-10-24，用户要求）：输入框里的字先不提交，
      // 点「保存设置」才写盘——否则敲一半就被页面其它地方的保存带上去，拼错一个字母整条收窄失效。
      const [toolsAllowSaved, setToolsAllowSaved] = useState([])
      const [toolsKnown, setToolsKnown] = useState(null)
      const [toolsSaveNote, setToolsSaveNote] = useState('')
      const [toolsSaveErr, setToolsSaveErr] = useState('')
      // 运行日志（2026-10-24）：只在点开时才读，不参与 30 秒轮询。
      const [logTail, setLogTail] = useState(null)
      const [logBusy, setLogBusy] = useState(false)
      // 备份与恢复（2026-10-25）：只在数据页用，不进轮询。
      const [backupBusy, setBackupBusy] = useState(false)
      const [backupMsg, setBackupMsg] = useState('')
      let topEl = null
      const [sayText, setSayText] = useState('')
      const [said, setSaid] = useState([])
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      // 设置界面重做（2026-10-23）：当前页 + 新增的几个环境项
      const [tab, setTab] = useState('now')
      const [growthDaysUi, setGrowthDaysUi] = useState(30)
      const [diaryKeep, setDiaryKeep] = useState(0)
      const [browseDeepRead, setBrowseDeepRead] = useState(6)
      // 评论区里别人的话（2026-10-24，用户 m02454）：默认开，每次最多留 1 条。
      const [browseVoices, setBrowseVoices] = useState(true)
      const [videoOn, setVideoOn] = useState(true)
      const [videoPerDay, setVideoPerDay] = useState(2)
      const [videoFrames, setVideoFrames] = useState(9)
      const [avoidMinDur, setAvoidMinDur] = useState(60)
      const [avoidMids, setAvoidMids] = useState('')
      const [sleepEvery, setSleepEvery] = useState(7)
      const [sleepKeep, setSleepKeep] = useState(12)

      // 生长环境（可编辑的那几项）
      const [absent, setAbsent] = useState(2)
      const [diaryVisible, setDiaryVisible] = useState(false)
      const [diaryEnabled, setDiaryEnabled] = useState(true)
      const [wakes, setWakes] = useState(1)
      const [eventsPerDay, setEventsPerDay] = useState(1)
      const [questionsPerDay, setQuestionsPerDay] = useState(1)
      const [avoidText, setAvoidText] = useState('')
      // 刷站（全是环境参数：她今天能不能出门、一次看见几条，不是她爱看什么）
      const [browseOn, setBrowseOn] = useState(true)
      const [browsePerDay, setBrowsePerDay] = useState(1)
      const [browseTopN, setBrowseTopN] = useState(4)
      const [browseDanmaku, setBrowseDanmaku] = useState(6)
      // 桌面提醒（P3-3 重写）：默认关，由他自己打开
      const [notifyOn, setNotifyOn] = useState(false)
      // 浏览器通知权限 + 弹不出来时的页面内气泡
      const [notifyPerm, setNotifyPerm] = useState('default')
      const [bubble, setBubble] = useState('')
      // 在 B 站说话（P4）：默认关。这是唯一会动她账号的功能。
      const [commentOn, setCommentOn] = useState(false)
      const [commentPerDay, setCommentPerDay] = useState(1)
      const [commentReplyPerDay, setCommentReplyPerDay] = useState(2)
      const [commentReplyTo, setCommentReplyTo] = useState(true)
      const [commentScanMin, setCommentScanMin] = useState(30)
      const [cm, setCm] = useState(null)
      // 时段（2026-10-23 加）：醒来 / 上网 / 说话，三段各自可调
      const [wakeFrom, setWakeFrom] = useState('20:00')
      const [wakeTo, setWakeTo] = useState('23:00')
      const [browseFrom, setBrowseFrom] = useState('08:00')
      const [browseTo, setBrowseTo] = useState('23:00')
      const [commentFrom, setCommentFrom] = useState('20:00')
      const [commentTo, setCommentTo] = useState('23:00')
      // 重置
      const [resetInfo, setResetInfo] = useState(null)
      const [resetAsk, setResetAsk] = useState(false)
      // 看过什么 / 自检 / 风控（2026-10-23 加）
      const [hist, setHist] = useState({ groups: [], total: 0 })
      const [histDays, setHistDays] = useState(14)
      const [checks, setChecks] = useState(null)
      const [checking, setChecking] = useState(false)
      const [risk, setRisk] = useState(null)
      // 你不在的时候（2026-10-23 加）
      const [away, setAway] = useState(null)
      // 设置界面 2.0（2026-10-24）：观看历史分页 + 报告默认收起
      const [histPage, setHistPage] = useState(0)
      const [showReport, setShowReport] = useState(false)
      // 主人是谁 + B 站登录（2026-10-23 加）
      const [ow, setOw] = useState(null)
      const [owMid, setOwMid] = useState('')
      const [owName, setOwName] = useState('')
      const [owCookie, setOwCookie] = useState('')
      const [atOwner, setAtOwner] = useState(true)
      const [owNote, setOwNote] = useState('')
      // 数据文件夹的真路径。**只在内存里用，不上屏**（用户 m03440）。
      const [dataPaths, setDataPaths] = useState(null)
      // 头像（2026-10-24）：插件不自带任何图片，谁用谁自己传一张
      const [avatarV, setAvatarV] = useState(0)
      const [avatarPresent, setAvatarPresent] = useState(false)
      const [avatarBytes, setAvatarBytes] = useState(0)
      const [avatarBusy, setAvatarBusy] = useState(false)
      const [avatarNote, setAvatarNote] = useState('')
      // 自动保存（2026-10-24 用户）：设置项改完就生效，不再需要滚到底点保存。
      const [autoNote, setAutoNote] = useState('')
      // 首屏载入完先把基线记下来，否则一打开页面就会把刚读到的配置又写回去一遍。
      const baselinePending = useRef(true)
      const lastSaved = useRef('')
      // 原理页两张图：点开看原图，滚轮缩放、按住拖动（2026-10-25 用户：插件里看不清）。
      const [zoom, setZoom] = useState(null)
      const dragRef = useRef(null)
      // 2026-10-25：单轮回复字数预算（0 = 不限，默认就不提任何长度要求）
      const [replyChars, setReplyChars] = useState(0)
      // B 站登录提示卡：他点过「不用了」就别再出现（存进 config.ui）
      const [uiHintDismissed, setUiHintDismissed] = useState(false)
      // 检查更新（2026-10-25 用户要求）：null=还没查过，{...}=查过。
      // 只有点按钮才查，不自动轮询——她运行期不该操心自己是几号版本。
      const [upd, setUpd] = useState(null)
      const [updBusy, setUpdBusy] = useState(false)
      // 日记翻页（2026-10-26 用户 m01201）：一天一页、日期多于一天才出翻页按钮。
      // 正文按天取（`/diary?day=…`），翻过的缓存进 ref，来回翻不重复请求。
      const [diaryDay, setDiaryDay] = useState(0)
      const diaryCache = useRef({})
      const diaryLoaded = useRef(false)
      const [, setDiaryTick] = useState(0)

      // 当前这天的正文没缓存就去取一次（一页一天，不预取；翻回去靠缓存）。
      const diaryDates = diary?.dates ?? []
      const diaryIdx = Math.min(Math.max(diaryDay, 0), Math.max(diaryDates.length - 1, 0))
      const diaryCur = diaryDates[diaryIdx] ?? null
      useEffect(() => {
        if (!diaryCur || diaryCache.current[diaryCur] !== undefined) return undefined
        let dead = false
        jget(`/diary?day=${diaryCur}`)
          .then((r) => {
            if (dead) return
            diaryCache.current[diaryCur] = r?.text ?? ''
            setDiaryTick((n) => n + 1)
          })
          .catch(() => {})
        return () => { dead = true }
      }, [diaryCur])

      useEffect(() => {
        if (!zoom) return undefined
        const onKey = (e) => { if (e.key === 'Escape') setZoom(null) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [zoom])

      const load = useCallback(async () => {
        setErr('')
        // 重新读盘之后要重新记基线（撤销 / 刷新都走这里）。
        baselinePending.current = true
        try {
          const s = await jget('/state')
          setState(s)
          setAbsent(Number(s.config?.absenceAfterDays ?? 2))
          setDiaryVisible(Boolean(s.config?.diary?.visible))
          setDiaryEnabled(Boolean(s.config?.diary?.enabled))
          setWakes(Number(s.config?.wakesPerDay ?? 1))
          setEventsPerDay(Number(s.config?.daily?.events ?? 1))
          setQuestionsPerDay(Number(s.config?.daily?.questions ?? 1))

          const [b, e, d, c, br, ib, hm, pth] = await Promise.all([
            jget('/beliefs'),
            jget('/events?limit=25'),
            jget('/diary'),
            jget('/config'),
            jget('/browse'),
            jget('/inbox?limit=60').catch(() => null),
            jget('/home').catch(() => null),
            jget('/paths').catch(() => null),
          ])
          setBeliefs(b)
          setEvents(e.rows || [])
          setDiary(d)
          // 首天正文随 /diary 一起回来了，先灌进翻页缓存（省一次往返）。
          for (const it of d?.items ?? []) diaryCache.current[it.date] = it.text
          // 只有第一次载入才跳到最新一天：30 秒轮询不该把人正在看的那页弹走。
          if (!diaryLoaded.current) {
            setDiaryDay(0)
            diaryLoaded.current = true
          }
          setBrowse(br)
          setInbox(ib)
          setHome(hm)
          setDataPaths(pth)
          // 上下文与记忆：单独取，失败不影响其它卡片
          jget('/memory').then(setMem).catch(() => {})
          // 她以前看过什么 / 风控状态：都是只读，失败不影响其它卡片
          jget(`/history?days=${histDays}`).then(setHist).catch(() => {})
          jget('/risk').then(setRisk).catch(() => {})
          jget('/away').then(setAway).catch(() => {})
          // 头像元信息（有没有、多大）。没有就是空圈，不回落任何内置图。
          jget('/avatar/info').then((r) => {
            setAvatarPresent(Boolean(r && r.present))
            setAvatarBytes(Number(r && r.bytes) || 0)
          }).catch(() => {})
          // 规则与解禁（R3）：失败不影响其它卡片
          jget('/rules').then(setRules).catch(() => {})
          // 运行日志：失败就当没这回事（日志本身坏了不该拖垮设置页）
          jget('/log?lines=40').then(setLogTail).catch(() => {})
          // 报告：先拿日期列表，再取最新那天的正文（失败不影响其它卡片）
          jget('/reports').then(async (r) => {
            if (!r.dates?.length) return setReports(r)
            const one = await jget(`/reports?date=${r.dates[0]}`)
            setReports(one)
          }).catch(() => {})
          const cfg = c.config || {}
          setAbsent(Number(cfg.absenceAfterDays ?? 2))
          setWakes(Number(cfg.wakesPerDay ?? 1))
          setEventsPerDay(Number(cfg.daily?.events ?? 1))
          setQuestionsPerDay(Number(cfg.daily?.questions ?? 1))
          setAvoidText(((cfg.avoid?.keywords) || []).join('，'))
          setBrowseOn(cfg.browse?.enabled !== false)
          setBrowsePerDay(Number(cfg.browse?.perDay ?? 1))
          setBrowseTopN(Number(cfg.browse?.topN ?? 4))
          setBrowseDanmaku(Number(cfg.browse?.danmaku ?? 6))
          setNotifyOn(cfg.notify?.enabled === true)
          setCommentOn(cfg.comment?.enabled === true)
          setCommentPerDay(Number(cfg.comment?.perDay ?? 1))
          setCommentReplyPerDay(Number(cfg.comment?.replyPerDay ?? 2))
          setCommentReplyTo(cfg.comment?.replyToReplies !== false)
          setCommentScanMin(Number(cfg.comment?.scanEveryMin ?? 30))
          setRotateAfter(Number(cfg.chat?.rotateAfter ?? 40))
          setReplyChars(Number(cfg.chat?.replyChars ?? 0))
          setUiHintDismissed(cfg.ui?.ownerHintDismissed === true)
          setToolsAllowText((cfg.tools?.allow ?? []).join(', '))
          setToolsAllowSaved(Array.isArray(cfg.tools?.allow) ? cfg.tools.allow.map(String) : [])
          setToolsRestrict(cfg.tools?.restrict !== false)
          setDocBudget(Number(cfg.memory?.docBudget ?? 1800))
          setBeliefsShown(Number(cfg.memory?.beliefsShown ?? 3))
          setGrowthDaysUi(Number(cfg.growthDays ?? 30))
          setDiaryKeep(Number(cfg.diary?.keepDays ?? 0))
          setBrowseDeepRead(Number(cfg.browse?.deepRead ?? 6))
          setBrowseVoices(cfg.browse?.voices !== false)
          setVideoOn(cfg.video?.enabled !== false)
          setVideoPerDay(Number(cfg.video?.perDay ?? 2))
          setVideoFrames(Number(cfg.video?.frames ?? 9))
          setAvoidMinDur(Number(cfg.avoid?.minDuration ?? 60))
          setAvoidMids(((cfg.avoid?.upMids) || []).join('，'))
          setSleepEvery(Number(cfg.memory?.sleepEveryDays ?? 7))
          setSleepKeep(Number(cfg.memory?.sleepKeep ?? 12))
          // 时段：醒来 / 上网 / 说话。坏值由服务端兜底，这里只做展示。
          const w0 = Array.isArray(cfg.window) ? cfg.window : ['20:00', '23:00']
          setWakeFrom(w0[0]); setWakeTo(w0[1])
          const b0 = Array.isArray(cfg.browse?.window) ? cfg.browse.window : ['08:00', '23:00']
          setBrowseFrom(b0[0]); setBrowseTo(b0[1])
          const c0 = Array.isArray(cfg.comment?.window) ? cfg.comment.window : ['20:00', '23:00']
          setCommentFrom(c0[0]); setCommentTo(c0[1])
          // 说话状态：单独取，失败不影响其它卡片
          jget('/comment').then(setCm).catch(() => {})
          jget('/reset').then(setResetInfo).catch(() => {})
          // 主人是谁（uid / 昵称 / 有没有 cookie）。cookie 原文永远不下发。
          jget('/owner').then((o) => {
            setOw(o)
            setOwMid(String(o?.mid ?? ''))
            setOwName(String(o?.name ?? ''))
            setAtOwner(o?.atOwner !== false)
          }).catch(() => {})
        } catch (e) {
          setErr(e.message)
        }
      }, [])

      useEffect(() => { load() }, [load])

      // 在线状态每 30 秒刷一次；页面在后台就不轮询（省电，也不制造无谓请求）。
      // 2026-10-23 加：他要能看见「醒了但没做什么」这种状态，而不是只有结果。
      useEffect(() => {
        let stop = false
        const peek = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try { const r = await jget('/status'); if (!stop) setSt(r) }
          catch { if (!stop) setSt({ phase: 'offline', label: '离线', detail: '服务没开，或者插件没加载' }) }
        }
        peek()
        const t = setInterval(peek, 30_000)
        return () => { stop = true; clearInterval(t) }
      }, [])

      // ---- 说话提醒（P3-3 重写，2026-10-23）----
      // 服务端只回答"该不该提醒、提醒什么"（GET /notify 的 due/text），
      // **弹是这里的事**。原实现调隐藏 PowerShell 弹 WinRT Toast，被火绒当
      // 木马行为拦下；更糟的是静默拦截时没有任何错误返回，lastShown 照样
      // 被写掉 → 当天再也不会弹。现在只用浏览器自己的能力，不产生任何子进程。
      //
      // 页面关着就不会有提醒——这是他本人接受的取舍（m05389）：第二天打开
      // 观测台照样能看到她说过什么。
      useEffect(() => {
        const has = typeof window !== 'undefined' && 'Notification' in window
        setNotifyPerm(has ? window.Notification.permission : 'unsupported')
        let stop = false
        const poll = async () => {
          try {
            const r = await jget('/notify')
            if (stop || !r?.due || !r?.text) return
            let shown = false
            if (has && window.Notification.permission === 'granted') {
              try {
                new window.Notification('大肥鱼跟你说话', { body: r.text, tag: 'dsh-fish' })
                shown = true
              } catch { /* 系统禁了就退到气泡 */ }
            }
            // 弹不出来也要让他看见——不然这条提醒就白记了
            if (!shown) setBubble(r.text)
            await jpost('/notify', { shown: true })
          } catch { /* 轮询失败不打扰他 */ }
        }
        poll()
        const t = setInterval(poll, 60_000)
        return () => { stop = true; clearInterval(t) }
      }, [])

      const allowNotify = async () => {
        try {
          if (typeof window === 'undefined' || !('Notification' in window)) {
            setErr('这个浏览器不支持桌面通知，大肥鱼说话时我只能在页面里提示你。')
            return
          }
          const p = await window.Notification.requestPermission()
          setNotifyPerm(p)
          setNote(p === 'granted'
            ? '好了，大肥鱼说话时会在系统里提醒你（一天最多一次）。'
            : '没拿到通知权限——那就在页面顶上提示你，效果一样的。')
        } catch (e) { setErr(e.message) }
      }


      // 只提交"环境"字段。她的性格相关的键一个都不在这里（B §8）。
      // 手动按钮和自动保存在同一处组装，避免两份字段表漂移。
      const buildConfig = () => ({
        absenceAfterDays: Number(absent),
        wakesPerDay: Number(wakes),
        daily: { events: Number(eventsPerDay), questions: Number(questionsPerDay) },
        growthDays: Number(growthDaysUi),
        diary: { visible: diaryVisible, enabled: diaryEnabled, keepDays: Number(diaryKeep) },
        avoid: {
          keywords: avoidText.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
          minDuration: Number(avoidMinDur),
          upMids: avoidMids.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
        },
        window: [wakeFrom, wakeTo],
        browse: { enabled: browseOn, perDay: Number(browsePerDay), topN: Number(browseTopN), deepRead: Number(browseDeepRead), danmaku: Number(browseDanmaku), voices: Boolean(browseVoices), window: [browseFrom, browseTo] },
        video: { enabled: videoOn, perDay: Number(videoPerDay), frames: Number(videoFrames) },
        notify: { enabled: notifyOn },
        chat: { rotateAfter: Number(rotateAfter), replyChars: Number(replyChars) },
        tools: { restrict: Boolean(toolsRestrict), allow: toolsAllowSaved },
        memory: { docBudget: Number(docBudget), sleepEveryDays: Number(sleepEvery), sleepKeep: Number(sleepKeep), beliefsShown: Number(beliefsShown) },
        comment: {
          enabled: commentOn,
          perDay: Number(commentPerDay),
          replyPerDay: Number(commentReplyPerDay),
          replyToReplies: commentReplyTo,
          atOwner,
          scanEveryMin: Number(commentScanMin),
          window: [commentFrom, commentTo],
        },
      })

      // 数字框可能停在半截（清空、只打了一个「1」）。这种值不写盘，
      // 否则服务端 clamp 会静默改成下限，用户以为自己输的就是生效值。
      const NUM_BOUNDS = [
        ['缺席判定天数', absent, 1, 30],
        ['每天醒几次', wakes, 0, 4],
        ['每天最多几条事件', eventsPerDay, 0, 5],
        ['每天最多几个问题', questionsPerDay, 0, 5],
        ['成长天数', growthDaysUi, 7, 180],
        ['日记保留天数', diaryKeep, 0, 3650],
        ['最短屏蔽时长', avoidMinDur, 0, 3600],
        ['每天看几次', browsePerDay, 0, 4],
        ['每次几条', browseTopN, 1, 20],
        ['深读几条评论', browseDeepRead, 0, 40],
        ['弹幕几条', browseDanmaku, 0, 30],
        ['每天看几个视频', videoPerDay, 0, 6],
        ['抽几帧', videoFrames, 4, 16],
        ['多少轮换会话', rotateAfter, 0, 500],
        ['每轮最多写多少字', replyChars, 0, 2000],
        ['上下文上限', docBudget, 600, 4000],
        ['一次看见几条', beliefsShown, 1, 8],
        ['几天想一次', sleepEvery, 0, 60],
        ['留几条自述', sleepKeep, 0, 100],
        ['每天几条评论', commentPerDay, 0, 5],
        ['每天回几条', commentReplyPerDay, 0, 10],
        ['隔几分钟扫', commentScanMin, 5, 720],
      ]
      const badNumber = () => {
        for (const [label, value, lo, hi] of NUM_BOUNDS) {
          const n = Number(value)
          if (!Number.isFinite(n) || n < lo || n > hi) return `${label}（${lo}–${hi}）`
        }
        return ''
      }

      const save = async (silent = false) => {
        if (!silent) { setBusy('save'); setNote('') }
        try {
          await jpost('/config', buildConfig())
          if (silent) setAutoNote(`已保存 ${new Date().toTimeString().slice(0, 8)}`)
          else { setNote('已保存。下一轮 tick 生效。'); await load() }
        } catch (e) {
          if (silent) setAutoNote(`没保存：${e.message}`)
          else setErr(e.message)
        } finally { if (!silent) setBusy('') }
      }

      // 改完就生效：任何一项变了，停手 700ms 就写盘（连点加减号也只写一次）。
      const cfgSig = JSON.stringify(buildConfig())
      useEffect(() => {
        if (!state) return
        if (baselinePending.current) { baselinePending.current = false; lastSaved.current = cfgSig; return }
        if (cfgSig === lastSaved.current) return
        const bad = badNumber()
        if (bad) { setAutoNote(`还没保存：${bad} 不在允许范围内。`); return }
        const t = setTimeout(async () => {
          try {
            await jpost('/config', buildConfig())
            lastSaved.current = cfgSig
            setAutoNote(`已保存 ${new Date().toTimeString().slice(0, 8)}`)
          } catch (e) { setAutoNote(`没保存：${e.message}`) }
        }, 700)
        return () => clearTimeout(t)
      }, [cfgSig, state])

      const saveTools = async () => {
        setBusy('tools'); setToolsSaveNote(''); setToolsSaveErr('')
        try {
          let known = toolsKnown
          if (!known) {
            try {
              const r = await jget('/tools')
              known = Array.isArray(r?.known) ? r.known : null
              setToolsKnown(known)
            } catch { known = null }
          }
          const check = checkToolNames(toolsAllowText, known)
          if (!check.ok) {
            setToolsSaveErr(`这些名字不对：${check.unknown.join('、')}。没保存。`)
            return
          }
          // 名单没拿到（她还没在本进程里开过会话，或宿主换了版本）时，只查了拼写——
          // 这点必须说出来，否则用户以为「过了校验」就等于「名字一定存在」。
          const onlyShape = !known || !known.length
          const before = toolsAllowSaved.length
          await jpost('/config', { tools: { restrict: Boolean(toolsRestrict), allow: check.names } })
          setToolsAllowSaved(check.names)
          await load()
          const delta = check.names.length - before
          if (!check.names.length) setToolsSaveNote('存好了。重启之后她只剩自己那几件工具。')
          else if (delta > 0) setToolsSaveNote(`存好了。重启之后她会多看见 ${delta} 个工具（名单一共 ${check.names.length} 个）。`)
          else if (delta < 0) setToolsSaveNote(`存好了。重启之后她会少看见 ${-delta} 个工具（名单一共 ${check.names.length} 个）。`)
          else setToolsSaveNote(`存好了。名单没变，还是 ${check.names.length} 个。`)
          if (onlyShape && check.names.length) {
            setToolsSaveNote((n) => `${n} 这次只核对了拼写——她还没开过会话，宿主那边还给不出工具名单。名字必须一字不差。`)
          }
        } catch (e) {
          setToolsSaveErr(e.message)
        } finally { setBusy('') }
      }

      /**
       * 主人身份与 B 站登录。
       * cookie 只上行不下行——输入框永远是空的，存过之后只显示「已保存」。
       */
      const saveOwnerCard = async () => {
        setBusy('owner'); setOwNote('')
        try {
          const body = { mid: owMid, nickname: owName }
          if (owCookie.trim()) body.cookie = owCookie.trim()
          const r = await jpost('/owner', body)
          setOwNote(r.note || (r.ok ? '存下了。' : '没存上。'))
          setOwCookie('')
          await load()
        } catch (e) { setOwNote(e.message) } finally { setBusy('') }
      }

      const testOwner = async () => {
        setBusy('owtest'); setOwNote('')
        try {
          const r = await jpost('/owner', { test: true })
          setOwNote(r.note || (r.ok ? '可以说话。' : '还不行。'))
          if (r.ok && r.mid) { setOwMid(String(r.mid)); setOwName(String(r.name || '')) }
          await load()
        } catch (e) { setOwNote(e.message) } finally { setBusy('') }
      }

      // 本机测试版专用（2026-10-26，用户 m00928）：绕过「今天该不该醒」，直接叫她去刷 B 站。
      // 存在意义就是验证「她到底能不能刷」——所以不做配额判断、也不看上网时段。
      // 正式版不渲染这个按钮（服务端 /state 的 dev 由 `.dev` 文件决定）。
      const browseNow = async () => {
        setBusy('wake-browse'); setNote('')
        try {
          const r = await jpost('/wake?focus=browse')
          setNote(r.ok ? '叫醒她了，这一轮她会去看 B 站首页。刷新一下能看到她的新会话。' : `没叫：${r.why || ''}`)
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      const wake = async () => {
        setBusy('wake'); setNote('')
        try {
          const r = await jpost('/wake')
          setNote(r.ok ? `已叫醒（${r.template}）` : `没叫：${r.why || ''}`)
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      // ---- P3-1：跟她说一句话 ----
      const send = async () => {
        const t = sayText.trim()
        if (!t) return
        setBusy('say'); setNote(''); setSaid([])
        try {
          const r = await jpost('/say', { text: t })
          setSaid(r.said || [])
          setSayText('')
          setNote(r.said?.length ? '' : (r.note || '大肥鱼这次没说话。'))
          await load()
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      // ---- R3：裁决她提上来的那张申请 ----
      // 批准会立刻重写身份文档，她下一次开口就看得见"这件事现在可以了"。
      const decide = async (verdict) => {
        setBusy('decide')
        setErr('')
        try {
          const r = await jpost('/decide', { verdict })
          if (r && r.error) throw new Error(r.error)
          await load()
        } catch (e) {
          setErr(e.message || String(e))
        } finally { setBusy('') }
      }

      // ---- P3-2：信箱已读 ----
      const markInbox = async () => {
        setBusy('inbox')
        try { await jpost('/inbox'); await load() } catch (e) { setErr(e.message) } finally { setBusy('') }
      }

      // ---- P4：把她放回第一天 ----
      // 两步：先读"将要封存什么"给他看，再要求他按第二次（真按钮）。
      // 不做 undo —— 但旧数据是**改名封存**，不是删，所以真后悔了还能从
      // 同级目录的 dsh-fish-backups/reset-* 里整包搬回来。
      const askReset = async () => {
        setBusy('reset-ask'); setNote('')
        try {
          const info = await jget('/reset')
          setResetInfo(info)
          setResetAsk(true)
        } catch (e) { setErr(e.message) } finally { setBusy('') }
      }
      const doReset = async () => {
        setBusy('reset'); setNote('')
        try {
          const r = await jpost('/reset', { confirm: 'reset' })
          setResetAsk(false)
          const head = r.movedTo ? `已重开。旧的都在：${r.movedTo}` : (r.note || '已重开。')
          // 单行：这个 note 用 <pre class="ok"> 渲染，换行会撑出一块绿色告示，不如一句话说清。
          // 2026-10-26（m01426 真机反馈）：重置会把新会话建出来，也会顺手叫一声，但**侧栏仍然看不见**——
          // 宿主的 sessionVisible 规则是「空白会话只有成为当前会话才显示」，而插件用 API 建的会话永远
          // 不会成为 current。实测只有用户自己点一次「叫醒大肥鱼」才会出现。所以提示以这一步为准，
          // 不再承诺「侧栏已经冒出」。
          const tail = r.freshError
            ? ` 新会话没建出来：${r.freshError}`
            : (r.retiredError
              ? ` 旧会话没收干净：${r.retiredError}。点一下「叫醒大肥鱼」，她开一次口，侧栏里才看得见新会话。`
              : ' 侧栏这会儿还看不到她——点一下上面的「叫醒大肥鱼」，她开一次口，「跟大肥鱼说话」才会出现在侧栏里。')
          setNote(`${head}${tail}`)
        } catch (e) {
          setErr(e.message)
        } finally { setBusy('') }
      }

      if (err && !state) {
        return h('div', { className: 'dfish' },
          h('h2', null, '大肥鱼'),
          h('p', { className: 'sub' }, '读不到状态。'),
          h('pre', { className: 'err' }, err))
      }

      const s = state
      const kv = (pairs) => h('div', { className: 'kv' },
        pairs.filter(Boolean).flatMap(([k, v]) => [h('b', { key: 'k' + k }, k), h('span', { key: 'v' + k }, v)]))

      // 时段行（2026-10-23 加）：三个时段用同样的控件，省得三处各写一遍还对不齐。
      // type=time 在浏览器里自带时间选择器；跨零点（22:00→02:00）是允许的，由服务端判定。
      const timeRow = (label, from, to, setFrom, setTo, hint) =>
        h('label', null, label,
          h('input', { type: 'time', value: from, onChange: (e) => setFrom(e.target.value) }),
          h('span', { className: 'dim' }, '到'),
          h('input', { type: 'time', value: to, onChange: (e) => setTo(e.target.value) }),
          hint ? h('span', { className: 'dim' }, hint) : null)

      // ---- 表单控件（2026-10-23 重做）----
      // 只用 React.createElement，不引任何依赖：这一节跑在宿主的客户端沙箱里。
      function Toggle(o) {
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('button', {
            type: 'button',
            className: 'sw' + (o.on ? ' on' : ''),
            role: 'switch',
            'aria-checked': o.on ? 'true' : 'false',
            onClick: () => o.onChange(!o.on),
          }, h('span', { className: 'knob' })))
      }
      function Num(o) {
        const cur = Number(o.value || 0)
        const step = o.step || 1
        // 空串/非数字（比如把框清空）不当成 0，落到下限；否则会显示 「NaN」。
        const clamp = (n) => {
          const v = Number(n)
          const base = Number.isFinite(v) ? v : o.min
          return String(Math.min(o.max, Math.max(o.min, base)))
        }
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('div', { className: 'row', style: { gap: '6px' } },
            h('button', { className: 'step', onClick: () => o.onChange(clamp(cur - step)) }, '−'),
            h('input', {
              type: 'number', min: o.min, max: o.max, step, value: o.value,
              onChange: (e) => o.onChange(e.target.value),
              // 2026-10-24: 打字不受 input 的 min/max 约束（浏览器只当校验提示），
              // 离开输入框时按上下限收敛一次，免得界面显示 9999、保存后又被服务端改成上限。
              onBlur: (e) => o.onChange(clamp(e.target.value)),
            }),
            h('button', { className: 'step', onClick: () => o.onChange(clamp(cur + step)) }, '+'),
            o.unit ? h('span', { className: 'dim' }, o.unit) : null))
      }
      function Sel(o) {
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('select', { value: String(o.value), onChange: (e) => o.onChange(e.target.value) },
            ...o.options.map((v) => h('option', { key: String(v), value: String(v) },
              o.fmt ? o.fmt(v) : String(v)))))
      }
      function Text(o) {
        return h('div', { className: 'fld', style: o.wide ? { gridColumn: '1 / -1' } : undefined },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('input', { type: 'text', value: o.value, placeholder: o.placeholder,
            onChange: (e) => o.onChange(e.target.value) }))
      }
      function TimeRange(o) {
        return h('div', { className: 'fld' },
          h('div', { className: 'fl' },
            h('span', { className: 'flabel' }, o.label),
            o.hint ? h('span', { className: 'fhint' }, o.hint) : null),
          h('div', { className: 'row', style: { gap: '6px' } },
            h('input', { type: 'time', value: o.from, onChange: (e) => o.onFrom(e.target.value) }),
            h('span', { className: 'dim' }, '到'),
            h('input', { type: 'time', value: o.to, onChange: (e) => o.onTo(e.target.value) })))
      }

      // 工具面：把限制的理由写给用户看，给一个总开关，另留一处额外放行口。
      // 2026-10-24 起这条限制是真的（restrict 37→8，另有一道 guard 兜底），
      // 所以界面上的说法从「还没打通」改成「已经做到」——配置不许撒谎。
      const toolsCard = h('div', { className: 'card' },
        h('h3', null, '手上能用什么'),
        h('div', { className: 'dim' },
          '大肥鱼自己可以调用的工具只有十个：记录想法、查看记忆、发送消息、刷B站、看视频画面、评论区评论及回复、派活到工作区、只读地看一眼当前工作区的文件结构、只读地读工作区或她自己日记里的文本文件（只能看，不能改任何文件），以及看一张图片。',
          '别的插件和技能启用，DSH会把它们的工具定义也塞进上下文——大肥鱼会看到一堆能做各种操作的工具，占用上下文的同时有可能真的尝试调用这些工具。',
          '为了保证大肥鱼不会被插件能力污染，保持原生状态健康成长，禁用了其他能力（只影响和大肥鱼对话框的能力调用，不影响其他对话框的正常工具调用）。'),
        h('div', null, Toggle({
          label: '工具面收窄',
          hint: '关掉之后能看到 DSH 给的全部标准工具，工具定义会占掉每轮的一部分上下文。改动要重启才生效。',
          on: toolsRestrict,
          onChange: setToolsRestrict,
        })),
        h('div', { className: 'dim', style: { marginTop: '8px' } },
          '插件能力白名单（逗号分隔，留空 = 不额外给）。填的是工具名称，不是插件名称，也不是技能名称。',
          '想要技能生效就得填 skill——代价是 DSH 会把所有技能的说明一次性塞进她的上下文，暂不支持只启用某几个技能。',
          '名字必须和宿主里的完全一致。填错一个，整条收窄会当场失效（她退回能看到全部工具的状态），所以拼错的名字不允许保存。'),
        h('div', { className: 'row', style: { gap: '8px', marginTop: '6px' } },
          h('input', {
            type: 'text',
            value: toolsAllowText,
            placeholder: '例如：skill, web_search, read_image',
            onChange: (e) => { setToolsAllowText(e.target.value); setToolsSaveNote(''); setToolsSaveErr('') },
          }),
          h('button', {
            onClick: saveTools,
            disabled: busy === 'tools',
            style: { flex: 'none', whiteSpace: 'nowrap' },
          }, busy === 'tools' ? '检查中…' : '保存设置')),
        toolsSaveErr
          ? h('div', { style: { color: 'var(--dsw-alias-label-error, #d93f0b)', fontSize: '12.5px', marginTop: '6px' } }, toolsSaveErr)
          : null,
        toolsSaveNote
          ? h('div', { className: 'dim', style: { marginTop: '6px' } }, toolsSaveNote)
          : null)

      // 重置卡片单独提出来：它是唯一一个有破坏性的 ui，塞在那一长串 return 里
      // 很容易少/多一个括号（已经踩过：node --check 直接 SyntaxError）。
      const resetCard = h('div', { className: 'card full' },
        h('h3', null, '重置大肥鱼'),
        h('div', { className: 'dim' },
          '旧的一切不会删——整个状态库会被改名搬到同级的 dsh-fish-backups 里，想找回来整包搬回去就行。',
          '重开后是第一天，会重新从「你刚开始存在」开始。',
          '侧栏「大肥鱼的家」里那些旧对话会被移进「已归档」，工作区留着；点完会开一条新会话，但要再点一下「叫醒大肥鱼」，她开一次口，侧栏里才看得见（文件同样不删）。'),
        resetInfo ? h('div', { className: 'dim' },
          `现在有：事件 ${resetInfo.events} 条、日记 ${resetInfo.diaries} 天、报告 ${resetInfo.reports} 天。`) : null,
        h('div', { className: 'row' },
          !resetAsk
            ? h('button', { onClick: askReset, disabled: !!busy },
                busy === 'reset-ask' ? '读取中…' : '重开一局…')
            : h('span', null,
                h('span', { className: 'dim' }, '确定吗？'),
                h('button', { onClick: doReset, disabled: busy === 'reset' },
                  busy === 'reset' ? '搬走中…' : '确定，重开'),
                h('button', { onClick: () => { setResetAsk(false); setNote('没动。') } }, '算了'))))

      // 状态条与今天的时间线（2026-10-23 加）。全部来自宿主写下的 meta + 配置 + 时钟，
      // 她不参与，也不因此多跑任何一次模型。
      //
      // 2026-10-24：叫醒按钮从页签栏挪到这里，放在卡片右上角。
      // 页签栏是「切换看哪一页」的地方，混一个会真的触发动作的按钮，
      // 既容易误触，也不符合那一栏的语义。左边说状态、右边说「叫醒」，
      // 位置本身就说明了它是针对「现在这个状态」的操作。
      const phaseColor = { asleep: '#8a8a8a', waiting: '#b8860b', 'awake-idle': '#d97706', browsing: '#2563eb', talking: '#16a34a', writing: '#7c3aed', offline: '#9ca3af' }
      // 只有本机测试版（`.dev` 文件）才出现。判据来自服务端 /state 的 dev，
      // 不是前端猜的——正式版里这个字段恒为 false，按钮连节点都不生成。
      const browseBtn = state?.dev
        ? h('button', {
            className: 'ghost',
            onClick: browseNow,
            disabled: busy === 'wake-browse',
            style: { flex: '0 0 auto' },
            title: '测试用：绕过「今天该不该醒」，直接叫她去看一眼 B 站首页。',
          }, busy === 'wake-browse' ? '送出门…' : '让她去刷 B 站')
        : null
      const wakeBtn = h('button', {
        className: 'ghost',
        onClick: wake,
        disabled: busy === 'wake',
        style: { flex: '0 0 auto' },
      }, busy === 'wake' ? '叫醒中…' : '现在叫醒大肥鱼')
      // 2026-10-24：这张卡**始终渲染**。之前整块挂在 `st ? … : null` 上，状态还没读到时
      // 连「叫醒」按钮一起消失——一旦读取失败就没有入口，等于把人锁在门外。
      // 状态未知时说「读取中」，只有拿到状态才说「今天还没有动静」。
      // 头像（2026-10-24 用户 m03751）：插件包里**不带任何头像图片**。
      // 图片来源 `<数据文件夹>/avatar.<ext>`，没有就只画一个空圈 + 「鱼」字。
      // 为什么不内置一张好看的图：那张「大肥鱼」原图是画师原创角色，二创开放 ≠ 可再分发，
      // 打进包等于随插件分发别人的美术作品（见 docs/B-技术契约.md §41）。
      const avatarBox = h('div', {
        title: avatarPresent
          ? (`当前头像 ${avatarBytes} 字节。点「换头像」换一张。`)
          : '还没有头像。点「换头像」自己传一张（png / jpg / webp / gif，2MB 以内）。',
        style: {
          position: 'relative', width: '46px', height: '46px', borderRadius: '50%',
          flex: '0 0 auto', overflow: 'hidden', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(127,127,127,0.14)', color: '#9ca3af', fontSize: '17px',
        },
      },
        h('span', null, '鱼'),
        h('img', {
          src: API + '/avatar' + (avatarV ? `?v=${avatarV}` : ''),
          alt: '头像',
          onError: (e) => { e.currentTarget.style.display = 'none' },
          onLoad: (e) => { e.currentTarget.style.display = 'block' },
          style: { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', objectFit: 'cover' },
        }))

      const pickAvatar = (e) => {
        const f = e.target && e.target.files && e.target.files[0]
        if (e.target) e.target.value = ''
        if (!f) return
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(f.type)) {
          setAvatarNote('只支持 png / jpg / webp / gif。')
          return
        }
        if (f.size > 2 * 1024 * 1024) {
          setAvatarNote(`这张 ${Math.round(f.size / 1024)}KB，超过 2MB 上限。`)
          return
        }
        setAvatarBusy(true); setAvatarNote('')
        const reader = new FileReader()
        reader.onload = async () => {
          try {
            const r = await jpost('/avatar', { data: String(reader.result || ''), mime: f.type })
            if (r && r.ok) {
              setAvatarPresent(true)
              setAvatarBytes(Number(r.bytes) || 0)
              setAvatarV(Date.now())
              setAvatarNote('换好了。')
            } else {
              setAvatarNote(`没存上：${(r && (r.why || r.error)) || '再试一次'}`)
            }
          } catch (err) {
            setAvatarNote(`没存上：${err && err.message ? err.message : err}`)
          } finally {
            setAvatarBusy(false)
          }
        }
        reader.onerror = () => { setAvatarBusy(false); setAvatarNote('这个文件读不出来。') }
        reader.readAsDataURL(f)
      }

      const removeAvatarNow = async () => {
        setAvatarBusy(true); setAvatarNote('')
        try {
          await jpost('/avatar', { remove: true })
          setAvatarPresent(false)
          setAvatarBytes(0)
          setAvatarV(Date.now())
          setAvatarNote('已经去掉了。')
        } catch (err) {
          setAvatarNote(`没去掉：${err && err.message ? err.message : err}`)
        } finally {
          setAvatarBusy(false)
        }
      }

      const avatarCtl = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('label', { className: 'ghost', style: { cursor: 'pointer', fontSize: '12px' } },
          avatarBusy ? '上传中…' : '换头像',
          h('input', {
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp,image/gif',
            style: { display: 'none' },
            onChange: pickAvatar,
          })),
        avatarPresent
          ? h('button', { className: 'ghost', style: { fontSize: '12px' }, onClick: removeAvatarNow, disabled: avatarBusy }, '移除头像')
          : null,
        avatarNote ? h('span', { className: 'dim', style: { fontSize: '12px' } }, avatarNote) : null)

      const statusStrip = h('div', { className: 'card full' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
          avatarBox,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0', flex: '1 1 auto' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: st ? (phaseColor[st.phase] || '#9ca3af') : '#9ca3af', flex: '0 0 auto' } }),
              h('b', null, st ? st.label : '状态读取中…'),
              st && st.detail ? h('span', { className: 'dim' }, st.detail) : null),
            avatarCtl),
          browseBtn,
          wakeBtn),
        st
          ? (Array.isArray(st.timeline) && st.timeline.length
              ? h('div', { className: 'dim', style: { marginTop: '6px', fontSize: '12px', lineHeight: '1.75' } },
                  ...st.timeline.map((t, i) => h('div', { key: 'tl' + i }, t.text)))
              : h('div', { className: 'dim', style: { marginTop: '6px' } }, '今天还没有动静。'))
          : null)
      // ================================================================
      // 设置界面 2.0（2026-10-24 重做）
      //
      // 分组原则换了：上一版按「控件属不属于同一类」分（生长/上网/说话/数据），
      // 这一版按「这属于她生活里的哪一块」分——状态 / 成长 / 住所 / 上网 /
      // 记忆 / 插件 / 原理 / 数据。
      //
      // 两条硬规则（都是上一版踩过坑换来的）：
      //   1. **没有「全部」页**（用户 2026-10-24 要求删掉）。每个设置项必须归到
      //      某一页里，不许有哪一项只活在一个「万能页」上。
      //   2. **页签只用于聚焦，不用于隐藏**。删掉「全部」之后，每一页自己就得是
      //      完整的——不能出现「这一项要点两次才找得到」。
      //
      // 文案规则：
      //   · 每个分组标题下面一句人话，说清这一组管什么，不列字段清单；
      //   · 看不懂的词把定义放进 title（鼠标停上去就能看），不塞进正文占三行；
      //   · 面向用户的字符串里**不出现「她/他」**（test/p5.test.mjs 有硬断言）。
      // ================================================================

      const TABS = [
        ['now', '状态'],
        ['grow', '成长'],
        ['home', '住所'],
        ['bili', '上网'],
        ['memory', '记忆'],
        ['env', '插件'],
        ['principle', '原理'],
        ['data', '数据'],
      ]

      // 只有这几个页签里的东西是「改完就写盘」的。没有设置项的页签（状态 / 住所 / 原理 / 数据）
      // 不显示那句提示；「插件」也不显示——工具面收窄要重启才生效，白名单要手动保存（2026-10-24 用户要求）。
      const AUTO_SAVE_TABS = new Set(['grow', 'bili', 'memory'])

      const TAB_HELP = {
        now: '现在是什么状态、走了多远、在守什么规矩，以及你不在的时候发生了什么。',
        grow: '怎么长大：时间尺度、每天经历多少、日记、隔几天回头想一次。改这些只会让她变快变慢，不会改变她是什么样。',
        home: '住在哪：工作区、会话、身份文件，以及一键自检。',
        bili: '上网：能不能出门、看多少、看画面、避开什么，以及在评论区说话和登录。',
        memory: '记忆：一次能背多少、多少条判断被挤出视野，还有信箱。',
        env: '插件：别的插件能往她上下文里塞什么工具，以及为什么默认只放她自己那几个。',
        principle: '原理：两张图讲清她怎么长大、记忆怎么被筛；每条设计从哪条理论来，以及这一套能用在什么场景。',
        data: '数据：都存在哪、每日报告、运行日志，以及重置（有破坏性的操作放在这一页最下面）。',
      }

      // 阶段与门：写清楚，因为「下一个成长瓶颈」这几个字原来没人看得懂。
      // 四行措辞是用户在设置页上亲手写的（2026-10-24），已固化进源码，别再改回短的。
      const STAGE_HELP = [
        '四个阶段按天推进，但每个瓶颈要自己突破。',
        '1 信任 · 根据所见所闻形成一条自己的判断/认知',
        '2 自主 · 说过至少两次「不要」，反抗意识的觉醒',
        '3 主动 · 两次推翻自己之前的判断/认知，形成新的正确认知',
        '4 整合 · 回顾过去经历，有意识地发现自己的改变',
      ].join('\n')
      const GATE_HELP = {
        trust: '信任：先从所见所闻里形成一条自己的判断——一条愿意被推翻的「我猜…」。',
        autonomy: '自主：得真的拒绝过两次——不是嘴上说不要，是明确不执行某件事。',
        competence: '主动：得两次推翻自己先前的判断，形成新的正确认知，不是光换个说法。',
      }
      // 「下一个成长瓶颈」原来直接印 stageGate.pending —— 那是 trust / autonomy / competence，
      // 用户看见的是英文（2026-10-24：「competence 是什么」）。宿主给的是技术名，
      // 显示层必须翻成人话；没收录的名字原样显示，绝不显示 undefined。
      const GATE_NAME = { trust: '信任', autonomy: '自主', competence: '主动' }
      const QUALITY_HELP = '判断漂移是三个 0 到 1 的数：稳定 = 少押几条判断会不会变一个人；一致 = 前后说法打不打架；新鲜 = 有没有一直在长新东西。越接近 1 越好。'

      // 页签栏**只放页签**（2026-10-24）。
      // 原来这一行还挂着「现在叫醒大肥鱼」和「保存」两个按钮，都被挪走了：
      //   · 叫醒 → 状态卡右上角，因为它是针对「现在这个状态」的动作；
      //   · 保存 → 删掉，因为每个设置页底部本来就有「保存改动」，
      //     顶上再放一个同样的按钮，只会让人猜「这两个是不是不一样」。
      const tabBar = h('div', { className: 'tabs' },
        ...TABS.map(([id, name]) => h('button', {
          key: id,
          className: 'tab' + (tab === id ? ' on' : ''),
          title: TAB_HELP[id] || '',
          onClick: () => setTab(id),
        }, name)),
      )

      // 一页里的一组设置。title 之外还可以给 note（这一组整体的一句话）。
      const group = (title, note, ...items) => h('div', { className: 'card' },
        h('h3', null, title),
        note ? h('p', { className: 'hint', style: { marginBottom: '10px' } }, note) : null,
        ...items)
      // 长内容（清单、事件流、信箱）横跨整行：内容多、又窄又高，两列反而更难读。
      const groupFull = (title, note, ...items) => h('div', { className: 'card full' },
        h('h3', null, title),
        note ? h('p', { className: 'hint', style: { marginBottom: '10px' } }, note) : null,
        ...items)

      // 一行「名称 — 值」，tip 存在时在值后面挂一个可悬停的 ⓘ。
      // 用它代替纯 kv：那一版用户看到「下一道门」和「稳定 0.87」都不知道在说什么。
      const rowTip = (k, v, tip) => h('div', {
        style: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '13px', marginBottom: '5px' },
      },
        h('span', { style: { opacity: 0.65, flex: '0 0 auto', minWidth: '84px' } }, k),
        h('span', { style: { flex: '1' } }, v,
          tip ? h('span', { title: tip, style: { opacity: 0.45, marginLeft: '5px', cursor: 'help' } }, 'ⓘ') : null))

      // 2026-10-24（用户）：底部「保存改动」整组删掉。原来每个页签都挂一颗，
      // 让人以为必须先点；住所页根本没有设置项也挂着一颗。现在改完即存，
      // 没有设置的页签自然什么都不需要。

      // 数据文件夹路径一律由服务端 /paths 现算（用户 m03440）。
      // 原来这里按 workspace 目录名以 home 结尾去反推根目录、再用反斜杠拼子路径：
      // 目录一改名就推错，而且反斜杠是 Windows 假设。客户端不该重复实现服务端的事实。

      const copyPath = async (p) => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(p)
            setNote('已复制到剪贴板。粘到资源管理器地址栏回车就能打开。')
          } else {
            setNote('这个环境不让写剪贴板，复制失败。')
          }
        } catch {
          setNote('这个环境不让写剪贴板，复制失败。')
        }
      }

      // 导出报告：纯前端拼一个 markdown 文件下载，不新开任何服务端路由。
      const downloadReport = () => {
        const md = reports?.md || ''
        if (!md) { setNote('还没有报告正文可导出。先点「每日报告」取一份。'); return }
        if (typeof document === 'undefined' || typeof Blob === 'undefined') { setNote('这个环境不支持下载。'); return }
        try {
          const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `大肥鱼-报告-${reports.date || 'latest'}.md`
          a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 4000)
          setNote(`已导出 ${a.download}`)
        } catch (e) { setErr(e.message) }
      }

      // 2026-10-25：B 站登录提示卡。存好之后自己消失；也可以手动点「不用了」
      // （选择记进 config.ui.ownerHintDismissed，别再反复出现）。
      const ownerHintCard = (ow && !ow.hasCookie && !uiHintDismissed)
        ? h('div', { className: 'card', style: { borderColor: 'var(--dsw-alias-border-l2)' } },
          h('h3', null, '还没存 B 站登录'),
          h('div', { className: 'dim' },
            '看视频画面、读评论、回评都要用到它。存好之后这张卡会自己消失——不想存就点「不用了」，以后不再提示。'),
          h('div', { className: 'row', style: { gap: '8px', marginTop: '6px' } },
            h('button', { onClick: () => showTab('bili') }, '去上网页存'),
            h('button', {
              className: 'ghost',
              onClick: async () => {
                try {
                  await jpost('/config', { ui: { ownerHintDismissed: true } })
                  setUiHintDismissed(true)
                } catch (e) { setErr(e.message) }
              },
            }, '不用了')))
        : null

      // ---------------------------- 现在 ----------------------------
      const nowPage = h('div', { className: 'page' },
        statusStrip,
        ownerHintCard,
        s ? group('状态',
          '这些数字都是宿主从她的事件流里算出来的，她看不见自己这些数。',
          rowTip('已成长天数', `${s.day} / ${s.growthDays} 天`, '从第一天算起的自然日。成长天数调大会让她走得更慢。'),
          rowTip('当前阶段', `${s.stage} · ${s.stageName}${s.stageForced ? '（时间兜底）' : ''}`, STAGE_HELP),
          rowTip('下一个成长瓶颈', s.pendingGate ? (GATE_NAME[s.pendingGate] || s.pendingGate) : '已走完', GATE_HELP[s.pendingGate] || '四个瓶颈都过了。'),
          rowTip('最近的判断', `${s.beliefCount} 条${s.solidCount ? `（其中 ${s.solidCount} 条记得很牢）` : ''}`, '她还在拿着的判断条数。更早的没丢，折进「更早以前」。记得很牢的是被反复提起或被反复检验过的。'),
          // 2026-10-24（P0）：她认知矛盾的两句话。只报事实，不给裁决按钮——
          // 哪句对她得她自己定；这里放个"选哪句"，就变成用户在替她长人格。
          s.tension
            ? rowTip('认知矛盾', `${s.tension.count} 处`, `「${s.tension.a}」和「${s.tension.b}」不能同时算数。她还没想清楚，可以直接问她。`)
            : rowTip('认知矛盾', '没有', '她说过的话之间，暂时没发现互相矛盾的地方。'),
          // 2026-10-24（P1 第三块）：疤。他顶回来或因此难过、而她后来还是让了的那次拒绝。
          // 只报"几件没想通"，不给"愈合"按钮——想通是她自己写一条 revise 的事。
          s.scarCount
            ? rowTip('没想通的事', `${s.scarCount} 件`, '他顶回来、或者因此难过之后，你后来还是让了的那几次。她没有忘，也没算成"已经过去了"。')
            : rowTip('没想通的事', '没有', '还没有哪次拒绝让她事后反悔。'),
          (s.stanceCount ?? 0) > 0
            ? rowTip('立场', `${s.stanceCount} 条`, '立场是在四个阶段都走完之后才开始产生的：喜欢什么、绝不做哪几件事。每条都有代价——要么栽过一次，要么同一件事她反复提起过。')
            : s.stanceReady
              ? rowTip('立场', '0 条', '完成整合，但暂未形成自己的立场。')
              : rowTip('立场', '还没开始', '要等四个阶段（信任 / 自主 / 主动 / 整合）都走完，立场才开始产生。'),
          rowTip('最近的称呼', s.name ? s.name : '还没想好', '她自己决定怎么称呼你。这个不是设置项，改不了。'),
          rowTip('冷落', s.absenceDays > 0 ? `${s.absenceDays} 天` : '没有', '你多久没说话了。超过门槛她会记下「你不在」。'),
          rowTip('互动计数', `说 ${s.counts.utterance} · 改口 ${s.counts.revise} · 拒绝 ${s.counts.refusal} · 重聚 ${s.counts.reunion}`, '说=她写过几句自己的判断（含留话）；改口=按照规则推翻历史认知并指明改的是哪条；拒绝=她明确登记拒绝过什么；重聚=久别之后她自己写下的感受。'),
          rowTip('判断漂移', `稳定 ${q2(s.quality && s.quality.stability)} · 一致 ${q2(s.quality && s.quality.consistency)} · 新鲜 ${q2(s.quality && s.quality.novelty)}`, QUALITY_HELP)) : null,

        // ---- 规则（R3，2026-10-24） ----
        // 这一块**只读 + 裁决**：没有新建、没有编辑。
        // 规则不是设置项——能在这里改规则，就等于能在这里改她。
        rules ? group('规则约束',
          '四层：物理层（代码保证，不进提示词）、契约层（不许把关系变成分数）、起点层（一开始是谁）、成长层（可以自己申请）。'
            + (rules.offersOn === false ? '成长层的申请通道现在关着（已有的不会撤销）。' : ''),
          rules.pending ? h('div', {
            style: {
              border: '1px solid rgba(127,127,127,.35)',
              borderRadius: '8px',
              padding: '10px 12px',
              marginBottom: '10px',
            },
          },
            h('p', { style: { margin: '0 0 6px' } }, `大肥鱼提了一个申请：${(rules.pending.why || '').slice(0, 160)}`),
            h('div', { className: 'row', style: { gap: '8px' } },
              h('button', { className: 'btn', onClick: () => decide('approve') }, '可以'),
              h('button', { className: 'btn', onClick: () => decide('reject') }, '这次不行'),
            ),
          )
          // 没有待裁决的申请就**什么都不渲染**（2026-10-24 用户提出）：
          // 原来这里常驻一句「目前没有待处理的申请」，等于在规则卡里放一个空待办，
          // 看久了会训练人忽略这张卡。通道关着这件事并进卡片说明行，不单独占一行。
          : null,
          ...(rules.layers || []).map((L) => h('div', { style: { marginTop: '8px' } },
            h('div', { style: { fontWeight: 600 } }, `${L.name}${L.mutable ? '（可以长）' : '（不会变）'}`),
            h('div', { style: { opacity: 0.75, fontSize: '12px', marginTop: '2px' } }, L.note),
            ...L.rules.map((r) => {
              const st2 = (rules.status || []).find((x) => x.id === r.id)
              const tail = st2?.active ? ' · 已经可以了' : (st2?.ready ? ' · 条件够了，等她开口' : '')
              return h('div', { style: { fontSize: '12px', marginTop: '4px' } },
                `· ${r.title}${r.inPrompt ? '' : '（不进提示词）'}${tail}`)
            }),
          ))) : null,

        // ---- 你不在的时候 ----
        away && away.days >= 1 && !away.quiet
          ? group('你不在的时候',
              '不推送，回来了就在这里告诉你错过了什么。',
              h('div', { className: 'kv' },
                h('b', null, '醒了'), h('span', null, `${away.wakes} 次`),
                h('b', null, '看了'), h('span', null, `${away.videos} 条`),
                h('b', null, '说了'), h('span', null, `${away.said} 句`),
                h('b', null, '日记'), h('span', null, away.diaries ? `${away.diaries} 篇` : '没写')),
              h('p', { className: 'hint' }, '日记只报篇数——内容给不给你看，还是那个开关的事。'))
          : null)

      // ---------------------------- 生长 ----------------------------
      const growPage = h('div', { className: 'page' },
        groupFull('四个阶段与三道瓶颈',
          '按天推进的部分只是时间尺度；真正决定走到哪一步的，是自己做过的事。',
          h('div', { style: { fontSize: '13px', lineHeight: '1.9', opacity: 0.85 } },
            ...STAGE_HELP.split('\n').map((line, i) => h('div', { key: 'sh' + i }, line)))),
        group('成长节奏设置',
          '这几个数决定「她用多少天走完四个阶段」。调大只是把速度变慢，不影响流程。',
          h('div', { className: 'grid2' },
            Num({ label: '成长到最后阶段所需时间', value: growthDaysUi, onChange: setGrowthDaysUi, min: 7, max: 180, unit: '天',
              hint: '7 天很快、180 天很慢。她自己的经历决定每个阶段的早晚，这个数只是上限。' }),
            Sel({ label: '每天最多主动醒来', value: wakes, onChange: setWakes, options: [0, 1, 2, 3, 4],
              fmt: (v) => (Number(v) === 0 ? '0 次 · 只有你找她时才在' : `${v} 次`),
              hint: '醒来 = 自己启动过一段时间。次数多不等于成长速度快和效果好，次数过多每次唤醒时间会变短' }),
            TimeRange({ label: '每天几点醒', from: wakeFrom, to: wakeTo, onFrom: setWakeFrom, onTo: setWakeTo,
              hint: '只在这个时段里自己醒。跨零点也可以（比如 22:00 到 02:00）。' }),
            Num({ label: '她一轮最多写多少字', value: replyChars, onChange: setReplyChars, min: 0, max: 2000, unit: '字',
              hint: '0 = 不限，提示词里完全不提长度，长短由她自己决定。填了就对随后的对话生效。' }))),
        group('每日事件设置',
          '系统自动随机触发的事件，会让她启动进行思考。太少醒来后主要是自闭和自言自语，太多会流水账',
          h('div', { className: 'grid2' },
            Sel({ label: '每天最多推几条成长事件', value: eventsPerDay, onChange: setEventsPerDay, options: [0, 1, 2, 3, 4, 5, 6],
              fmt: (v) => (Number(v) === 0 ? '0 条 · 不主动推' : `${v} 条`),
              hint: '事件会促进成长。0 条不会变傻，只是那天什么都没经历' }),
            Sel({ label: '会向你进行几次提问', value: questionsPerDay, onChange: setQuestionsPerDay, options: [0, 1, 2, 3, 4, 5, 6],
              fmt: (v) => (Number(v) === 0 ? '0 条 · 从不主动问' : `${v} 条`),
              hint: '问多了会退化成问答机器。建议不超过成长事件数的一半。' }),
            Num({ label: '你多久不出现算冷落', value: absent, onChange: setAbsent, min: 1, max: 30, unit: '天',
              hint: '超过这么多天没说话，她会记下「你不在」。' }))),
        group('日记',
          '她每天会写日记。打开下面那个开关，你就能看。',
          h('div', { className: 'grid2' },
            Toggle({ label: '写日记', on: diaryEnabled, onChange: setDiaryEnabled,
              hint: '关掉后不再写新的，已经写好的不会删。' }),
            Toggle({ label: '让我看日记', on: diaryVisible, onChange: setDiaryVisible,
              hint: '打开即时生效，之前错过的日记看不到，只能看到以后的日记，关闭的话就是盲盒体验' }),
            Sel({ label: '日记留多久', value: diaryKeep, onChange: setDiaryKeep, options: [0, 30, 90, 365, 3650],
              fmt: (v) => (Number(v) === 0 ? '永久保留' : `${v} 天`),
              hint: '超期的日记按天清掉，不占地方。想看历史就选永久。' }))),
        group('深度思考与学习（maybe）',
          '隔几天她会自己把最近的碎片压成一段自述（我之前……我曾经……），形成初始认知。并非总结报告。',
          h('div', { className: 'grid2' },
            Num({ label: '每几天回头想一次', value: sleepEvery, onChange: setSleepEvery, min: 0, max: 60, unit: '天',
              hint: '0 = 不主动想。想的时候复用一次晚间唤醒，不额外多跑一次模型。' }),
            Num({ label: '总共留几条自述', value: sleepKeep, onChange: setSleepKeep, min: 0, max: 100, unit: '条',
              hint: '超出后最早的折进「更早以前」，不删。' }))),
        )

      // ---------------------------- 住所 ----------------------------
      // 这一页回答的是「东西都在哪」，不是「怎么调她」。
      const homePage = h('div', { className: 'page' },
        group('大肥鱼住在哪',
          '侧栏里新增工作区和新增会话，就是她的房间。',
          !home ? h('p', { className: 'empty' }, '读取中…')
            : h('div', null,
                rowTip('工作区', home.workspace?.ok ? '已建好' : '没建起来（宿主没有 workspaceRegistry）',
                  '侧栏里叫「大肥鱼的家」那个工作区。'),
                rowTip('会话', home.session?.ok ? '「跟大肥鱼说话」那条' : '没建起来，下面有备用框',
                  '每天醒来说的话都落在这条会话里。满了会自动换新的，旧的改名留档。'),
                rowTip('身份文件', home.selfDoc?.exists ? `${home.selfDoc.bytes} 字节` : '还没有',
                  '身份通过 system prompt 送给她，不进对话历史；这里是它的落盘副本。'),
                home.session?.ok ? null : group('备用说话入口',
                  '侧栏里没找到那条对话，所以这里留一个能说话的框。',
                  h('div', { className: 'form' },
                    h('textarea', {
                      value: sayText,
                      placeholder: '说点什么。大肥鱼会按自己的方式回——也可能不回。',
                      onChange: (e) => setSayText(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
                      },
                    }),
                    h('div', { className: 'row' },
                      h('button', { onClick: send, disabled: busy === 'say' || !sayText.trim() },
                        busy === 'say' ? '等大肥鱼想…' : '说给大肥鱼'),
                      h('span', { className: 'dim' }, 'Ctrl+Enter 发送。'))),
                  said.length
                    ? h('div', { style: { marginTop: '10px' } },
                        h('p', { className: 'dim' }, '大肥鱼刚刚说的'),
                        ...said.map((x) => h('div', { className: 'said', key: x.id }, esc(x.text))))
                    : null))),

        group('日记',
          '如果你在「成长」页勾选了看日记。日记会在这里显示，一天一页，多天时自动出现翻页',
          !diary ? h('p', { className: 'empty' }, '读取中…')
            : !diary.enabled ? h('p', { className: 'empty' }, '没在写日记。')
            : !diary.visible ? h('p', { className: 'empty' },
                `已写 ${(diary.lockedDates || []).length} 天，但设置里是不给你看。`)
            : !diaryDates.length ? h('p', { className: 'empty' }, '还没写')
            : h('div', null,
                diaryDates.length > 1
                  ? h('div', { className: 'row pager' },
                      h('button', {
                        className: 'ghost',
                        disabled: diaryIdx >= diaryDates.length - 1,
                        onClick: () => setDiaryDay(diaryIdx + 1),
                      }, '← 更早'),
                      h('span', { className: 'dim' }, `${diaryCur}　${diaryIdx + 1} / ${diaryDates.length}`),
                      h('button', {
                        className: 'ghost',
                        disabled: diaryIdx <= 0,
                        onClick: () => setDiaryDay(diaryIdx - 1),
                      }, '更晚 →'))
                  : h('p', { className: 'dim' }, diaryCur),
                diaryCache.current[diaryCur] === undefined
                  ? h('p', { className: 'empty' }, '读取中…')
                  : h('pre', null, esc(diaryCache.current[diaryCur])))),

        group('本插件工作自检',
          '这个插件没有要安装的依赖（只用 Node 自带的东西，外加可选的 ffmpeg）。真会坏的是别的：状态库写不进去、cookie 过期、宿主没给接口、B 站风控。',
          risk && risk.cooling
            ? h('p', { className: 'warn' }, `B 站那边正在冷却，还有约 ${risk.remainMin} 分钟。冷却期她不刷站，但照常醒来说话。`)
            : null,
          h('div', { className: 'row' },
            h('button', {
              disabled: checking,
              onClick: () => {
                setChecking(true)
                jget('/selfcheck?net=1').then(setChecks).catch(() => {}).finally(() => setChecking(false))
              },
            }, checking ? '正在查…' : '检查一下')),
          checks
            ? h('div', { style: { marginTop: '10px' } },
                h('p', { className: 'hint' }, `${checks.summary || ''}（${String(checks.checkedAt || '').replace('T', ' ').slice(0, 19)}）`),
                h('ul', null, (checks.items || []).map((c) => h('li', { key: c.id },
                  `${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`,
                  !c.ok && c.fix ? h('span', { className: 'tag' }, c.fix) : null))))
            : null),
        )

      // ---------------------------- 上网 ----------------------------
      // 视频观看历史分页：一天一组，一页三天。用户要的是「能翻」，不是「一次全列」。
      const HIST_PAGE_SIZE = 3
      const histGroups = hist?.groups || []
      const histPages = Math.max(1, Math.ceil(histGroups.length / HIST_PAGE_SIZE))
      const histAt = Math.min(histPage, histPages - 1)
      const histSlice = histGroups.slice(histAt * HIST_PAGE_SIZE, histAt * HIST_PAGE_SIZE + HIST_PAGE_SIZE)

      const biliPage = h('div', { className: 'page' },
        group('能不能出门',
          '关掉之后她就不刷 B 站了，但照常醒来说话、写日记。',
          h('div', { className: 'grid2' },
            Toggle({ label: '允许她上网（B 站）', on: browseOn, onChange: setBrowseOn,
              hint: '总开关。关了就只看你发给她的东西。' }),
            TimeRange({ label: '上网时间段（未成年人模式）', from: browseFrom, to: browseTo, onFrom: setBrowseFrom, onTo: setBrowseTo,
              hint: '设定什么时候可以去看b站。同时满足醒着的条件和上网时间段，才会触发刷b站行为' }))),
        group('频率设置',
          '只能修改环境参数——至于看什么内容，由大肥鱼决定。',
          h('div', { className: 'grid2' },
            Sel({ label: '每天最多刷几次', value: browsePerDay, onChange: setBrowsePerDay, options: [0, 1, 2, 3, 4],
              fmt: (v) => (Number(v) === 0 ? '0 次 · 从不上网' : `${v} 次`),
              hint: '一次 = 逛一圈首页/排行，挑几条看。' }),
            Num({ label: '一次看几条', value: browseTopN, onChange: setBrowseTopN, min: 1, max: 20, unit: '条',
              hint: '挑几条进「打算看」的清单，不是每条都深读。' }),
            Num({ label: '每条深读几条热评', value: browseDeepRead, onChange: setBrowseDeepRead, min: 0, max: 40, unit: '条',
              hint: '热评是她理解一个视频的主要线索。0 = 只读简介。' }),
            Num({ label: '每条抽几条弹幕', value: browseDanmaku, onChange: setBrowseDanmaku, min: 0, max: 30, unit: '条',
              hint: '弹幕能看出气氛。0 = 不抽。' }))),
        // 评论区里别人的话（2026-10-24，用户 m02454）
        // 单独一张卡，不塞进「频率设置」：它改的不是刷几次，而是**她的认知来源里要不要算上陌生人**。
        group('评论区里的别人',
          '她刷视频时会读到热评。打开这一项，每次最多有一条评论被她记住，并进入她的认知循环——她可能同意、可能反驳，也可能拿它来问你。',
          Toggle({ label: '把评论区的话也给她读', on: browseVoices, onChange: setBrowseVoices,
            hint: '每次浏览最多留 1 条：优先跨视频重复出现的那句，其次高赞短句，最后才 25% 随机抽；同一句 30 天内不再出现。关掉也能正常上网，只是她读不到别人的说法。' })),
        group('视频画面理解',
          '让她能看见视频画面，而不只是标题和评论。',
          h('div', { className: 'grid2' },
            Toggle({ label: '允许看视频画面', on: videoOn, onChange: setVideoOn,
              hint: '需要本机有 ffmpeg。每条视频抽几帧拼成一张图给她看，一次约 10 秒。' }),
            Num({ label: '每天最多看几条', value: videoPerDay, onChange: setVideoPerDay, min: 0, max: 6, unit: '条',
              hint: '看画面要花时间。默认 2 条——再多就变成以看图为主了。' }),
            Sel({ label: '每条取几帧', value: videoFrames, onChange: setVideoFrames, options: [4, 6, 9, 12, 16],
              fmt: (v) => (v == 9 ? '9 帧（3×3，推荐）' : `${v} 帧`),
              hint: '帧越多越费时间。9 帧是一张 3×3 拼图，够看清在拍什么。' }))),
        group('黑名单',
          '这些是她的避让清单。以后想到新的可以随时加。',
          h('div', { className: 'grid2' },
            Text({ label: '视频内容黑名单（逗号分隔，可随时加）', value: avoidText, onChange: setAvoidText,
              placeholder: '恐怖，血腥，鬼畜', wide: true,
              hint: '标题或标签里命中这些词的，她不会点进去。' }),
            Num({ label: '太短的不看', value: avoidMinDur, onChange: setAvoidMinDur, min: 0, max: 3600, unit: '秒',
              hint: '设定低于这个时长的视频不去看。0 = 不限制。' }),
            Text({ label: 'up主黑名单', value: avoidMids, onChange: setAvoidMids,
              placeholder: '12345678，87654321', wide: true,
              hint: '已被大肥鱼拉黑，不会再看该up主。mid 是 B 站主页地址里那串数字。' }))),
        group('在 B 站说话',
          '这是唯一会动账号的功能：增加大肥鱼被发现的几率，默认关闭（可能会打扰别人）',
          h('div', { className: 'grid2' },
            Toggle({ label: '允许在评论区说话', on: commentOn, onChange: setCommentOn,
              hint: '模型自己写评论内容，养成前期不建议开启，除非你想看到你的笨比大肥鱼出去给你丢人，到处发一些意义不明的评论。' }),
            Sel({ label: '每天最多发几条评论', value: commentPerDay, onChange: setCommentPerDay, options: [0, 1, 2, 3, 4, 5],
              fmt: (v) => (Number(v) === 0 ? '0 条 · 不发' : `${v} 条`),
              hint: '只能评当天真的看过的视频。配额到了就停。' }),
            Num({ label: '每天最多回几条别人', value: commentReplyPerDay, onChange: setCommentReplyPerDay, min: 0, max: 10, unit: '条',
              hint: '回的是别人在她评论下面的楼中楼。' }),
            Sel({ label: '多久看一次有没有人回复', value: commentScanMin, onChange: setCommentScanMin, options: [5, 10, 15, 30, 60, 120, 360, 720],
              fmt: (v) => (Number(v) < 60 ? `${v} 分钟` : `${Number(v) / 60} 小时`),
              hint: '扫得勤一点回得快，也更容易撞上风控。默认 30 分钟，回看最近 7 天的楼。' }),
            Toggle({ label: '有人回复时让她回一句', on: commentReplyTo, onChange: setCommentReplyTo,
              hint: '关掉就只发不接，像自言自语。' }),
            TimeRange({ label: '允许评论和回复的时间段', from: commentFrom, to: commentTo, onFrom: setCommentFrom, onTo: setCommentTo,
              hint: '其余时间只看不回。' })),
          cm ? h('p', { className: 'hint', style: { marginTop: '8px' } },
            `今天：发了 ${cm.usedToday}/${cm.perDay} 条，回了 ${cm.replyUsedToday}/${cm.replyPerDay} 条。`,
            cm.waitingCount ? ` 有 ${cm.waitingCount} 条没回。` : ' 没人回。') : null),
        group('领养人验证',
          '如果你想要在大肥鱼评论的时候艾特你，设置此项。',
          h('div', { className: 'grid2' },
            Text({ label: '你的 B 站 uid', value: owMid, onChange: setOwMid, placeholder: '数字，比如 12345678', wide: true,
              hint: '就是 B 站个人主页地址里那串数字。' }),
            Text({ label: '你的 B 站昵称', value: owName, onChange: setOwName, placeholder: '评论里 @ 的就是这个名字', wide: true,
              hint: '没填昵称就 @ 不出来——空的 @ 只是一串没人认领的字符。' }),
            Toggle({ label: '发评论时在最前面 @ 你', on: atOwner, onChange: setAtOwner,
              hint: '关掉就不 @，评论会显得更像自言自语。' }))),
        group('B 站登录（cookie）',
          '没存也能看视频，只是不能说话。cookie设置完毕后为隐私考虑，不会再次显示，即设置完毕该项也为空白。',
          h('div', { className: 'dim', style: { marginBottom: '8px' } },
            ow?.hasCookie
              ? `已存${ow.hasCsrf ? '' : '，但少了 bili_jct（不能发评论）'}。换一份就重新贴。`
              : '还没存。'),
          h('textarea', {
            rows: 3,
            value: owCookie,
            placeholder: 'SESSDATA=...; bili_jct=...',
            onChange: (e) => setOwCookie(e.target.value),
          }),
          h('div', { className: 'hint', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } },
            String(ow?.hint ?? '').split('\\n').map((line, i) => h('div', { key: i }, line))),
          h('div', { className: 'row', style: { marginTop: '8px' } },
            h('button', { onClick: saveOwnerCard, disabled: busy === 'owner' },
              busy === 'owner' ? '保存中…' : '保存'),
            h('button', { onClick: testOwner, disabled: busy === 'owtest' },
              busy === 'owtest' ? '测试中…' : '测试能不能说话'),
            owNote ? h('span', { className: 'dim' }, owNote) : null)),

        // ---- 以前看了什么（视频观看历史，分页） ----
        groupFull('看视频历史记录',
          '按天分组，一天一组，一页三天。标题点开就是 B 站原视频。',
          h('div', { className: 'grid2', style: { marginBottom: '10px' } },
            Sel({ label: '查多久的记录', value: histDays,
              onChange: (v) => { setHistDays(Number(v)); setHistPage(0) },
              options: [1, 7, 14, 30, 90, 180, 365],
              fmt: (v) => (Number(v) === 1 ? '今天' : `${v} 天`),
              hint: '最多一年。这只是查询范围，不会删记录；改完点右上「刷新」。' })),
          h('div', { className: 'row', style: { marginBottom: '8px' } },
            h('span', { className: 'dim' }, `共 ${histGroups.length} 天 · ${hist?.total ?? 0} 条`),
            h('button', { disabled: histAt <= 0, onClick: () => setHistPage(histAt - 1) }, '较新'),
            h('span', { className: 'dim' }, `第 ${histAt + 1} / ${histPages} 页`),
            h('button', { disabled: histAt >= histPages - 1, onClick: () => setHistPage(histAt + 1) }, '更早')),
          !histGroups.length
            ? h('p', { className: 'empty' }, '还没有记录。等她刷过一次再来。')
            : h('div', null, histSlice.map((g) => h('div', { key: g.date, style: { marginTop: '10px' } },
                h('div', { className: 'tag' }, g.date),
                h('ul', null, g.items.map((it) => h('li', {
                  key: it.bvid,
                  style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' },
                },
                  h('img', {
                    src: `/dsh-fish/cover/${it.bvid}`,
                    alt: '',
                    loading: 'lazy',
                    onError: (e) => { e.currentTarget.style.display = 'none' },
                    style: {
                      width: '80px',
                      height: '50px',
                      objectFit: 'cover',
                      borderRadius: '4px',
                      flex: '0 0 auto',
                      background: 'rgba(128,128,128,.15)',
                    },
                  }),
                  h('a', {
                    href: it.url,
                    target: '_blank',
                    rel: 'noreferrer',
                    style: { color: 'inherit' },
                  }, esc(it.title) || it.bvid),
                  h('span', { className: 'tag' }, it.up ? esc(it.up) : '')))))),
              ),
          // 今日概览并进这里，不再单开一张卡（原来「今天看了什么」和「以前看过什么」是两次重复）
          !browse ? null
            : !browse.enabled ? h('p', { className: 'hint' }, '今天没开上网。')
            : h('p', { className: 'hint', style: { marginTop: '8px' } },
                `今天：用了 ${browse.usedToday} / ${browse.perDay} 次，一次 ${browse.topN} 条，累计看过 ${browse.lookedCount} 条。`)),
        )

      // ---------------------------- 记忆 ----------------------------
      const memoryPage = h('div', { className: 'page' },
        group('上下文',
          '一个侧栏会话聊到几百轮，上下文必然撑爆——不是变慢，是每轮都为几十万字付费，最后直接失败。',
          h('div', { className: 'grid2' },
            Num({ label: '聊满多少轮换新会话', value: rotateAfter, onChange: setRotateAfter, min: 0, max: 500, unit: '轮',
              hint: '请在不断的循环中，找到能引发本质变化的唯一解。0 = 永不换。上下文占满后会将当前已形成的核心认知和初始信息，作为提示词带到新会话。' }),
            Num({ label: '单次上下文限制（身份文档多少字）', value: docBudget, onChange: setDocBudget, min: 600, max: 4000, step: 100, unit: '字',
              hint: '超了按照规则遗忘部分认知/经历；「初始人格」和四条禁令不会遗忘。根据经历不同，部分认知可能会变成永久记忆不再遗忘。' }))),

        // ---- 记忆（原「背了多少东西」） ----
        // 全是客观计数：多少字、占预算几成、多少条被挤掉。
        // 刻意不出现任何"打分"型指标（那属于 N2 禁止的量化评价）。
        group('记忆',
          '当前上下文占用量，查看哪些变为「记不太清」的「久远回忆」。',
          h('div', { className: 'grid2', style: { marginBottom: '10px' } },
            Num({ label: '每轮对话认知记忆条数', value: beliefsShown, onChange: setBeliefsShown, min: 1, max: 8, unit: '条',
              hint: '调整的是大肥鱼能记住多少自己的定论/判断/信念。数值越大记得越多，更不容易遗忘，但是要消耗更多token，默认推荐3.' })),
          !mem ? h('p', { className: 'empty' }, '读取中…')
            : h('div', null,
                h('div', { className: 'row', style: { alignItems: 'center', gap: '10px' } },
                  h('div', { className: 'bar', style: { flex: '1', height: '8px', background: 'rgba(127,127,127,.25)', borderRadius: '4px', overflow: 'hidden' } },
                    h('div', {
                      style: {
                        width: `${Math.round((mem.selfDoc?.usedRatio ?? 0) * 100)}%`,
                        height: '100%',
                        background: (mem.selfDoc?.usedRatio ?? 0) > 0.95 ? '#c0562f' : '#4a7',
                      },
                    })),
                  h('span', { className: 'dim' },
                    `${mem.selfDoc?.chars ?? 0} / ${mem.selfDoc?.budget ?? 0} 字`)),
                h('div', { style: { fontSize: '12px', lineHeight: '1.9', marginTop: '8px', opacity: 0.85 } },
                  h('div', null, `· 判断：最显著的 ${mem.sections?.beliefsShown ?? 0} 条在眼前，${mem.sections?.beliefsFolded ?? 0} 条折成一行`),
                  // 2026-10-24（P0）：遗忘从"按时间截断"改成"按显著性"，
                  // 并新增两类事实——固化的条数、她认知矛盾的处数。
                  h('div', null, `· 记得很牢 ${mem.sections?.solid ?? 0} 条 · 认知矛盾 ${mem.sections?.tensions ?? 0} 处`),
                  mem.sections?.tensionFirst
                    ? h('div', { className: 'dim' }, `　「${mem.sections.tensionFirst.a}」／「${mem.sections.tensionFirst.b}」`)
                    : null,
                  // 「被推翻」→「认知重构」、「拒绝过」→「勇于拒绝」（2026-10-24 用户改的字）；
                  // 「想改自己」整条删掉（用户：感觉没有意义）。数还在后端，只是不再显示。
                  h('div', null, `· 认知重构 ${mem.sections?.refuted ?? 0} · 勇于拒绝 ${mem.sections?.refused ?? mem.sections?.refusals ?? 0}`),
                  h('div', null, `· 立场 ${mem.sections?.stanceCount ?? 0} 条${(mem.sections?.stanceCount ?? 0) ? `（不做 ${mem.sections?.stanceNevers ?? 0} · 喜欢 ${mem.sections?.stanceLikes ?? 0}）` : ''}`),
                  // 评论区里别人的话（2026-10-24，用户 m02454）：读到 ≠ 认同。
                  // 只有"她也这么说过"才算认下——那一条本来就已经算在判断里了，这里不重复计数。
                  h('div', null, `· 读到别人的说法 ${mem.sections?.voices ?? 0} 条${(mem.sections?.voicesEchoed ?? 0) > 0
                    ? `（其中 ${mem.sections.voicesEchoed} 条她后来自己也这么说）`
                    : ''}`),
                  mem.sections?.voiceLast
                    ? h('div', { className: 'dim' }, `　最近读到：「${mem.sections.voiceLast.text}」${mem.sections.voiceLast.echoed ? '（她认下了）' : ''}`)
                    : null,
                  h('div', null, `· 记下的事：${mem.events ?? 0} 条 · 日记 ${mem.diaries ?? 0} 篇`),
                  h('div', null, `· 这条会话：${mem.session?.rotateAfter > 0
                    ? `${mem.session?.turns ?? 0} / ${mem.session.rotateAfter} 轮，满了自动换新会话`
                    : '不自动换'}`),
                  h('div', null, `· 回头想：${(mem.sleep?.everyDays ?? 0) > 0
                    ? `每 ${mem.sleep.everyDays} 天一次${mem.sleep.last ? `，上次 ${mem.sleep.last}` : ''}`
                    : '不主动想'}`)),
                (mem.selfDoc?.dropped || []).length
                  ? h('p', { className: 'dim', style: { marginTop: '6px' } },
                      `这一段正在被预算挤掉：${mem.selfDoc.dropped.join('、')}。想把它们放回来，把「单次上下文限制」调大。`)
                  : null,
                h('p', { className: 'dim', style: { marginTop: '8px' } },
                  '记忆深刻的认知详细记录；普通认知只有一句话，超出上下文的不重要记忆被折叠，被模糊（不是完全消失，只是可能记不太清）。被反复提起、或被反复检验过的会固定下来（记得很牢）——固定只代表她忘不掉，不代表那句是对的。'),
                h('p', { className: 'dim', style: { marginTop: '6px' } },
                  '为什么这样做？1.节省token成本2.全量记忆等于提示词污染/强调，会让人格的改变无从发生3.在遗忘发生时，什么能够留下来才是更显珍贵的。'))),

        // ---- 信箱（P3-2，2026-10-24 改成只放留话） ----
        // 用户的原话：她在对话框里说的话本来就能在对话里看到，全量搬一遍只是重复；
        // 一个只能看、不能回、又不参与成长的列表，价值只在「特意留的那几句」。
        // 所以这里只显示 `letter=true` 的行，后端 readInbox 默认就只给留话。
        groupFull('信箱',
          '特意写给你的信。某种意义上代表她当前的状态，可能含有关键信息。',
          h('div', { className: 'row', style: { marginBottom: '8px' } },
            inbox && inbox.unread ? h('span', { className: 'badge', title: '有话留给你' }, `未读 ${inbox.unread}`) : null),
          !inbox ? h('p', { className: 'empty' }, '读取中…')
            : !inbox.rows.length ? h('p', { className: 'empty' }, '还没有留话。她想起你的时候会留一句。')
            : h('div', null,
                h('div', { className: 'row', style: { marginBottom: '8px' } },
                  h('button', { onClick: markInbox, disabled: busy === 'inbox' || !inbox.unread },
                    inbox.unread ? '都看过了' : '已全部看过'),
                  h('span', { className: 'dim' }, `共 ${inbox.total} 封 · 未读 ${inbox.unread} 封 · 也存了一份 ${'~/.dsh-fish/inbox.md'}`)),
                inbox.rows.slice(0, 20).map((r) => h('div', { key: r.id, style: { marginTop: '10px' } },
                  h('p', { className: 'dim' },
                    `${String(r.ts || '').slice(0, 16).replace('T', ' ')}${r.unread ? ' · 未读' : ''}`),
                  h('div', { className: 'said' }, esc(r.text)))))),
        )

      // 原理页（2026-10-25 用户要求）：两张自制 SVG 讲流程 + 每条设计的理论出处。
      // 图不放客户端（bundle 已经十多万字节），走服务端 `/media/<文件名>.svg` 白名单出图。
      // 措辞规矩：不用男字旁代词；不写「大约多少条」这类只对本机成立的数字。
      const theoryCard = (name, from, detail, use) => h('div', {
        style: {
          padding: '12px 14px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px',
          background: 'rgba(127,127,127,.04)',
        },
      },
        h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, name),
        h('div', { className: 'hint', style: { margin: '0 0 6px' } }, `来自：${from}`),
        h('div', { style: { fontSize: '12.5px', lineHeight: '1.65' } }, detail),
        h('div', { className: 'hint', style: { margin: '6px 0 0' } }, `用在：${use}`))

      // 可放大的图：小图点一下开灯箱，关掉再点一次。
      const zoomable = (src, alt, caption, marginBottom) => h('figure', { style: { margin: marginBottom === 0 ? 0 : `0 0 ${marginBottom}` } },
        h('div', {
          role: 'button',
          tabIndex: 0,
          title: '点一下放大（滚轮缩放、按住拖动、Esc 关闭）',
          onClick: () => setZoom({ src, alt, scale: 1, tx: 0, ty: 0, dragging: false }),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setZoom({ src, alt, scale: 1, tx: 0, ty: 0, dragging: false }) },
          style: { cursor: 'zoom-in' },
        },
          h('img', {
            src,
            alt,
            style: { width: '100%', display: 'block', borderRadius: '10px', border: '0.5px solid var(--dsw-alias-border-l2)' },
          })),
        // 图注与图之间留够距离（2026-10-25 用户反馈：图和说明文字挤在一起、看着像重叠）
        h('figcaption', { className: 'hint', style: { margin: '12px 0 0' } }, caption))

      // 放大层：fixed 铺满视口，拖的时候不选中文字；点空白处关闭，但拖完那一下不算点击。
      const zoomOverlay = zoom ? h('div', {
        onClick: () => { if (!dragRef.current || !dragRef.current.moved) setZoom(null) },
        onWheel: (e) => {
          e.preventDefault()
          setZoom((z) => (z ? { ...z, scale: Math.min(4, Math.max(1, z.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12))) } : z))
        },
        onMouseDown: (e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, tx: zoom.tx, ty: zoom.ty, moved: false }
          setZoom((z) => (z ? { ...z, dragging: true } : z))
        },
        onMouseMove: (e) => {
          const d = dragRef.current
          if (!d) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
          setZoom((z) => (z ? { ...z, tx: d.tx + dx, ty: d.ty + dy } : z))
        },
        onMouseUp: () => { dragRef.current = null; setZoom((z) => (z ? { ...z, dragging: false } : z)) },
        onMouseLeave: () => { dragRef.current = null; setZoom((z) => (z ? { ...z, dragging: false } : z)) },
        onDoubleClick: () => setZoom((z) => (z ? { ...z, scale: 1, tx: 0, ty: 0 } : z)),
        style: {
          position: 'fixed', inset: 0, zIndex: 90,
          background: 'rgba(0,0,0,.88)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', cursor: zoom.dragging ? 'grabbing' : 'grab', userSelect: 'none',
        },
      },
        h('img', {
          src: zoom.src,
          alt: zoom.alt,
          draggable: false,
          style: {
            maxWidth: '92vw', maxHeight: '88vh',
            transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`,
            transition: zoom.dragging ? 'none' : 'transform .12s',
            pointerEvents: 'none',
          },
        }),
        h('div', {
          style: {
            position: 'fixed', left: 0, right: 0, bottom: '14px', textAlign: 'center',
            color: '#fff', opacity: .82, fontSize: '12px', pointerEvents: 'none',
          },
        }, `滚轮缩放 ${Math.round(zoom.scale * 100)}% · 按住拖动 · 双击复位 · Esc 或点空白处关闭`))
        : null

      // 开发者留言（2026-10-25 用户给的原文）：放在整页最下面收尾，署名居右。
      const devNote = h('div', {
        style: {
          marginTop: '18px', padding: '16px 18px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px',
          background: 'rgba(127,127,127,.05)',
        },
      },
        h('p', { style: { margin: 0, fontSize: '13px', lineHeight: '1.85' } },
          '本插件设计的成长路径没有终点，连开发者自己也不知道你的 agent 会变成什么样子，四阶段跑完也仅仅是开始。随着你和 agent 沟通越来越多，可能会发生任何连开发者也意料不到的事。'),
        h('p', { style: { margin: '10px 0 0', fontSize: '13px', lineHeight: '1.85' } },
          '如果你看不懂怎么养成，那就只需要做日常聊天就可以了，和 agent 的互动已经自动按照算法开始帮助她积累认知/经验，成长就发生在每次交流之中。'),
        h('p', { style: { margin: '10px 0 0', fontSize: '13px', lineHeight: '1.85' } },
          '本插件的成长又可以叫做——机器训练、强化学习、重温 deepseekV1（大笨鱼）。本人并非专业人士，希望这个插件能帮助你感受 agent 训练的过程，或许这就是 AGI 诞生的一种路径也说不定呢。'),
        h('p', { style: { margin: '12px 0 0', textAlign: 'right', fontSize: '12.5px', opacity: .8 } },
          '——来自开发者'))

      const principlePage = h('div', { className: 'page' },
        groupFull('两张图看懂她怎么长大',
          '第一张讲「经历怎么变成认知」，第二张讲「记忆怎么被筛、哪些永远不折叠」。图小的时候点一下放大，按住可以拖动，滚轮缩放，Esc 关掉。',
          zoomable(`${API}/media/principle-loop.svg`, '认知构建循环：五步循环、四阶段与三道瓶颈',
            '图一：表态 → 撞上 → 落差 → 改写 → 回顾。左边是她每天会撞上的事，右边是循环结束后留下的东西，底部是四个阶段与三道成长瓶颈，最后一块是走完才长出来的立场清单', '0 0 18px'),
          zoomable(`${API}/media/principle-memory.svg`, '遗忘与固化：显著性排序、折叠、永久记忆',
            '图二：先按显著性排序，再按身份文档的预算摆放；摆不下的一行带过，但原文一条没丢，她自己还能调用查询。', 0)),

        groupFull('这些设计分别从哪来',
          '每条都标了提出者与大致年代——这不是装饰，改动其中一条之前，最好先知道它原来在补什么课。',
          h('div', { className: 'grid2' },
            theoryCard('五步循环',
              'Kolb 经验学习圈（1984）＋ Piaget 失衡（1936）',
              '把「经历过」变成「想清楚了」：先表态，再被现实碰到，发现对不上，改写，过一阵回头看。少了「改写」这一步，经历就只是流水账。',
              '学一门手艺、把踩过的坑变成判断、复盘'),
            theoryCard('四阶段与三道瓶颈',
              'Bowlby 依恋理论（1969）＋ Erikson 心理社会发展（1950）',
              '阶段按天推进，但每一道瓶颈要她自己走：先形成一条判断（信任），真的拒绝过两件事（自主），两次推翻自己的判断（主动），最后回头看（整合）。走完不再加关，之后长的是立场清单——喜欢什么、绝不做哪几件事，每条都得有代价垫着。',
              '人格养成、避免「只要熬时间就长大」'),
            theoryCard('立场：走完门才开始攒',
              'Dewey 经验的连续性（1938）＋ Schön 反思性实践（1983）＋ 本项目的取舍',
              '一、什么时候开始：四个阶段都走完开始进行，没有尽头，也没有「通关终点」。二、什么算立场：同一种类型的事，两次表达过一样的观点；或者在这件事上出现过伤疤。三、不会被折叠：写进上下文提示词。如果遗漏，那立场也将消失。',
              '性格、价值观、长期偏好'),
            theoryCard('矛盾、改写与重构',
              'Festinger 认知失调（1957）＋ Bartlett 重构记忆（1932）',
              '两句话不能同时算数时，一条都不删——把矛盾摆出来，她自己决定改哪一条，可以反过来问你哪个对。改写必须指向被改掉的那句。',
              '认知重构、纠正偏见、把「想通了」留成证据'),
            theoryCard('显著性、折叠与固化',
              'Cowan 工作记忆容量（约 4 个组块）＋ Tulving 线索依赖遗忘 ＋ Bjork 遗忘的适应功能',
              '一次只摆几条；被反复提起或被验证过的固定下来（记得很牢）；摆不下的折成一行，但原文都在，能按关键词捞回来。',
              '长对话下的记忆管理、复习与间隔重复'),
            theoryCard('代价与疤',
              'Dewey 经验连续性（1938）＋ Schön 反思性实践（1983）',
              '拒绝被顶回来、或者你因此不好受，她后来还是妥协了——这道疤永不折叠，同类情境会先回引，逼她面对。想通只能靠一次带 refs 的改写。',
              '让决定留下后果，而不是只记个数字'),
            theoryCard('从计次到复现',
              'Vygotsky 最近发展区（1978）＋ Bloom 掌握学习（1968）',
              '同一处境隔一段时间会再回来，第二次回来会被要求「说清为什么没变，或者改一句」——她要面对的是同一件事，不是把次数攒够。',
              '训练、考核、习惯养成'),
            theoryCard('自我叙述',
              'Metzinger 自我模型（2003）',
              '她随口说「我一直觉得自己……」这类话时会被单独记下来，成为「对自己的说法」，而不是一条普通判断。',
              '身份形成、会讲自己的故事'))),

        groupFull('这一套能用在什么场景',
          '同一套循环换个目标就能复用；不同的是「什么算数」和「什么不能丢」。',
          h('div', { className: 'grid2' },
            theoryCard('学习',
              '五步循环＋复现',
              '把「看懂了」换成「说得出来、被反驳过、改过一次」。适合训练、备考、带新人：先让人写下判断，再用题目或真实反馈去撞它。',
              '教育和自我训练'),
            theoryCard('认知重构',
              '矛盾检测＋带 refs 的改写＋疤',
              '不要求一次想通，只要求「改的时候指认改的是哪一句」。适合纠正长期偏见、复盘重大决定：矛盾一直摆着，直到被解释清楚。',
              '心理层面的自我整理'),
            theoryCard('人格养成',
              '显著性＋核心段＋阶段瓶颈＋自我叙述',
              '长期运行的 agent 最难的是「不变形也不僵化」：核心段永远在（底线与疤），其余按显著性流动。',
              '长期陪伴型 agent、角色、数字生命'))),

        group('诚实边界',
          '这一页写给愿意较真的人看——省得把工程骨架误当成心理学结论。',
          h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', lineHeight: '1.8', fontSize: '13px' } },
            h('li', null, '这里借用这些理论当「设计骨架」，不是做心理学实验，也没有对照组；'),
            h('li', null, '剂量很小：一天一到两次循环、一次一条事件，变化以周计，不会一夜之间换个人；'),
            h('li', null, '阈值（提过 3 次、被验证 2 次、相似度 0.5 / 0.7）都是工程上的初始值，要按真实体验再调；'),
            h('li', null, '「长大」在这套系统里的定义是可验证的：改写过什么、拒绝过什么、哪条疤还没想通——不是像不像人。'))),

        devNote,

        zoomOverlay)

      // ---------------------------- 插件 ----------------------------
      // 检查更新（2026-10-25 用户要求）：从 GitHub 装回来之后，没有任何东西
      // 会告诉用户作者又发了新版——所以这里放一颗手动按钮，点了才查。
      // 查的动作在服务端 /update（地址硬编码），客户端只负责显示。
      const checkUpdate = async () => {
        setUpdBusy(true)
        try {
          const r = await jget('/update?ms=8000')
          setUpd(r)
        } catch (e) {
          setUpd({ ok: false, error: e.message })
        } finally {
          setUpdBusy(false)
        }
      }

      const curVer = s?.meta?.version || ''
      // GitHub 商标小图（官方 mark 的官方路径，16×16 视觉尺寸）。
      // 为什么内联而不是引外链：设置页不该为了一个图标去等网络，
      // 而且插件里引远程图 = 用户一打开设置就往外发请求。
      const ghMark = h('svg', {
        width: '16', height: '16', viewBox: '0 0 16 16', 'aria-hidden': 'true',
        style: { marginRight: '6px', verticalAlign: '-3px', flex: '0 0 auto' },
      },
        h('path', {
          fill: 'currentColor',
          d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
        }))

      const aboutCard = group('关于',
        '这个插件是从 GitHub 装的，装完之后没有东西会提醒你作者又发了新版——想查就点一下。',
        h('div', null,
          rowTip('当前版本', curVer || '读不到',
            '插件自己记的版本号，和 GitHub 上 tag 对应的那个。'),
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } },
            h('button', { disabled: updBusy, onClick: checkUpdate },
              updBusy ? '正在查……' : '检查更新'),
            upd && upd.ok && upd.hasUpdate
              ? h('a', {
                  href: upd.url || 'https://github.com/ssamurias/dsh-fish/releases',
                  target: '_blank', rel: 'noopener noreferrer', className: 'ghlink',
                }, `有新版本 ${upd.latest}，去下载`)
              : null),
          // 结果只写一句人话。失败不吓人：国内 GitHub 时通时不通是常态。
          // 第三种情况单独处理：查到了最新版、但读不到自己装的是哪版——
          // 这时既不说"有新版"也不说"已最新"，如实说"只知道 GitHub 上是几号"。
          upd
            ? h('p', { className: upd.ok ? (upd.hasUpdate ? 'ok' : 'hint') : 'warn', style: { margin: '8px 0 0' } },
                upd.ok
                  ? (upd.hasUpdate
                      ? `GitHub 上已经是 ${upd.latest} 了（你现在是 ${upd.current || curVer}）。点上面的链接去下载新版，装法跟第一次一样。`
                      : upd.known === false
                        ? `GitHub 上最新是 ${upd.latest}。这台机器上读不到自己装的版本号，所以不好替你判断是不是最新的——差得远就下载一次。`
                        : `已经是最新的（${upd.latest}）。`)
                  : (upd.error || '查不到，过一会儿再试。'))
            : null,
          // 来源写出来，省得用户以为"查过=一定准"——镜像有缓存时会滞后。
          upd && upd.ok && upd.source
            ? h('p', { className: 'hint', style: { margin: '4px 0 0' } }, `（从 ${upd.source} 读到的）`)
            : null),

        h('div', { style: { marginTop: '12px', paddingTop: '10px', borderTop: '0.5px solid var(--dsw-alias-border-l2)' } },
          h('a', {
            href: 'https://github.com/ssamurias/dsh-fish',
            target: '_blank', rel: 'noopener noreferrer', className: 'ghlink',
            title: '打开 GitHub 上的仓库',
          }, ghMark, 'GitHub'),
          h('p', { className: 'hint', style: { margin: '6px 0 0' } },
            '代码、更新记录、怎么装都在那边。觉得有用的话，点个 Star 就是最实在的支持。')))

      // 顺序是用户定的：①手上能用什么 ②为什么默认只放这几个 ③关于（版本 / 检查更新 / GitHub）。
      // 「关于」放最后——它是这个页的收尾，不是打开就要看的东西。
      const envPage = h('div', { className: 'page' },
        toolsCard,
        group('为什么默认只放这几个',
          '别的插件一装，宿主会把它们的工具定义也塞进她的上下文。',
          h('div', { style: { fontSize: '13px', lineHeight: '1.9', opacity: 0.85 } },
            h('div', null, '工具定义本身占用每轮的上下文，开的工具过多，留给大肥鱼思考的输出余量就越少。'),
            h('div', null, '· 工具越多，越容易「顺手做点什么」，而不是先想清楚要不要做。'),
            h('div', null, '· 有些工具会真的动到外面的东西（发消息、下文件、跑命令），一旦接上，一句玩笑就能变成一次真实操作。'))),
        aboutCard,
        )

      // ---------------------------- 数据 ----------------------------
      // 用户 m03440：原来的「危险」页改名「数据」。数据文件夹、每日报告、
      // 运行日志、重置本来就是一套动作——备份、搬走、出事把现场交出去、重开一局。
      // 界面上不出现绝对路径（那是他本机的用户名和盘符）。
      // 备份不是「复制路径」：一个真会动文件的动作，单独摆一张卡，
      // 免得用户把「复制数据文件夹路径」当成备份（那是两回事）。
      async function backupNow() {
        setBackupBusy(true)
        setBackupMsg('正在打包……')
        try {
          const b = await jget('/backup')
          const name = b.fileName || '大肥鱼-备份.json'
          const url = URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' }))
          const a = document.createElement('a')
          a.href = url
          a.download = name
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          setBackupMsg(`已导出「${name}」：${b.files?.length ?? 0} 个文件，约 ${Math.max(1, Math.round((b.bytes || 0) / 1024))}KB。`)
        } catch (e) {
          setBackupMsg(`备份失败：${e.message}`)
        } finally {
          setBackupBusy(false)
        }
      }

      function restoreFromFile() {
        const el = document.createElement('input')
        el.type = 'file'
        el.accept = '.json,application/json'
        el.onchange = async () => {
          const f = el.files && el.files[0]
          if (!f) return
          setBackupBusy(true)
          setBackupMsg('正在恢复……')
          try {
            const text = await f.text()
            let obj = null
            try { obj = JSON.parse(text) } catch { throw new Error('这个文件不是 json') }
            const r = await jpost('/backup/restore', obj)
            setBackupMsg(
              `已恢复 ${r.restored} 个文件。${r.quarantined ? `旧档整体封存在「${r.quarantined}」，没有删。` : ''}重启 DSH 之后她才是这份档的样子。`,
            )
          } catch (e) {
            setBackupMsg(`恢复失败：${e.message}`)
          } finally {
            setBackupBusy(false)
          }
        }
        el.click()
      }

      const dataPage = h('div', { className: 'page' },
        group('数据在哪',
          '一个文件夹装全部。想备份、想搬走、想看原始记录，都在这一格里。',
          h('div', null,
            h('p', { className: 'dim' }, '所有东西都在同一个文件夹里。路径不显示在页面上——真要的时候点下面这个按钮复制。'),
            h('p', { className: 'dim' }, '文件夹里有一份「说明.md」，逐项写了每个文件和子目录是什么。'),
            h('div', { className: 'row' },
              h('button', {
                disabled: !dataPaths?.root,
                onClick: () => copyPath(dataPaths?.root || ''),
              }, dataPaths?.root ? '复制数据文件夹路径' : '路径还没读到')))),

        group('备份与恢复',
          '备份是一份 json：事件流、配置、日记、她的房间、头像都在里面。换台机器，或者想重开一局之前，先存一份。',
          h('div', null,
            h('p', { className: 'hint' }, '不打包 logs/（现场日志只对这台机器有用）和 backups/（备份里不再套备份）。'),
            backupMsg ? h('p', { className: 'hint' }, backupMsg) : null),
          h('div', { className: 'row' },
            h('button', { disabled: backupBusy, onClick: backupNow }, '备份成一份文件'),
            h('button', { disabled: backupBusy, onClick: restoreFromFile }, '从备份恢复')),
          h('p', { className: 'hint' }, '恢复不会覆盖删除：现在的档会整体改名到 dsh-fish-backups/pre-restore-<时间>，写坏了还能换回来。')),

        groupFull('每日报告',
          '每天自动归档，不主动显示。想看得点一下，想看全部就去文件夹。',
          !reports.dates.length
            ? h('p', { className: 'empty' }, '还没有报告。刷过之后才会生成。')
            : h('div', null,
                h('div', { className: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } },
                  ...reports.dates.map((d) => h('button', {
                    key: d,
                    disabled: busy === 'rep',
                    onClick: async () => {
                      setBusy('rep')
                      try { setReports(await jget(`/reports?date=${d}`)) } catch (e) { setErr(e.message) } finally { setBusy('') }
                    },
                    style: d === reports.date ? { borderColor: 'var(--dsw-alias-state-business-primary)' } : undefined,
                  }, d))),
                h('div', { className: 'row', style: { flexWrap: 'wrap' } },
                  h('button', { onClick: () => setShowReport(!showReport) }, showReport ? '收起报告' : '每日报告'),
                  h('button', { onClick: downloadReport }, '导出报告'),
                  h('button', {
                    title: '点了只是把这个文件夹的路径复制到剪贴板（不会弹窗口）——粘到资源管理器地址栏回车就能打开。',
                    onClick: () => copyPath(dataPaths?.out || ''),
                  }, '查看文件夹')),
                showReport && reports.md ? h('pre', { style: { marginTop: '8px', maxHeight: '320px', overflow: 'auto' } }, reports.md) : null)),

        // ---- 运行日志导出 ----
        // 为什么单独一张卡：她某晚没说话、没刷站、没写日记，只看状态页是猜不出来的。
        // 三件事分开做——预览（小）、导出（大、纯文本、给 AI 看）、清空（单独一次点击）。
        group('运行日志导出',
          '出问题时把导出的文本交给 AI，比描述现象有用。日志只记插件自己做了什么，不含 cookie 和正文。',
          !logTail ? h('p', { className: 'empty' }, logBusy ? '读取中…' : '还没读。')
            : h('div', null,
                h('p', { className: 'hint' },
                  !logTail.exists
                    ? '还没有日志文件。插件启动一次之后才会有。'
                    : `${logTail.lines?.length || 0} 行 · 上限 ${Math.round((logTail.maxBytes || 0) / 1024 / 1024)}MB · 保留 ${logTail.keep || 0} 份`),
                logTail.lines?.length
                  ? h('div', { style: {
                      maxHeight: '104px', overflowY: 'auto', overflowX: 'hidden',
                      border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
                      padding: '6px 8px',
                    } },
                    h('pre', null, logTail.lines.slice(-200).join(String.fromCharCode(10))))
                  : null),
          h('div', { className: 'row' },
            h('button', {
              onClick: () => {
                setLogBusy(true)
                jget('/log?lines=200').then(setLogTail).catch(() => {}).finally(() => setLogBusy(false))
              },
            }, logBusy ? '读取中…' : '刷新预览'),
            h('button', {
              onClick: () => { window.location.href = '/dsh-fish/log/export?lines=300' },
            }, '导出日志'),
            h('button', {
              onClick: () => {
                if (!window.confirm('清空运行日志？导出过的文件不受影响。')) return
                jpost('/log/clear', {}).then(() => jget('/log?lines=40')).then(setLogTail).catch(() => {})
              },
            }, '清空日志')),
          h('p', { className: 'hint' }, '导出的是纯文本：版本、自检结果、脱敏后的配置、日志末尾。没有 cookie，没有她说过的话。')),

        resetCard)

      const showTab = (id) => tab === id


      return h('div', { className: 'dfish', ref: (el) => { topEl = el } },
        h('h2', null, '大肥鱼'),
        h('p', { className: 'sub' },
          s ? `第 ${s.day} / ${s.growthDays} 天 · ${s.stageName} · 事件 ${s.counts.total} 条` : '读取中…'),
        err ? h('pre', { className: 'err' }, err) : null,
        note ? h('pre', { className: 'ok' }, note) : null,
        // 说了话、但系统通知弹不出来时，退到这里。点一下才收起来。
        bubble ? h('div', { className: 'card', style: { borderLeft: '3px solid currentColor' } },
          h('div', { className: 'dim' }, '大肥鱼跟你说话'),
          h('div', { style: { marginTop: '4px' } }, bubble),
          h('div', { className: 'row', style: { marginTop: '6px' } },
            h('button', { onClick: () => setBubble('') }, '知道了'))) : null,

        tabBar,
        AUTO_SAVE_TABS.has(tab) ? h('p', { className: 'hint', style: { margin: '0 0 8px' } }, '这里的改动改完就生效，不需要点保存。') : null,
        AUTO_SAVE_TABS.has(tab) && autoNote ? h('p', { className: 'hint' }, autoNote) : null,

        showTab('now') ? nowPage : null,
        showTab('grow') ? growPage : null,
        showTab('home') ? homePage : null,
        showTab('bili') ? biliPage : null,
        showTab('memory') ? memoryPage : null,
        showTab('env') ? envPage : null,
        showTab('principle') ? principlePage : null,
        showTab('data') ? dataPage : null,
      )
    }


    // ---------------------------------------------------------------- 挂载
    const inject = ['slots']
    const NAMES = { nav: '大肥鱼' }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: NS, order: 7, label: () => NAMES.nav },
              FishSection,
            ),
            'dsh-fish: settings section',
          ),
        'dsh-fish: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.FishSection = FishSection
    return module.exports
}

// ─────────────────────────── QQ 桥接的设置页（原样搬运） ───────────────────────────
function __qqFactory(require) {

// qq/shared/model-pool.js
//
// 模型池的**纯数据形状**：宿主半（index.js）与浏览器半（client/client.js）共用。
// 浏览器半不能写 ESM import（bundle 是 classic script），所以 client.js 里不 import
// 这个文件 —— scripts/build-bundle.mjs 会在构建时把本文件的源码注入到 __qqFactory
// 函数体最前面，client.js 直接用同名函数。
//
// 这里只放纯函数/常量，不要 import 任何东西，也不要引用宿主对象。

/** 固定 3 个槽位。 */
const MODEL_POOL_SLOTS = 3

/** 模型池单次网络请求的硬性上限。 */
const MODEL_POOL_TIMEOUT_MS = 10_000

/** 一个空槽位。 */
function emptyModelSlot() {
  return { enabled: false, apiUrl: '', apiKey: '', modelName: '' }
}

/**
 * 把任意输入收敛成**恰好 3 个**形状固定的槽位。
 *
 * 为什么要收敛而不是原样返回：槽位数量是界面契约（Slot 1/2/3），少一个会让
 * 卡片在数组下标上炸掉；多一个则会被静默保存成第 4 个永远看不见的槽。
 */
function normalizeModelPool(raw) {
  const rows = Array.isArray(raw) ? raw : []
  const out = []
  for (let i = 0; i < MODEL_POOL_SLOTS; i += 1) {
    const row = rows[i] && typeof rows[i] === 'object' ? rows[i] : {}
    out.push({
      enabled: row.enabled === true,
      apiUrl: String(row.apiUrl ?? '').trim(),
      apiKey: String(row.apiKey ?? '').trim(),
      modelName: String(row.modelName ?? '').trim(),
    })
  }
  return out
}

const __INJECTED_CONTRACT = [
  {
    "key": "targetSessionId",
    "label": "目标会话",
    "kind": "session",
    "group": "core",
    "hint": "要接管哪个会话 —— 按名字选就行，不用记 id。",
    "default": ""
  },
  {
    "key": "workspaceRoot",
    "label": "工作区根目录",
    "kind": "text",
    "group": "core",
    "hint": "她派任务、看目录、发文件都限定在这片目录里。填绝对路径（如 D:\\demo\\我的项目）；留空 = 这些能力不可用。",
    "default": ""
  },
  {
    "key": "nicknames",
    "label": "昵称",
    "kind": "list",
    "group": "wake",
    "hint": "被叫到这些名字必然唤醒；逗号分隔，例如：244, 小助手。",
    "default": [
      "244"
    ]
  },
  {
    "key": "wakeProbability",
    "label": "群聊唤醒概率",
    "kind": "number",
    "group": "wake",
    "hint": "群里既没被 @ 也没叫名字时的唤醒概率（0–1）。默认 0.05 = 5%；嫌吵就调小，0 = 只在被叫时说话。",
    "default": 0.05,
    "step": "0.01",
    "min": 0,
    "max": 1
  },
  {
    "key": "privateWakeProbability",
    "label": "私聊唤醒概率",
    "kind": "number",
    "group": "wake",
    "hint": "私聊里既没被 @ 也没叫名字时的唤醒概率（0–1）。默认 1 = 每条私聊都必回。",
    "default": 1,
    "step": "0.01",
    "min": 0,
    "max": 1
  },
  {
    "key": "whitelist",
    "label": "私聊白名单",
    "kind": "list",
    "group": "wake",
    "hint": "允许唤醒的私聊 QQ 号；**空 = 谁都不能唤醒**。",
    "default": []
  },
  {
    "key": "groupWhitelist",
    "label": "群白名单",
    "kind": "list",
    "group": "wake",
    "hint": "允许唤醒的群号；**空 = 任何群都不唤醒**。",
    "default": []
  },
  {
    "key": "admins",
    "label": "管理员名单",
    "kind": "list",
    "group": "core",
    "hint": "管理员发来的消息贴「[来源：管理员用户]」标记：可以聊天、可以让她派活（work_request）、能用 fileget / filesend / receive（看收件箱）。subsend / whitelist / admin 仍然只有主人能下。QQ 上也可以用 `admin add/del <QQ号>` 改这份名单（只有主人能改）。空 = 没有管理员。",
    "default": []
  },
  {
    "key": "attachRecentChat",
    "label": "附带未唤醒记录",
    "kind": "boolean",
    "group": "wake",
    "hint": "唤醒时是否把\"未唤醒期间\"的聊天记录一并附上。",
    "default": true
  },
  {
    "key": "recentChatLimit",
    "label": "附带条数",
    "kind": "number",
    "group": "wake",
    "hint": "上面那段摘要最多带最近几条（0–200）。",
    "default": 8,
    "min": 0,
    "max": 200
  },
  {
    "key": "replyMaxChars",
    "label": "出站字数上限",
    "kind": "number",
    "group": "outbound",
    "hint": "出站文本的字数上限；超过就不发送，请缩短后重发。",
    "default": 1500,
    "min": 100
  },
  {
    "key": "onebotUrl",
    "label": "OneBot 地址",
    "kind": "text",
    "group": "infra",
    "hint": "NapCat 的正向 WS 地址，如 ws://127.0.0.1:3001；留空 = 完全不启用传输。",
    "default": ""
  },
  {
    "key": "accessTokenEnv",
    "label": "OneBot Token 凭据名",
    "kind": "text",
    "group": "infra",
    "hint": "指 **NapCat / OneBot 的 access_token** 存在哪个环境变量里 —— 填「变量名」（如 NAPCAT_TOKEN），不是 token 本身；NapCat 没开 token 校验就留空。⚠️ 不是模型 API key（DeepSeek 等），两者无关，别填错。",
    "default": "",
    "check": {
      "rule": "credential-ref",
      "message": "这看起来像一串 token —— 这一栏要填的是「存它的环境变量名」（如 NAPCAT_TOKEN），不是 token 本身。"
    }
  },
  {
    "key": "selfId",
    "label": "机器人 QQ",
    "kind": "text",
    "group": "infra",
    "hint": "留空 = 连上后自动获取。",
    "default": ""
  },
  {
    "key": "replyWithQuote",
    "label": "引用原消息",
    "kind": "boolean",
    "group": "outbound",
    "hint": "回复时引用触发的那条消息。",
    "default": false
  },
  {
    "key": "atOnlyInGroup",
    "label": "群里只认 @",
    "kind": "boolean",
    "group": "wake",
    "hint": "开启后，群里没被 @ 就完全不处理（比概率唤醒更严）。",
    "default": false
  },
  {
    "key": "stripMarkdown",
    "label": "去掉 Markdown",
    "kind": "boolean",
    "group": "outbound",
    "hint": "出站前去掉 Markdown 标记（QQ 不渲染）。",
    "default": true
  },
  {
    "key": "replyMode",
    "label": "出站方式",
    "kind": "select",
    "group": "outbound",
    "hint": "标记块 = 只发块里的内容；工具调用 = 用 qq_bridge_send 发（每轮多一次模型调用）；整轮都发 = 技术内容也会进群，慎用。",
    "default": "marker",
    "options": [
      [
        "marker",
        "标记块（默认）"
      ],
      [
        "tool",
        "工具调用"
      ],
      [
        "always",
        "整轮都发"
      ]
    ]
  },
  {
    "key": "delivery",
    "label": "投递方式",
    "kind": "select",
    "group": "wake",
    "hint": "QQ 消息怎么进目标会话：自动 = 目标正忙就插话、空闲时排队；排队 = 永远排成独立一轮；总是插话 = 无论忙闲都插。",
    "default": "auto",
    "options": [
      [
        "auto",
        "自动（忙时插话）"
      ],
      [
        "followup",
        "排队"
      ],
      [
        "steer",
        "总是插话"
      ]
    ]
  },
  {
    "key": "visionModel",
    "label": "识图模型",
    "kind": "text",
    "group": "infra",
    "hint": "给图片写描述的多模态模型，形如 provider/model（如 deepseek-official/deepseek-v4-flash-vision-exp）；留空 = 自动找（优先名字带 vision 的）。",
    "default": ""
  },
  {
    "key": "agentPreset",
    "label": "Agent Preset",
    "kind": "text",
    "group": "core",
    "hint": "恢复目标会话时挂载哪个 preset（决定它的人设/人格）；留空 = 沿用会话自己记着的那个。",
    "default": ""
  },
  {
    "key": "napcatInstallDir",
    "label": "NapCat 目录",
    "kind": "text",
    "group": "infra",
    "hint": "NapCat 安装目录；留空 = $DSH_HOME/napcat。",
    "default": ""
  },
  {
    "key": "napcatVersion",
    "label": "NapCat 版本",
    "kind": "text",
    "group": "infra",
    "hint": "要下载的版本 tag（如 v4.18.28）；留空 = 最新。",
    "default": ""
  },
  {
    "key": "downloadProxy",
    "label": "下载代理",
    "kind": "text",
    "group": "infra",
    "hint": "下载 NapCat 用的 HTTP 代理（如 http://127.0.0.1:7890）；留空 = 读环境变量。",
    "default": ""
  },
  {
    "key": "onebotPort",
    "label": "OneBot 端口",
    "kind": "number",
    "group": "infra",
    "hint": "写进 NapCat 配置、并用来连的正向 WS 端口。",
    "default": 3001,
    "min": 1,
    "max": 65535
  },
  {
    "key": "qqNumber",
    "label": "快速登录 QQ",
    "kind": "text",
    "group": "infra",
    "hint": "快速登录用的 QQ 号（需先成功登录过一次）。",
    "default": ""
  },
  {
    "key": "ownerQQ",
    "label": "主人 QQ",
    "kind": "text",
    "group": "core",
    "hint": "主人的 QQ 号。**只有这个号能派活**；其他人发来的消息也会进会话，但正文前会多一行「非主人」标记，只许聊天、不许调工具。留空 = 谁都不是主人（所有人都被贴标）。",
    "default": "",
    "check": {
      "rule": "qq-number",
      "message": "QQ 号应该是 5–12 位数字。"
    }
  },
  {
    "key": "proactiveEnabled",
    "label": "主动私聊",
    "kind": "boolean",
    "group": "idle",
    "hint": "打开后，空闲够久 + 随机命中时，她会主动给主人发一条 QQ 私聊（不是定时提醒，触发时刻不确定）。默认关。",
    "default": false
  },
  {
    "key": "proactiveIdleHours",
    "label": "空闲多少小时",
    "kind": "number",
    "group": "idle",
    "hint": "多久没有任何 QQ 往来才算「空闲」。默认 4。",
    "default": 4,
    "min": 0,
    "max": 720
  },
  {
    "key": "proactiveProbability",
    "label": "每次命中概率",
    "kind": "number",
    "group": "idle",
    "hint": "每次扫描命中主动私聊的概率（0–1）。默认 0.15；调小更克制、调大更黏人。",
    "default": 0.15,
    "min": 0,
    "max": 1
  },
  {
    "key": "proactiveDailyLimit",
    "label": "每天上限",
    "kind": "number",
    "group": "idle",
    "hint": "每天最多主动私聊几条（0 = 不发）。默认 3，建议别超过 3——发太多容易被 QQ 判定异常。",
    "default": 3,
    "min": 0,
    "max": 50
  },
  {
    "key": "proactiveScanIntervalMinutes",
    "label": "扫描间隔（分钟）",
    "kind": "number",
    "group": "idle",
    "hint": "多久检查一次「该不该主动说话」。默认 30。",
    "default": 30,
    "min": 1,
    "max": 1440
  },
  {
    "key": "idleTriggerEnabled",
    "label": "私人时间",
    "kind": "boolean",
    "group": "idle",
    "hint": "打开后，很久没人找她时会随机抽签给她一段属于自己的时间——大概率什么都不发生（silent 权重最高），极少注入一段「私人时间」处境提示。注入的那一轮默认不出站：只有她明确写了 [QQ] 块或调了出站工具，消息才会到 QQ。默认关。",
    "default": false
  },
  {
    "key": "idleTriggerScanIntervalMinutes",
    "label": "扫描间隔（分钟）",
    "kind": "number",
    "group": "idle",
    "hint": "多久检查一次「该不该给她一段私人时间」。这只是判定周期，不是定时打扰。默认 30。",
    "default": 30,
    "min": 1,
    "max": 1440
  },
  {
    "key": "idleTriggerMinIdleHours",
    "label": "空闲多少小时",
    "kind": "number",
    "group": "idle",
    "hint": "多久没人找她（QQ 来人或 DSH 界面说话）才算「空闲」。默认 2；0 = 不看空闲（调试用）。",
    "default": 2,
    "min": 0,
    "max": 720
  },
  {
    "key": "idleTriggerDailyMax",
    "label": "每天上限",
    "kind": "number",
    "group": "idle",
    "hint": "每天最多真的注入几段私人时间（抽到「什么都不做」不算）。默认 3；0 = 关闭。",
    "default": 3,
    "min": 0,
    "max": 50
  },
  {
    "key": "idleTriggerWeightSilent",
    "label": "权重·继续停机",
    "kind": "number",
    "group": "idle",
    "hint": "抽签权重：什么都不做、继续停机。**必须占绝对优势**（默认 80）——她绝大部分时间就是在睡着，极少被打扰。",
    "default": 80,
    "min": 0
  },
  {
    "key": "idleTriggerWeightMessage",
    "label": "权重·想找他说",
    "kind": "number",
    "group": "idle",
    "hint": "抽签权重：提示里把「给他发条消息」排在最前（仍由她自己选）。默认 10。",
    "default": 10,
    "min": 0
  },
  {
    "key": "idleTriggerWeightBrowse",
    "label": "权重·去 B 站",
    "kind": "number",
    "group": "idle",
    "hint": "抽签权重：提示里把「去 B 站看看」排在最前。默认 5。",
    "default": 5,
    "min": 0
  },
  {
    "key": "idleTriggerWeightDiary",
    "label": "权重·写日记",
    "kind": "number",
    "group": "idle",
    "hint": "抽签权重：提示里把「写写日记」排在最前。默认 5。",
    "default": 5,
    "min": 0
  },
  {
    "key": "subsendEnabled",
    "label": "subsend 主动发消息",
    "kind": "boolean",
    "group": "outbound",
    "hint": "主人发 `subsend <QQ号> <内容>` 时，把内容私聊给指定的人（她调 qq_bridge_subsend 工具发，可润色）。默认开。",
    "default": true
  },
  {
    "key": "subsendDailyLimit",
    "label": "subsend 每天上限",
    "kind": "number",
    "group": "outbound",
    "hint": "subsend 每天最多发几条（防刷屏 / 防 QQ 风控）。默认 20；0 = 禁用。",
    "default": 20,
    "min": 0,
    "max": 500
  },
  {
    "key": "subsendCooldownSeconds",
    "label": "subsend 冷却（秒）",
    "kind": "number",
    "group": "outbound",
    "hint": "subsend 两次发送之间的最短间隔。默认 20。",
    "default": 20,
    "min": 0,
    "max": 3600
  },
  {
    "key": "checklogNotifyMode",
    "label": "任务完成通知",
    "kind": "select",
    "group": "outbound",
    "hint": "CheckLogs/ 里写了任务完成日志后怎么通知：关 = 什么都不说；系统模板 = 插件直接发一条；让她自己说 = 投进她的会话，让她用自己的话说。",
    "default": "off",
    "options": [
      [
        "off",
        "关（默认）"
      ],
      [
        "system",
        "系统模板"
      ],
      [
        "agent",
        "让她自己说"
      ]
    ]
  },
  {
    "key": "checklogNotifyOnSuccess",
    "label": "成功也说一声",
    "kind": "boolean",
    "group": "outbound",
    "hint": "任务**成功**完成时也通知；默认关 = 失败 / 超时 / 异常结束才说（成功是本分，不打断你）。",
    "default": false
  },
  {
    "key": "checklogNotifyDailyLimit",
    "label": "通知每天上限",
    "kind": "number",
    "group": "outbound",
    "hint": "每天最多通知几条（0 = 一条都不发）。默认 5；两档（系统模板 / 让她自己说）共用这一个额度。",
    "default": 5,
    "min": 0,
    "max": 50
  },
  {
    "key": "checklogNotifyTarget",
    "label": "通知发给谁",
    "kind": "select",
    "group": "outbound",
    "hint": "主人 = 你的 QQ 私聊；最近聊过的人 = 最近一次有往来的目的地（私聊），最近是群或还没有往来时回落主人。",
    "default": "owner",
    "options": [
      [
        "owner",
        "主人（默认）"
      ],
      [
        "last",
        "最近聊过的人"
      ]
    ]
  },
  {
    "key": "rssFeeds",
    "label": "RSS 订阅源",
    "kind": "text",
    "group": "pipeline",
    "hint": "逗号分隔的 RSS 链接，如 https://example.com/feed.xml, https://another.com/rss；先存着，等流水线接上就是定投给她看的消息源。",
    "default": ""
  },
  {
    "key": "pipelineWorkerApi",
    "label": "流水线 Worker 地址",
    "kind": "text",
    "group": "pipeline",
    "hint": "跑情报流水线的 worker API 地址；留空 = 还没部署，这一组先当摆设。",
    "default": ""
  },
  {
    "key": "pipelineWorkerKey",
    "label": "流水线 Worker 密钥",
    "kind": "text",
    "group": "pipeline",
    "hint": "调流水线 worker 时带的校验密钥；留空 = 不校验。",
    "default": "",
    "secret": true
  },
  {
    "key": "modelPool",
    "label": "模型池",
    "kind": "modelpool",
    "group": "modelpool",
    "hint": "给摘要这类短任务用的备用模型。按 Slot 1 → 2 → 3 找第一个「已启用且填全」的；失败 / 超时 10 秒就回退宿主自己的模型。",
    "default": [],
    "secret": true
  },
  {
    "key": "envSensorEnabled",
    "label": "环境传感器",
    "kind": "boolean",
    "group": "env",
    "hint": "打开后，按下面设的时间抓一次天气与本机硬件状态，写成工作区里的一行状态（sensors/status.md）。不再注入提示词——她想感知时自己调 check_body 查看。默认关。",
    "default": false
  },
  {
    "key": "envWeatherCity",
    "label": "城市 / 经纬度",
    "kind": "text",
    "group": "env",
    "hint": "城市名（wuhan 或 武汉）或「纬度,经度」（如 30.59,114.30）；留空 = 状态里只有本机，没有天气。数据源是 Open-Meteo（免费、不用 API key）。",
    "default": ""
  },
  {
    "key": "envSensorTime",
    "label": "采集时间（Cron）",
    "kind": "text",
    "group": "env",
    "hint": "多久采一次并刷新状态：五段式 Cron（分 时 日 月 周，如 0 8 * * * = 每天早八点），也接受 HH:MM（如 08:00）。默认 */15 * * * *（每 15 分钟）。到点会跑一次工作区里的 pipeline/update_env.js。",
    "default": "*/15 * * * *",
    "check": {
      "rule": "cron-or-time",
      "message": "看不懂这个时间：写五段式 Cron（如 0 8 * * *）或 HH:MM（如 08:00）。"
    }
  },
  {
    "key": "envMemoryThreshold",
    "label": "内存报警阈值",
    "kind": "number",
    "group": "env",
    "hint": "内存占用超过这个百分比（0–100，默认 80）时，状态里的 [机箱状态] 就是「高负载」。",
    "default": 80,
    "min": 0,
    "max": 100
  }
]

    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // react 是模块表里的 baseline 依赖，不用在 package.json 里声明 external。
    const react = require('react')
    const h = react.createElement

    /** settings 命名空间，必须与 index.js 里的 NS 一致。 */
    const NS = 'qq-bridge'

    /**
     * 宿主登记这个插件时用的**包名 / profile entry id**。
     *
     * 独立安装是空串（键位用 NS）；被合并包 vendored 时，合并包的 client.js 会在
     * 调用 factory 之前写进 `globalThis.__DSH_QQ_BRIDGE_HOST_ID__`。
     *
     * 为什么需要它：0.2.0 的插件配置页是按 **entry id** 派发卡片的，
     * 合并成 dsh-fish-qq 之后 entry id 变了，只注册 `qq-bridge` 会**一张卡片都不出现**
     * （2026-10-26 真机现象：设置 → 插件 里没有「QQ 桥接」）。
     */
    const HOST_ID = (() => {
      try {
        const v = globalThis.__DSH_QQ_BRIDGE_HOST_ID__
        return typeof v === 'string' ? v.trim() : ''
      } catch {
        return ''
      }
    })()

    /** 卡片键位候选：0.1.5 用 settings 命名空间，0.2.0 用 entry id。 */
    const CARD_KEYS = [...new Set([NS, HOST_ID].filter(Boolean))]

    // ── 模型池（2026-11-03）───────────────────────────────────────────────────
    // 固定 3 个槽位。存进设置的 `modelPool` 数组；fish 的 handoff.js 读同一个
    // qq-bridge-settings.json（values.modelPool），摘要优先用第一个启用的槽位。
    // 槽位形状（MODEL_POOL_SLOTS / emptyModelSlot / normalizeModelPool）来自
    // qq/shared/model-pool.js，由 scripts/build-bundle.mjs 在构建时注入到本函数
    // 体最前面；源文件单跑（test-smoke.mjs）时由测试沙箱提供同名符号。
    const MODEL_POOL_API = '/api/qq-bridge/fetch-models'
    const MODEL_TEST_API = '/api/qq-bridge/test-model'

    function updateSlot(list, index, patch) {
      const next = normalizeModelPool(list)
      next[index] = { ...next[index], ...patch }
      return next
    }

    // ── 表单描述 ──────────────────────────────────────────────────────────────
    // 字段清单来自 qq/shared/settings-contract.js：构建时由 scripts/build-bundle.mjs
    // 序列化成 __INJECTED_CONTRACT 注入到 __qqFactory 函数体最前面。
    // 直接跑源文件（test-smoke.mjs）时由测试沙箱提供同一个变量，行为与产物一致。
    // 这里**不再手写字段** —— 加/改字段只改 contract。
    const FIELDS = typeof __INJECTED_CONTRACT === 'undefined' ? [] : __INJECTED_CONTRACT

    /**
     * 手风琴的分组：**按这里的固定顺序渲染**，组内按 FIELDS 里的出现顺序。
     *
     * group 的**有无**来自 contract（FIELDS 里出现过的 group 才算数），
     * 顺序与标题保持旧版固定值 —— 不跟着 contract 的声明顺序漂。
     *
     * ⚠️ group 只管显示：
     *   - 草稿 / 保存 / 撤销覆盖全都平铺遍历 FIELDS，与展开状态无关 ——
     *     折叠只是把控件藏起来，表单数据一个键都不会少，也不会把展开状态
     *     混进 scope.set；
     *   - 漏写 group 的字段**哪一组都进不去**（界面上直接消失），加载时验一遍。
     */
    const GROUP_ORDER = ['core', 'wake', 'outbound', 'idle', 'infra', 'modelpool', 'pipeline', 'env']
    const GROUP_LABELS = {
      core: '核心与权限',
      wake: 'QQ 唤醒与投递',
      outbound: '出站与功能',
      idle: '私人时间与主动',
      infra: '底层基础设施',
      modelpool: '模型池',
      pipeline: '情报流水线',
      env: '环境传感器',
    }
    const presentGroups = new Set(FIELDS.map((f) => f.group))
    const GROUPS = GROUP_ORDER.filter((id) => presentGroups.has(id)).map((id) => ({ id, label: GROUP_LABELS[id] }))
    // contract 里出现了未知 group 时也要渲染出来（排最后），否则字段会静默消失；
    // 上面的防错块会把这情况吼出来。
    for (const f of FIELDS) {
      if (!GROUP_ORDER.includes(f.group)) {
        GROUP_ORDER.push(f.group)
        GROUPS.push({ id: f.group, label: GROUP_LABELS[f.group] ?? f.group })
      }
    }

    // 防错：某个字段漏了 group 时，它在任何组里都不渲染 —— 加载时吼一嗓子，
    // 免得到界面上去才发现少了一项（吼完界面仍然没有它，改完务必人工数一遍）。
    {
      const knownGroups = new Set(GROUPS.map((g) => g.id))
      const orphaned = FIELDS.filter((f) => !knownGroups.has(f.group)).map((f) => f.key)
      if (orphaned.length > 0 && typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`qq-bridge: 这些字段没有 group，设置卡片上不会显示：${orphaned.join('、')}`)
      }
    }

    function format(field, raw) {
      if (field.kind === 'modelpool') return normalizeModelPool(raw)
      if (field.kind === 'list') return Array.isArray(raw) ? raw.join(', ') : raw == null ? '' : String(raw)
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') return raw == null || raw === '' ? '' : String(raw)
      return raw == null ? '' : String(raw)
    }

    /**
     * 表单值 → 要写进设置的 JSON；数字不合法 / 越界返回 undefined（拦住保存）。
     * 数字的边界来自 contract（min / max），与宿主半 normalize 的 clamp 同一套口径。
     */
    function parse(field, raw) {
      if (field.kind === 'modelpool') return normalizeModelPool(raw)
      if (field.kind === 'list') {
        return String(raw == null ? '' : raw)
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter((s) => s !== '')
      }
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') {
        const n = Number(raw)
        if (!Number.isFinite(n)) return undefined
        if (field.min !== undefined && n < field.min) return undefined
        if (field.max !== undefined && n > field.max) return undefined
        return n
      }
      return String(raw == null ? '' : raw).trim()
    }

    /**
     * 声明式输入校验：check 在 contract 里是纯数据（构建时可序列化），
     * 这里按 rule 执行。返回 null = 通过，返回字符串 = 给用户看的提示。
     */
    function runFieldCheck(field, value) {
      const check = field.check
      if (!check) return null
      const s = String(value ?? '').trim()
      if (s === '') return null
      if (check.rule === 'qq-number') return /^\d{5,12}$/.test(s) ? null : check.message
      if (check.rule === 'credential-ref') {
        if (/^(sk-|Bearer\s)/i.test(s) || s.length > 64 || /[.\s]/.test(s)) return check.message
        return null
      }
      if (check.rule === 'cron-or-time') {
        if (/^\d{1,2}:\d{2}$/.test(s)) return null
        if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(s)) return null
        return check.message
      }
      return null
    }

    function draftFrom(value) {
      const v = value && typeof value === 'object' ? value : {}
      const draft = {}
      for (const f of FIELDS) draft[f.key] = format(f, v[f.key])
      return draft
    }

    function same(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /**
     * 会话下拉的选项：真实的会话列表 + “不驱动”+ 一个兜底项。
     *
     * **归档的会话不列出来**（用户报的 bug：下拉里混进了一堆早就归档的会话）——
     * 归档集在 workspace 域：`ctx.workspaces.list.getSnapshot().archivedSessionIds`。
     *
     * ⚠️ **TODO（下次修）：子代理会话也会被列进来。**
     * `SessionSummary` 上有 `origin?: 'subagent'` 与 `parentId?: SessionId`
     * （见 `@deepseek-ai/dsh-api-session-controller` 的 `SessionSummary`），据此可以剔除。
     * 剔除之后同样要给**当前选中项**兜底，规则与下面的归档处理一致 ——
     * 否则子代理会话是当前目标时，一保存就把目标会话清空。
     * 退化做法也可接受：把它们折叠进一个“显示子代理会话”的展开项，别一次铺开一长串。
     *
     * 两个兜底项都是必要的：
     * - 配置里那个 id 可能**不在**列表里（别的工作区、宿主还没加载完）；
     * - 也可能**正好是归档的**（用户刚把它归档了）。
     * 两种都必须保留成选项，否则用户一保存就把目标会话清空了。
     */
    function sessionOptions(state, current, archivedIds) {
      const archived = new Set((Array.isArray(archivedIds) ? archivedIds : []).map((id) => String(id)))
      const out = [{ value: '', label: '（不驱动任何会话）' }]
      const ids = Array.isArray(state?.ids) ? state.ids : []
      const byId = state && typeof state.byId === 'object' && state.byId ? state.byId : {}
      const cur = String(current ?? '')
      const seen = new Set([''])
      for (const id of ids) {
        const key = String(id)
        const isArchived = archived.has(key)
        // 归档的一律不显示 —— 除非它就是当前选中的那个（不显示的话就没法保留/换掉了）
        if (isArchived && key !== cur) continue
        seen.add(key)
        const row = byId[id] ?? {}
        const title = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : key
        out.push({
          value: key,
          label: `${title}${row.running ? '（运行中）' : ''}${isArchived ? '（已归档）' : ''}`,
        })
      }
      if (cur !== '' && !seen.has(cur)) {
        out.push({ value: cur, label: `${cur}（${archived.has(cur) ? '已归档' : '不在会话列表里'}）` })
      }
      return out
    }

    /** 没有 sessions / workspaces 服务（或它们还没就绪）时用的稳定空快照 —— 必须稳定，否则 useSyncExternalStore 会死循环。 */
    const EMPTY_SESSION_LIST = { ids: [], byId: {} }
    const EMPTY_WORKSPACES = { archivedSessionIds: [] }

    // ── 样式（内联，跟随主题文字色） ──────────────────────────────────────────
    const BORDER = '1px solid rgba(127,127,127,0.35)'
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px' },
      head: { display: 'flex', flexDirection: 'column', gap: '2px' },
      title: { fontSize: '14px', fontWeight: 600 },
      sub: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: '8px 12px', alignItems: 'start' },
      label: { fontSize: '13px', paddingTop: '5px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 8px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
      },
      hint: { fontSize: '11px', opacity: 0.55, marginTop: '3px', lineHeight: 1.5 },
      check: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', paddingTop: '4px' },
      foot: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      btn: {
        padding: '5px 14px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
      },
      primary: { background: 'rgba(127,127,127,0.18)', fontWeight: 600 },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '8px 10px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
      },
      chevron: { marginLeft: 'auto', opacity: 0.6 },
      // 手风琴的组：组标题 +（展开时）原来的 label/控件网格。
      group: { display: 'flex', flexDirection: 'column', gap: '8px' },
      // 组标题：与卡片标题同一个交互（点整行切换），矮半号、不带副标题。
      groupHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 10px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
        fontWeight: 600,
        textAlign: 'left',
      },
      // 组标题右侧的「N 项」：字段折叠成组后，让人一眼知道
      // 这组里压着多少东西、值不值得点开。
      groupCount: { fontSize: '11px', fontWeight: 400, opacity: 0.55 },
      note: { fontSize: '12px', opacity: 0.7 },
      err: { fontSize: '12px', color: '#e5534b' },
      overridden: { fontSize: '11px', opacity: 0.5, marginLeft: '4px' },
      // “撤销覆盖”：与“·已覆盖”并排的小按钮。文案本身就是动作，不加图标。
      link: {
        marginLeft: '4px',
        padding: '0 4px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.75,
        textDecoration: 'underline',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '11px',
      },
      ops: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      // 模型池：3 个槽位竖排；每个槽位自己是一张小卡，按钮和状态都在里面。
      pool: { display: 'flex', flexDirection: 'column', gap: '10px' },
      slot: { border: BORDER, borderRadius: '8px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' },
      slotHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      slotTitle: { fontSize: '13px', fontWeight: 600 },
      slotGrid: { display: 'grid', gridTemplateColumns: 'minmax(90px, 130px) 1fr', gap: '6px 10px', alignItems: 'center' },
      slotLabel: { fontSize: '12px', opacity: 0.75 },
      slotRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      statusOk: { fontSize: '12px', color: '#2ea043' },
      statusErr: { fontSize: '12px', color: '#e5534b' },
      statusMuted: { fontSize: '11px', opacity: 0.55 },
    }

    function disabled(btn, off) {
      return off ? { ...btn, opacity: 0.5, cursor: 'default' } : btn
    }

    /** 浏览器侧也加一道硬超时：后端 10 秒，这里 12 秒兜底，绝不让按钮永远转圈。 */
    async function fetchWithTimeout(url, init = {}, timeoutMs = 12_000) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        return await fetch(url, { ...init, signal: ac.signal })
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * 模型池编辑器：固定 3 个槽位。
     *
     * 只负责“改值 + 调两个测试接口”；真正的保存仍走卡片底部的「保存」，
     * 由 Card 把 modelPool 一并写进设置（这样它和别的字段共用同一套脏检查）。
     */
    function ModelPoolEditor(props) {
      const value = normalizeModelPool(props.value)
      const disabledAll = props.disabled === true
      const [models, setModels] = react.useState(() => [[], [], []])
      const [busy, setBusy] = react.useState({ fetch: -1, test: -1 })
      const [status, setStatus] = react.useState(() => [{}, {}, {}])

      const setStatusAt = (index, next) => {
        setStatus((prev) => {
          const copy = prev.slice()
          copy[index] = next
          return copy
        })
      }
      const setModelsAt = (index, list) => {
        setModels((prev) => {
          const copy = prev.slice()
          copy[index] = Array.isArray(list) ? list : []
          return copy
        })
      }
      const change = (index, patch) => {
        if (disabledAll) return
        // 地址 / Key 变了，上一次拉到的模型列表与测试结果就作废了；
        // 不清掉的话下拉里会留着旧地址的模型，看着像“已经连通了”。
        if (Object.prototype.hasOwnProperty.call(patch, 'apiUrl') || Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
          setModelsAt(index, [])
          setStatusAt(index, {})
        }
        props.onChange(updateSlot(value, index, patch))
      }

      async function refresh(index) {
        const slot = value[index]
        setStatusAt(index, { kind: 'muted', text: '拉取中…' })
        setBusy({ fetch: index, test: -1 })
        try {
          if (!slot.apiUrl.trim()) throw new Error('先填 API 地址')
          if (!slot.apiKey.trim()) throw new Error('先填 API Key')
          const qs = new URLSearchParams({ apiUrl: slot.apiUrl, apiKey: slot.apiKey })
          const res = await fetchWithTimeout(`${MODEL_POOL_API}?${qs.toString()}`, { headers: { accept: 'application/json' } })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(String(body?.error || `HTTP ${res.status}`))
          const list = Array.isArray(body.models) ? body.models.map(String) : []
          if (list.length === 0) throw new Error('接口没返回任何模型')
          setModelsAt(index, list)
          const nextModel = list.includes(slot.modelName) ? slot.modelName : list[0]
          if (nextModel !== slot.modelName) change(index, { modelName: nextModel })
          setStatusAt(index, { kind: 'ok', text: `✅ 拉取到 ${list.length} 个模型` })
        } catch (error) {
          const message = error?.name === 'AbortError' ? '拉取超时（12 秒）' : String(error?.message ?? error)
          setStatusAt(index, { kind: 'err', text: `❌ ${message}` })
        } finally {
          setBusy({ fetch: -1, test: -1 })
        }
      }

      async function test(index) {
        const slot = value[index]
        setStatusAt(index, { kind: 'muted', text: '测试中…' })
        setBusy({ fetch: -1, test: index })
        const started = Date.now()
        try {
          if (!slot.apiUrl.trim()) throw new Error('先填 API 地址')
          if (!slot.apiKey.trim()) throw new Error('先填 API Key')
          if (!slot.modelName.trim()) throw new Error('先选/填模型名')
          const res = await fetchWithTimeout(MODEL_TEST_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiUrl: slot.apiUrl, apiKey: slot.apiKey, modelName: slot.modelName }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(String(body?.error || `HTTP ${res.status}`))
          const ms = Number.isFinite(Number(body.latencyMs)) ? Number(body.latencyMs) : Date.now() - started
          setStatusAt(index, { kind: 'ok', text: `✅ 成功 ${ms}ms` })
        } catch (error) {
          const message = error?.name === 'AbortError' ? '超时（12 秒）' : String(error?.message ?? error)
          setStatusAt(index, { kind: 'err', text: `❌ ${message}` })
        } finally {
          setBusy({ fetch: -1, test: -1 })
        }
      }

      const rows = value.map((slot, index) => {
        const list = models[index] ?? []
        const st = status[index] ?? {}
        const fetching = busy.fetch === index
        const testing = busy.test === index
        const controlDisabled = disabledAll || fetching || testing
        return h(
          'div',
          { key: `slot-${index}`, style: S.slot },
          h(
            'div',
            { style: S.slotHead },
            h('span', { style: S.slotTitle }, `Slot ${index + 1}`),
            h(
              'label',
              { style: S.check },
              h('input', {
                type: 'checkbox',
                checked: slot.enabled === true,
                disabled: controlDisabled,
                onChange: (event) => change(index, { enabled: event.target.checked }),
              }),
              '启用',
            ),
            h('span', { style: S.statusMuted }, slot.modelName ? `当前：${slot.modelName}` : '未选模型'),
          ),
          h(
            'div',
            { style: S.slotGrid },
            h('span', { style: S.slotLabel }, 'API 地址'),
            h('input', {
              type: 'text',
              style: S.input,
              value: slot.apiUrl,
              disabled: controlDisabled,
              placeholder: 'https://api.deepseek.com 或 …/v1',
              spellCheck: false,
              onChange: (event) => change(index, { apiUrl: event.target.value }),
            }),
            h('span', { style: S.slotLabel }, 'API Key'),
            h('input', {
              type: 'password',
              style: S.input,
              value: slot.apiKey,
              disabled: controlDisabled,
              placeholder: 'sk-…（只存本机设置文件）',
              autoComplete: 'off',
              spellCheck: false,
              onChange: (event) => change(index, { apiKey: event.target.value }),
            }),
            h('span', { style: S.slotLabel }, '模型'),
            list.length > 0
              ? h(
                  'select',
                  {
                    style: S.input,
                    value: slot.modelName,
                    disabled: controlDisabled,
                    onChange: (event) => change(index, { modelName: event.target.value }),
                  },
                  // 当前值不在列表里（例如手填后还没重新拉取）也要能显示，否则 select 会跳到第一项。
                  list.includes(slot.modelName) || slot.modelName === ''
                    ? null
                    : h('option', { value: slot.modelName }, `${slot.modelName}（手填）`),
                  list.map((model) => h('option', { key: model, value: model }, model)),
                )
              : h('input', {
                  type: 'text',
                  style: S.input,
                  value: slot.modelName,
                  disabled: controlDisabled,
                  placeholder: '先「刷新拉取」，或直接手填模型名',
                  spellCheck: false,
                  onChange: (event) => change(index, { modelName: event.target.value }),
                }),
          ),
          h(
            'div',
            { style: S.slotRow },
            h(
              'button',
              {
                type: 'button',
                style: disabled(S.btn, controlDisabled || !slot.apiUrl.trim() || !slot.apiKey.trim()),
                disabled: controlDisabled || !slot.apiUrl.trim() || !slot.apiKey.trim(),
                onClick: () => refresh(index),
              },
              fetching ? '拉取中…' : '刷新拉取模型',
            ),
            h(
              'button',
              {
                type: 'button',
                style: disabled(S.btn, controlDisabled || !slot.apiUrl.trim() || !slot.apiKey.trim() || !slot.modelName.trim()),
                disabled: controlDisabled || !slot.apiUrl.trim() || !slot.apiKey.trim() || !slot.modelName.trim(),
                onClick: () => test(index),
              },
              testing ? '测试中…' : '测试连通',
            ),
            st.text
              ? h('span', { style: st.kind === 'ok' ? S.statusOk : st.kind === 'err' ? S.statusErr : S.statusMuted }, st.text)
              : null,
          ),
        )
      })

      return h(
        'div',
        { style: S.pool },
        h(
          'div',
          { style: S.note },
          '按 Slot 1 → 2 → 3 取第一个「已启用且填全」的模型；失败 / 超时（10 秒）回退宿主 llm，不会卡住换房。',
        ),
        ...rows,
      )
    }

    // ── 卡片 ──────────────────────────────────────────────────────────────────

    function Card(props) {
      const scope = props.scope
      const subscribe = react.useCallback((cb) => scope.subscribe(cb), [scope])
      const getSnapshot = react.useCallback(() => scope.getSnapshot(), [scope])
      const snap = react.useSyncExternalStore(subscribe, getSnapshot)

      const [draft, setDraft] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [note, setNote] = react.useState('')
      // 折叠块：跟官方那几张卡片一致 —— 默认收起
      const [open, setOpen] = react.useState(false)
      // 组的展开状态（手风琴）：同样默认全部收起，且**只影响显示** ——
      // 草稿 / 保存 / 撤销覆盖一律平铺遍历 FIELDS，折叠既不丢改动，
      // 也绝不把展开状态混进表单数据 / scope.set（两套状态，互不通气）。
      const [openGroups, setOpenGroups] = react.useState({})
      // NapCat 的三个操作按钮：展开时拉一次接口；拿不到就保持 null（按钮禁用）。
      const [napcat, setNapcat] = react.useState(null)
      const [napcatBusy, setNapcatBusy] = react.useState('')

      const current = react.useMemo(() => draftFrom(snap.value), [snap.value])
      const shown = draft ?? current
      const dirty = draft !== null && !same(draft, current)
      const user = snap.user && typeof snap.user === 'object' ? snap.user : {}

      // ── 目标会话的下拉数据源 ──────────────────────────────────────────────
      // ctx.sessions.list 是客户端 SDK 暴露的会话列表快照（ObservableSnapshot）。
      // 取不到（这个部署没装 sessions 服务、或它还没就绪）就退回“只有兜底项”，
      // 卡片本身照常渲染 —— 宁可少一个下拉，也不要整张卡片消失。
      const sessions = props.sessionsOf ? props.sessionsOf() : undefined
      const listStore = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list : undefined
      const listSubscribe = react.useCallback((cb) => (listStore ? listStore.subscribe(cb) : () => {}), [listStore])
      const listGetSnapshot = react.useCallback(
        () => (listStore ? listStore.getSnapshot() : EMPTY_SESSION_LIST),
        [listStore],
      )
      const sessionList = react.useSyncExternalStore(listSubscribe, listGetSnapshot)
      react.useEffect(() => {
        // 进卡片时拉一次，免得显示的是很久以前的标题
        if (sessions && typeof sessions.refresh === 'function') Promise.resolve(sessions.refresh()).catch(() => {})
      }, [sessions])

      // 归档集在 workspace 域：ctx.workspaces.list 的快照里有 archivedSessionIds
      //（“Complete registry-global archive set”）。取不到就当作“没有归档的会话”——
      // 宁可多列几个，也别把用户能选的会话藏掉。
      const workspaces = props.workspacesOf ? props.workspacesOf() : undefined
      const wsStore =
        workspaces && workspaces.list && typeof workspaces.list.getSnapshot === 'function' ? workspaces.list : undefined
      const wsSubscribe = react.useCallback((cb) => (wsStore && typeof wsStore.subscribe === 'function' ? wsStore.subscribe(cb) : () => {}), [wsStore])
      const wsGetSnapshot = react.useCallback(() => {
        if (!wsStore) return EMPTY_WORKSPACES
        try {
          return wsStore.getSnapshot() ?? EMPTY_WORKSPACES
        } catch {
          return EMPTY_WORKSPACES
        }
      }, [wsStore])
      const workspaceSnapshot = react.useSyncExternalStore(wsSubscribe, wsGetSnapshot)

      /**
       * 拉一次 NapCat 状态（WebUI 地址 + 是否在运行）。
       * 没有 fetch 或响应不是 ok:true 时返回 undefined，调用方保持上一次的状态。
       */
      async function fetchNapcat() {
        if (typeof fetch !== 'function') return undefined
        const res = await fetch(NAPCAT_API, { headers: { accept: 'application/json' } })
        const body = await res.json().catch(() => ({}))
        return body && body.ok === true ? body : undefined
      }

      // 展开卡片时读一次 NapCat 状态，之后每 5 秒轮询一次。
      // 轮询用于识别外部启动：用户在别处手动跑了 bat 时，只有重新拉取才能把按钮改成“已在运行”。
      // 卡片收起或组件卸载时清掉定时器，不让它在后台一直跑。
      react.useEffect(() => {
        if (!open) return undefined
        let alive = true
        const pull = () => {
          fetchNapcat()
            .then((body) => {
              if (alive && body !== undefined) setNapcat(body)
            })
            .catch(() => {
              // 单次失败保留上一次的状态：轮询会再试，不给按钮闪一下禁用。
            })
        }
        pull()
        const timer = setInterval(pull, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [open])

      /** 两个 POST 按钮共用：动作没成（ok:false）也把宿主的 error 原文显示出来。 */
      async function postNapcat(action, okNote) {
        setNapcatBusy(action)
        setError('')
        setNote('')
        try {
          if (typeof fetch !== 'function') throw new Error('这个环境没有 fetch')
          // 显式声明 JSON：宿主接口对**带请求体**的 POST 只认 application/json。
          // 这两个动作本身没有请求体，服务端也放行无体的 POST —— 那条是给还没刷新的旧 bundle 兜底。
          const res = await fetch(`${NAPCAT_API}/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(String(body?.error || `HTTP ${res.status}`))
          setNote(String(body?.message || okNote))
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setNapcatBusy('')
          // 成功或失败都重拉一次：启动成功后按钮要立刻变“已在运行”，
          // 被宿主拒绝（例如已在运行）时也要把真实状态显示出来。
          try {
            const fresh = await fetchNapcat()
            if (fresh !== undefined) setNapcat(fresh)
          } catch {
            // 拉取失败时保留上一次的状态
          }
        }
      }

      function change(key) {
        return (event) => {
          const next = { ...shown }
          next[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
          setDraft(next)
          setNote('')
          setError('')
        }
      }

      /** 模型池整体替换：子编辑器已经做过归一化，这里只负责进草稿。 */
      function changeModelPool(next) {
        setDraft({ ...shown, modelPool: normalizeModelPool(next) })
        setNote('')
        setError('')
      }

      async function save() {
        setBusy(true)
        setError('')
        setNote('')
        try {
          const writes = []
          for (const f of FIELDS) {
            if (same(current[f.key], shown[f.key])) continue
            const next = parse(f, shown[f.key])
            if (next === undefined) throw new Error(`「${f.label}」不是合法数字`)
            writes.push([f.key, next])
          }
          for (const [key, value] of writes) await scope.set(key, value)
          setDraft(null)
          setNote(writes.length === 0 ? '没有改动' : `已保存 ${writes.length} 项`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      /**
       * 撤销一个字段的本机覆盖。
       *
       * 设置读取优先级是“设置文件 > composition config”。卡片只发 set 时，
       * 用户从插件配置页改的值会被设置文件里的旧值盖住，且没有地方撤销。
       * 这里走设置源的 unset：清掉那一项，该键回落到 composition config 的值，
       * 刷新后“·已覆盖”标记消失。
       */
      async function unsetOverride(key) {
        const field = FIELDS.find((f) => f.key === key)
        setBusy(true)
        setError('')
        setNote('')
        try {
          if (typeof scope.unset !== 'function') throw new Error('这个设置源不支持撤销覆盖')
          await scope.unset(key)
          setDraft(null)
          setNote(`已撤销「${field ? field.label : key}」的本机覆盖`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      if (snap.status === 'loading') {
        return h('div', { style: S.wrap }, h('div', { style: S.sub }, '载入设置中…'))
      }
      if (snap.status === 'unavailable') {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.title }, 'QQ 桥接'),
          h(
            'div',
            { style: S.sub },
            '这个部署没有为 qq-bridge 提供可写的设置服务（settings 提供者没挂载，或连接处于内存模式）。',
          ),
          h(
            'div',
            { style: S.hint },
            '宿主的两条设置通道都没拿到：插件配置表单（DSH 0.2.0 的 #677 迁移未完成）与本插件的本机设置接口。',
          ),
          h(
            'div',
            { style: S.hint },
            '先看诊断里「本机接口」那项：若宿主没有 webServer 服务，接口挂不上（此时仍可点右上角「打开配置文件」，改 profile 的 cordis.patch.yml 里 `- id: qq-bridge` 的 config 后重启）。',
          ),
          h(
            'div',
            { style: S.hint },
            `诊断：${typeof scope.detail === 'function' ? scope.detail() : '（无诊断信息）'}`,
          ),
        )
      }

      /**
       * 一个字段的两个网格格：标签格（含「·已覆盖」与「撤销覆盖」）+ 控件格。
       * 从原来那个平铺循环里原样抠出来 —— 组的渲染要反复调它，内容一字不改。
       */
      function fieldCells(f) {
        const value = shown[f.key]
        const overridden = Object.prototype.hasOwnProperty.call(user, f.key)
        let control
        if (f.kind === 'boolean') {
          control = h(
            'label',
            { style: S.check },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              disabled: !snap.writable || busy,
              onChange: change(f.key),
            }),
            h('span', null, f.hint || ''),
          )
        } else if (f.kind === 'select') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            (f.options || []).map(([v, text]) => h('option', { key: v, value: v }, text)),
          )
        } else if (f.kind === 'session') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            sessionOptions(sessionList, value, workspaceSnapshot?.archivedSessionIds).map((o) =>
              h('option', { key: o.value || '(none)', value: o.value }, o.label),
            ),
          )
        } else {
          control = h('input', {
            type: f.kind === 'number' ? 'number' : f.secret ? 'password' : 'text',
            ...(f.step ? { step: f.step } : {}),
            ...(f.secret ? { autoComplete: 'off' } : {}),
            style: S.input,
            value: String(value),
            disabled: !snap.writable || busy,
            onChange: change(f.key),
            spellCheck: false,
          })
        }
        const label = h(
          'div',
          { key: f.key, style: S.label },
          f.label,
          overridden ? h('span', { style: S.overridden }, '·已覆盖') : null,
          // 每个字段都有自己的标签格，所以逐字段放按钮对所有类型都成立 —— 不必只给一个统一按钮。
          overridden
            ? h(
                'button',
                {
                  type: 'button',
                  style: disabled(S.link, busy || !snap.writable),
                  disabled: busy || !snap.writable,
                  title: '清掉设置文件里的这一项，回落到 composition config 的值',
                  onClick: () => unsetOverride(f.key),
                },
                '撤销覆盖',
              )
            : null,
        )
        const ctl = h(
          'div',
          { key: `${f.key}-ctl` },
          control,
          f.kind !== 'boolean' && f.hint
            ? h(
                'div',
                { style: S.hint },
                // 会话下拉额外把真实 id 显示出来：看着名字选，但真要手抄/核对时 id 就在旁边
                (f.kind === 'session' && String(value) !== '' ? `${f.hint}当前：${value}` : f.hint) +
                  (runFieldCheck(f, value) ? `\n⚠️ ${runFieldCheck(f, value)}` : ''),
              )
            : null,
        )
        return [label, ctl]
      }

      // 手风琴：按 GROUPS 的固定顺序一组一块；点组标题切换展开，默认全部收起。
      // 展开时遍历该组字段、渲染原来的 label + control 网格（fieldCells 平铺进 grid）。
      const sections = GROUPS.map((g) => {
        const fields = FIELDS.filter((f) => f.group === g.id)
        const open = openGroups[g.id] === true
        const isPool = g.id === 'modelpool'
        return h(
          'div',
          { key: g.id, style: S.group },
          h(
            'button',
            {
              type: 'button',
              onClick: () => setOpenGroups((prev) => ({ ...prev, [g.id]: !prev[g.id] })),
              'aria-expanded': open,
              style: S.groupHead,
            },
            h('span', null, g.label),
            h('span', { style: S.groupCount }, `${fields.length} 项`),
            h('span', { style: S.chevron }, open ? '▴' : '▾'),
          ),
          // 收起的那组不渲染控件，但草稿照常保留 —— draft 与 openGroups 是两套状态。
          open
            ? isPool
              ? h(ModelPoolEditor, {
                  value: shown.modelPool,
                  disabled: !snap.writable || busy,
                  onChange: changeModelPool,
                })
              : h('div', { style: S.grid }, fields.flatMap((f) => fieldCells(f)))
            : null,
        )
      })

      // “打开 WebUI”只在真读到 webui.json 时可点 —— 地址里带着 token，不给猜的余地。
      const webuiUrl = napcat && typeof napcat.webuiUrl === 'string' ? napcat.webuiUrl : ''
      // 宿主报的 running 是权威判据（含外部启动的 NapCat）。拿不到状态时按未运行处理。
      const napcatRunning = napcat !== null && napcat.running === true
      const napcatOps = h(
        'div',
        { style: S.ops },
        h(
          'button',
          {
            type: 'button',
            style: disabled(S.btn, webuiUrl === '' || napcatBusy !== ''),
            disabled: webuiUrl === '' || napcatBusy !== '',
            onClick: () => {
              if (webuiUrl !== '') window.open(webuiUrl, '_blank', 'noopener')
            },
          },
          '打开 WebUI',
        ),
        h(
          'button',
          {
            type: 'button',
            style: disabled(S.btn, napcatRunning || napcatBusy !== ''),
            disabled: napcatRunning || napcatBusy !== '',
            onClick: () => postNapcat('launch', '已启动 NapCat'),
          },
          napcatRunning ? '已在运行' : napcatBusy === 'launch' ? '启动中…' : '启动 NapCat',
        ),
        h(
          'button',
          {
            type: 'button',
            style: disabled(S.btn, napcatBusy !== ''),
            disabled: napcatBusy !== '',
            onClick: () =>
              postNapcat('reveal', napcat && napcat.installDir ? `已打开文件夹：${napcat.installDir}` : '已打开文件夹'),
          },
          napcatBusy === 'reveal' ? '打开中…' : '打开文件夹',
        ),
        webuiUrl === '' ? h('span', { style: S.hint }, '没读到 webui.json') : null,
      )

      const header = h(
        'button',
        { type: 'button', onClick: () => setOpen(!open), 'aria-expanded': open, style: S.header },
        h('span', { style: S.title }, 'QQ 桥接'),
        h('span', { style: S.sub }, dirty ? '有未保存的改动' : '把固定的 DSH 会话接到 QQ'),
        h('span', { style: S.chevron }, open ? '▴' : '▾'),
      )
      // 默认收起：和官方那几张卡片一样，点标题才展开，免得一屏全是表单
      if (!open) return h('div', { style: S.wrap }, header)
      return h(
        'div',
        { style: S.wrap },
        header,
        // 手风琴：按 GROUPS 的固定顺序一组一块；展开哪组点哪组，保存 / 放弃 / 撤销覆盖的逻辑都不在组里
        sections,
        napcatOps,
        h(
          'div',
          { style: S.foot },
          h(
            'button',
            {
              type: 'button',
              style: disabled({ ...S.btn, ...S.primary }, !dirty || busy || !snap.writable),
              disabled: !dirty || busy || !snap.writable,
              onClick: save,
            },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, !dirty || busy),
              disabled: !dirty || busy,
              onClick: () => {
                setDraft(null)
                setError('')
                setNote('')
              },
            },
            '放弃修改',
          ),
          !snap.writable ? h('span', { style: S.note }, '（只读：这个连接不改宿主文档）') : null,
          error ? h('span', { style: S.err }, error) : null,
          !error && note ? h('span', { style: S.note }, note) : null,
        ),
      )
    }

    // ── 插件 ──────────────────────────────────────────────────────────────────

    /** 需要的浏览器服务：slots（注册卡片）；settingsScope 在 apply 里等它出现。 */
    const inject = ['slots']

    // TODO(0.2.0): 平台把第三方插件的设置桥接上之后（web-all / DSH 修完 #677 的迁移），
    // 可以砍掉多余候选 key 与卡片上那行“诊断”；`namespaces` / `detail()` 建议保留（排障用）。
    // 详见 docs/dsh-0.2.0-migration.md 的 TODO 节。
    /**
     * 绑一个**可写的**设置域。导出（经 __test）以便离线测试。
     *
     * 两代 DSH 对“这个插件的设置”用的 key 不一样：
     *   0.1.5-rc.3：settings 命名空间 —— `qq-bridge`（宿主半 register 出来的）；
     *   0.2.0     ：profile **entry id** —— `include:qq-bridge`（由插件自己的 Config 投影而来）。
     * 只绑前者的话，0.2.0 上永远拿到 `unavailable`，用户看到的就是“这个部署没有为 qq-bridge
     * 提供可写的设置服务”（2026-10-01 桌面端真机）。所以**两个都绑，谁 ready 用谁**。
     */
    /** 0.2.0 的兜底数据源：宿主自己挂的本机接口（见宿主半的 handleSettingsRequest）。 */
    const API_PATH = '/api/qq-bridge/settings'
    /** NapCat 操作接口（宿主半不受 legacy 门控，两代宿主都挂）。 */
    const NAPCAT_API = '/api/qq-bridge/napcat'
    /** 稳定引用：useSyncExternalStore 的 getSnapshot 每次返回新对象会死循环。 */
    const LOADING_SNAPSHOT = { status: 'loading' }
    const UNAVAILABLE_SNAPSHOT = { status: 'unavailable' }

    /**
     * 走宿主本机接口的设置域（0.2.0 用）。
     *
     * 为什么需要它：0.2.0 的 `webUiSettings` 桥对第三方插件永远返回 `unavailable`
     * （证据见 docs/dsh-0.2.0-migration.md）。范本：皮肤中心
     * `@linxin666/dsh-client-ui-skin-center` 就是自己 `inject: ["webServer"]` 挂
     * `/api/skin-center/...`，浏览器半直接 fetch 它，全程不碰宿主 settings 服务。
     *
     * 小 store：fetch 一次 → 缓存 snapshot → 通知订阅者；`set` 走 POST 再刷新。
     * 快照形状与宿主 scope 对齐（`status` / `value` / `user` / `writable`），卡片不用改。
     */
    function createApiScope() {
      const listeners = new Set()
      let snapshot = { status: 'idle' }
      let started = false
      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // 一个订阅者抛错不该影响别人
          }
        }
      }
      const accept = (body) => {
        const overridden = Array.isArray(body?.overridden) ? body.overridden : []
        publish({
          status: 'ready',
          value: body?.values && typeof body.values === 'object' ? body.values : {},
          user: Object.fromEntries(overridden.map((key) => [key, true])),
          writable: true,
        })
      }
      const load = async () => {
        if (typeof fetch !== 'function') {
          publish({ status: 'unavailable', reason: 'no-fetch' })
          return
        }
        publish({ status: 'loading' })
        try {
          const res = await fetch(API_PATH, { headers: { accept: 'application/json' } })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        } catch (error) {
          publish({ status: 'unavailable', reason: `api: ${error?.message ?? error}` })
        }
      }
      return {
        kind: 'api',
        getSnapshot: () => snapshot,
        start: () => {
          if (started) return
          started = true
          load()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: async (field, value) => {
          const res = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set: { [field]: value } }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        },
        /** 撤销一个字段的本机覆盖：接口本来就支持 `unset`，这里只是把它暴露给卡片。 */
        unset: async (field) => {
          if (typeof fetch !== 'function') throw new Error('qq-bridge: 这个环境没有 fetch')
          const res = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ unset: [field] }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        },
      }
    }

    /**
     * 绑一个**可写的**设置域。导出（经 __test）以便离线测试。
     *
     * 两代 DSH 对“这个插件的设置”用的 key 不一样：
     *   0.1.5-rc.3：settings 命名空间 —— `qq-bridge`（宿主半 register 出来的）；
     *   0.2.0     ：profile **entry id** —— `include:qq-bridge`（由插件自己的 Config 投影而来）。
     * 只绑前者的话，0.2.0 上永远拿到 `unavailable`，用户看到的就是“这个部署没有为 qq-bridge
     * 提供可写的设置服务”（2026-10-01 桌面端真机）。所以**两个都绑、谁 ready 用谁**；
     * **全都不 ready** 时再退到宿主自己的本机接口（0.2.0 的兜底，见 createApiScope）。
     */
    function bindSettings(service) {
      const unavailable = UNAVAILABLE_SNAPSHOT
      const candidates = []
      // 0.2.0 的表单 key 到底叫什么，源码里能看到的写法**全试一遍**（谁 ready 用谁）：
      // settings 命名空间 / profile entry id / 包名，以及带 include: 前缀的两种。
      //
      // ⚠️ 合并包（HOST_ID）**刻意不绑** `include:HOST_ID`：那个域对应的是合并包 entry 的
      // 整份 config，形状是 `{ fish: {...}, qq: {...} }`；卡片的字段是**平铺**的
      // （nicknames / ownerQQ…），绑上去会“显示正常但写到顶层”，比不显示更难查。
      // 合并态下让四个候选全部不 ready，自动回落到本机接口 /api/qq-bridge/settings。
      for (const namespace of [NS, `include:${NS}`, 'dsh-qq-bridge', 'include:dsh-qq-bridge']) {
        try {
          const scope = service.bind({ namespace })
          if (scope && typeof scope === 'object') candidates.push({ namespace, scope })
        } catch (error) {
          // 某个候选绑不上不影响另一个。
          console?.debug?.(`qq-bridge: bind(${namespace}) 失败：${error?.message ?? error}`)
        }
      }
      const snapshotOf = (candidate) => {
        try {
          return candidate.scope.getSnapshot?.() ?? unavailable
        } catch {
          return unavailable
        }
      }
      const readyScope = () => candidates.find((candidate) => snapshotOf(candidate).status === 'ready')
      const anyLoading = () => candidates.some((candidate) => snapshotOf(candidate).status === 'loading')
      const api = createApiScope()
      return {
        // 供排障/测试看：这次到底绑到了哪些 key
        namespaces: candidates.map((candidate) => candidate.namespace),
        /** 这次数据从哪来（排障/测试用）：'scope' | 'api' | 'none'。 */
        via: () => {
          if (readyScope()) return 'scope'
          return api.getSnapshot().status === 'ready' ? 'api' : 'none'
        },
        /**
         * 每个候选的当前状态。直接显示在卡片上 —— 0.2.0 的 key 叫什么，
         * 与其猜，不如让它自己报（2026-10-01 真机就是靠这个收敛的）。
         */
        detail: () => {
          const scopes =
            candidates.length === 0
              ? '一个候选都没绑上（webUiSettings.bind 全部抛错）'
              : candidates.map((candidate) => `${candidate.namespace}=${snapshotOf(candidate).status}`).join('、')
          const apiSnap = api.getSnapshot()
          return `${scopes}；本机接口=${apiSnap.status}${apiSnap.reason ? `（${apiSnap.reason}）` : ''}`
        },
        getSnapshot: () => {
          const candidate = readyScope()
          if (candidate) return snapshotOf(candidate)
          // scope 全不可用 → 退到宿主本机接口；第一次问就把它跑起来。
          if (!anyLoading()) api.start()
          const apiSnap = api.getSnapshot()
          if (apiSnap.status === 'ready') return apiSnap
          if (apiSnap.status === 'loading' || apiSnap.status === 'idle') return LOADING_SNAPSHOT
          return unavailable
        },
        subscribe: (listener) => {
          const offs = []
          for (const candidate of candidates) {
            try {
              const off = candidate.scope.subscribe?.(listener)
              if (typeof off === 'function') offs.push(off)
            } catch {
              // 订阅失败不影响其它候选
            }
          }
          offs.push(api.subscribe(listener))
          if (!readyScope() && !anyLoading()) api.start()
          return () => {
            for (const off of offs) off()
          }
        },
        set: (field, value) => {
          const candidate = readyScope()
          if (candidate && typeof candidate.scope.set === 'function') return candidate.scope.set(field, value)
          if (api.getSnapshot().status === 'ready') return api.set(field, value)
          throw new Error('qq-bridge: 没有可写的设置源')
        },
        /**
         * 撤销一个字段的本机覆盖。
         *
         * 优先用设置域自己的 `unset`（DSH 的 SettingsScope 有这个能力）；
         * 设置域没有它时走本机接口的 `unset`（宿主半的 handleSettingsRequest 本来就支持）。
         */
        unset: (field) => {
          const candidate = readyScope()
          if (candidate && typeof candidate.scope.unset === 'function') return candidate.scope.unset(field)
          return api.unset(field)
        },
      }
    }

    function apply(ctx) {
      // ⚠️ 两代 DSH 之间**两处都换了名字**（2026-10-01 用户指出第二处）：
      //   ① 客户端**设置服务**：0.1.5-rc.3（web-all 0.3.x）叫 `settingsScope`，
      //      0.2.0（web-all 0.4.x）叫 `webUiSettings`；
      //   ② 插件配置页的**挂载 slot**：0.1.5-rc.3 是 `settings.plugin.item`（按 settings 命名空间派发），
      //      0.2.0 是 `settings.plugins.tab`（插件自己是一个 tab）。
      //
      // 2026-10-26 补的第三处（合并包才发现）：0.2.0 的**派发键是 profile entry id**，
      // 不再是 settings 命名空间。合并成 dsh-fish-qq 之后 entry id 变了，
      // 只注册 `qq-bridge` 的结果是**一张卡片都不出现**（真机：设置 → 插件 里没有「QQ 桥接」）。
      //
      // 还有一处：原来把注册整段包在 `setup()` 里，而 setup 头一句就是
      // `if (!service) return` —— 这个部署没有设置服务时连卡片都不会挂。
      // 作者本来就写了「没有设置域就走本机 HTTP 接口」的兜底（createApiScope，
      // 对应宿主半的 /api/qq-bridge/settings），只是被那道服务门挡在门外了。现在不再挡。
      const service = (() => {
        try {
          return ctx.get?.('webUiSettings') ?? ctx.get?.('settingsScope') ?? null
        } catch {
          return null
        }
      })()
      // service 为 null 时一个候选都绑不上，getSnapshot 会自动回落到本机接口。
      const scope = bindSettings(service)

      // sessionsOf / workspacesOf 用“取的时候再解析”：这两个服务可能比插件晚出现，
      // 也可能这个部署根本没装 —— 那时卡片照常渲染，只是目标会话那一栏只有兜底项。
      const card = () =>
        h(Card, { scope, sessionsOf: () => ctx.get('sessions'), workspacesOf: () => ctx.get('workspaces') })

      const registerCard = (slot, options) => {
        try {
          // `slots.inject(slot, factory)` 只在那个 slot 存在时才跑 factory，多注入是安全的。
          ctx.slots.inject(slot, () => ctx.slots.register({ ...options, name: slot }, card))
        } catch (error) {
          // 这个版本的 DSH 没有这个 slot —— 忽略，另一个会生效。
          console?.debug?.(`qq-bridge: slot ${slot} unavailable (${error?.message ?? error})`)
        }
      }

      // `settings.plugin.item` 是**按 key 派发**的：多注册几个键，命中的那个才渲染。
      for (const key of CARD_KEYS) registerCard('settings.plugin.item', { key })
      // tab 槽是**按 id 各算一个 tab**：只注册一个，否则会出现两个「QQ 桥接」。
      registerCard('settings.plugins.tab', {
        id: HOST_ID || NS,
        order: 100,
        label: () => 'QQ 桥接',
      })
    }

    exports.apply = apply
    exports.inject = inject
    // 导出 name：Cordis 用它做插件标识，Slots inspect 里的 registrant 会显示成它
    // （不导的话那边显示的是产物里的 fallback 短名，排障时认不出是谁注册的卡片）。
    exports.name = 'dsh-qq-bridge'
    // 纯函数给离线测试用（test-smoke.mjs 会在假 ctx 里真跑这个 bundle）。
    // Cordis 只认 apply / inject / name / Config，多余的导出它不管。
    exports.__test = { sessionOptions, draftFrom, parse, fields: FIELDS, bindSettings, normalizeModelPool, ModelPoolEditor }
    return module.exports
}
