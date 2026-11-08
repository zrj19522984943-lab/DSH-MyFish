#!/usr/bin/env node
/**
 * update_env.js — 大肥鱼的「体温计」采集端（赛博感官 · 环境状态）
 *
 * 做什么：量一次「体温」——读本机内存占用 / CPU 负载，配了城市就再抓一眼外面天气
 * （Open-Meteo，免费、无需 key），拼成**一行**极简状态写到 sensors/status.md：
 *
 *   [内存占用:72%] [机箱状态:正常] [天气:小雨 12°C]
 *
 * 给谁：给大肥鱼她自己。她用 check_body 工具按需读这个文件，自己决定要不要在意、
 * 怎么说。这一端**只采集、只写文件，不再往任何提示词里注入环境**——她没问，
 * 就当这行字不存在。
 *
 * 谁在调它：qq-bridge 的定时器按 envSensorTime 每 15 分钟 spawn 一次（stdio 忽略，
 * 只看退出码）；也可以手动跑（见下面用法）。
 *
 * 配置来源（优先级从高到低）：
 *   1. 命令行：--city=wuhan --memory-threshold=80 --out=<路径> --json --dry --no-cpu
 *   2. qq-bridge 的设置文件（~/.dsh/qq-bridge-settings.json 的 values，
 *      也就是设置页写进去的 envWeatherCity / envMemoryThreshold；DSH_HOME 优先）
 *   3. 内置默认：city=''（不报天气）、memoryThreshold=80
 *
 * 用法：
 *   node pipeline/update_env.js                        # 采一次，写盘
 *   node pipeline/update_env.js --json                 # 同上，结构化结果打到 stdout（日志仍走 stderr）
 *   node pipeline/update_env.js --dry                  # 只采不写盘，预览打日志
 *   node pipeline/update_env.js --no-cpu               # 跳过 CPU 采样（Windows 计数器太慢 / 不可用时用）
 *   node pipeline/update_env.js --city=wuhan --memory-threshold=75 --out=/some/dir/sensors/status.md
 *
 * 输出契约（给读取方，务必稳定）：
 *   - 整个文件**只有一行**，行尾恰好一个 \n，没有多余空格；
 *   - [内存占用:NN%] 永远有，NN 是整数百分比；
 *   - [机箱状态:高负载|正常]：内存 >= 阈值**或** CPU >= 85% 算高负载；CPU 取不到就只看内存；
 *   - [天气:…] 只在配了城市时才出现：没配城市整个标签省略（不写空标签）；
 *     请求失败写 [天气:未知]；取到就写「短词」+ 可选温度（小雨 12°C）；
 *     温度 >= 35°C / <= -10°C 时描述换成 酷热 / 严寒，温度照样跟在后面。
 *
 * 防呆红线（把坑写在前面）：
 *   1. 写盘一律 tmp + rename：挂在中途也不会把旧文件写半行；
 *   2. 任何单项采集失败都只是「这一项不报 / 写未知」，绝不抛、绝不连累别的项——
 *      Windows 上 spawn PowerShell 可能被沙箱拒绝，这是允许的降级情形：
 *      机箱状态退回只看内存，不算出错；
 *   3. 退出码 1（采不到任何东西 / 写盘失败）时**不覆盖旧文件**，旧的体温先留着。
 *
 * 零依赖：只用 Node 内置模块，要求 Node >= 18（需要全局 fetch）。
 *
 * 退出码：0 = 文件已写（哪怕天气没取到、CPU 没取到，只要写了盘就是 0）；
 *         1 = 采不到任何东西 / 写盘失败。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ---------- 路径 ----------
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SETTINGS_PATH = path.join(DSH_HOME, 'qq-bridge-settings.json');
// 默认输出：脚本自己住在 pipeline/，写到上一级的 sensors/status.md。
const DEFAULT_OUT = path.join(__dirname, '..', 'sensors', 'status.md');

// ---------- 默认值（与设置页的默认档保持一致） ----------
const DEFAULTS = Object.freeze({
  city: '', // 空串 = 不报天气（整个 [天气:…] 标签都不要）
  memoryThreshold: 80, // 内存占用 >= 这个百分比就算「高负载」的一半
});

// ---------- 超时：后台活儿，不抢时间，但不能挂死 ----------
const GEO_TIMEOUT_MS = 15000;
const FORECAST_TIMEOUT_MS = 20000;
const WIN_CPU_TIMEOUT_MS = 20000;
// 机箱状态判定里 CPU 的固定线（与内存阈值无关，单独一根）
const CPU_HIGH_PCT = 85;

// ---------- 日志：走 stderr，把 stdout 留给 --json ----------
const log = (m) => console.error(`[update-env] ${m}`);
const warn = (m) => console.error(`[update-env][warn] ${m}`);

// ---------- 小工具（与 env_sensor.js 同一套） ----------
function stamp(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const num = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
};
function fetchJson(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { signal: ac.signal })
    .then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }))
    .catch((e) => {
      if (ac.signal.aborted) throw new Error(`请求超时（${timeoutMs}ms）`);
      throw new Error(`网络请求失败：${e?.message ?? e}`);
    })
    .finally(() => clearTimeout(timer));
}

// ---------- 配置 ----------
function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? '1' : m[2];
  }
  return out;
}

/** 设置页写进去的键；读不到文件 / 键缺失都当没配。 */
function loadSettingsFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const v = raw && typeof raw === 'object' && raw.values && typeof raw.values === 'object' ? raw.values : {};
    return {
      city: String(v.envWeatherCity ?? '').trim(),
      memoryThreshold: num(v.envMemoryThreshold, 0, 100, undefined),
    };
  } catch {
    return {}; // 没配过 / 文件坏了：回落默认值，不报错
  }
}

