// Pure text-buffer model for the prompt: cursor movement, word motions,
// kill/yank, multiline and history. No React — fully unit-testable.

export type EditorState = {
  text: string
  cursor: number // index into text, 0..text.length
  history: string[] // newest first
  historyIndex: number // -1 = editing a fresh draft
  draft: string // the fresh draft saved while browsing history
  killRing: string
}

export const emptyEditor = (history: string[] = []): EditorState => ({
  text: '',
  cursor: 0,
  history,
  historyIndex: -1,
  draft: '',
  killRing: '',
})

export type EditorAction =
  | { type: 'insert'; text: string }
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'wordLeft' }
  | { type: 'wordRight' }
  | { type: 'lineStart' }
  | { type: 'lineEnd' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'killToEnd' }
  | { type: 'killToStart' }
  | { type: 'killWordBack' }
  | { type: 'yank' }
  | { type: 'clear' }
  | { type: 'set'; text: string }
  | { type: 'replace'; start: number; end: number; text: string }
  | { type: 'commit' } // after submit: push to history, reset

const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)

function lineBounds(text: string, cursor: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', cursor - 1) + 1
  const nl = text.indexOf('\n', cursor)
  return { start, end: nl === -1 ? text.length : nl }
}

function wordLeft(text: string, cursor: number): number {
  let i = cursor
  while (i > 0 && !isWord(text[i - 1])) i--
  while (i > 0 && isWord(text[i - 1])) i--
  return i
}

function wordRight(text: string, cursor: number): number {
  let i = cursor
  while (i < text.length && !isWord(text[i])) i++
  while (i < text.length && isWord(text[i])) i++
  return i
}

function splice(s: EditorState, from: number, to: number, insert: string): EditorState {
  return { ...s, text: s.text.slice(0, from) + insert + s.text.slice(to), cursor: from + insert.length }
}

/** Normalize pasted / typed text: CRLF → LF, tabs → two spaces, strip other control chars. */
export function normalizeInput(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
}

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case 'insert': {
      const text = normalizeInput(a.text)
      return text ? splice(s, s.cursor, s.cursor, text) : s
    }
    case 'newline':
      return splice(s, s.cursor, s.cursor, '\n')
    case 'backspace':
      return s.cursor > 0 ? splice(s, s.cursor - 1, s.cursor, '') : s
    case 'delete':
      return s.cursor < s.text.length ? { ...s, text: s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1) } : s
    case 'left':
      return { ...s, cursor: Math.max(0, s.cursor - 1) }
    case 'right':
      return { ...s, cursor: Math.min(s.text.length, s.cursor + 1) }
    case 'wordLeft':
      return { ...s, cursor: wordLeft(s.text, s.cursor) }
    case 'wordRight':
      return { ...s, cursor: wordRight(s.text, s.cursor) }
    case 'lineStart':
      return { ...s, cursor: lineBounds(s.text, s.cursor).start }
    case 'lineEnd':
      return { ...s, cursor: lineBounds(s.text, s.cursor).end }
    case 'up': {
      // Move within a multiline buffer first; only browse history from the first line
      const { start } = lineBounds(s.text, s.cursor)
      if (start > 0) {
        const col = s.cursor - start
        const prev = lineBounds(s.text, start - 1)
        return { ...s, cursor: Math.min(prev.start + col, prev.end) }
      }
      if (s.historyIndex + 1 >= s.history.length) return s
      const historyIndex = s.historyIndex + 1
      const text = s.history[historyIndex]!
      return { ...s, historyIndex, draft: s.historyIndex === -1 ? s.text : s.draft, text, cursor: text.length }
    }
    case 'down': {
      const { start, end } = lineBounds(s.text, s.cursor)
      if (end < s.text.length) {
        const col = s.cursor - start
        const next = lineBounds(s.text, end + 1)
        return { ...s, cursor: Math.min(next.start + col, next.end) }
      }
      if (s.historyIndex === -1) return s
      const historyIndex = s.historyIndex - 1
      const text = historyIndex === -1 ? s.draft : s.history[historyIndex]!
      return { ...s, historyIndex, text, cursor: text.length }
    }
    case 'killToEnd': {
      const { end } = lineBounds(s.text, s.cursor)
      const to = end === s.cursor && end < s.text.length ? end + 1 : end // at EOL: join next line
      return { ...splice(s, s.cursor, to, ''), killRing: s.text.slice(s.cursor, to) }
    }
    case 'killToStart': {
      const { start } = lineBounds(s.text, s.cursor)
      return { ...splice(s, start, s.cursor, ''), killRing: s.text.slice(start, s.cursor) }
    }
    case 'killWordBack': {
      const from = wordLeft(s.text, s.cursor)
      return { ...splice(s, from, s.cursor, ''), killRing: s.text.slice(from, s.cursor) }
    }
    case 'yank':
      return s.killRing ? splice(s, s.cursor, s.cursor, s.killRing) : s
    case 'clear':
      return { ...s, text: '', cursor: 0, historyIndex: -1 }
    case 'set':
      return { ...s, text: a.text, cursor: a.text.length, historyIndex: -1 }
    case 'replace':
      return { ...s, text: s.text.slice(0, a.start) + a.text + s.text.slice(a.end), cursor: a.start + a.text.length, historyIndex: -1 }
    case 'commit': {
      const entry = s.text.trim()
      const history = entry && s.history[0] !== entry ? [entry, ...s.history].slice(0, 200) : s.history
      return { ...emptyEditor(history), killRing: s.killRing }
    }
  }
}

/** Split the buffer into display lines with the cursor's (line, column). */
export function cursorPosition(s: EditorState): { lines: string[]; line: number; col: number } {
  const lines = s.text.split('\n')
  const before = s.text.slice(0, s.cursor).split('\n')
  return { lines, line: before.length - 1, col: before[before.length - 1]!.length }
}
