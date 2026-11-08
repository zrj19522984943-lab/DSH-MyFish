import { readForHer } from '../dsh-fish-qq/fish/lib/readfile.js'
import { defaultCheckLogsDir } from '../dsh-fish-qq/fish/lib/checklog.js'

const workspaceRoot = 'D:\\demo\\workspace\\DSH-MyFish'
const selfRoot = `${process.env.USERPROFILE}\\.dsh-fish`

const a = readForHer({ workspaceRoot }, { path: 'README.md', offset: 1, limit: 5 })
console.log('workspace ok=', a.ok, '| head=', JSON.stringify(a.text.split('\n')[0]), '| note=', a.note)

const b = readForHer({ selfRoot }, { path: 'diary/2026-10-26.md', scope: 'self', limit: 3 })
console.log('self diary ok=', b.ok, '| head=', JSON.stringify(b.text.split('\n')[0]), '| note=', b.note)

const c = readForHer({ selfRoot }, { path: 'config.json', scope: 'self' })
console.log('self config ok=', c.ok, '| note=', c.note)

const d = readForHer({ selfRoot }, { path: 'events.jsonl', scope: 'self', limit: 1 })
console.log('self events ok=', d.ok, '| note=', d.note)

console.log('CheckLogs ->', defaultCheckLogsDir({}))
