/**
 * imagelook.test.mjs —— 看图（image_look）
 *
 * 守的是这几件事：
 *   ① 她真的能看到图：render 吐出 text + image 两个块，image 块带 attachment 引用；
 *   ② execute 把 saveImage 的回执完整带回来（render 是同步的，ref 只能由 execute 先拿到）；
 *   ③ 只读：源文件不被修改（读前读后字节一致）；
 *   ④ 不认识的格式、不存在的文件、没有附件服务、存附件失败——都返回 ok:false
 *      的一句话，不抛红错（她看到的是"没看成"，不是一条故障）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerImageLook, sniffMediaType } from '../lib/imagelook.js'
import { FISH_TOOLS } from '../lib/restrict.js'

// 1x1 的最小 PNG（文件头 8 字节就是 PNG signature，正好也测嗅探）。
const MIN_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 假附件服务：记下入参，返回宿主 saveImage 同构的回执。 */
function fakeAttachments({ fails = false, limits } = {}) {
  const saved = []
  return {
    saved,
    imageLimits: limits ?? { maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 20 * 1024 * 1024 },
    async saveImage(input) {
      if (fails) throw new Error('saveImage 炸了')
      saved.push(input)
      return {
        attachmentId: 'att-test-1',
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 1,
        height: 1,
        name: input.name,
      }
    },
  }
}

function fakeCtx(attachments) {
  const defs = []
  return {
    defs,
    tools: { register(d) { defs.push(d); return () => {} } },
    get: (k) => (k === 'attachments' ? attachments : undefined),
  }
}

async function tmpWithPng() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fish-img-'))
  const p = join(dir, 'a.png')
  await writeFile(p, Buffer.from(MIN_PNG_B64, 'base64'))
  return { dir, p, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// 共享一个目录：a.png 从一开始就在，其余测试按需往里放文件。
const { dir, cleanup } = await tmpWithPng()
test.after(() => { cleanup() })



test('image_look 在 FISH_TOOLS 里', () => {
  assert.ok(FISH_TOOLS.includes('image_look'), '白名单里少了 image_look')
})

test('sniffMediaType：四种格式只认文件头', () => {
  const png = Buffer.from(MIN_PNG_B64, 'base64')
  assert.equal(sniffMediaType(png), 'image/png')
  assert.equal(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00])), 'image/jpeg')
  assert.equal(sniffMediaType(Buffer.from('GIF89a-rest')), 'image/gif')
  const webp = Buffer.alloc(14)
  Buffer.from('RIFF').copy(webp, 0)
  Buffer.from('WEBP').copy(webp, 8)
  assert.equal(sniffMediaType(webp), 'image/webp')
  assert.equal(sniffMediaType(Buffer.from('not an image at all')), undefined)
})

test('注册形状：名字、参数、output.render、execute 都是宿主认的形状', async () => {
  const ctx = fakeCtx(fakeAttachments())
  registerImageLook(ctx, { root: dir })
  assert.equal(ctx.defs.length, 1)
  const d = ctx.defs[0]
  assert.equal(d.name, 'image_look')
  assert.equal(d.parameters?.type, 'object')
  assert.equal(typeof d.output?.render, 'function')
  assert.equal(typeof d.execute, 'function')
  assert.equal(d.output?.schema?.type, 'object')
})

test('execute 成功：回执带 ref，render 吐 text + image 两个块', async () => {
  const att = fakeAttachments()
  const ctx = fakeCtx(att)
  registerImageLook(ctx, { root: dir })
  const tool = ctx.defs[0]

  const out = await tool.execute({ file_path: join(dir, 'a.png') }, { cwd: dir })
  assert.equal(out.ok, true)
  assert.equal(out.path, join(dir, 'a.png').replace(/\\/g, '/'), '路径一律正斜杠')
  assert.equal(out.image.attachmentId, 'att-test-1')
  assert.equal(out.image.mediaType, 'image/png')
  assert.equal(att.saved.length, 1)
  assert.equal(att.saved[0].name, 'a.png')

  // render 是同步的：值里已经有 ref，这里只管组装。
  const blocks = tool.output.render({}, out)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /a\.png/)
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'att-test-1')
  assert.equal(blocks[1].attachment.mediaType, 'image/png')
})

