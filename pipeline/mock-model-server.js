#!/usr/bin/env node
/**
 * mock-model-server.js — 本地假「打工模型」接口，仅用于自测流水线的摘要半条链路。
 * 模拟 OpenAI 兼容的 chat/completions：
 *   - 第 1 次请求故意返回「没有标签」的输出 → 用来验证脚本的重试逻辑；
 *   - 之后返回合法的「[标签] 摘要」。
 * 用法：node pipeline/mock-model-server.js   （监听 127.0.0.1:18739，Ctrl-C 停）
 */
'use strict';

const http = require('http');
const PORT = 18739;
const TAGS = ['技术', '政策', '数据', '水会', '广告'];

let reqs = 0;

function pickTag(title) {
  return TAGS[[...title].reduce((a, c) => a + c.charCodeAt(0), 0) % TAGS.length];
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let title = '';
    try {
      const p = JSON.parse(body || '{}');
      const user = (p.messages || []).find((m) => m.role === 'user');
      const m = /文章标题：([^\n]*)/.exec((user && user.content) || '');
      title = m ? m[1] : '(unknown)';
    } catch (_) {}
    reqs++;
    let content;
    if (reqs === 1) {
      // 故意不带标签，逼脚本走一次重试
      content = `这篇的摘要没有写标签——${title.slice(0, 20)}，看看脚本会不会重试。`;
    } else {
      content = `[${pickTag(title)}] 模拟摘要：${title.slice(0, 26)} 的核心干货已提炼完毕。`;
    }
    const out = {
      id: 'mock-' + reqs,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
    console.log(`[mock] req#${reqs}  title=${title.slice(0, 34)}`);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] 假打工模型已上线: http://127.0.0.1:${PORT}/v1/chat/completions`);
});
