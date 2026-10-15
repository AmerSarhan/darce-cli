import React from 'react'
import { Box, Text, useWindowSize } from 'ink'
import stringWidth from 'string-width'
import { cursorPosition, type EditorState } from './input/editor.js'
import { theme } from './theme.js'

type Props = {
  editor: EditorState
  busy: boolean
  dimmed?: boolean
  suggestion?: string | null
  /** Replaces the usual hint, e.g. while a board on screen has the keys */
  placeholder?: string
}

/** `lines` are the visible ones, from `start` to `end` of `total`; `line`/`col` is the cursor within them */
export type PromptWindow = { start: number; end: number; total: number; lines: string[]; line: number; col: number }

/**
 * The lines to draw: all of them when they fit in `maxRows`, else a window around the cursor. A frame taller
 * than the terminal makes Ink clear and redraw the whole screen on every key, and a long buffer is slow to draw.
 */
export function promptWindow(editor: EditorState, maxRows: number, width: number): PromptWindow {
  const { lines, line, col } = cursorPosition(editor)
  const w = Math.max(10, width)
  // stringWidth only where it matters: short lines fit anyway, and a huge line is too tall either way
  const rows = (s: string) => Math.max(1, Math.ceil((s.length > w && s.length < 4096 ? stringWidth(s) : s.length) / w))
  if (lines.length <= maxRows && lines.reduce((n, l) => n + rows(l), 0) <= maxRows) return { start: 0, end: lines.length, total: lines.length, lines, line, col }
  const budget = Math.max(1, maxRows - 2) // room for the "more lines" markers
  let cur = lines[line]!
  let c = col
  // One line taller than the window on its own: show the stretch around the cursor
  if (rows(cur) > budget) {
    const span = budget * w
    const from = Math.max(0, Math.min(c - Math.floor(span / 2), cur.length - span))
    cur = cur.slice(from, from + span)
    c -= from
  }
  let start = line, end = line + 1, used = rows(cur)
  for (let grew = true; grew;) {
    grew = false
    if (end < lines.length && used + rows(lines[end]!) <= budget) { used += rows(lines[end]!); end++; grew = true }
    if (start > 0 && used + rows(lines[start - 1]!) <= budget) { used += rows(lines[start - 1]!); start--; grew = true }
  }
  const shown = lines.slice(start, end)
  shown[line - start] = cur
  return { start, end, total: lines.length, lines: shown, line: line - start, col: c }
}

/** Renders the editable prompt. All key handling lives in REPL via input/keys.ts. */
export function Prompt({ editor, busy, dimmed = false, suggestion, placeholder }: Props) {
  const t = theme()
  const { rows, columns } = useWindowSize()
  const maxRows = Math.max(4, Math.floor((rows || 24) / 2))
  const win = promptWindow(editor, maxRows, (columns || 80) - 2)
  const { lines, line: cursorLine, col } = win
  const above = win.start
  const below = win.total - win.end
  const empty = editor.text.length === 0
  const more = (n: number) => <Text color={t.faint}>  … {n.toLocaleString('en-US')} more {n === 1 ? 'line' : 'lines'}</Text>

  return (
    <Box flexDirection="column">
      {above > 0 && more(above)}
      {lines.map((text, i) => {
        const prefix = i + above === 0 ? '> ' : '  '
        const hasCursor = !dimmed && i === cursorLine
        return (
          <Box key={i + above}>
            <Text color={dimmed ? t.faint : t.accent} bold>{prefix}</Text>
            {empty && i === 0 ? (
              <Text>
                {!dimmed && <Text inverse> </Text>}
                {suggestion && !busy && !dimmed
                  ? <Text><Text color={t.faint}>{suggestion}</Text><Text color={t.faint} dimColor>   tab ↹</Text></Text>
                  : <Text color={t.faint}>
                      {placeholder ?? (busy ? 'Type to queue a message · Esc stops Darce' : 'Ask Darce to change, fix or explain something')}
                    </Text>}
              </Text>
            ) : hasCursor ? (
              <Text>
                {text.slice(0, col)}
                <Text inverse>{text[col] ?? ' '}</Text>
                {text.slice(col + 1)}
              </Text>
            ) : (
              <Text color={dimmed ? t.faint : undefined}>{text || ' '}</Text>
            )}
          </Box>
        )
      })}
      {below > 0 && more(below)}
    </Box>
  )
}
