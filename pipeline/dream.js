#!/usr/bin/env node
/**
 * dream.js — 梦境碎片生成器（大肥鱼夜间打工流水线的最后一个小挂件，2026-11-02 赛博感官任务书模块 4）
 *
 * 做什么：抽三个元素——昨天她在 B 站刷过的任意一个词、当日天气、一个 1-9999 的随机数——
 * 交给打工模型（OpenAI 兼容 /v1/chat/completions，配置同 fetch_news.js 的 newsPipeline.model），
 * 写一句 50 字以内、毫无逻辑、跳跃得像真梦一样的「梦境碎片」到 <工作区>/dreams/tonight.md，
 * 文件里只有那一句。她下次组装提示词时只会看到一句「梦的碎片在 dreams/tonight.md」，
 * 想看自己去看，不想看就当没这回事——提示不携带内容，内容只在读文件的那一瞬间进上下文。
 *
 * 流程：
 *   1. 取配置：model = newsPipeline.model（endpoint / model / apiKeyEnv），API key 从
 *      model.apiKeyEnv 指定的环境变量读。拿不到 key → WARN「没配打工模型的 key，梦境跳过」
 *      并退出 0，不写任何文件（与 fetch_news.js 摘要步骤的降级口径一致：没 key 就优雅跳过）。
 *   2. 凑三个元素：
 *      - 词：读 <DSH_FISH_HOME>/events.jsonl（环境变量优先，默认 ~/.dsh-fish），
 *        找 meta 事件里 text 以 `browse:<昨天 YYYY-MM-DD>` 开头的行，把日期标记后面的
 *        JSON 数组解析出来，随机挑一条，从 title / up 里用 /[一-龥A-Za-z0-9]{2,}/g
 *        切出候选词随机取一个；昨天没有浏览记录 → 用内置的怪东西兜底列表
 *        （空转的电梯 / 没关的台灯 / 翻面的硬币 / 没信号的电视），并写一行日志说明用了兜底。
 *      - 天气：读 <工作区>/sensors/status.md 里的 `[天气:...]` 标签；文件不存在 /
 *        没有天气标签 → 「天气未知」。
 *      - 数字：1 到 9999 的随机整数。
 *   3. 调打工模型：中文 prompt，要求用这三个元素造一句 50 字以内、毫无逻辑、
 *      跳跃得像真梦一样的碎片，只输出那一句（不要引号、不要解释、不要标题）。
 *      解析 choices[0].message.content，trim，取第一个非空行，去掉首尾引号；
 *      空 / 超过 100 字 → WARN 跳过不写（宁可没有梦，也不要一坨坏的）。
 *   4. 写盘：--out 默认 = 脚本所在目录的 ../dreams/tonight.md，mkdir 递归 + 原子写
 *      （先写 .tmp 再 rename），内容只有那一句（一行 + 一个换行）。
 *      每晚覆盖；提示侧按 mtime 判断「新的一段梦」（fish/lib/dream.js）。
 *
 * 参数：--word= --weather= --number= --out= --json；命令行传的元素直接覆盖自动采集的，方便测试。
 * --json 时 stdout 只输出一行 JSON 结果；日志进 rss/pipeline.log（与 fetch_news 同一份）。
 *
 * 另外导出 runDreamStep({ config, log }) 供 fetch_news.js 在流水线末尾调用：
 * config 是已加载好的那份 config.json，log 是 log(level, msg)。每次调用重新取元素、
 * 重新请求；返回 { ok: true, text } | { ok: false, reason }，永不抛。
 *
 * 零依赖：只用 Node 内置模块，要求 Node >= 18（需要全局 fetch）。
 *
 * 用法：
 *   node pipeline/dream.js                 # 自动取元素（报表在 rss/pipeline.log）
 *   node pipeline/dream.js --json          # 结果另以一行 JSON 打到 stdout
 *   node pipeline/dream.js --word=电梯 --weather=暴雨 --number=42
 *   node pipeline/dream.js --out=/tmp/tonight.md --json
 * 退出码：0 = 正常（含「没配 key 跳过」这一已处理情形），1 = 致命错误。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 路径 ----------
const WORK_ROOT = path.resolve(__dirname, '..');                 // 工作区根（与 fetch_news.js 同一个）
const DREAMS_DIR_DEF = path.join(WORK_ROOT, 'dreams');
const STATUS_FILE_DEF = path.join(WORK_ROOT, 'sensors', 'status.md');
const FISH_HOME = (process.env.DSH_FISH_HOME || '').trim() || path.join(os.homedir(), '.dsh-fish');
const EVENTS_PATH = path.join(FISH_HOME, 'events.jsonl');
const CONFIG_PATH = path.join(FISH_HOME, 'config.json');
const LOG_PATH = path.join(WORK_ROOT, 'rss', 'pipeline.log');    // 与 fetch_news.js 同一份日志

// ---------- 常量 ----------
const DEFAULT_MODEL = {
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  model: 'deepseek-chat',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
};
const REQUEST_TIMEOUT_MS = 90000;
const MAX_FRAGMENT_CHARS = 100;   // 模型返回的兜底上限（prompt 要 50 字，留一倍容差）
// 昨天没有浏览记录时的兜底词（都是些梦里才会出现的东西）
const FALLBACK_WORDS = ['空转的电梯', '没关的台灯', '翻面的硬币', '没信号的电视', '排队的椅子', '褪色的站牌'];
// 解析「词」的正则：中文 / 英文 / 数字，2 个字符起
const TOKEN_RE = /[一-龥A-Za-z0-9]{2,}/g;

// ---------- 小工具 ----------
function stamp(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** 写日志：控制台 + rss/pipeline.log（写不进去也不崩）。独立跑时与 fetch_news 写同一份。 */
function log(level, msg) {
  const line = `[${stamp()}] [${level}] [dream] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) { /* ignore */ }
}
const info = (m) => log('INFO', m);
const warn = (m) => log('WARN', m);

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = /^--([a-zA-Z0-9_-]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function pickRandom(arr) {
  return arr.length === 0 ? '' : arr[Math.floor(Math.random() * arr.length)];
}

// ---------- 元素 1：昨天她看过的词 ----------
/**
 * 从 events.jsonl 里找昨天（本地日期）的 browse:<dk> 记账，随机取一个词。
 * meta 形状（fish/lib/browse.js 里定的，这里只读不写）：
 *   { type: 'meta', text: 'browse:2026-10-22 [{"bvid":"…","title":"…","up":"…",…}]' }
 * 找不到 / 解析失败 → 兜底词（并写一行日志说明）。
 */
function wordFromYesterday() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dk = fmtDate(yesterday);
  let lines = [];
  try {
    lines = fs.readFileSync(EVENTS_PATH, 'utf8').split(/\r?\n/);
  } catch (e) {
    warn(`读事件流失败（${EVENTS_PATH}）：${e.message} → 用兜底词`);
    return { word: pickRandom(FALLBACK_WORDS), fallback: true };
  }
  const prefix = `browse:${dk} `;
  const tokens = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith(prefix)) continue;
    const json = t.slice(prefix.length).trim();
    let arr;
    try { arr = JSON.parse(json); } catch (_) { continue; }
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      // title / up 里切词；每条只取一个候选，避免长标题垄断
      const src = `${String(item?.title ?? '')} ${String(item?.up ?? '')}`;
      const cands = src.match(TOKEN_RE);
      if (cands && cands.length > 0) tokens.push(cands[Math.floor(Math.random() * cands.length)]);
    }
    if (tokens.length > 0) break; // 只用昨天第一笔记账（一笔就是一次刷站）
  }
  if (tokens.length === 0) {
    warn(`昨天（${dk}）没有浏览记录，梦境用了兜底词`);
    return { word: pickRandom(FALLBACK_WORDS), fallback: true };
  }
  return { word: pickRandom(tokens), fallback: false };
}

// ---------- 元素 2：今天天气 ----------
/** 从 sensors/status.md 的 `[天气:…]` 标签里取天气；没有文件 / 没标签 → 「天气未知」。 */
function weatherFromStatus(statusFile) {
  let text = '';
  try {
    text = fs.readFileSync(statusFile, 'utf8');
  } catch (_) {
    warn(`状态文件读不到（${statusFile}）→ 天气未知`);
    return '天气未知';
  }
  const m = /\[天气:([^\]]*)\]/.exec(text);
  if (!m) {
    warn('状态文件里没有天气标签（可能没配城市）→ 天气未知');
    return '天气未知';
  }
  return m[1].trim() || '天气未知';
}

// ---------- 元素 3：随机数 ----------
function randomNumber() {
  return String(1 + Math.floor(Math.random() * 9999));
}

// ---------- 调打工模型 ----------
/**
 * 让模型用三个元素造一句梦。请求带超时；http 错误 / 解析失败 / 内容为空或超长
 * 都返回 null（调用方跳过不写）。
 * @param {{endpoint:string, model:string, apiKeyEnv:string}} mc
 * @param {string} apiKey
 * @param {{word:string, weather:string, number:string}} els
 */
async function generateFragment(mc, apiKey, els) {
  const prompt =
    `你是一个梦境发生器。用下面三个元素造一句梦的碎片：要求 50 字以内、毫无逻辑、` +
    `跳跃得像真的梦一样，不要起承转合，不要解释。只输出那一句，不要引号、不要标题、不要任何说明。\n` +
    `元素一：${els.word}\n元素二：${els.weather}\n元素三：数字 ${els.number}`;
  let res;
  try {
    res = await fetch(`${mc.endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: mc.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 1.2, // 梦要的是发散，不是稳妥
        max_tokens: 120,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    warn(`打工模型请求失败：${e.message}`);
    return null;
  }
  if (!res.ok) {
    warn(`打工模型返回 HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 120)}`);
    return null;
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    warn(`打工模型返回不是 JSON：${e.message}`);
    return null;
  }
  const raw = String(data?.choices?.[0]?.message?.content ?? '').trim();
  // 取第一个非空行，去首尾引号（模型偶尔会顺手加引号）
  const firstLine = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  const cleaned = firstLine.replace(/^["“”'']+|["“”'']+$/g, '').trim();
  if (cleaned === '') {
    warn('打工模型返回是空的，跳过今晚的梦');
    return null;
  }
  if (cleaned.length > MAX_FRAGMENT_CHARS) {
    warn(`碎片太长（${cleaned.length} 字 > ${MAX_FRAGMENT_CHARS}），跳过今晚的梦：${cleaned.slice(0, 40)}…`);
    return null;
  }
  return cleaned;
}

