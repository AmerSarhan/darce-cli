import { fstatSync } from 'node:fs'
import type { Readable } from 'node:stream'

export const STDIN_LIMIT = 400_000

/**
 * What was piped into Darce (`cat log | darce -p "why"`), or null when nothing was.
 * A shell pipe or a file is read to the end. Anything else (a socket a parent process left open) only counts
 * if data shows up quickly, so a script that never closes stdin doesn't hang Darce.
 * With `firstByteMs` (a prompt was given on the command line), even a pipe that stays silent that long is ignored:
 * a parent that opened a pipe and never wrote or closed it would otherwise hang Darce for good.
 */
export async function readPipedStdin(stream: Readable = process.stdin, fd = 0, waitMs = 1500, firstByteMs?: number): Promise<{ text: string; truncated: boolean } | null> {
  if ((stream as { isTTY?: boolean }).isTTY) return null
  let definite = false
  try {
    const st = fstatSync(fd)
    definite = st.isFIFO() || st.isFile()
  } catch { return null }

  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(first)
      stream.off('data', onData)
      stream.off('end', finish)
      stream.off('error', finish)
      stream.pause()
      const text = Buffer.concat(chunks).toString('utf8').replace(/\s+$/, '')
      resolve(text ? { text, truncated } : null)
    }
    const onData = (chunk: Buffer | string) => {
      clearTimeout(first)
      // A socket that stays open after sending is treated as done once it goes quiet
      if (!definite) { clearTimeout(timer); timer = setTimeout(finish, waitMs) }
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (size + buf.length > STDIN_LIMIT) {
        chunks.push(buf.subarray(0, STDIN_LIMIT - size))
        size = STDIN_LIMIT
        truncated = true
        finish()
        return
      }
      chunks.push(buf)
      size += buf.length
    }
    let timer = definite ? undefined : setTimeout(finish, waitMs)
    const first = definite && firstByteMs !== undefined ? setTimeout(finish, firstByteMs) : undefined
    stream.on('data', onData)
    stream.once('end', finish)
    stream.once('error', finish)
    stream.resume()
  })
}
