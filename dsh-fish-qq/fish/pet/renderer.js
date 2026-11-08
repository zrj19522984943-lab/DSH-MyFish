/**
 * renderer.js —— 桌宠窗口的界面逻辑。
 *
 * 两件事：
 *   1. 把输入框里的话交给 preload，再根据回执清空或提示；
 *   2. 把宿主写进 messages.json 的她的话显示在上面的返回框里。
 * 不生成快捷指令，不写引导文案，不碰任何设置。
 */
const input = document.getElementById('text')
const send = document.getElementById('send')
const bar = document.querySelector('.bar')
const reply = document.getElementById('reply')
const replyList = document.getElementById('reply-list')
const DEFAULT_PLACEHOLDER = '跟大肥鱼说点什么…'

let busy = false
let composing = false
let statusToken = 0
let errorTimer = null
let historyLoaded = false
const pending = []
let messages = []
let thinking = false

function messageKey(item) {
  return item?.seq !== undefined ? `seq:${item.seq}` : `id:${item?.id ?? ''}:${item?.text ?? ''}`
}

function mergeMessages(list) {
  const map = new Map()
  for (const item of [...messages, ...list]) {
    if (!item || typeof item !== 'object') continue
    map.set(messageKey(item), item)
  }
  return [...map.values()].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0)).slice(-30)
}

function renderMessages() {
  replyList.replaceChildren()
  for (const item of messages) {
    const line = document.createElement('div')
    line.className = item.kind === 'note' ? 'msg note' : 'msg'
    line.textContent = String(item.text ?? '')
    replyList.append(line)
  }
  if (thinking) {
    const line = document.createElement('div')
    line.className = 'msg note pending'
    line.textContent = '她在想…'
    replyList.append(line)
  }
  reply.hidden = messages.length === 0 && !thinking
  replyList.scrollTop = replyList.scrollHeight
  fitWindow()
}

/**
 * 返回框按内容长高，避免透明窗口留一大片看不见却挡鼠标的区域。
 * 常量对应 CSS：body padding 16 + bar 60 + gap 8 + reply padding 18 +
 * header 13 + gap 4 = 119；列表最多 170（超过就滚动）。
 */
function fitWindow() {
  if (!window.fishPet?.resize) return
  if (messages.length === 0 && !thinking) {
    window.fishPet.resize(76)
    return
  }
  const listHeight = Math.min(replyList.scrollHeight || 21, 170)
  const needed = Math.max(120, Math.min(360, Math.ceil(119 + listHeight + 6)))
  window.fishPet.resize(needed)
}

function appendMessages(fresh) {
  if (!Array.isArray(fresh) || fresh.length === 0) return
  thinking = false
  messages = mergeMessages(fresh)
  renderMessages()
}

function setStatus(text, ms = 1800) {
  const token = ++statusToken
  input.placeholder = text
  if (!ms) return
  setTimeout(() => {
    // 期间又发了一次 / 又有新状态，就不要把旧提示盖回去。
    if (token !== statusToken) return
    if (!input.value) input.placeholder = DEFAULT_PLACEHOLDER
  }, ms)
}

function flashError(note) {
  bar.classList.add('error')
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => {
    bar.classList.remove('error')
    errorTimer = null
  }, 1200)
  input.title = String(note || '')
  if (!input.value) setStatus(String(note || '没递出去，再试一次'), 2200)
}

async function submit() {
  if (busy) return
  const text = input.value.trim()
  if (!text) {
    input.focus()
    return
  }

  busy = true
  send.disabled = true
  send.textContent = '…'
  thinking = true
  renderMessages()
  try {
    const result = await window.fishPet.send(text)
    if (result && result.ok) {
      input.value = ''
      input.title = ''
      setStatus(result.queued ? '排上了，她一会儿看' : '说给她了')
    } else {
      thinking = false
      renderMessages()
      flashError(result && result.note)
    }
  } catch (err) {
    thinking = false
    renderMessages()
    flashError(`没递出去：${String(err?.message ?? err).slice(0, 80)}`)
  } finally {
    busy = false
    send.disabled = false
    send.textContent = '发送'
    input.focus()
  }
}

input.addEventListener('compositionstart', () => { composing = true })
input.addEventListener('compositionend', () => { composing = false })
input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    input.value = ''
    input.title = ''
    setStatus(DEFAULT_PLACEHOLDER, 0)
    return
  }
  if (event.key !== 'Enter') return
  // 中文输入法选字时的回车是“确认候选”，不是发送。
  if (composing || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  submit()
})

send.addEventListener('click', () => { submit() })
window.addEventListener('focus', () => { input.focus() })

if (!window.fishPet) {
  send.disabled = true
  setStatus('窗口没接上 DSH，重启试试', 0)
} else {
  // 先挂监听，再取历史；两者之间来的新消息不会丢。
  window.fishPet.onHer((fresh) => {
    if (!historyLoaded) pending.push(...(Array.isArray(fresh) ? fresh : []))
    else appendMessages(fresh)
  })
  window.fishPet.history().then((result) => {
    const list = Array.isArray(result?.messages) ? result.messages : []
    messages = mergeMessages([...list, ...pending])
    pending.length = 0
    historyLoaded = true
    renderMessages()
  }).catch(() => {
    messages = mergeMessages(pending)
    pending.length = 0
    historyLoaded = true
    renderMessages()
  })
  window.fishPet.ready()
  input.focus()
}
