import { createReadStream } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

const p = process.argv[2]
const chunks = []
await pipeline(
  createReadStream(p),
  createZstdDecompress(),
  async function* (src) { for await (const c of src) chunks.push(c) },
)
const raw = Buffer.concat(chunks).toString('utf8')
const lines = raw.split('\n').filter((l) => l.trim() !== '')
console.log(`decompressed -> ${raw.length} bytes, ${lines.length} lines\n`)
const mode = process.argv[3] ?? 'head'
if (mode === 'head') for (const l of lines.slice(0, 2)) console.log(l.slice(0, 400) + '\n')
if (mode === 'tail') for (const l of lines.slice(-10)) console.log(l.slice(0, 800) + '\n')
if (mode === 'tools') {
  let n = 0
  for (const l of lines) {
    if (/"(tool|toolCall|name)":"(work_request|read|write|edit|pwsh|glob|grep|apply_patch)"/i.test(l) || /denied|not allowed|refus/i.test(l)) { n++; if (n > 30) break; console.log(l.slice(0, 600) + '\n') }
  }
  console.log(`matched ${n}`)
}
