import type { EditorState } from './editor.js'

export type CompletionContext =
  | { kind: 'command'; query: string; start: number; end: number }
  | { kind: 'file'; query: string; start: number; end: number }

/** What the user is typing at the cursor that we can complete: "/comm" at the start, or "@path" anywhere. */
export function completionContext(s: EditorState): CompletionContext | null {
  const before = s.text.slice(0, s.cursor)
  if (/^\/[\w-]*$/.test(before) && !s.text.slice(s.cursor).trim()) {
    return { kind: 'command', query: before.slice(1), start: 0, end: s.text.length }
  }
  const m = before.match(/(?:^|\s)@([^\s@]*)$/)
  if (m) {
    const start = s.cursor - m[1]!.length - 1
    const afterWord = s.text.slice(s.cursor).match(/^[^\s]*/)![0]
    return { kind: 'file', query: m[1]!, start, end: s.cursor + afterWord.length }
  }
  return null
}

/**
 * Fuzzy match score (higher is better), or -1 for no match. Rewards prefix matches,
 * consecutive characters and matches at word/path boundaries.
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (t.startsWith(q)) return 1000 - t.length
  const base = t.split('/').pop()!
  if (base.startsWith(q)) return 800 - t.length
  if (t.includes(q)) return 600 - t.indexOf(q) - t.length / 10
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return -1
    score += found === prev + 1 ? 8 : 1
    if (found === 0 || /[/_.\-\s]/.test(t[found - 1]!)) score += 6
    prev = found
    ti = found + 1
  }
  return score - t.length / 20
}

export function rank<T>(items: T[], query: string, key: (t: T) => string, limit = 8): T[] {
  return items
    .map(item => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter(x => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.item)
}
