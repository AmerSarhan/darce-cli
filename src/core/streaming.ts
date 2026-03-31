export type SSEFrame = {
  event?: string
  data?: string
  id?: string
}

export function parseSSEFrames(buffer: string): { frames: SSEFrame[]; remaining: string } {
  const frames: SSEFrame[] = []
  const parts = buffer.split('\n\n')

  // Last part is incomplete — keep as remaining
  const remaining = parts.pop() ?? ''

  for (const part of parts) {
    if (!part.trim()) continue
    const frame: SSEFrame = {}
    for (const line of part.split('\n')) {
      const colonIndex = line.indexOf(':')
      if (colonIndex === -1) continue
      const field = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim()
      switch (field) {
        case 'event': frame.event = value; break
        case 'data': frame.data = (frame.data ? frame.data + '\n' : '') + value; break
        case 'id': frame.id = value; break
      }
    }
    if (frame.data !== undefined) frames.push(frame)
  }

  return { frames, remaining }
}
