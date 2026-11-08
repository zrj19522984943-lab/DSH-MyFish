#!/usr/bin/env node
/**
 * update_rhythm.js — 大肥鱼的「心跳触觉」采集端
 *
 * 做什么：每运行一次，采一次「距离上一次键盘/鼠标输入过了多少毫秒」（用户空闲时长），
 * 把 {"t":<epoch毫秒>,"idleMs":<n>} 追加到 <raw>/<YYYY-MM-DD>.jsonl，再把当天所有
 * 样本按本地小时聚合成一句话，原子写到 <out>。
 *
 * 为什么按小时聚合、采样却频繁得多：fish 插件会每 5 分钟左右 spawn 本脚本一次，
 * 一个小时能积累约 12 个样本。一个小时只采一次是分不出「高频打字」和「间歇操作」的
 * ——比如整点采样恰好那一秒人在发呆，整个小时就错判成「无操作」；样本多了，
 * 「12 次里有 10 次在两分钟内动过」才是「高频打字」该有的样子。
 *
 * 数据给谁：这是给大肥鱼自己的「赛博感官」——她用 read_user_rhythm 工具按需读
 * <out>（以及背后的原始采样文件），系统**不往任何提示词里注入**这些数据，
 * 她想知道的时候自己伸手拿，不想知道就当它不存在。
 *
 * 采样路（两条，失败都不抛、一律降级，本轮跳过采样但流程继续）：
 *   - Windows：spawn powershell -NoProfile -NonInteractive -Command，内联一段 C#
 *     用 GetLastInputInfo + Environment.TickCount 算出空闲毫秒（系统自带，零依赖）；
 *   - POSIX：spawn xprintidle（输出单位毫秒），命令不存在（ENOENT）就是没有这条路。
 *
 * 清理：<raw> 里 mtime 超过 2 天的日期文件（<YYYY-MM-DD>.jsonl）删掉，删不掉不报错。
 *
 * 用法：
 *   node pipeline/update_rhythm.js                          # 用默认路径采一次、写一次
 *   node pipeline/update_rhythm.js --out=<路径> --raw=<目录> # 自定义输出文件 / 原始采样目录
 *   node pipeline/update_rhythm.js --json                   # 结构化结果打 stdout（日志走 stderr）
 *
 * 退出码：0 = 正常（即使本次采样失败、只写了「今天还没采到节奏」也是 0）；
 *         1 = 写盘失败这类致命错（聚合结果写不进 <out>）。
 *         采样失败或追加采样失败都只算降级：聚合照常、退出码照常 0。
 *
 * 零依赖：只用 Node 内置模块，要求 Node >= 18。CommonJS。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------- 路径（默认相对脚本目录：../sensors/... ） ----------
const SCRIPT_DIR = __dirname;
const DEFAULT_OUT = path.join(SCRIPT_DIR, '..', 'sensors', 'user_rhythm.md');
const DEFAULT_RAW_DIR = path.join(SCRIPT_DIR, '..', 'sensors', '.rhythm');

// ---------- 常量 ----------
const ACTIVE_THRESHOLD_MS = 120000; // idleMs < 2 分钟 → 这一样本算「活跃」
const SAMPLE_TIMEOUT_MS = 10000;    // 单次采样（含 PowerShell 现编译 C#）最多等 10 秒
const RAW_RETAIN_DAYS = 2;          // 原始采样文件按 mtime 保留的天数

// Windows 那条路：C# 代码整体包在 PowerShell 单引号串里（串内没有单引号，无需转义）。
const PS_IDLE_COMMAND =
  `Add-Type -Language CSharp -TypeDefinition ` +
  `'using System;using System.Runtime.InteropServices;public class IdleT{` +
  `[StructLayout(LayoutKind.Sequential)]public struct LASTINPUTINFO{public uint cbSize;public uint dwTime;}` +
  `[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);` +
  `public static uint IdleMs(){LASTINPUTINFO li=new LASTINPUTINFO();` +
  `li.cbSize=(uint)Marshal.SizeOf(typeof(LASTINPUTINFO));if(!GetLastInputInfo(ref li))return 0;` +
  `return (uint)Environment.TickCount-li.dwTime;}}'; [IdleT]::IdleMs()`;

// ---------- 日志：走 stderr，把 stdout 留给 --json ----------
const log = (m) => console.error(`[rhythm] ${m}`);
const warn = (m) => console.error(`[rhythm][warn] ${m}`);

// ---------- 小工具 ----------
function stamp(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function dayKey(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 参数 ----------
function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? '1' : m[2];
  }
  return out;
}
function resolveConfig(args) {
  return {
    out: String(args['out'] ?? '').trim() || DEFAULT_OUT,
    raw: String(args['raw'] ?? '').trim() || DEFAULT_RAW_DIR,
    json: args['json'] === '1' || args['json'] === 'true',
  };
}

// ---------- 采样：spawn 一个子进程、捕 stdout、解析成整数毫秒 ----------
/**
 * 照 env_sensor.js 的 readWindowsCpuPct 那样包 Promise：stdout 攒字符串、
 * error/close 事件都接、超时强杀、spawn 同步抛也接住；失败一律返回 {value:null, reason}。
 * @returns {Promise<{value:number|null, reason:string|null}>}
 */
