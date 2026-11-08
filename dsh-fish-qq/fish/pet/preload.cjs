/**
 * preload.cjs —— 桌宠窗口与 dsh-fish 宿主之间唯一的桥。
 *
 * 只暴露：把一句话递出去、拿她说过的话（历史 + 新消息）、问一句窗口是不是就绪。
 * 不暴露文件系统、不暴露 Node、不暴露任何设置项——这个窗口只承担
 * 「多一个说话的口子」，不承担面板职责。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('fishPet', {
  send: (text) => ipcRenderer.invoke('pet:send', text),
  history: () => ipcRenderer.invoke('pet:history'),
  resize: (height) => ipcRenderer.send('pet:resize', height),
  onHer: (callback) => {
    if (typeof callback !== 'function') return
    ipcRenderer.on('pet:her', (_event, messages) => callback(messages))
  },
  ready: () => ipcRenderer.send('pet:ready'),
})
