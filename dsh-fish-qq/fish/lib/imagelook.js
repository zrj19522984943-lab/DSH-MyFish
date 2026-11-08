/**
 * imagelook.js —— 工具 `image_look`：她要「看一张图」的时候用这个
 *
 * ## 为什么需要它（2026-10-27）
 *
 * 她的工具面里一直都留着宿主的 `read_image`——看 B 站画面、看工作区里
 * 生成的图，都靠它。但这个工具是宿主的 `@deepseek-ai/dsh-tool-fs` 注册的，
 * **只在持久 attachments 服务挂载时才注册**，不同机器、不同版本上不一定有。
 * 真机上她报过「unknown tool」：工具面收窄时 `restrict()` 不认识 read_image
 * 这个名字（它当时还没登记），它就被从白名单里剔了下去——她连看图的手都没有。
 *
 * 自己注册一个就没有这个问题：名字是我们自己登记的，一定在。
 *
 * ## 怎么把图「递给她」
 *
 * 宿主工具的 output.render 返回 ContentBlock 数组，其中 image 块带一个
 * attachment 引用（由 `ctx.attachments.saveImage()` 落进宿主的附件存储）。
 * 这是宿主自己的 read_image 同款做法（applyReadImageTool）：
 *   execute 里读字节 → saveImage 拿 ref → render 把 ref 组装成
 *   `{ type: 'image', attachment: ref }` —— 模型就直接「看见」画面，
 *   而不是只收到一个路径。
 *
 * 关键是 render 必须同步：所以 ref 在 execute 里（异步）先拿到手，塞进
 * 结构化返回值；render 只负责把它组装成块。
 *
 * ## 边界
 *
 * - **只读**：图片源文件只读不写（本工具不做任何修改）。
 * - **不过 guard.js**：guard 拦的是**文本**输入口（评论、弹幕、/say），图片是
 *   视觉素材、路径是她自己产生的，不是外来文本，不在 guard 的职责内——
 *   宿主的 read_image 同样不走 guard。
 * - **零依赖**：只用 node 内置 fs/path，图片格式靠文件头判断。
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { defineTool } from './tool.js'
import { slashed } from './posix.js'

/** 默认字节上限（20 MiB）；宿主 attachments 服务有更精确的限额就用它的。 */
const DEFAULT_BYTE_CAP = 20 * 1024 * 1024

/** 文件头签名：只认宿主附件服务也认的四种。magic byte 判定以附件服务为准。 */
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIG = [0xff, 0xd8, 0xff]
const WEBP_SIG_RIFF = [0x52, 0x49, 0x46, 0x46] // "RIFF"
const WEBP_SIG_WEBP = [0x57, 0x45, 0x42, 0x50] // "WEBP"，在偏移 8
const GIF_SIG_87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] // "GIF87a"
const GIF_SIG_89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] // "GIF89a"

function matches(data, offset, expected) {
  if (data.length < offset + expected.length) return false
  return expected.every((b, i) => data[offset + i] === b)
}

/** 从文件头嗅探媒体类型；不认识返回 undefined。 */
export function sniffMediaType(data) {
  if (matches(data, 0, PNG_SIG)) return 'image/png'
  if (matches(data, 0, JPEG_SIG)) return 'image/jpeg'
  if (matches(data, 0, GIF_SIG_87) || matches(data, 0, GIF_SIG_89)) return 'image/gif'
  if (matches(data, 0, WEBP_SIG_RIFF) && matches(data, 8, WEBP_SIG_WEBP)) return 'image/webp'
  return undefined
}

/** 结构化返回值里 image 字段的形状（与宿主 read_image 的 IMAGE_VALUE_SCHEMA 对齐）。 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

/**
 * 注册 image_look 工具。
 * @param {object} ctx    插件 context（用 ctx.tools.register 注册，用 ctx.get('attachments') 拿附件服务）
 * @param {object} deps
 * @param {string} [deps.root]     状态库根（保持与其他工具一致的签名）
 * @param {object} [deps.attachments]  附件服务（测试注入用；不传则从 ctx 取）
 */