test('只读：看完之后文件字节一个没变', async () => {
  const before = await readFile(join(dir, 'a.png'))
  const ctx = fakeCtx(fakeAttachments())
  registerImageLook(ctx, { root: dir })
  await ctx.defs[0].execute({ file_path: join(dir, 'a.png') }, { cwd: dir })
  const after = await readFile(join(dir, 'a.png'))
  assert.deepEqual(before, after)
})

test('相对路径相对 exec.cwd', async () => {
  const ctx = fakeCtx(fakeAttachments())
  registerImageLook(ctx, { root: dir })
  const out = await ctx.defs[0].execute({ file_path: 'a.png' }, { cwd: dir })
  assert.equal(out.ok, true)
  assert.equal(out.path, join(dir, 'a.png').replace(/\\/g, '/'))
})

test('扩展名不认时靠文件头：无扩展名的 png 也能看', async () => {
  const noext = join(dir, 'sigfile')
  await writeFile(noext, Buffer.from(MIN_PNG_B64, 'base64'))
  const ctx = fakeCtx(fakeAttachments())
  registerImageLook(ctx, { root: dir })
  const out = await ctx.defs[0].execute({ file_path: noext }, { cwd: dir })
  assert.equal(out.ok, true)
  assert.equal(out.image.mediaType, 'image/png')
})

test('失败都返回一句话，不抛红错', async () => {
  const ctx = fakeCtx(fakeAttachments())
  registerImageLook(ctx, { root: dir })
  const tool = ctx.defs[0]

  await writeFile(join(dir, 'note.txt'), 'hello')
  const cases = [
    [{}, '没给 file_path'],
    [{ file_path: '' }, '空路径'],
    [{ file_path: join(dir, 'nope.png') }, '不存在'],
    [{ file_path: dir }, '不是文件'],
    [{ file_path: join(dir, 'note.txt') }, '不是图'],
  ]
  for (const [args] of cases) {
    const out = await tool.execute(args, { cwd: dir }).catch((e) => ({ threw: e }))
    assert.equal(out.threw, undefined, '不该抛')
    assert.equal(out.ok, false)
    assert.ok(out.note.length > 0)
    const blocks = tool.output.render({}, out)
    assert.equal(blocks.length, 1, '失败时只有文本块，没有 image 块')
    assert.match(blocks[0].text, /没看成/)
  }
})

test('没有附件服务 / 存附件失败：明确告诉她', async () => {
  const noAtt = fakeCtx(undefined)
  registerImageLook(noAtt, { root: dir })
  const out1 = await noAtt.defs[0].execute({ file_path: join(dir, 'a.png') }, { cwd: dir })
  assert.equal(out1.ok, false)
  assert.match(out1.note, /附件服务/)

  const broken = fakeCtx(fakeAttachments({ fails: true }))
  registerImageLook(broken, { root: dir })
  const out2 = await broken.defs[0].execute({ file_path: join(dir, 'a.png') }, { cwd: dir })
  assert.equal(out2.ok, false)
  assert.match(out2.note, /存不进/)
})

test('超过字节上限的不读', async () => {
  const att = fakeAttachments({
    limits: { maxImageBytes: 8, maxMessageImageBytes: 8 },
  })
  const ctx = fakeCtx(att)
  registerImageLook(ctx, { root: dir })
  const out = await ctx.defs[0].execute({ file_path: join(dir, 'a.png') }, { cwd: dir })
  assert.equal(out.ok, false)
  assert.match(out.note, /太大/)
  assert.equal(att.saved.length, 0)
})

test('image_look 也注册在 index.js 的注册列表里', async () => {
  const src = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(/registerImageLook/.test(src), 'index.js 没有调用 registerImageLook')
})
