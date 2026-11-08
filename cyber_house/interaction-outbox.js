'use strict'

/**
 * interaction-outbox.js —— 场景交互消息的本地出站队列
 *
 * 状态引擎（独立 Node 进程）和 QQ 桥接（DSH 宿主进程）不在同一个进程里，
 * 也不能互相 require 宿主服务。这里用一条最简单的追加式 JSONL 队列解耦：
 *
 *   状态引擎 append 一条 { featureId, featureName, text, message, at }
 *   QQ 桥接每秒读新增行，直调 OneBot send_private_msg 发给主人。
 *
 * 队列文件：<工作区>/cyber_house/interaction-outbox.jsonl
 * 只追加、不重写；桥接按字节偏移消费，消费到哪由 qq-bridge-state.json 记住。
 */

const fs = require('node:fs')
const path = require('node:path')

const OUTBOX_FILENAME = 'interaction-outbox.jsonl'

/** 交互消息的固定文案（任务书 1 的格式）。 */
function buildInteractionMessage(featureName, text) {
  const name = String(featureName || '某个东西').trim().slice(0, 40) || '某个东西'
  const dialogue = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return `[系统：小鱼碰到了${name}，触发对话：“${dialogue}”]`
}

function interactionQueueFile(workspaceRoot) {
  return path.join(String(workspaceRoot || ''), 'cyber_house', OUTBOX_FILENAME)
}

/**
 * 追加一条交互触发记录。
 *
 * @param {{workspaceRoot:string, featureId:string, featureName:string, text:string, now?:number}} input
 * @returns {object} 写入的记录
 */
function enqueueInteraction(input) {
  const workspaceRoot = String(input && input.workspaceRoot || '').trim()
  if (!workspaceRoot) throw new Error('缺少 workspaceRoot，无法写交互队列')
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now()
  const record = {
    id: `interaction-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date(now).toISOString(),
    featureId: String(input.featureId || ''),
    featureName: String(input.featureName || '某个东西').slice(0, 40),
    text: String(input.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    message: buildInteractionMessage(input.featureName, input.text),
  }

  const file = interactionQueueFile(workspaceRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

module.exports = {
  OUTBOX_FILENAME,
  interactionQueueFile,
  buildInteractionMessage,
  enqueueInteraction,
}