export function registerImageLook(ctx, deps = {}) {
  const getAttachments = () => {
    if (deps.attachments) return deps.attachments
    try { return ctx.get?.('attachments') } catch { return undefined }
  }

  return ctx.tools.register(
    defineTool({
      name: 'image_look',
      description:
        '看一张图片：把画面递给你看，不是只给你一个路径。支持 PNG / JPEG / WebP / GIF。' +
        'bili_watch 存下来的拼图、工作区里的图，想知道画面里画了什么就用它。',
      // 完整 JSON Schema（不是简写 DSL）：工具参数必须根级 type:object，否则 provider 直接拒。
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '图片在哪。绝对路径，或相对当前目录的路径。',
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string', description: '图本身的绝对路径（正斜杠，要贴图时照抄）' },
            text: { type: 'string' },
            note: { type: 'string' },
            image: IMAGE_VALUE_SCHEMA,
          },
          required: ['ok', 'path', 'text', 'note'],
        },
        // render 必须同步：ref 已经由 execute 放进返回值里了，这里只管组装。
        // 失败时不给 image 块，只给一句话。
        render: (_args, out) => {
          const blocks = [
            { type: 'text', text: out.ok ? out.text : `这次没看成：${out.note}` },
          ]
          if (out.ok && out.image) blocks.push({ type: 'image', attachment: out.image })
          return blocks
        },
      },
      async execute(args, exec) {
        const raw = String(args?.file_path ?? '').trim()
        if (!raw) return { ok: false, path: '', text: '', note: '没给路径。' }

        const attachments = getAttachments()
        if (!attachments) {
          return { ok: false, path: '', text: '', note: '宿主没挂附件服务，图递不过来。' }
        }

        // 相对路径相对当前目录：优先取会话的 cwd（她在她的屋子里，cwd 一般就是那）。
        const cwd =
          exec?.cwd ??
          exec?.agent?.session?.header?.cwd ??
          exec?.agent?.header?.cwd ??
          process.cwd()
        const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)

        let size = 0
        try {
          const st = await stat(abs)
          if (!st.isFile()) return { ok: false, path: slashed(abs), text: '', note: '这不是一个文件。' }
          size = st.size
        } catch {
          return { ok: false, path: slashed(abs), text: '', note: '找不到这个文件。' }
        }

        const limits = attachments.imageLimits ?? {}
        const byteCap = Math.min(
          Number(limits.maxImageBytes) || DEFAULT_BYTE_CAP,
          Number(limits.maxMessageImageBytes) || DEFAULT_BYTE_CAP,
        )
        if (size > byteCap) {
          return { ok: false, path: slashed(abs), text: '', note: '图太大了，递不过去。' }
        }

        let data
        try {
          data = await readFile(abs)
        } catch {
          return { ok: false, path: slashed(abs), text: '', note: '文件读不出来。' }
        }

        // 扩展名先声明，文件头不认的再拒（与宿主 read_image 同样的顺序）。
        const ext = extname(abs).toLowerCase()
        const byExt = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.webp': 'image/webp', '.gif': 'image/gif',
        }[ext]
        const mediaType = byExt ?? sniffMediaType(data)
        if (!mediaType) {
          return { ok: false, path: slashed(abs), text: '', note: '不是 PNG / JPEG / WebP / GIF。' }
        }

        let ref
        try {
          ref = await attachments.saveImage({ data, mediaType, name: basename(abs) })
        } catch {
          // 16-bit PNG、超大像素等会在附件服务里被拒：让她知道是图本身的问题。
          return { ok: false, path: slashed(abs), text: '', note: '图存不进附件服务，可能太大了或格式特殊。' }
        }
        if (!ref?.attachmentId) {
          return { ok: false, path: slashed(abs), text: '', note: '附件服务没接住这张图。' }
        }

        // 路径一律给正斜杠：宿主渲染 markdown 图片时拿路径拼 /api/file，反斜杠取不到文件。
        const posix = slashed(abs)
        return {
          ok: true,
          path: posix,
          // 文案与宿主 read_image 的信封同构：路径 + 类型 + 尺寸 + 字节数。
          text: [
            `${posix}`,
            `${mediaType} · ${ref.width ?? '?'}x${ref.height ?? '?'} px · ${ref.bytes ?? data.length} 字节`,
            '图递给你了。要在回复里贴这张图，路径照抄第一行（正斜杠）。',
          ].join('\n'),
          note: '',
          // render 需要完整的 ref 才能组装 image 块；字段与宿主 IMAGE_VALUE_SCHEMA 对齐。
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType ?? mediaType,
            bytes: ref.bytes ?? data.length,
            ...(ref.width !== undefined ? { width: ref.width } : {}),
            ...(ref.height !== undefined ? { height: ref.height } : {}),
            ...(ref.name !== undefined ? { name: ref.name } : {}),
          },
        }
      },
    }),
  )
}
