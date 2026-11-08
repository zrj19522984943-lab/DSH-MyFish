#!/usr/bin/env node
/**
 * fetch_news.js — 资讯流水线（RSS 抓取 → 打工模型摘要 → 归档）
 *
 * 流程：
 *   1. 读 ~/.dsh-fish/config.json 的 rssFeeds（数组）与 newsPipeline（模型接口与参数）
 *   2. 每个源抓最新 N 条，每篇把 标题 / 原文链接 / 正文文本 各存一个文件到 rss/raw/
 *   3. 逐篇调打工模型（OpenAI 兼容 chat/completions）：50 字干货摘要 + 五选一标签
 *   4. 结果写到 rss/summary/，文件名「[标签] 标题.md」，正文 = 摘要 + 原文链接
 *   5. 把 raw 归档（移动）到 rss/archive/<日期>/
 *   6. 写触发文件 rss/DONE-<日期>.txt
 *   7. 梦境碎片（2026-11-02）：调 ./dream.js 用「昨天的词 + 今天天气 + 随机数」
 *      生成一句 ≤50 字的梦到 <工作区>/dreams/tonight.md；没配 key / 失败都只跳过，
 *      在 DONE 里记一行 dream: …，不拖垮整轮。
 *
 * 每一步都写日志到 rss/pipeline.log（控制台同步输出）。
 * 单源失败 / 单篇摘要失败都不会拖垮整轮；请求带超时，抓取与调用之间有限流。
 *
 * 零依赖：只用 Node 内置模块，要求 Node >= 18（需要全局 fetch）。
 *
 * 用法：node pipeline/fetch_news.js
 * 退出码：0 = 正常（含「rssFeeds 为空跳过」「没配 key 跳过摘要」这两种已处理情形），1 = 致命错误。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------- 路径 ----------
const WORK_ROOT = path.resolve(__dirname, '..');          // D:\demo\workspace
const RSS_DIR = path.join(WORK_ROOT, 'rss');
const RAW_DIR = path.join(RSS_DIR, 'raw');
const SUMMARY_DIR = path.join(RSS_DIR, 'summary');
const ARCHIVE_DIR = path.join(RSS_DIR, 'archive');
const LOG_PATH = path.join(RSS_DIR, 'pipeline.log');
const CONFIG_PATH = path.join(os.homedir(), '.dsh-fish', 'config.json');

// ---------- 常量 ----------
const TAGS = ['技术', '政策', '数据', '水会', '广告'];
const MAX_SUMMARY_CHARS = 50;      // 摘要上限（配置里 prompt 的约定）
const MAX_BODY_CHARS = 4000;       // 喂给模型的正文截断
const MAX_RAW_BODY_CHARS = 50000;  // 落盘 raw 的正文截断
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 DSHNewsPipeline/1.0';

const DEFAULTS = {
  maxItemsPerFeed: 15,      // 每源取最新条数（10-20 之间为宜）
  feedTimeoutMs: 30000,     // 抓源超时
  modelTimeoutMs: 90000,    // 模型调用超时
  interFeedDelayMs: 2000,   // 两个源之间的间隔（限流）
  interItemDelayMs: 1500,   // 两篇模型调用之间的间隔（限流）
  archiveMaxDays: 0,        // 归档保留天数，0 = 永不删旧归档
  model: {
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',   // 读 API key 的环境变量名
  },
};

// ---------- 小工具 ----------
function stamp(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function today() { return stamp().slice(0, 10); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 限流间隔加 ±30% 抖动，别像机器人
const jitter = (ms) => Math.round(ms * (0.7 + Math.random() * 0.6));

function log(level, msg) {
  const line = `[${stamp()}] [${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) { /* 日志写不进去也不能崩 */ }
}
const info = (m) => log('INFO', m);
const warn = (m) => log('WARN', m);
const errorLog = (m) => log('ERROR', m);