function resolveConfig(args) {
  const file = loadSettingsFile();
  const city = String(args['city'] ?? '').trim() || String(file.city ?? '').trim();
  const threshold =
    args['memory-threshold'] !== undefined
      ? num(args['memory-threshold'], 0, 100, DEFAULTS.memoryThreshold)
      : file.memoryThreshold !== undefined
        ? file.memoryThreshold
        : DEFAULTS.memoryThreshold;
  return {
    city,
    memoryThreshold: num(threshold, 0, 100, DEFAULTS.memoryThreshold),
    out: String(args['out'] ?? '').trim() || DEFAULT_OUT,
    json: args['json'] === '1' || args['json'] === 'true',
    dry: args['dry'] === '1' || args['dry'] === 'true',
    noCpu: args['no-cpu'] === '1' || args['no-cpu'] === 'true',
  };
}

// ---------- 天气（Open-Meteo，免费、无需 API key） ----------
// WMO weather_code → 短词。这是写给大肥鱼一眼扫的体温贴，不是天气预报，
// 所以每个 code 只留一个两三个字的词（env_sensor.js 里那种长句在这里不用）。
const WEATHER_TABLE = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  56: '冻雨', // 冻毛毛雨：词表里没有单独的词，归到「冻雨」
  57: '冻雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '冰粒',
  80: '阵雨',
  81: '阵雨',
  82: '倾盆阵雨',
  85: '小阵雪',
  86: '急阵雪',
  95: '雷阵雨',
  96: '雷暴伴冰雹',
  99: '雷暴伴冰雹',
};

/**
 * 城市配置支持三种写法：英文名（wuhan）、中文名（武汉）、「纬度,经度」（30.59,114.30）。
 * 经纬度直接用；名字走 Open-Meteo 的地理编码查第一个结果。
 * @returns {Promise<{name:string, lat:number, lon:number} | null>} 查不到返回 null，绝不抛
 */
