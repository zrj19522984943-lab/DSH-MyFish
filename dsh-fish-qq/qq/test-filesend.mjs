/**
 * test-filesend.mjs —— 发文件（fileget / filesend，2026-10-27）
 *
 * 验收清单：
 *   解析：只有**主人**的 `fileget <路径>` / `filesend <QQ号> <路径>` 算指令（前缀在行首）。
 *   唤醒：主人的发文件指令必唤醒（群里也越过 atOnlyInGroup）。
 *   发送：工具直调 OneBot `upload_private_file`；本机不支持路径方式时退到 base64://，
 *         退一次后记住（state.fileSend.base64），之后不再先试路径。
 *   沙箱：`..` 越界、绝对路径跳出工作区、符号链接外跳、文件不存在、是目录、超过 50MB 都被拒。
 *   身份：非主人（群友）在同一轮里调工具会被拒；DSH 界面里的非 QQ 轮要二次确认。
 *   台账：发出去的落 outbox（via: fileget / filesend），被拒的进丢弃台账、不占 outbox。
 *   兼容：subsend 通路不受影响（test-subsend.mjs 独立覆盖）。
 *
 * 跑法：node test-filesend.mjs（和 test-subsend.mjs 一样是脚本式断言）
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 工作区根 = 仓库根（本文件在 dsh-fish-qq/qq/ 下，往上两级）。不再依赖本机写死的路径。
const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── 假 WebSocket：让 OneBot 传输真的“连上”并捕获出站帧 ─────────────────────
const wsSent = []
/**
 * 模拟「本机 OneBot 不支持 upload_private_file 的本地路径方式」：
 * 打开后，file 参数不是 base64:// 的上传请求一律回 failed：「unknown action …」。
 */
let rejectPathMode = false
class FakeWS {
  constructor(url) {
    this.url = url
    this.readyState = 0
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 0)
  }

  send(data) {
    let frame
    try {
      frame = JSON.parse(String(data))
    } catch {
      return
    }
    wsSent.push(frame)
    setTimeout(() => {
      if (
        frame.action === 'upload_private_file' &&
        rejectPathMode &&
        !String(frame.params?.file ?? '').startsWith('base64://')
      ) {
        this.onmessage?.({
          data: JSON.stringify({
            echo: frame.echo,
            status: 'failed',
            retcode: 10003,
            message: 'unknown action upload_private_file',
            data: null,
          }),
        })
        return
      }
      this.onmessage?.({ data: JSON.stringify({ echo: frame.echo, status: 'ok', retcode: 0, data: { file_id: 'test-fid' } }) })
    }, 0)
  }

  close() {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: 'test' })
  }
}
globalThis.WebSocket = FakeWS

const {
  apply,
  buildUsagePrompt,
  parseFileCommand,
  renderFileInstruction,
  resolveWorkspaceFile,
  formatBytes,
  FILE_MAX_BYTES,
  NON_OWNER_MARKER,
} = await import('./index.js')