// ---------- 主步骤 ----------
/**
 * 生成并落盘一句梦境碎片。
 * @param {object} opts { config, log, word?, weather?, number?, out? } 命令行覆盖项优先
 * @returns {Promise<{ok:true, text:string, out:string} | {ok:false, reason:string}>}
 */
async function runDreamStep(opts = {}) {
  const cl = parseArgs(process.argv);
  const cfg = opts.config || null;
  const logFn = typeof opts.log === 'function' ? opts.log : null;
  // 独立跑时从命令行 / 配置文件取元素；流水线调时元素也可由调用方直接塞
  const fixedWord = opts.word !== undefined ? opts.word : cl.word;
  const fixedWeather = opts.weather !== undefined ? opts.weather : cl.weather;
  const fixedNumber = opts.number !== undefined ? opts.number : cl.number;
  const outFile = opts.out !== undefined ? opts.out : (cl.out || path.join(DREAMS_DIR_DEF, 'tonight.md'));

  // 模型配置：调用方给的 config > 配置文件 > 默认
  let mc = Object.assign({}, DEFAULT_MODEL);
  let cfgSource = '';
  if (cfg?.newsPipeline?.model) {
    mc = Object.assign({}, DEFAULT_MODEL, cfg.newsPipeline.model);
    cfgSource = '（config 参数）';
  } else {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.newsPipeline?.model) {
        mc = Object.assign({}, DEFAULT_MODEL, parsed.newsPipeline.model);
        cfgSource = '（配置文件）';
      }
    } catch (e) {
      cfgSource = `（配置文件读不到：${e.message} → 用默认）`;
    }
  }
  const apiKey = (process.env[mc.apiKeyEnv] || '').trim();
  if (!apiKey) {
    const reason = `没配打工模型的 key（环境变量 ${mc.apiKeyEnv} 为空）→ 梦境步骤跳过`;
    warn(reason);
    logFn?.('WARN', reason);
    return { ok: false, reason: 'no-key' };
  }

  // 凑元素
  const w = fixedWord !== undefined && String(fixedWord).trim() !== ''
    ? String(fixedWord).trim()
    : wordFromYesterday().word;
  const weather = fixedWeather !== undefined && String(fixedWeather).trim() !== ''
    ? String(fixedWeather).trim()
    : weatherFromStatus(path.join(WORK_ROOT, 'sensors', 'status.md'));
  const number = fixedNumber !== undefined && String(fixedNumber).trim() !== ''
    ? String(fixedNumber).trim()
    : randomNumber();
  info(`梦境元素：词=「${w}」 天气=「${weather}」 数字=${number}${cfgSource ? ' ' + cfgSource : ''}`);

  const text = await generateFragment(mc, apiKey, { word: w, weather, number });
  if (text === null) return { ok: false, reason: 'generate-failed' };

  // 落盘（先建目录，tmp + rename 原子写）
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp`;
  fs.writeFileSync(tmp, `${text}\n`, 'utf8');
  fs.renameSync(tmp, outFile);
  info(`梦境碎片已写入 ${outFile}：${text}`);
  logFn?.('INFO', `梦境碎片：${text}`);
  return { ok: true, text, out: outFile };
}

// ---------- 独立入口 ----------
async function main() {
  const cl = parseArgs(process.argv);
  const r = await runDreamStep({});
  if (cl.json) console.log(JSON.stringify(r));
  if (!r.ok && r.reason !== 'no-key' && r.reason !== 'generate-failed') return 1;
  // no-key / generate-failed 都是「已处理的跳过」，正常退出（与 fetch_news 的口径一致）
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code === undefined ? 0 : code))
    .catch((e) => {
      console.error('[FATAL]', e.message);
      process.exit(1);
    });
}

module.exports = { runDreamStep };
