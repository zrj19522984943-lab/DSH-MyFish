const ws = new WebSocket('ws://127.0.0.1:3001')
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
ws.onopen = () => {
  ws.send(JSON.stringify({ action: 'get_recent_contact', params: {}, echo: 'rc' }))
  ws.send(JSON.stringify({ action: 'get_friend_list', params: {}, echo: 'fl' }))
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.post_type) { console.log(`[${stamp()}] EVENT ${msg.post_type}`, JSON.stringify(msg).slice(0, 300)); return }
  if (msg.echo === 'rc') {
    console.log('recent_contact raw:')
    for (const c of msg.data ?? []) {
      const when = c.lastestMsgTime ? new Date(Number(c.lastestMsgTime) * 1000).toLocaleString('zh-CN') : '(no time)'
      console.log('  ', JSON.stringify({ peer: c.peerUin, type: c.chat_type, remark: c.remark, nick: c.nickName, lastMsgTime: when, preview: JSON.stringify(c.lastestMsg)?.slice(0, 400) }))
    }
  }
  if (msg.echo === 'fl') {
    const hit = (msg.data ?? []).find((f) => String(f.user_id) === '10001')
    console.log('friend 10001:', JSON.stringify(hit))
  }
}
setTimeout(() => { ws.close(); }, 4000)
ws.onclose = () => process.exit(0)
