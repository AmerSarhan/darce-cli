import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type Attachment = { n: number; name: string; path: string; mediaType: string; bytes: number; width?: number; height?: number }

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MAX_BYTES = 8 * 1024 * 1024

function dir(): string {
  const d = join(homedir(), '.darce', 'attachments')
  mkdirSync(d, { recursive: true })
  return d
}

/** Width × height from a PNG, JPEG, GIF or WebP header (no decoding). */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]!
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
      i += 2 + len
    }
  }
  return undefined
}

/** Turn a dropped/pasted path into a clean absolute path if it points at an image. */
export function imagePathFrom(text: string, cwd: string): string | null {
  let p = text.trim()
  if (!p || p.includes('\n')) return null
  p = p.replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ').replace(/^file:\/\//, '')
  if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
  if (!p.startsWith('/')) p = join(cwd, p)
  const ext = extname(p).toLowerCase()
  if (!TYPES[ext]) return null
  try { return existsSync(p) && statSync(p).isFile() ? p : null } catch { return null }
}

export function attachmentFromFile(path: string, n: number): Attachment | { error: string } {
  const bytes = statSync(path).size
  if (bytes > MAX_BYTES) return { error: `${basename(path)} is ${(bytes / 1e6).toFixed(1)} MB; images must be under 8 MB.` }
  const size = imageSize(readFileSync(path))
  return { n, name: basename(path), path, mediaType: TYPES[extname(path).toLowerCase()]!, bytes, ...size }
}

/** Read an image from the system clipboard (macOS, Wayland, X11). */
export async function clipboardImage(n: number): Promise<Attachment | { error: string }> {
  const out = join(dir(), `pasted-${Date.now()}.png`)
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('osascript', ['-e', 'get the clipboard as «class PNGf»'], { maxBuffer: 64 * 1024 * 1024 })
      const hex = stdout.match(/«data PNGf([0-9A-Fa-f]+)»/)?.[1]
      if (!hex) return { error: 'No image on the clipboard. Copy a screenshot first (Cmd+Ctrl+Shift+4), or drag an image file in.' }
      writeFileSync(out, Buffer.from(hex, 'hex'))
    } else if (process.platform === 'linux') {
      const tool = process.env.WAYLAND_DISPLAY ? ['wl-paste', ['--type', 'image/png']] as const : ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']] as const
      const { stdout } = await run(tool[0], [...tool[1]], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
      if (!stdout.length) return { error: 'No image on the clipboard.' }
      writeFileSync(out, stdout)
    } else {
      return { error: 'Pasting images from the clipboard is not supported here yet. Drag the image file into the terminal instead.' }
    }
  } catch {
    return { error: 'No image on the clipboard. Copy a screenshot first, or drag an image file in.' }
  }
  const a = attachmentFromFile(out, n)
  return 'error' in a ? a : { ...a, name: 'clipboard image' }
}

export function toBase64(a: Attachment): string {
  return readFileSync(a.path).toString('base64')
}