function ensureDirs() {
  for (const d of [RSS_DIR, RAW_DIR, SUMMARY_DIR, ARCHIVE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ---------- XML 解析（够用的 RSS 2.0 / Atom 子集解析器） ----------
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, g) => { try { return String.fromCodePoint(parseInt(g, 16)); } catch (_) { return ''; } })
    .replace(/&#(\d+);/g, (m, g) => { try { return String.fromCodePoint(parseInt(g, 10)); } catch (_) { return ''; } })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // 最后解 &，避免二次解码
}

// 取 <tag ...>...</tag> 的内容（支持 CDATA），取不到返回 null
function extractTag(xml, tag) {
  const re = new RegExp('<' + tag + '(\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'i');
  const m = re.exec(xml);
  if (!m) return null;
  let v = m[2];
  const t = v.trim();
  if (t.startsWith('<![CDATA[') && t.endsWith(']]>')) v = t.slice(9, -3);
  return decodeEntities(v).trim();
}
// 取自闭合标签的属性，如 Atom 的 <link href="..."/>
function extractAttr(xml, tag, attr) {
  const re = new RegExp('<' + tag + '\\b[^>]*\\b' + attr + '="([^"]*)"', 'i');
  const m = re.exec(xml);
  return m ? decodeEntities(m[1]).trim() : null;
}

function parseFeed(xml) {
  let blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item\s*>/gi)].map((m) => m[0]);
  let format = 'rss2';
  if (blocks.length === 0) {
    blocks = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry\s*>/gi)].map((m) => m[0]);
    format = 'atom';
  }
  // feed 标题：取第一个 <item>/<entry> 之前的 <title>
  const cut = xml.search(/<item\b|<entry\b/i);
  const feedTitle = extractTag(cut > 0 ? xml.slice(0, cut) : xml, 'title') || '(无标题)';

  const items = blocks.map((b) => {
    const title = extractTag(b, 'title') || '';
    const link =
      extractTag(b, 'link') ||                 // RSS: <link>文本</link>
      extractAttr(b, 'link', 'href') ||        // Atom: <link href="..."/>
      '';
    const content =
      extractTag(b, 'content:encoded') ||
      extractTag(b, 'content') ||
      extractTag(b, 'description') ||
      extractTag(b, 'summary') ||
      '';
    const pubDate = extractTag(b, 'pubDate') || extractTag(b, 'published') || extractTag(b, 'updated') || '';
    return { title: title.trim(), link: link.trim(), content, pubDate: pubDate.trim() };
  });
  return { title: feedTitle, format, items };
}

