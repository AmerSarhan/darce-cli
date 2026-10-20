import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { writePrivate } from '../utils/privateFile.js'

/**
 * Darce's memory: short durable notes it keeps across sessions.
 *   user    — about you and how you like to work (all projects)
 *   project — about this codebase (stored outside the repo, keyed by path)
 */
export type MemoryScope = 'user' | 'project'

const MAX_LINES = 150
// Shorter matches hit notes nobody meant (forget('e') took three), and punctuation alone matches every note
const MIN_FORGET = 3

export function memoryPath(scope: MemoryScope, cwd: string): string {
  if (scope === 'user') return join(homedir(), '.darce', 'memory.md')
  const slug = cwd.split('/').filter(Boolean).slice(-2).join('-').replace(/[^A-Za-z0-9._-]/g, '_')
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 8)
  return join(homedir(), '.darce', 'projects', `${slug}-${hash}`, 'memory.md')
}

export function readMemory(scope: MemoryScope, cwd: string): string {
  try {
    return readFileSync(memoryPath(scope, cwd), 'utf-8').trim()
  } catch {
    return ''
  }
}

// Unicode-aware so notes in other scripts don't all normalise to '' (and count as duplicates of each other)
const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const isNote = (l: string) => l.startsWith('- ')
const noteText = (l: string) => l.replace(/^[-*]\s*/, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '')

/** Add a note. Skips exact duplicates; keeps the file bounded (oldest notes drop off). Other lines are the user's and stay. */
export function remember(scope: MemoryScope, cwd: string, note: string): { added: boolean; path: string } {
  const path = memoryPath(scope, cwd)
  const clean = note.replace(/\s+/g, ' ').trim().replace(/^[-*]\s*/, '')
  const key = normalize(clean)
  const text = readMemory(scope, cwd)
  const header = scope === 'user'
    ? '# What Darce remembers about you\n\nEdit or delete lines freely. Darce reads this at the start of every session.\n'
    : `# What Darce remembers about ${cwd}\n\nEdit or delete lines freely. Darce reads this when working in this project.\n`
  const lines = (text || header).split('\n')
  if (!key || lines.some(l => isNote(l) && normalize(noteText(l)) === key)) return { added: false, path }
  lines.push(`- ${clean} (${new Date().toISOString().slice(0, 10)})`)
  let drop = lines.filter(isNote).length - MAX_LINES
  const kept = drop > 0 ? lines.filter(l => !(isNote(l) && drop-- > 0)) : lines
  writePrivate(path, kept.join('\n') + '\n')
  return { added: true, path }
}

/** Why forget() won't take this match, or null when it will. */
export function forgetProblem(match: string): string | null {
  return normalize(match).length < MIN_FORGET
    ? `Give at least ${MIN_FORGET} letters or digits of the note to forget, so other notes aren't removed with it.`
    : null
}

/** Remove notes containing `match`. 0 (nothing touched) when forgetProblem() refuses it. */
export function forget(scope: MemoryScope, cwd: string, match: string): number {
  const path = memoryPath(scope, cwd)
  if (forgetProblem(match) || !existsSync(path)) return 0
  const lines = readFileSync(path, 'utf-8').split('\n')
  const needle = normalize(match)
  // Match the note itself, not its date: "2026" shouldn't forget everything saved this year
  const kept = lines.filter(l => !(isNote(l) && normalize(noteText(l)).includes(needle)))
  if (kept.length !== lines.length) writePrivate(path, kept.join('\n'))
  return lines.length - kept.length
}