async function resolveLocation(city) {
  const raw = String(city ?? '').trim();
  if (raw === '') return null;
  const ll = /^(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(raw);
  if (ll) {
    const lat = num(ll[1], -90, 90, null);
    const lon = num(ll[2], -180, 180, null);
    if (lat === null || lon === null) return null;
    return { name: `${lat},${lon}`, lat, lon };
  }
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(raw)}&count=1&language=zh&format=json`;
    const r = await fetchJson(url, GEO_TIMEOUT_MS);
    if (r.status !== 200 || !r.data) throw new Error(`地理编码返回 HTTP ${r.status}`);
    const hit = r.data?.results?.[0];
    if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return null;
    return {
      name: String(hit.name ?? raw),
      lat: hit.latitude,
      lon: hit.longitude,
    };
  } catch (e) {
    warn(`城市「${raw}」查不到（${e?.message ?? e}）`);
    return null;
  }
}

/**
 * 取当前位置此刻的天气。失败返回 null，绝不抛——天气取不到时内存那一半照样能写。
 * 新格式不用气压，预报里就不拉它了（少一个字段、少一次出错面）。
 * @returns {Promise<{code:number, desc:string, tempC:number|null} | null>}
 */
async function fetchWeather(loc) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&current=weather_code,temperature_2m&timezone=auto`;
    const r = await fetchJson(url, FORECAST_TIMEOUT_MS);
    if (r.status !== 200 || !r.data) throw new Error(`天气预报返回 HTTP ${r.status}`);
    const cur = r.data?.current;
    if (!cur || typeof cur !== 'object') throw new Error('预报里没有 current 字段');
    const code = num(cur.weather_code, 0, 99, -1);
    const tempC = cur.temperature_2m == null ? null : num(cur.temperature_2m, -100, 100, null);
    // WMO code 理论上全在表里，防一手表外的：算「未知」，不编一个词。
    let desc = code >= 0 ? WEATHER_TABLE[code] : null;
    if (typeof desc !== 'string') desc = null;
    // 温度极端本身就是「天气很糟」，覆盖描述词；温度照样跟在后面（酷热 38°C）。
    if (tempC !== null) {
      if (tempC >= 35) desc = '酷热';
      else if (tempC <= -10) desc = '严寒';
    }
    return { code, desc: desc ?? '未知', tempC };
  } catch (e) {
    warn(`天气取不到（${e?.message ?? e}）`);
    return null;
  }
}

// ---------- 硬件：内存（os 模块，全平台）+ CPU ----------
function readMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = total > 0 ? ((total - free) / total) * 100 : 0;
  // 状态行里 [内存占用:NN%] 是整数：这里先取整，判定高负载也用同一个整数，
  // 免得「显示 80%、判定却按 79.6%」这种前后不一。
  return { totalBytes: total, usedPct: Math.round(usedPct) };
}

/**
 * CPU 负载：POSIX 直接用 os.loadavg() 的 1 分钟平均（除以核数折成百分比）。
 * Windows 上 os.loadavg() 恒为 [0,0,0]（Node 官方文档明说的限制），退到
 * 性能计数器「\Processor(_Total)\% Processor Time」采一次（系统自带 PowerShell，零依赖）。
 * 两条路都走不通就返回 null——状态行里如实不说 CPU，机箱状态只看内存，不编一个 0%。
 * @returns {Promise<{pct:number, cores:number, source:string} | null>}
 */
function readCpu(noCpu) {
  const cores = os.cpus().length || 1;
  if (noCpu) return Promise.resolve(null);
  const la = os.loadavg();
  if (process.platform !== 'win32' && Number.isFinite(la[0]) && la[0] > 0) {
    return Promise.resolve({
      pct: Math.min(100, Math.round((la[0] / cores) * 1000) / 10),
      cores,
      source: 'loadavg',
    });
  }
  if (process.platform !== 'win32') {
    // POSIX 上 load 恰好为 0（机器闲着）是真实数据，不是取不到——照实报 0。
    return Promise.resolve({ pct: 0, cores, source: 'loadavg' });
  }
  return readWindowsCpuPct().then((pct) =>
    pct === null ? null : { pct: Math.round(pct * 10) / 10, cores, source: 'counter' },
  );
}

function readWindowsCpuPct() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { ps.kill() } catch { /* 已经退出了 */ }
      resolve(v);
    };
    let out = '';
    let ps;
    try {
      // EPERM 之类的同步抛出也得接住（受限环境里 spawn 本身就会被拒），
      // 采样失败只是「机箱状态少一个判据」，不能让整个脚本挂掉。
      ps = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          "(Get-Counter '\\Processor(_Total)\\% Processor Time' -ErrorAction Stop).CounterSamples.CookedValue"],
        { windowsHide: true },
      );
    } catch {
      return resolve(null);
    }
    ps.stdout.on('data', (d) => { out += String(d) });
    ps.stderr.on('data', () => {}); // 不把 PowerShell 的红字混进我们的日志
    ps.on('error', () => finish(null));
    ps.on('close', (code) => {
      const n = parseFloat(String(out).trim());
      finish(code === 0 && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null);
    });
    setTimeout(() => finish(null), WIN_CPU_TIMEOUT_MS).unref?.();
  });
}

