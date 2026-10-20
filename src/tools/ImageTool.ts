import { z } from 'zod'
import { writeFile, mkdir, readFile, stat, lstat } from 'node:fs/promises'
import { resolve, dirname, extname } from 'node:path'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { loadConfig } from '../config/config.js'
import { keyOutBackground } from '../utils/keyBackground.js'
import { outside } from '../core/risk.js'

const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'auto'] as const

const inputSchema = z.object({
  prompt: z.string().min(1).max(4000).describe('Detailed visual description: subject, style, composition, colours, lighting, and any exact text that must appear (in quotes)'),
  file_path: z.string().describe('Where to save the image inside the project, e.g. public/hero.png'),
  aspect_ratio: z.enum(RATIOS).optional().describe('Defaults to 1:1'),
  resolution: z.enum(['1K', '2K']).optional().describe('1K (default) is enough for UI assets; 2K for large hero images'),
  reference_images: z.array(z.string()).max(2).optional().describe('Paths of existing images in the project to edit or match in style'),
  model: z.enum(['gpt-image', 'nano-banana', 'nano-banana-pro', 'seedream']).optional().describe('Leave unset for the plan default. gpt-image (OpenAI): best for UI assets, icons, logos and any text in the image, nano-banana-pro (Google): photorealism and complex scenes. nano-banana: good alternative. seedream: different style.'),
  quality: z.enum(['low', 'medium', 'high']).optional().describe('gpt-image only. medium (default) for most assets; high for final hero images; low for quick drafts'),
  transparent: z.boolean().optional().describe('Transparent background, for icons, logos and stickers (saved as PNG)'),
})

type Input = z.infer<typeof inputSchema>

const MIME_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }

const EXTS = ['.png', '.jpg', '.jpeg', '.webp']

/** Why the image can't be saved at `p`, if it can't. The path written must be exactly the one that was
 *  risk-scored and snapshotted, or /undo misses it, so it is checked here and never adjusted. */
async function badPath(p: string, cwd: string): Promise<string | undefined> {
  const abs = resolve(cwd, p)
  if (!p.trim() || abs === resolve(cwd)) return 'file_path must name an image file in the project, e.g. public/hero.png'
  if (!EXTS.includes(extname(abs).toLowerCase())) return `${p} needs a .png, .jpg or .webp extension`
  if (outside(p, cwd)) return `${p} is outside the project`
  if (await lstat(abs).then(s => s.isSymbolicLink(), () => false)) return `${p} is a symlink; save the image to a regular path`
  return undefined
}

function pngSize(buf: Buffer): string {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`
  return ''
}

export const ImageTool: ToolDef<typeof inputSchema, string> = {
  name: 'Image',
  description: 'Generate an image and save it into the project: icons, logos, illustrations, hero images, textures, mockup assets, or an edit of an existing image (pass it in reference_images). Write a specific visual prompt, and quote any exact text that must appear. An image counts as 2 requests by default (gpt-image, medium) and up to 22 for nano-banana-pro, so only make the images the task needs, never decorative extras.',
  inputSchema,
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input: Input, context: ToolContext): Promise<ToolResult<string>> {
    // Before the request, so a bad path doesn't spend a generation
    const bad = await badPath(input.file_path, context.cwd)
    if (bad) return { data: `Error: ${bad}`, isError: true }
    const config = loadConfig()
    const base = (config.apiBase || 'https://api.darce.dev').replace(/\/$/, '')
    const refs: string[] = []
    for (const p of input.reference_images ?? []) {
      const abs = resolve(context.cwd, p)
      try {
        if ((await stat(abs)).size > 4 * 1024 * 1024) return { data: `Error: ${p} is over 4 MB; use a smaller reference image`, isError: true }
        const ext = extname(abs).toLowerCase()
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png'
        refs.push(`data:${mime};base64,${(await readFile(abs)).toString('base64')}`)
      } catch {
        return { data: `Error: couldn't read reference image ${p}`, isError: true }
      }
    }

    let res: Response
    try {
      res = await fetch(`${base}/v1/images`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: input.transparent ? `${input.prompt}\n\nPlace it on a plain, flat, pure white background with nothing else: no shadow, no gradient, no border.` : input.prompt, aspect_ratio: input.aspect_ratio ?? '1:1', resolution: input.resolution ?? '1K', input_references: refs,
          ...(input.model ? { model: input.model } : {}),
          ...(input.quality ? { quality: input.quality } : {}),
          // Transparent: ask for a plain white background and remove it ourselves (see keyOutBackground)
        }),
        signal: context.abortSignal ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(150_000)]) : AbortSignal.timeout(150_000),
      })
    } catch (err) {
      return { data: `Error: image request failed (${(err as Error).message})`, isError: true }
    }
    const json = (await res.json().catch(() => ({}))) as { data?: Array<{ b64_json?: string; media_type?: string }>; message?: string; cost?: number; model?: string; units?: number }
    if (!res.ok) return { data: `Error: ${json.message || `image generation failed (${res.status})`}`, isError: true }
    const img = json.data?.[0]
    if (!img?.b64_json) return { data: 'Error: the image provider returned no image', isError: true }

    let bytes: Buffer = Buffer.from(img.b64_json, 'base64')
    let keyed = false
    if (input.transparent && (img.media_type ?? 'image/png') === 'image/png') {
      try { bytes = keyOutBackground(bytes); keyed = true } catch {}
    }
    // Keep the extension honest without renaming: a renamed file is one undo never saw
    const want = MIME_EXT[img.media_type ?? 'image/png'] ?? '.png'
    const filePath = resolve(context.cwd, input.file_path)
    const ext = extname(filePath).toLowerCase()
    if (ext !== want && !(want === '.jpg' && ext === '.jpeg')) {
      return { data: `Error: the image came back as ${want.slice(1).toUpperCase()}, so it wasn't saved to ${input.file_path}. Call Image again with a file_path ending in ${want}.`, isError: true }
    }
    // Generation takes a while; the path could have become a symlink since the first check
    const late = await badPath(input.file_path, context.cwd)
    if (late) return { data: `Error: ${late}`, isError: true }
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, bytes)
    } catch (err) {
      return { data: `Error: couldn't save ${input.file_path} (${(err as Error).message})`, isError: true }
    }
    const size = pngSize(bytes)
    const rel = filePath.startsWith(context.cwd + '/') ? filePath.slice(context.cwd.length + 1) : filePath
    const by = json.model ? ` with ${json.model.split('/').pop()}` : ''
    if (input.transparent && !keyed) return { data: `Saved ${rel} with its white background (it couldn't be made transparent automatically).` }
    return { data: `Saved ${rel}${keyed ? ' with a transparent background' : ''}${size ? ` (${size}` : ' ('}${size ? ', ' : ''}${Math.round(bytes.length / 1024)} KB)${by}${json.units ? ` · counted as ${json.units} requests` : ''}` }
  },

  formatResult(output: string): string { return output },
  activityDescription(input) {
    return input.file_path ? `Generating ${input.file_path}` : 'Generating an image'
  },
}