function runCaptured(file, args) {
  return new Promise((resolve) => {
    let done = false;
    let out = '';
    let child;
    const finish = (v, reason) => {
      if (done) return;
      done = true;
      try { child && child.kill(); } catch { /* 已经退出了 */ }
      resolve({ value: v, reason: reason ?? null });
    };
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ value: null, reason: `spawn 同步抛：${e?.message ?? e}` });
    }
    child.stdout.on('data', (d) => { out += String(d) });
    child.stderr.on('data', () => {}); // 不把子进程的红字混进我们的日志
    child.on('error', (e) => finish(null, `spawn 失败：${e?.code || e?.message || e}`));
    child.on('close', (code) => {
      const n = parseInt(String(out).trim(), 10); // trim() 顺带吃掉首尾空白和 BOM
      if (code === 0 && Number.isFinite(n) && n >= 0) return finish(n);
      finish(null, code === 0 ? 'stdout 里解析不出非负整数' : `退出码 ${code}`);
    });
    setTimeout(() => finish(null, `超时（${SAMPLE_TIMEOUT_MS}ms）`), SAMPLE_TIMEOUT_MS).unref?.();
  });
}

/**
 * 采一次当前用户空闲时长（ms）。Windows 走 PowerShell 内联 C#，POSIX 走 xprintidle。
 * @returns {Promise<{t:number, idleMs:number|null, source:string, error:string|null}>}
 */
async function sampleIdle() {
  const t = Date.now();
  if (process.platform === 'win32') {
    const r = await runCaptured('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_IDLE_COMMAND]);
    return { t, idleMs: r.value, source: 'powershell', error: r.reason };
  }
  const r = await runCaptured('xprintidle', []); // 命令不存在 → 'error' 事件 ENOENT → null
  return { t, idleMs: r.value, source: 'xprintidle', error: r.reason };
}

// ---------- 原始采样 ----------
/** 追加一行 {"t","idleMs"} 到 <rawDir>/<dateStr>.jsonl；抛了由调用方接。 */
function appendSample(rawDir, dateStr, t, idleMs) {
  fs.mkdirSync(rawDir, { recursive: true });
  const file = path.join(rawDir, `${dateStr}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ t, idleMs })}\n`, 'utf8');
  return file;
}

// ---------- 聚合：按本地小时分桶 ----------
function labelForRatio(r) {
  if (r >= 0.8) return '高频打字';
  if (r >= 0.3) return '间歇操作';
  if (r > 0) return '少量操作';
  return '无操作';
}
/**
 * 读 <rawDir>/<dateStr>.jsonl，按样本的本地小时分组算 active 比例。
 * 坏行 / 字段缺失 / 日期对不上的残渣一律跳过，不抛。
 * @returns {{hours: Array<{hour:number, range:string, total:number, active:number, ratio:number, label:string}>, rawFile:string}}
 */
function aggregateDay(rawDir, dateStr) {
  const rawFile = path.join(rawDir, `${dateStr}.jsonl`);
  const buckets = new Map(); // hour -> {total, active}
  let lines = [];
  try {
    lines = fs.readFileSync(rawFile, 'utf8').split(/\r?\n/);
  } catch {
    return { hours: [], rawFile }; // 今天还没有 raw 文件：正常，不是错
  }
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      continue; // 脏行：跳过
    }
    const t = Number(rec?.t);
    const idleMs = Number(rec?.idleMs);
    if (!Number.isFinite(t) || !Number.isFinite(idleMs)) continue;
    const d = new Date(t);
    if (Number.isNaN(d.getTime()) || dayKey(d) !== dateStr) continue; // 不是这一天的样本
    const h = d.getHours();
    const b = buckets.get(h) ?? { total: 0, active: 0 };
    b.total += 1;
    if (idleMs < ACTIVE_THRESHOLD_MS) b.active += 1;
    buckets.set(h, b);
  }
  const hours = [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((h) => {
      const b = buckets.get(h);
      const ratio = b.total > 0 ? b.active / b.total : 0;
      const from = String(h).padStart(2, '0');
      const to = String((h + 1) % 24).padStart(2, '0'); // 23 点的下一档是 00
      return {
        hour: h,
        range: `${from}:00-${to}:00`,
        total: b.total,
        active: b.active,
        ratio: Math.round(ratio * 10000) / 10000,
        label: labelForRatio(ratio),
      };
    });
  return { hours, rawFile };
}

