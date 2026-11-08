// qq-bridge 环境传感器测试：Cron 解析 / 唤醒**不注入** / 定时器接线 / 状态文件。
//
// 2026-11-02 起这块改造为「去提示词化」：采集脚本（pipeline/update_env.js）
// 定时把一行状态覆盖写进工作区的 sensors/status.md，桥接层**不再**在唤醒消息里
// 前置注入 `[系统环境反馈：…]`。所以本测试最重要的断言反而是反向的——
// 无论开关开没开、状态文件新不新鲜，唤醒消息里都不该出现环境前缀。
//
// 运行：node test-env-sensor.mjs
//   ENV_SENSOR_TIMER=1 时额外跑「定时器到点真的会跑采集脚本写状态文件」那条
//   （耗时约 100 秒，因为最小粒度是一分钟；沙箱里 spawn 会被拒，那条用例只断言「到点尝试过」）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, parseCron } from './index.js'
const tempRoot = join(tmpdir(), 'qq-bridge-env-sensor')
if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true })
mkdirSync(tempRoot, { recursive: true })

// 大肥鱼的状态库：在导入前设好，apply 里读的就是它
const fishHome = join(tempRoot, 'fish-home')
mkdirSync(fishHome, { recursive: true })
process.env.DSH_FISH_HOME = fishHome
// qq-bridge 的设置文件（0.2.0 形态：本机文件）与 state 落在同一个临时目录
const dshHome = join(tempRoot, 'dsh-home')
mkdirSync(dshHome, { recursive: true })
process.env.DSH_HOME = dshHome
const statePath = join(dshHome, 'qq-bridge-state.json')
const settingsPath = join(dshHome, 'qq-bridge-settings.json')

// 假工作区：状态文件落在这里；采集脚本从真脚本复制一份进来，免得写脏真工作区。
const fakeWs = join(tempRoot, 'workspace')
mkdirSync(join(fakeWs, 'sensors'), { recursive: true })
mkdirSync(join(fakeWs, 'pipeline'), { recursive: true })
copyFileSync(
  join(process.cwd(), '..', '..', 'pipeline', 'update_env.js'),
  join(fakeWs, 'pipeline', 'update_env.js'),
)

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

// ── 1. parseCron：纯函数，可复现 ──────────────────────────────────────────────
{
  const at = Date.parse('2026-11-01T21:45:30+08:00')
  const fmt = (ms) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  const cases = [
    ['0 8 * * *', '2026/11/2 08:00:00'],
    ['08:00', '2026/11/2 08:00:00'], // HH:MM 简写等价
    ['*/15 * * * *', '2026/11/1 22:00:00'],
    ['47 21 1 11 *', '2026/11/1 21:47:00'], // 「两分钟后」这一档
    ['0 8 * * 1', '2026/11/2 08:00:00'], // 2026-11-02 是周一
    ['0 0 29 2 *', '2028/2/29 00:00:00'], // 闰年二月二十九
    ['0 8 * * 7', '2026/11/8 08:00:00'], // 7 = 星期天
    ['5-30/5 * * * *', '2026/11/1 22:05:00'],
  ]
  for (const [expr, want] of cases) {
    const next = parseCron(expr)?.nextFrom(at)
    check(`Cron「${expr}」下一个命中 = ${want}`, next !== null && fmt(next) === want, next === null ? 'NULL' : fmt(next))
  }
  for (const bad of ['60 * * * *', 'xyz', '', '0 8', '* * * * * *', '0 25 * * *']) {
    check(`Cron「${bad}」非法 → null`, parseCron(bad) === null)
  }
}

// ── 2. 配置贯通：默认值接力 + 设置文件覆盖 ────────────────────────────────────
// 0.2.0 形态的假 ctx：没有 settings.register/get → 设置走本机文件
const warnings = []
const capturedRoutes = []
const registered = []
let fakeAgent = null
const ctx = {
  logger: { info() {}, warn: (m) => warnings.push(String(m)) },
  settings: { configure() {} },
  agents: {
    get: (id) => (fakeAgent && fakeAgent.id === id ? fakeAgent : undefined),
    roots: () => [],
    resume: async () => { throw new Error('env-test: no agent factory') },
    withInitiator: (agent, fn) => fn(),
  },
  tools: { register: (def) => registered.push(def) },
  on: () => () => {},
  effect: () => {},
  get: () => undefined,
  inject: (_deps, cb) => cb(ctx),
  webServer: { register: (route) => { capturedRoutes.push(route); return () => {} } },
}
const config = {
  targetSessionId: 'session-env-test',
  statePath,
  debugTools: true,
  nicknames: ['244'],
  privateWakeProbability: 1,
  whitelist: ['test-user'],
  groupWhitelist: [],
  // 工作区根 = 上面的假工作区（pipeline/update_env.js 已经复制进去了）
  workspaceRoot: fakeWs,
}

function writeSettings(values) {
  writeFileSync(settingsPath, `${JSON.stringify({ version: 1, values }, null, 2)}\n`, 'utf8')
}

// 默认值（没写设置文件）：enabled=false、threshold=80
writeSettings({})
apply(ctx, config)
const settingsTool = registered.find((t) => t.name === 'qq_bridge_simulate')