// ---------- 状态行（体温贴本体） ----------
/**
 * 拼成一行：[内存占用:NN%] [机箱状态:…] [天气:…]
 * - 天气标签只在配了城市时才挂上去；没配城市整个省略，不写空标签。
 * - CPU 取不到（Windows 计数器被拒 / --no-cpu）时机箱状态只看内存。
 */
function buildStatusLine({ memory, cpu, threshold, weather, hasCity }) {
  const tags = [`[内存占用:${memory.usedPct}%]`];

  const memHigh = memory.usedPct >= threshold;
  const cpuHigh = cpu !== null && cpu.pct >= CPU_HIGH_PCT;
  tags.push(`[机箱状态:${memHigh || cpuHigh ? '高负载' : '正常'}]`);

  if (hasCity) {
    if (!weather) {
      tags.push('[天气:未知]');
    } else {
      let s = weather.desc;
      if (weather.tempC !== null) s += ` ${Math.round(weather.tempC)}°C`;
      tags.push(`[天气:${s}]`);
    }
  }

  return tags.join(' ');
}

// ---------- 写盘 ----------
/** 单行文件：tmp + rename，中途挂了也不会把旧文件写半行。 */
function writeStatus(outPath, line) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, `${line}\n`, 'utf8'); // 行尾恰好一个 \n
  fs.renameSync(tmp, outPath);
}

// ---------- 主流程 ----------
async function main() {
  const cfg = resolveConfig(parseArgs());
  log(`==== 开始采集（${stamp()}）====`);
  log(`配置：城市=${cfg.city || '（未配置，不报天气）'}，内存阈值=${cfg.memoryThreshold}%${cfg.noCpu ? '，跳过 CPU' : ''}`);

  // 内存是「永远都要有」的那一半——它要是都读不到，就是「采不到任何东西」，直接认输，不动旧文件。
  let memory;
  try {
    memory = readMemory();
  } catch (e) {
    warn(`内存读不到（${e?.message ?? e}），没东西可写`);
    return 1;
  }

  const cpu = await readCpu(cfg.noCpu);
  if (cpu === null && !cfg.noCpu) warn('CPU 负载取不到（Windows 计数器不可用 / 被沙箱拒绝），机箱状态只看内存');

  const loc = cfg.city ? await resolveLocation(cfg.city) : null;
  const weather = loc ? await fetchWeather(loc) : null;
  if (cfg.city && !weather) warn('天气抓取失败，状态行里写 [天气:未知]');

  const line = buildStatusLine({
    memory,
    cpu,
    threshold: cfg.memoryThreshold,
    weather,
    hasCity: cfg.city !== '',
  });

  const payload = {
    version: 1,
    at: stamp(),
    atMs: Date.now(),
    place: loc ? loc.name : null,
    line,
    weather: weather ? { code: weather.code, desc: weather.desc, tempC: weather.tempC } : null,
    hardware: {
      memoryUsedPct: memory.usedPct,
      memoryTotalBytes: memory.totalBytes,
      cpuPct: cpu === null ? null : cpu.pct,
      cpuCores: cpu === null ? null : cpu.cores,
      cpuSource: cpu === null ? null : cpu.source,
    },
    config: {
      city: cfg.city,
      memoryThreshold: cfg.memoryThreshold,
    },
  };

  if (cfg.dry) {
    log('--dry：只采不写。状态行预览：');
    log(line);
  } else {
    try {
      writeStatus(cfg.out, line);
    } catch (e) {
      warn(`写盘失败（${e?.message ?? e}），旧文件不动`);
      return 1;
    }
    log(`已写入 ${cfg.out}`);
    log(`状态行：${line}`);
  }
  if (cfg.json) console.log(JSON.stringify(payload, null, 2));
  return 0;
}

main()
  .then((code) => process.exit(code === undefined ? 0 : code))
  .catch((e) => {
    console.error('[update-env][FATAL]', e?.message ?? e);
    process.exit(1);
  });
