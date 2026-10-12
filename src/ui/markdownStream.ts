/**
 * Split streaming markdown into a stable prefix (complete blocks that will not
 * change) and a live tail. The prefix ends at the last blank line that is not
 * inside an open code fence, so blocks can be rendered once and frozen.
 */
export function splitStable(text: string): { stable: string; tail: string } {
  let inFence = false
  let fenceMarker = ''
  let cut = 0
  let pos = 0

  const lines = text.split('\n')
  // The last element is an incomplete line (no trailing newline yet) — never cut after it
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!
    pos += line.length + 1
    const fence = line.trimStart().match(/^(`{3,}|~{3,})/)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]![0]!
      } else if (fence[1]![0] === fenceMarker) {
        inFence = false
      }
      continue
    }
    if (!inFence && line.trim() === '') cut = pos
  }

  return { stable: text.slice(0, cut), tail: text.slice(cut) }
}

/**
 * The last `max` lines of the live tail. Output taller than the terminal makes the terminal redraw the whole
 * screen every frame (flicker, duplicated scrollback); the full text is printed once it's final.
 */
export function liveWindow(text: string, max: number): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  const cut = lines.length - max
  // If the cut lands inside a code block, reopen it so the rest still renders as code
  let open: string | null = null
  for (const line of lines.slice(0, cut)) {
    const m = line.trimStart().match(/^(`{3,}|~{3,})/)
    if (!m) continue
    if (!open) open = line.trimStart()
    else if (m[1]![0] === open[0]) open = null
  }
  return [`… ${cut} more line${cut === 1 ? '' : 's'} above`, '', ...(open ? [open] : []), ...lines.slice(cut)].join('\n')
}

/** Close an unterminated code fence so a half-streamed block renders as code, not stray backticks. */
export function closeOpenFence(text: string): string {
  // A closing fence that is still arriving ("`" or "``") would show as stray backticks
  text = text.replace(/\n[ \t]*(`{1,2}|~{1,2})[ \t]*$/, '\n')
  let open: string | null = null
  for (const line of text.split('\n')) {
    const m = line.trimStart().match(/^(`{3,}|~{3,})/)
    if (!m) continue
    if (!open) open = m[1]!
    else if (m[1]![0] === open[0]) open = null
  }
  return open ? `${text.replace(/\n?$/, '\n')}${open}` : text
}