{
  // 没法直接 export readSettings（它在闭包里）；用设置接口的存在性确认装配没炸。
  const route = capturedRoutes.find((r) => r.path === '/api/qq-bridge/settings')
  check('0.2.0 宿主上挂了设置接口', !!route)
}

// ── 3. 唤醒消息：任何姿势都不该出现环境反馈前缀（去提示词化的核心断言）───────
function freshStatusFile() {
  writeFileSync(join(fakeWs, 'sensors', 'status.md'), '[内存占用:72%] [机箱状态:正常] [天气:小雨 12°C]\n', 'utf8')
}

async function wakeAndCapture() {
  let injected = null
  fakeAgent = {
    id: 'session-env-test',
    status: 'idle',
    ctx: { get: () => undefined, effect: () => () => {} },
    followup: (msg) => { injected = msg },
  }
  const r = JSON.parse(await settingsTool.execute({ text: '244 在吗', userId: 'test-user' }))
  fakeAgent = null
  return { decision: r?.decision, text: String(injected?.content?.[0]?.text ?? '') }
}

// ① 开关关着（默认）+ 状态文件新鲜 → 不注入
freshStatusFile()
{
  const { text } = await wakeAndCapture()
  check('开关关着：唤醒消息不带环境反馈前缀', !text.includes('[系统环境反馈'), text.slice(0, 30))
}

// ② 开关开着 + 状态文件新鲜 → 也不注入（任务书红线①：绝对禁止强行拼接）
writeSettings({ envSensorEnabled: true, envWeatherCity: 'wuhan', envSensorTime: '*/15 * * * *', envMemoryThreshold: 80 })
{
  const { decision, text } = await wakeAndCapture()
  check('开关开着 + 状态文件新鲜：唤醒消息**仍然**不带环境前缀', decision?.delivered === true && !text.includes('[系统环境反馈'), text.slice(0, 30))
  check('开关开着：唤醒消息里也没有「可以无视」那段旧声明', !text.includes('如果你觉得毫无影响'), '')
}

// ③ 开关开着、状态文件不存在 → 不注入、也不报错
rmSync(join(fakeWs, 'sensors', 'status.md'), { force: true })
{
  const { text } = await wakeAndCapture()
  check('状态文件不存在：不注入、不报错', !text.includes('[系统环境反馈'), text.slice(0, 30))
  check('缺文件时一条 warn 都没有（诊断不进会话）', !warnings.some((w) => w.includes('环境传感器')), warnings.filter(Boolean).join(' | ').slice(0, 80))
}

// ── 4. 定时器接线：到点会真的跑采集脚本覆盖状态文件（ENV_SENSOR_TIMER=1 才跑，约 100 秒） ──
if (process.env.ENV_SENSOR_TIMER === '1') {
  // 每分钟都触发 → 最多等 100 秒。判据是「开始采集状态（定时 …）」那条日志
  // （与启动补采那条区分开），再加 status.md 真的被一行标签覆盖——整条链路
  // （Cron → spawn → 脚本 → 落盘）都过。
  const infos = []
  ctx.logger = { info: (m) => infos.push(String(m)), warn: (m) => warnings.push(String(m)) }
  writeSettings({ envSensorEnabled: true, envSensorTime: '* * * * *', envWeatherCity: 'wuhan', envMemoryThreshold: 80 })
  apply(ctx, config)
  const statusFile = join(fakeWs, 'sensors', 'status.md')
  const deadline = Date.now() + 100_000
  let saw = false
  while (Date.now() < deadline && !saw) {
    saw = infos.some((l) => l.includes('开始采集状态（定时'))
    if (!saw) await new Promise((r) => setTimeout(r, 1000))
  }
  check('Cron 到点真的跑了采集脚本（看到「开始采集状态（定时 …）」）', saw, infos.filter((l) => l.includes('环境传感器')).join(' | ').slice(0, 160))
  // 沙箱里 spawn 会被拒（脚本没起来），那条路径只断言「尝试过」；
  // 真机上才进一步断言文件真的落盘、格式真的是一行标签。
  const spawnBlocked = warnings.some((w) => w.includes('脚本没起来') || w.includes('脚本运行出错'))
  if (saw && !spawnBlocked) {
    // 采集脚本自己还要跑几秒（天气请求 / CPU 计数器）：看到日志后再给它 20 秒落盘。
    let waited = 0
    while (!existsSync(statusFile) && waited++ < 20) await new Promise((r) => setTimeout(r, 1000))
    check('status.md 被写出，且是一行标签格式', existsSync(statusFile) && /^\[内存占用:\d+%\] \[机箱状态:/.test(readFileSync(statusFile, 'utf8').trim()), existsSync(statusFile) ? readFileSync(statusFile, 'utf8').trim() : '(文件不存在)')
  } else {
    console.log(`(spawn 被环境拒绝（saw=${saw}，spawnBlocked=${spawnBlocked}），跳过文件落盘断言——真机上复验这一条)`)
  }
} else {
  console.log('(跳过定时器实跑用例：ENV_SENSOR_TIMER=1 才跑，约 100 秒)')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