// ── 断言器 ────────────────────────────────────────────────────────────────
let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ══════════════════════════════════════════════════════════════════════════
// 第一部分：纯函数
// ══════════════════════════════════════════════════════════════════════════
{
  const p = (t) => parseFileCommand(t)
  check('解析：fileget 基本形态', JSON.stringify(p('fileget qq/CHANGELOG.md')) === JSON.stringify({ kind: 'fileget', path: 'qq/CHANGELOG.md' }))
  check('解析：fileget 路径可以有空格', p('fileget my files/报告 v2.md')?.path === 'my files/报告 v2.md')
  check('解析：fileget 前缀大小写不敏感', p('FileGet a.txt')?.kind === 'fileget')
  check('解析：filesend 基本形态', JSON.stringify(p('filesend 12345678 qq/README.md')) === JSON.stringify({ kind: 'filesend', targetQQ: '12345678', path: 'qq/README.md' }))
  check('解析：filesend 路径可以有空格', p('filesend 12345678 a b/c.txt')?.path === 'a b/c.txt')
  check('解析：filesend 前缀大小写不敏感', p('FileSend 12345678 a.txt')?.targetQQ === '12345678')
  check('解析：filesend QQ 太短不算', p('filesend 123 x.txt') === null)
  check('解析：filesend QQ 太长不算', p('filesend 1234567890123 x.txt') === null)
  check('解析：filesend QQ 非数字不算', p('filesend abc x.txt') === null)
  check('解析：没路径不算', p('fileget') === null && p('filesend 12345678') === null)
  check('解析：前缀不在行首不算', p('看这个 fileget a.txt') === null && p('帮忙 filesend 1 2 a.txt') === null)
  check('解析：空串不算', p('') === null && p(null) === null)
  check('解析：subsend 前缀不算发文件指令', p('subsend 12345678 hello') === null)
  check('解析：普通聊天不算', p('把那个文件发我') === null)
  check('解析：fileget 不会吞掉 filesend', p('filesend 12345678 x.txt')?.kind === 'filesend')

  // ── 路径沙箱（与 fish/test/listdir.test.mjs 同一套手法，只是落在文件上）──
  const tmpRoot = () => mkdtempSync(join(tmpdir(), 'qq-bridge-file-'))
  {
    const root = tmpRoot()
    try {
      writeFileSync(join(root, 'a.txt'), 'hello')
      mkdirSync(join(root, 'sub'))
      writeFileSync(join(root, 'sub', 'b.txt'), 'world')
      const r = resolveWorkspaceFile(root, 'a.txt')
      check('沙箱：工作区里的文件能解析', r.ok === true, JSON.stringify(r).slice(0, 120))
      check('沙箱：name 取basename', r.name === 'a.txt')
      check('沙箱：size 是字节数', r.size === 5)
      check('沙箱：子目录里的文件也行', resolveWorkspaceFile(root, 'sub/b.txt').ok === true)
      check('沙箱：正斜杠 / 反斜杠都吃', resolveWorkspaceFile(root, 'sub\\b.txt').ok === true)
      check('沙箱：根本身的文件可以', resolveWorkspaceFile(root, 'a.txt').ok === true)

      for (const bad of ['..', '../..', 'sub/../../x', '../evil.txt']) {
        const rb = resolveWorkspaceFile(root, bad)
        check(`沙箱：${bad} 越界被拒`, rb.ok === false && rb.reason === 'outside', JSON.stringify(rb))
      }
      const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname'
      const ro = resolveWorkspaceFile(root, outside)
      check('沙箱：绝对路径指向外面被拒', ro.ok === false && ro.reason === 'outside')
      check('沙箱：越界回执是中文权限拒绝', (ro.message ?? '').includes('权限拒绝'))

      const rn = resolveWorkspaceFile(root, 'nope.txt')
      check('沙箱：不存在说 not-found', rn.ok === false && rn.reason === 'not-found' && (rn.message ?? '').includes('没有这个文件'), JSON.stringify(rn))
      const rd = resolveWorkspaceFile(root, 'sub')
      check('沙箱：目录说 not-a-file', rd.ok === false && rd.reason === 'not-a-file', JSON.stringify(rd))
      check('沙箱：空根配 no-root', resolveWorkspaceFile('', 'a.txt').reason === 'no-root')

      // 超大小：造一个 FILE_MAX_BYTES + 1 的文件
      const big = join(root, 'big.bin')
      writeFileSync(big, Buffer.alloc(FILE_MAX_BYTES + 1, 0))
      const rb2 = resolveWorkspaceFile(root, 'big.bin')
      check('沙箱：超过 50MB 说 too-big', rb2.ok === false && rb2.reason === 'too-big', JSON.stringify(rb2).slice(0, 120))

      // 符号链接 / junction 外跳（没有权限建链接就跳过，不造假红）
      const outsideDir = tmpRoot()
      try {
        writeFileSync(join(outsideDir, 'a.txt'), 'outside')
        symlinkSync(outsideDir, join(root, 'escape'), 'junction')
        const rl = resolveWorkspaceFile(root, 'escape/a.txt')
        check('沙箱：指向外面的 junction 被拒', rl.ok === false && rl.reason === 'outside', JSON.stringify(rl))
      } catch {
        console.log('SKIP  沙箱：本机不允许建链接，junction 外跳这条跳过')
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // 格式化字节
  check('formatBytes：B / KB / MB', formatBytes(0) === '0B' && formatBytes(300) === '300B' && formatBytes(1536) === '1.5KB' && formatBytes(FILE_MAX_BYTES) === '50MB')

  // 注入说明
  const instGet = renderFileInstruction({ kind: 'fileget', path: 'qq/x.md' }, { ownerQQ: '10001' })
  check('说明：fileget 带路径', instGet.includes('qq/x.md'))
  check('说明：fileget 点名工具', instGet.includes('qq_bridge_fileget'))
  check('说明：fileget 写明不受标记块约束', instGet.includes('不受回复标记块约束') || instGet.includes('不用写 [QQ] 块'))
  check('说明：fileget 写明边界（50MB）', instGet.includes('50MB'))
  const instSend = renderFileInstruction({ kind: 'filesend', targetQQ: '12345678', path: 'qq/y.md' }, { ownerQQ: '10001' })
  check('说明：filesend 带目标 QQ', instSend.includes('12345678'))
  check('说明：filesend 点名工具', instSend.includes('qq_bridge_filesend'))
  check('说明：filesend 写明不要改目标号', instSend.includes('不要改目标 QQ 号'))
  check('说明：没配主人时不带主人号', !renderFileInstruction({ kind: 'fileget', path: 'a' }, {}).includes('主人 QQ'))

  // 用法说明：2026-11-04 起不再常驻「发文件」长说明 —— 指令通过校验后由
  // renderFileInstruction 当轮注入；系统提示只保留权限边界。
  const promptOn = buildUsagePrompt({ ownerQQ: '10001', workspaceRoot: WORKSPACE_ROOT })
  check('提示词：不再常驻发文件用法', !promptOn.includes('【发文件：把工作区里的文件发出去】'))
  check('提示词：仍保留文件指令的权限边界', promptOn.includes('只有主人和管理员能下这个指令'))
  check('提示词：权限段仍点名 fileget / filesend', promptOn.includes('fileget') && promptOn.includes('filesend'))
  const promptNoOwner = buildUsagePrompt({ ownerQQ: '' })
  check('提示词：没配主人 → 不写文件权限', !promptNoOwner.includes('fileget') && !promptNoOwner.includes('filesend'))
  check('指令说明：fileget 仍点名工具与工作区', (() => {
    const inst = renderFileInstruction({ kind: 'fileget', path: 'a.txt' }, { ownerQQ: '10001', workspaceRoot: WORKSPACE_ROOT })
    return inst.includes('qq_bridge_fileget') && inst.includes('工作区')
  })())
}

// ══════════════════════════════════════════════════════════════════════════
// 第二部分：走真实 apply + 入站链路 + 工具调用
// ══════════════════════════════════════════════════════════════════════════
const statePath = join(mkdtempSync(join(tmpdir(), 'qq-bridge-file-')), 'state.json')
{
  const warnings = []
  const registered = []
  const handlers = {}
  let resolvedSettings = {}

  const agent = {
    id: 'session-file',
    status: 'idle',
    session: { id: 'session-file' },
    followups: [],
    followup(msg) {
      this.followups.push(msg)
      return Promise.resolve()
    },
    steer(msg) {
      this.followups.push(msg)
      return Promise.resolve()
    },
  }

  const ctx = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)) },
    settings: {
      register: (ns, schema, opts) => {
        resolvedSettings = { ...(opts?.base ?? {}) }
        return {}
      },
      get: () => resolvedSettings,
    },
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      roots: () => [],
      resume: async () => {
        throw new Error('file-test: no resume')
      },
    },
    tools: { register: (def) => registered.push(def) },
    on: (name, fn) => {
      handlers[name] = fn
      return () => {}
    },
    effect: (fn) => {
      const d = fn?.()
      return () => d?.()
    },
    get: () => undefined,
  }
  ctx.inject = (_deps, cb) => cb(ctx)

  const config = {
    targetSessionId: 'session-file',
    statePath,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:3998',
    selfId: '99999999',
    whitelist: ['10001', '20002'],
    groupWhitelist: ['90001'],
    nicknames: ['244'],
    wakeProbability: 1,
    privateWakeProbability: 1,
    ownerQQ: '10001',
    workspaceRoot: WORKSPACE_ROOT,
  }

  apply(ctx, config)

  const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
  const status = registered.find((t) => t.name === 'qq_bridge_status')
  const fileget = registered.find((t) => t.name === 'qq_bridge_fileget')
  const filesend = registered.find((t) => t.name === 'qq_bridge_filesend')
  const subsend = registered.find((t) => t.name === 'qq_bridge_subsend')
  check('注册：qq_bridge_fileget 存在', Boolean(fileget))
  check('注册：qq_bridge_filesend 存在', Boolean(filesend))
  check('注册：不影响其它工具（simulate/status/subsend 都在）', Boolean(sim && status && subsend))

  const sessionHandler = handlers['session/event']
  const fire = (type, data = {}) => sessionHandler({ id: 'session-file' }, { type, data })
  const lastInjected = () => {
    const msg = agent.followups.at(-1)
    const blocks = msg?.content ?? []
    return blocks.map((b) => b?.text ?? '').join('')
  }
  const uploads = () => wsSent.filter((f) => f.action === 'upload_private_file')
  const openTransport = async () => {
    for (let i = 0; i < 100; i++) {
      const st = JSON.parse(await status.execute({}))
      if (st.transport?.state === 'open') return true
      await sleep(20)
    }
    return false
  }
  const opened = await openTransport()
  check('链路：假 OneBot 连接已建立', opened)

  // 工作区里真实存在的一个小文件，用来走完整出站（WORKSPACE_ROOT 是工作区根，
  // 插件目录是它下面的 dsh-fish-qq/，所以相对路径要带这一层）
  const realFile = 'docs/archive/dsh-qq-bridge__CHANGELOG.md'
  const realResolved = resolveWorkspaceFile(WORKSPACE_ROOT, realFile)
  check('链路：测试用文件在工作区里（本机口径）', existsSync(join(WORKSPACE_ROOT, realFile)), realFile)

  // ── 场景 1：主人私聊下发 fileget 指令 ───────────────────────────────────
  agent.followups.length = 0
  await sim.execute({ text: `fileget ${realFile}`, userId: '10001', nickname: '主人' })
  check('指令：主人私聊被唤醒', agent.followups.length === 1)
  const injected1 = lastInjected()
  check('指令：附了「主人的 fileget 指令」说明', injected1.includes('这是主人的 fileget 指令'))
  check('指令：正文带路径', injected1.includes(realFile))
  check('指令：点名工具', injected1.includes('qq_bridge_fileget'))
  check('指令：主人不带非主人标记', !injected1.includes(NON_OWNER_MARKER))

  // 唤醒原因是 owner-file（dryRun 直接看 decide）
  {
    const preview = JSON.parse(await sim.execute({ text: `fileget ${realFile}`, userId: '10001', dryRun: true })).preview
    check('唤醒：decision=owner-file', preview.action === 'wake' && preview.reason === 'owner-file', JSON.stringify(preview))
  }

  // 工具在「这一轮」里调用：先 turn/start（快照身份）
  fire('turn/start', { turn: 1 })
  wsSent.length = 0
  {
    const r = JSON.parse(await fileget.execute({ path: realFile }))
    check('发送：工具返回成功', r.ok === true, JSON.stringify(r).slice(0, 200))
    check('发送：真的调了 upload_private_file', uploads().length === 1, JSON.stringify(wsSent.map((f) => f.action)))
    const up = uploads()[0]
    check('发送：目标是主人号', String(up?.params?.user_id) === '10001')
    check('发送：file 是工作区里的绝对路径', String(up?.params?.file).startsWith(WORKSPACE_ROOT), String(up?.params?.file))
    check('发送：name 是 basename', up?.params?.name === 'dsh-qq-bridge__CHANGELOG.md')
    check('发送：mode 标明用了路径方式', r.mode === 'path', String(r.mode))
    check('发送：size 与磁盘一致', r.size === statSync(join(WORKSPACE_ROOT, realFile)).size)
    check('发送：回执是「文件已发送」', String(r.message).includes('文件已发送'))
  }
  const st1 = JSON.parse(await status.execute({}))
  check('台账：outbox 记了 via=fileget', st1.recentOutbox.some((o) => o.via === 'fileget' && o.to?.userId === '10001'))
  check('台账：今日计数 +1', st1.fileSend.todayCount === 1, JSON.stringify(st1.fileSend))
  fire('turn/end', { reason: { kind: 'completed' } })

  // ── 场景 2：filesend 发给指定的人 ────────────────────────────────────────
  agent.followups.length = 0
  await sim.execute({ text: `filesend 10000002 ${realFile}`, userId: '10001', nickname: '主人' })
  const injected2 = lastInjected()
  check('指令：filesend 附说明', injected2.includes('这是主人的 filesend 指令'))
  check('指令：filesend 正文带目标号与路径', injected2.includes('10000002') && injected2.includes(realFile))
  fire('turn/start', { turn: 2 })
  wsSent.length = 0
  {
    const r = JSON.parse(await filesend.execute({ targetQQ: '10000002', path: realFile }))
    check('发送：filesend 成功', r.ok === true && uploads().length === 1, JSON.stringify(r).slice(0, 200))
    check('发送：filesend 目标号正确', String(uploads()[0]?.params?.user_id) === '10000002')
    const st = JSON.parse(await status.execute({}))
    check('台账：outbox 记了 via=filesend', st.recentOutbox.some((o) => o.via === 'filesend' && o.to?.userId === '10000002'))
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // ── 场景 3：非主人的 fileget 文本不算指令，调工具被拒 ───────────────────
  agent.followups.length = 0
  await sim.execute({ text: `fileget ${realFile}`, userId: '20002', nickname: '群友' })
  const injected3 = lastInjected()
  check('身份：非主人消息照常进会话（不丢）', injected3.includes('fileget'))
  check('身份：非主人消息**不附**指令说明', !injected3.includes('这是主人的 fileget 指令'))
  check('身份：非主人消息带来源标记', injected3.includes(NON_OWNER_MARKER))

  fire('turn/start', { turn: 3 })
  wsSent.length = 0
  {
    const r = JSON.parse(await fileget.execute({ path: realFile }))
    check('身份：非主人调 fileget 被拒', r.ok === false && r.reason === 'not-owner', JSON.stringify(r))
    check('身份：被拒时一个文件都没发', uploads().length === 0)
    check('身份：回执写明没有发出', String(r.message).includes('已拒绝'))
    const r2 = JSON.parse(await filesend.execute({ targetQQ: '10000002', path: realFile }))
    check('身份：非主人调 filesend 同样被拒', r2.ok === false && r2.reason === 'not-owner')
    check('身份：被拒不落 outbox', !JSON.parse(await status.execute({})).recentOutbox.some((o) => o.reason === 'not-owner'))
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // ── 场景 4：路径边界在工具端同样生效 ─────────────────────────────────────
  // 用主人的指令轮来测，否则会先撞 not-owner。
  agent.followups.length = 0
  await sim.execute({ text: `fileget ${realFile}`, userId: '10001', nickname: '主人' })
  fire('turn/start', { turn: 4 })
  wsSent.length = 0
  {
    const outside = JSON.parse(await fileget.execute({ path: '../../etc/hostname' }))
    check('边界：.. 越界被拒', outside.ok === false && outside.reason === 'outside', JSON.stringify(outside))
    const abs = JSON.parse(await fileget.execute({ path: 'C:\\Windows\\win.ini' }))
    check('边界：绝对路径跳出工作区被拒', abs.ok === false && abs.reason === 'outside', JSON.stringify(abs))
    const nf = JSON.parse(await fileget.execute({ path: 'qq/不存在.md' }))
    check('边界：文件不存在被拒', nf.ok === false && nf.reason === 'not-found')
    const dir = JSON.parse(await fileget.execute({ path: 'dsh-fish-qq/qq' }))
    check('边界：目录被拒（not-a-file）', dir.ok === false && dir.reason === 'not-a-file', JSON.stringify(dir).slice(0, 160))
    check('边界：被拒时一个文件都没发', uploads().length === 0)
    check('边界：被拒进丢弃台账、不进 outbox', JSON.parse(await status.execute({})).recentDropped.length > 0 &&
      !JSON.parse(await status.execute({})).recentOutbox.some((o) => o.via === 'fileget' && (o.text ?? '').includes('不存在.md')))
    // 目标号校验
    const bad = JSON.parse(await filesend.execute({ targetQQ: 'abc', path: realFile }))
    check('校验：QQ 号不合法被拒', bad.ok === false && bad.reason === 'bad-target', JSON.stringify(bad))
    const self = JSON.parse(await filesend.execute({ targetQQ: '99999999', path: realFile }))
    check('校验：不能发给自己', self.ok === false && self.reason === 'self-target')
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // ── 场景 5：本机不支持 upload_private_file 的路径方式 → 退 base64 ─────────
  agent.followups.length = 0
  await sim.execute({ text: `fileget ${realFile}`, userId: '10001', nickname: '主人' })
  fire('turn/start', { turn: 5 })
  rejectPathMode = true
  wsSent.length = 0
  {
    const r = JSON.parse(await fileget.execute({ path: realFile }))
    check('回退：路径方式被拒后退 base64 成功', r.ok === true && r.mode === 'base64', JSON.stringify(r).slice(0, 200))
    check('回退：只发了**一个**上传帧（先路径后 base64 共 2 次 call，但路径那次被拒）', uploads().length === 2, JSON.stringify(uploads().map((u) => String(u.params.file).slice(0, 8))))
    const b64 = uploads().find((u) => String(u.params.file).startsWith('base64://'))
    check('回退：第二个帧是 base64://', Boolean(b64))
    check('回退：base64 内容能解回原文件', Buffer.from(String(b64.params.file).slice('base64://'.length), 'base64').equals(readFileSync(join(WORKSPACE_ROOT, realFile))))
    check('回退：name 仍然是原文件名', uploads()[0]?.params?.name === 'dsh-qq-bridge__CHANGELOG.md')
    const st = JSON.parse(await status.execute({}))
    check('回退：state 记住 base64 方式', st.fileSend.base64Mode === true, JSON.stringify(st.fileSend))
  }
  fire('turn/end', { reason: { kind: 'completed' } })

  // 记住之后：下一次直接走 base64，不再先试路径
  agent.followups.length = 0
  await sim.execute({ text: `fileget ${realFile}`, userId: '10001', nickname: '主人' })
  fire('turn/start', { turn: 6 })
  wsSent.length = 0
  {
    const r = JSON.parse(await fileget.execute({ path: realFile }))
    check('记住：直接走 base64（mode=base64）', r.ok === true && r.mode === 'base64')
    check('记住：只发一个上传帧（不再先试路径）', uploads().length === 1 && String(uploads()[0].params.file).startsWith('base64://'))
  }
  fire('turn/end', { reason: { kind: 'completed' } })
  rejectPathMode = false

  // ── 场景 6：DSH 界面里的非 QQ 轮 → 两步确认 ────────────────────────────
  {
    wsSent.length = 0
    const r1 = JSON.parse(await fileget.execute({ path: realFile }))
    check('确认：第一次只回确认、不发', r1.needsConfirm === true && uploads().length === 0, JSON.stringify(r1))
    const r2 = JSON.parse(await fileget.execute({ path: realFile }))
    check('确认：第二次真的发出去', r2.ok === true && uploads().length === 1, JSON.stringify(r2).slice(0, 160))
    // 确认状态按轮清零
    fire('turn/start', { turn: 7 })
    fire('turn/end', { reason: { kind: 'completed' } })
    const r3 = JSON.parse(await filesend.execute({ targetQQ: '10000003', path: realFile }))
    check('确认：发文件与 subsend 的确认状态互相独立', r3.needsConfirm === true)
    fire('turn/start', { turn: 8 })
    fire('turn/end', { reason: { kind: 'completed' } })
    const r4 = JSON.parse(await fileget.execute({ path: realFile }))
    check('确认：新的一轮重新要确认（不跨轮泄漏）', r4.needsConfirm === true)
  }

  // ── 场景 7：状态文件持久化（重启后 base64 标记仍在）──────────────────────
  {
    const registered2 = []
    const handlers2 = {}
    const agent2 = { id: 'session-file', status: 'idle', session: { id: 'session-file' }, followup: () => Promise.resolve(), steer: () => Promise.resolve() }
    const ctx2 = {
      logger: { info() {}, warn() {} },
      settings: { register: (_ns, _schema, opts) => ({ ...(opts?.base ?? {}) }), get: () => ({}) },
      agents: { get: (id) => (id === agent2.id ? agent2 : undefined), roots: () => [] },
      tools: { register: (def) => registered2.push(def) },
      on: (name, fn) => {
        handlers2[name] = fn
        return () => {}
      },
      effect: (fn) => {
        const d = fn?.()
        return () => d?.()
      },
      get: () => undefined,
    }
    ctx2.inject = (_d, cb) => cb(ctx2)
    apply(ctx2, { ...config, debugTools: true })
    const status2 = registered2.find((t) => t.name === 'qq_bridge_status')
    const st2 = JSON.parse(await status2.execute({}))
    check('持久化：重启后 base64 标记仍在', st2.fileSend?.base64Mode === true, JSON.stringify(st2.fileSend))
    check('持久化：重启后今日计数仍然算数', st2.fileSend?.todayCount >= 1, JSON.stringify(st2.fileSend))
  }
}

// ══════════════════════════════════════════════════════════════════════════
if (existsSync(statePath)) rmSync(statePath, { force: true })

console.log('')
if (failed === 0) {
  console.log('ALL PASS')
} else {
  console.log(`${failed} FAILED`)
}

// 与 test-subsend.mjs 同理：假 WS 的退避重连定时器会拖住事件循环，结论出完直接退。
process.exit(failed === 0 ? 0 : 1)