// ---------- 写盘 / 清理 ----------
/** 原子写：tmp + rename。抛了由调用方接（这算致命错）。 */
function writeOut(outPath, text) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, `${text}\n`, 'utf8');
  fs.renameSync(tmp, outPath);
}

/** 删 rawDir 里 mtime 超过 RAW_RETAIN_DAYS 天的日期文件，删不掉不报错。返回删掉了几个。 */
function pruneRaw(rawDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(rawDir);
  } catch {
    return 0; // 目录都没有：没事
  }
  const cutoff = Date.now() - RAW_RETAIN_DAYS * 86400000;
  let pruned = 0;
  for (const f of entries) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue; // 只动日期文件
    const p = path.join(rawDir, f);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(p);
        pruned += 1;
        log(`清理过期采样文件 ${f}（mtime 超过 ${RAW_RETAIN_DAYS} 天）`);
      }
    } catch {
      // stat / 删除失败：跳过，不报错
    }
  }
  return pruned;
}

// ---------- 主流程 ----------
async function main() {
  const cfg = resolveConfig(parseArgs());
  const nowMs = Date.now();
  const dateStr = dayKey(new Date(nowMs));
  log(`==== 心跳触觉采样（${stamp(new Date(nowMs))}）====`);
  log(`平台=${process.platform}，raw=${cfg.raw}，out=${cfg.out}`);

  // raw 目录先建出来：即便本轮采不到样本，目录也得在（清理、后续追加都认它）
  try {
    fs.mkdirSync(cfg.raw, { recursive: true });
  } catch (e) {
    warn(`raw 目录建不起来（${e?.message ?? e}），采样记录会写不进去`);
  }

  // 1+2. 采样并追加；采不到就跳过采样记录，流程继续
  const sample = await sampleIdle();
  if (sample.idleMs === null) {
    warn(`空闲时长采不到（${sample.source}：${sample.error ?? '未知原因'}），本轮不写采样记录，聚合照常`);
  } else {
    try {
      const f = appendSample(cfg.raw, dateStr, sample.t, sample.idleMs);
      log(`采样 idleMs=${sample.idleMs}（${sample.source}）→ ${f}`);
    } catch (e) {
      warn(`追加采样失败（${e?.message ?? e}），继续聚合`);
    }
  }

  // 3. 聚合当天
  const agg = aggregateDay(cfg.raw, dateStr);
  const text = agg.hours.length > 0
    ? agg.hours.map((h) => `${h.range} ${h.label}`).join('; ')
    : '（今天还没采到节奏）';
  log(`今天 ${agg.hours.length} 个小时有样本：${text}`);

  // 4. 写 <out>（致命）
  try {
    writeOut(cfg.out, text);
  } catch (e) {
    console.error(`[rhythm][FATAL] 写 ${cfg.out} 失败：${e?.message ?? e}`);
    return 1;
  }
  log(`已写入 ${cfg.out}`);

  // 5. 清理过期 raw
  const prunedFiles = pruneRaw(cfg.raw);

  if (cfg.json) {
    console.log(
      JSON.stringify(
        {
          version: 1,
          at: stamp(new Date(nowMs)),
          atMs: nowMs,
          date: dateStr,
          platform: process.platform,
          sample: sample.idleMs === null ? null : { t: sample.t, idleMs: sample.idleMs, source: sample.source },
          sampleError: sample.idleMs === null ? { source: sample.source, reason: sample.error } : null,
          rawFile: agg.rawFile,
          hours: agg.hours,
          text,
          prunedFiles,
          out: cfg.out,
        },
        null,
        2,
      ),
    );
  }
  return 0;
}

main()
  .then((code) => process.exit(code === undefined ? 0 : code))
  .catch((e) => {
    console.error('[rhythm][FATAL]', e?.message ?? e);
    process.exit(1);
  });
