// Big pastes sit in the prompt as one short token, like [Image #N], and are expanded when the message is sent.
// A 3000-line buffer redrawn on every keystroke cost ~140ms a key; the token costs nothing.

export const PASTE_MAX_LINES = 12
export const PASTE_MAX_CHARS = 2000

const TOKEN = /\[Pasted text #\d+: [\d,]+ (?:lines|chars)\]/g
const TOKEN_AT = new RegExp(TOKEN.source, 'y')

export function isBigPaste(text: string): boolean {
  if (text.length > PASTE_MAX_CHARS) return true
  let lines = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) if (++lines > PASTE_MAX_LINES) return true
  return false
}

export function pasteToken(n: number, text: string): string {
  const lines = text.split('\n').length
  return lines > 1
    ? `[Pasted text #${n}: ${lines.toLocaleString('en-US')} lines]`
    : `[Pasted text #${n}: ${text.length.toLocaleString('en-US')} chars]`
}

/** Replace every token still in the text with its paste. A token the user broke by editing stays as typed. */
export function expandPastes(text: string, pastes: ReadonlyMap<string, string>): string {
  if (!pastes.size) return text
  return text.replace(TOKEN, tok => pastes.get(tok) ?? tok)
}

/** End of the paste token that starts exactly at `i`, or -1. Delete removes the whole token. */
export function tokenStartingAt(text: string, i: number): number {
  TOKEN_AT.lastIndex = i
  const m = TOKEN_AT.exec(text)
  return m ? i + m[0].length : -1
}

/** Start of the paste token that ends exactly at `i`, or -1. Backspace removes the whole token. */
export function tokenEndingAt(text: string, i: number): number {
  if (text[i - 1] !== ']') return -1
  const start = text.lastIndexOf('[Pasted text #', i - 1)
  return start !== -1 && tokenStartingAt(text, start) === i ? start : -1
}
