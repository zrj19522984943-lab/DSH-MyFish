import { readFileSync } from 'node:fs'
const buf = readFileSync(process.argv[2])
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const hits = []
for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(magic, 0, 4, i, i + 4) === 0) hits.push(i)
console.log('file size', buf.length, 'zstd magic offsets:', hits.slice(0, 20), 'count', hits.length)
console.log('first 32 bytes:', buf.subarray(0, 32).toString('hex'))
if (hits.length > 1) console.log('bytes before 2nd frame:', buf.subarray(Math.max(0, hits[1] - 16), hits[1]).toString('hex'))
