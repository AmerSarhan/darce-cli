import { z } from 'zod'
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises'
import { resolve, dirname, extname } from 'node:path'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { loadConfig } from '../config/config.js'

const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'auto'] as const

const inputSchema = z.object({
  prompt: z.string().min(1).max(4000).describe('Detailed visual description: subject, style, composition, colours, lighting, and any exact text that must appear (in quotes)'),
  file_path: z.string().describe('Where to save the image inside the project, e.g. public/hero.png'),
  aspect_ratio: z.enum(RATIOS).optional().describe('Defaults to 1:1'),
  resolution: z.enum(['1K', '2K']).optional().describe('1K (default) is enough for UI assets; 2K for large hero images'),
  reference_images: z.array(z.string()).max(2).optional().describe('Paths of existing images in the project to edit or match in style'),
  model: z.enum(['gpt-image', 'nano-banana', 'nano-banana-pro', 'seedream']).optional().describe('Leave unset for the plan default. gpt-image (OpenAI): best for UI assets, icons, logos and any text in the image, and the only one with transparent backgrounds. nano-banana-pro (Google): photorealism and complex scenes. nano-banana: good and cheaper. seedream: fast, cheapest drafts.'),
  quality: z.enum(['low', 'medium', 'high']).optional().describe('gpt-image only. medium (default) for most assets; high for final hero images; low for quick drafts'),
  transparent: z.boolean().optional().describe('Transparent background (gpt-image only): icons, logos, stickers'),
})

type Input = z.infer<typeof inputSchema>

const MIME_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }

function pngSize(buf: Buffer): string {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`
  return ''
}

export const ImageTool: ToolDef<typeof inputSchema, string> = {
  name: 'Image',
  description: 'Generate an image and save it into the project: icons, logos, illustrations, hero images, textures, mockup assets, or an edit of an existing image (pass it in reference_images). Write a specific visual prompt, and quote any exact text that must appear. An image counts as 3 to 20 requests depending on model and quality, so only make the images the task needs, never decorative extras.',
  inputSchema,
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input: Input, context: ToolContext): Promise<ToolResult<string>> {
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
          prompt: input.prompt, aspect_ratio: input.aspect_ratio ?? '1:1', resolution: input.resolution ?? '1K', input_references: refs,
          ...(input.model ? { model: input.model } : {}),
          ...(input.quality ? { quality: input.quality } : {}),
          ...(input.transparent ? { background: 'transparent', model: input.model ?? 'gpt-image' } : {}),
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

    const bytes = Buffer.from(img.b64_json, 'base64')
    // Keep the extension honest: a PNG is saved as .png even if another was asked for
    const want = MIME_EXT[img.media_type ?? 'image/png'] ?? '.png'
    let filePath = resolve(context.cwd, input.file_path)
    if (extname(filePath).toLowerCase() !== want && !(want === '.jpg' && extname(filePath).toLowerCase() === '.jpeg')) {
      filePath = filePath.slice(0, filePath.length - extname(filePath).length) + want
    }
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, bytes)
    const size = pngSize(bytes)
    const rel = filePath.startsWith(context.cwd + '/') ? filePath.slice(context.cwd.length + 1) : filePath
    const by = json.model ? ` with ${json.model.split('/').pop()}` : ''
    return { data: `Saved ${rel}${size ? ` (${size}` : ' ('}${size ? ', ' : ''}${Math.round(bytes.length / 1024)} KB)${by}${json.units ? ` · counted as ${json.units} requests` : ''}` }
  },

  formatResult(output: string): string { return output },
  activityDescription(input) {
    return input.file_path ? `Generating ${input.file_path}` : 'Generating an image'
  },
}
