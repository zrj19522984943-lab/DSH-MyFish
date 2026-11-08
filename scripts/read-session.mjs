import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const p = process.argv[2]
const buf = readFileSync(p)
let raw
try {
  raw = zstdDecompressSync(buf)
} catch (e) {
  console.error('decompress failed:', e.message)
  process.exit(1)
}
const text = raw.toString('utf8')
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`decompressed ${buf.length} -> ${raw.length} bytes, ${lines.length} lines\n`)
const mode = process.argv[3] ?? 'head'
if (mode === 'head') {
  for (const l of lines.slice(0, 3)) console.log(l.slice(0, 500) + '\n')
} else if (mode === 'tail') {
  for (const l of lines.slice(-8)) console.log(l.slice(0, 700) + '\n')
} else if (mode === 'tools') {
  let n = 0
  for (const l of lines) {
    if (/tool|call|denied|error|refus/i.test(l)) {
      n++
      if (n > 40) break
      console.log(l.slice(0, 600) + '\n')
    }
  }
  console.log(`matched ${n} lines`)
}
