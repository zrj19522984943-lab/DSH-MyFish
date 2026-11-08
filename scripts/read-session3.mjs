import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const buf = readFileSync(process.argv[2])
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(magic, 0, 4, i, i + 4) === 0) starts.push(i)

const parts = []
for (let i = 0; i < starts.length; i++) {
  const from = starts[i]
  const to = i + 1 < starts.length ? starts[i + 1] : buf.length
  try {
    parts.push(zstdDecompressSync(buf.subarray(from, to)))
  } catch (e) {
    parts.push(Buffer.from(`\n<<frame ${i} failed: ${e.message}>>\n`))
  }
}
const raw = Buffer.concat(parts).toString('utf8')
const lines = raw.split('\n').filter((l) => l.trim() !== '')
console.log(`frames=${starts.length} bytes=${raw.length} lines=${lines.length}\n`)
const mode = process.argv[3] ?? 'all'
const limit = Number(process.argv[4] ?? 400)
if (mode === 'tail') for (const l of lines.slice(-limit)) console.log(l.slice(0, 1200))
else for (const l of lines.slice(0, limit)) console.log(l.slice(0, 1200))