// HTML → 纯文本（先解一次实体、去标签、再解一次残留实体）
function stripHtml(html) {
  let s = decodeEntities(String(html || ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\f\v\xa0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- HTTP ----------
async function fetchWithTimeout(url, opts, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
  } catch (e) {
    if (ac.signal.aborted) throw new Error(`请求超时（${timeoutMs}ms）: ${url}`);
    throw new Error(`网络请求失败: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// 请求返回 {status, data, bodyText}
async function fetchJson(url, opts, timeoutMs) {
  const res = await fetchWithTimeout(url, opts, timeoutMs);
  const bodyText = await res.text();
  let data = null;
  try { data = JSON.parse(bodyText); } catch (_) { /* 非 JSON，留给调用方按状态码处理 */ }
  return { status: res.status, data, bodyText };
}

async function fetchFeed(url, cfg) {
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
  }, cfg.feedTimeoutMs);
  if (!res.ok) throw new Error(`源返回 HTTP ${res.status} ${res.statusText || ''}`.trim());
  const xml = await res.text();
  const parsed = parseFeed(xml);
  if (!parsed.items.length) throw new Error('解析不到任何条目（feed 格式异常或为空）');
  return parsed;
}

// ---------- 模型摘要 ----------
async function callModel(model, apiKey, title, body, cfg) {
  const payload = {
    model: model.model,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: '你是资讯摘要助手。输出格式：先写标签（[技术]/[政策]/[数据]/[水会]/[广告] 五选一），空一格，然后写不超过 50 字的核心干货总结，同一行，除这一行外不要输出任何其它内容。',
      },
      {
        role: 'user',
        content:
          '阅读本文，用不超过 50 字总结核心干货，并打上一个标签（[技术]/[政策]/[数据]/[水会]/[广告]）。\n\n' +
          `文章标题：${title}\n\n正文：\n${body}`,
      },
    ],
  };
  const r = await fetchJson(model.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  }, cfg.modelTimeoutMs);
  return r;
}

// 解析「[标签] 摘要」，失败返回 null
function parseSummary(text) {
  if (!text) return null;
  const m = new RegExp('\\[(' + TAGS.join('|') + ')\\]').exec(text);
  if (!m) return null;
  let s = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length))
    .replace(/^摘要[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (s.length > MAX_SUMMARY_CHARS) s = s.slice(0, MAX_SUMMARY_CHARS);
  return { tag: m[1], summary: s };
}

// 带重试：第 1 次输出无有效标签 / 429 / 5xx 时重试一次；鉴权失败直接抛 stopAll
async function summarizeArticle(model, apiKey, id, title, body, cfg) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let r;
    try {
      r = await callModel(model, apiKey, title, body, cfg);
    } catch (e) {
      if (attempt === 1) {
        warn(`摘要 ${id} 请求失败（${e.message}），5 秒后重试一次`);
        await sleep(5000);
        continue;
      }
      throw e;
    }
    if (r.status === 401 || r.status === 403) {
      const e = new Error(`模型鉴权失败（HTTP ${r.status}）：API key 无效或无权限，停止本轮摘要`);
      e.stopAll = true;
      throw e;
    }
    if (r.status === 429 || r.status >= 500) {
      if (attempt === 1) {
        warn(`摘要 ${id} 模型返回 HTTP ${r.status}，5 秒后重试一次`);
        await sleep(5000);
        continue;
      }
      throw new Error(`模型返回 HTTP ${r.status}，重试仍失败`);
    }
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`模型返回 HTTP ${r.status}: ${(r.bodyText || '').slice(0, 200)}`);
    }
    const content =
      (r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content) || '';
    const parsed = parseSummary(content);
    if (parsed) return parsed;
    if (attempt === 1) {
      warn(`摘要 ${id} 模型输出没有有效标签（原始输出前 80 字: ${String(content).slice(0, 80)}），要求重试一次`);
      continue;
    }
    return null; // 重试后仍无法解析
  }
  return null;
}

// ---------- summary 文件名 ----------
function sanitizeTitle(t) {
  let s = String(t || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')   // Windows 非法字符
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!s) s = '无标题';
  if (s.length > 100) s = s.slice(0, 100).replace(/[. ]+$/, '');
  return s;
}
function buildSummaryName(tag, title) {
  return `[${tag}] ${sanitizeTitle(title)}.md`;
}

// ---------- 归档 ----------
function moveFile(from, to) {
  // copy + unlink：同卷移动，且目标已存在（同日重跑）时直接覆盖，不报错、不堆积
  fs.copyFileSync(from, to);
  fs.unlinkSync(from);
}
function pruneArchive(maxDays) {
  if (!maxDays || maxDays <= 0) return; // 默认保留全部（「别删」）
  const cutoff = Date.now() - maxDays * 86400000;
  let entries = [];
  try { entries = fs.readdirSync(ARCHIVE_DIR); } catch (_) { return; }
  for (const d of entries) {
    const dt = Date.parse(d);
    if (Number.isNaN(dt) || dt >= cutoff) continue;
    try {
      fs.rmSync(path.join(ARCHIVE_DIR, d), { recursive: true, force: true });
      info(`清理过期归档 ${d}（archiveMaxDays=${maxDays}）`);
    } catch (e) {
      warn(`清理归档失败 ${d}: ${e.message}`);
    }
  }
}

// ---------- 配置 ----------
function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (e) {
    throw new Error(`读不到配置文件 ${CONFIG_PATH}: ${e.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`配置文件 JSON 解析失败: ${e.message}`);
  }
  return cfg;
}

// ---------- 主流程 ----------
async function main() {
  const cfg = loadConfig();
  const pcfg = Object.assign({}, DEFAULTS, cfg.newsPipeline || {});
  pcfg.model = Object.assign({}, DEFAULTS.model, (cfg.newsPipeline && cfg.newsPipeline.model) || {});

  const feeds = Array.isArray(cfg.rssFeeds)
    ? cfg.rssFeeds.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim())
    : [];

  ensureDirs();

  // 要求 1：rssFeeds 为空（或没有）→ 直接跳过，正常退出
  if (feeds.length === 0) {
    info(`rssFeeds 为空（或未配置），本轮直接跳过，正常退出。（config: ${CONFIG_PATH}）`);
    return 0;
  }

  // 要求 2：没配 key → 写清楚，不静默失败
  const apiKey = (process.env[pcfg.model.apiKeyEnv] || '').trim();
  const runDate = today();
  info(`==== 本轮开始（${runDate}）====`);
  info(`配置: ${feeds.length} 个源，每源最多 ${pcfg.maxItemsPerFeed} 条；打工模型 ${pcfg.model.model} @ ${pcfg.model.endpoint}；key 读环境变量 ${pcfg.model.apiKeyEnv}`);
  if (!apiKey) {
    warn(`未配置打工模型 API key：环境变量 ${pcfg.model.apiKeyEnv} 没有设置。本轮照常抓取原文并归档，但【跳过摘要步骤】（rss/summary 不会有新文件）。`);
  }

  // ---- 抓取 ----
  const articles = []; // {id, title, url}
  let feedOk = 0;
  for (let fi = 0; fi < feeds.length; fi++) {
    const url = feeds[fi];
    info(`[源 ${fi + 1}/${feeds.length}] 开始抓取 ${url}`);
    let parsed;
    try {
      parsed = await fetchFeed(url, pcfg);
      feedOk++;
    } catch (e) {
      errorLog(`[源 ${fi + 1}] 抓取失败，跳过该源，整轮继续: ${e.message}`);
      continue;
    }
    const items = parsed.items.slice(0, pcfg.maxItemsPerFeed);
    info(`[源 ${fi + 1}] 《${parsed.title}》共 ${parsed.items.length} 条（${parsed.format}），取最新 ${items.length} 条`);
    for (const it of items) {
      const link = it.link || url; // 拿不到链接时退回 feed 地址，保证 id 可算
      const id = crypto.createHash('sha1').update(link).digest('hex').slice(0, 12);
      const title = it.title || '(无标题)';
      const body = stripHtml(it.content).slice(0, MAX_RAW_BODY_CHARS);
      try {
        fs.writeFileSync(path.join(RAW_DIR, `${id}.title.txt`), title + '\n');
        fs.writeFileSync(path.join(RAW_DIR, `${id}.url.txt`), link + '\n');
        fs.writeFileSync(path.join(RAW_DIR, `${id}.body.txt`), body + '\n');
        articles.push({ id, title, url: link });
        info(`  存 raw ${id}: ${title.slice(0, 60)}（正文 ${body.length} 字）`);
      } catch (e) {
        errorLog(`  存 raw 失败 ${id}: ${e.message}`);
      }
    }
    if (fi < feeds.length - 1) await sleep(jitter(pcfg.interFeedDelayMs));
  }
  info(`抓取完成: ${feedOk}/${feeds.length} 个源成功，共 ${articles.length} 篇，等待摘要。`);

  // ---- 摘要 ----
  let summarized = 0, skipped = 0, sumErrors = 0, stopReason = '';
  if (!apiKey) {
    skipped = articles.length;
    info(`摘要步骤整体跳过（未配置 API key），共 ${skipped} 篇不调用模型。`);
  } else {
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      let body = '';
      try {
        body = fs.readFileSync(path.join(RAW_DIR, `${a.id}.body.txt`), 'utf8').trim();
      } catch (e) {
        errorLog(`摘要 ${a.id} 读不到正文，跳过: ${e.message}`);
        sumErrors++;
        continue;
      }
      if (body.length < 20) warn(`摘要 ${a.id} 正文过短（${body.length} 字），按标题为主摘要。`);
      try {
        const out = await summarizeArticle(pcfg.model, apiKey, a.id, a.title, body.slice(0, MAX_BODY_CHARS), pcfg);
        if (out) {
          const fname = buildSummaryName(out.tag, a.title);
          const fpath = path.join(SUMMARY_DIR, fname);
          const overwrite = fs.existsSync(fpath);
          fs.writeFileSync(fpath, `${out.summary}\n\n原文链接：${a.url}\n`);
          info(`  摘要 ${a.id} -> summary/${fname}${overwrite ? '（覆盖同名旧文件）' : ''}`);
          summarized++;
        } else {
          skipped++;
          errorLog(`摘要 ${a.id} 重试后仍无法解析模型输出，跳过该篇。标题: ${a.title.slice(0, 60)}`);
        }
      } catch (e) {
        if (e.stopAll) {
          stopReason = e.message;
          errorLog(`摘要步骤中止: ${e.message}`);
          skipped += articles.length - i;
          break;
        }
        sumErrors++;
        errorLog(`摘要 ${a.id} 失败，跳过该篇，整轮继续: ${e.message}`);
      }
      if (i < articles.length - 1) await sleep(jitter(pcfg.interItemDelayMs));
    }
  }

  // ---- 归档 raw ----
  let moved = 0;
  const archDir = path.join(ARCHIVE_DIR, runDate);
  fs.mkdirSync(archDir, { recursive: true });
  try {
    for (const f of fs.readdirSync(RAW_DIR)) {
      const from = path.join(RAW_DIR, f);
      try {
        if (!fs.statSync(from).isFile()) continue;
        moveFile(from, path.join(archDir, f));
        moved++;
      } catch (e) {
        errorLog(`归档失败 ${f}: ${e.message}`);
      }
    }
  } catch (e) {
    errorLog(`读 raw 目录失败: ${e.message}`);
  }
  pruneArchive(pcfg.archiveMaxDays);

  // ---- 触发文件 ----
  const donePath = path.join(RSS_DIR, `DONE-${runDate}.txt`);
  const lines = [
    `DONE ${stamp()}`,
    `feeds_ok: ${feedOk}/${feeds.length}`,
    `raw_articles: ${articles.length}`,
    `summaries_written: ${summarized}`,
    `summaries_skipped: ${skipped}`,
    `summary_errors: ${sumErrors}`,
    `archive: rss/archive/${runDate}/ (${moved} files)`,
    apiKey
      ? `api_key: ${pcfg.model.apiKeyEnv} (set, model=${pcfg.model.model})`
      : `api_key: 未配置（环境变量 ${pcfg.model.apiKeyEnv} 为空）→ 本轮摘要步骤已跳过`,
  ];
  if (stopReason) lines.push(`note: ${stopReason}`);
  if (feedOk < feeds.length) lines.push('note: 有源抓取失败，详见 pipeline.log');
  fs.writeFileSync(donePath, lines.join('\n') + '\n');

  // ---- 梦境碎片（2026-11-02，赛博感官任务书模块 4）----
  // 流水线的最后一步：用昨天她刷过的词 + 今天天气 + 一个随机数，让打工模型
  // 写一句 50 字以内的梦境碎片到 <工作区>/dreams/tonight.md。她下次醒来时
  // 由 fish:dream 段提示一句（按 mtime 只提示一次），想看自己去看。
  // 失败只写日志、在 DONE 里记一行——绝不拖垮整轮流水线（与摘要步骤同一口径）。
  let dreamLine = '';
  try {
    const dream = require('./dream.js');
    const r = await dream.runDreamStep({ config: cfg, log });
    if (r.ok) dreamLine = `dream: ${r.text}`;
    else dreamLine = `dream: skipped (${r.reason})`;
  } catch (e) {
    dreamLine = `dream: skipped (失败: ${e.message})`;
    warn(`梦境步骤失败：${e.message}`);
  }
  try {
    fs.appendFileSync(donePath, dreamLine + '\n');
  } catch (e) {
    warn(`DONE 文件追不进梦境行：${e.message}`);
  }

  info(`归档完成: rss/archive/${runDate}/（${moved} 个文件）；raw 已清空。`);
  info(`写触发文件 rss/DONE-${runDate}.txt`);
  info(`==== 本轮结束: raw ${articles.length} 篇, summary ${summarized} 个, skipped ${skipped}, errors ${sumErrors} ====`);
  return 0;
}

main()
  .then((code) => process.exit(code === undefined ? 0 : code))
  .catch((e) => {
    try {
      ensureDirs();
      errorLog(`致命错误: ${e.message}`);
    } catch (_) { /* ignore */ }
    console.error('[FATAL]', e.message);
    process.exit(1);
  });
