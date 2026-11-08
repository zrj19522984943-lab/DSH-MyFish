// 只读探针：连上 NapCat 的 OneBot WS，问几个 API，并旁观 20 秒事件流。
// 不发送任何消息、不改任何状态。
const URL = 'ws://127.0.0.1:3001'
const ws = new WebSocket(URL)
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

const calls = [
  ['get_login_info', {}],
  ['get_recent_contact', {}],
  ['get_friend_list', {}],
  ['get_group_list', {}],
]

let pending = new Set(calls.map((c) => c[0]))

ws.onopen = () => {
  console.log(`[${stamp()}] open`)
  for (const [action, params] of calls) {
    ws.send(JSON.stringify({ action, params, echo: action }))
  }
}

ws.onmessage = (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch { console.log(`[${stamp()}] raw`, String(ev.data).slice(0, 300)); return }
  if (msg.post_type) {
    console.log(`[${stamp()}] EVENT post_type=${msg.post_type} message_type=${msg.message_type ?? '-'} user_id=${msg.user_id ?? '-'} group_id=${msg.group_id ?? '-'}`)
    if (msg.post_type === 'message') console.log('   message =', JSON.stringify(msg.message).slice(0, 400), '| raw =', String(msg.raw_message ?? '').slice(0, 200))
    return
  }
  const echo = msg.echo
  let data = msg.data
  if (echo === 'get_friend_list' && Array.isArray(data)) {
    data = { count: data.length, sample: data.slice(0, 5).map((f) => ({ user_id: f.user_id, nickname: f.nickname })) }
  }
  if (echo === 'get_group_list' && Array.isArray(data)) {
    data = { count: data.length, sample: data.slice(0, 5).map((g) => ({ group_id: g.group_id, group_name: g.group_name })) }
  }
  if (echo === 'get_recent_contact' && Array.isArray(data)) {
    data = {
      count: data.length,
      items: data.slice(0, 10).map((c) => ({ type: c.chat_type, peer: c.peerUin, remark: c.remark, nick: c.nickName, time: c.lastestMsgTime, msg: String(c.lastestMsg?.elements?.[0]?.textElement?.content ?? c.lastestMsg?.msgTitle ?? '').slice(0, 60) })),
    }
  }
  console.log(`[${stamp()}] API ${echo} retcode=${msg.retcode} status=${msg.status}`)
  console.log('   ', JSON.stringify(data).slice(0, 900))
  pending.delete(echo)
}

ws.onerror = (e) => console.log(`[${stamp()}] error`, e?.message ?? e)
ws.onclose = (e) => { console.log(`[${stamp()}] close code=${e.code} reason=${e.reason ?? ''}`); process.exit(0) }

setTimeout(() => {
  if (pending.size) console.log(`[${stamp()}] 没回音的 API: ${[...pending].join(', ')}`)
  console.log(`[${stamp()}] 20s 旁观结束，主动断开`)
  ws.close()
}, 20000)
