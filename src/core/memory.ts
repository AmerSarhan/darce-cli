import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

/**
 * Darce's memory: short durable notes it keeps across sessions.
 *   user    — about you and how you like to work (all projects)
 *   project — about this codebase (stored outside the repo, keyed by path)
 */
export type MemoryScope = 'user' | 'project'

const MAX_LINES = 150

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

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Add a note. Skips near-duplicates; keeps the file bounded (oldest notes drop off). */
export function remember(scope: MemoryScope, cwd: string, note: string): { added: boolean; path: string } {
  const path = memoryPath(scope, cwd)
  const clean = note.replace(/\s+/g, ' ').trim().replace(/^[-*]\s*/, '')
  const existing = readMemory(scope, cwd).split('\n').filter(l => l.startsWith('- '))
  if (!clean || existing.some(l => normalize(l).includes(normalize(clean)))) return { added: false, path }
  const date = new Date().toISOString().slice(0, 10)
  const lines = [...existing, `- ${clean} (${date})`].slice(-MAX_LINES)
  const header = scope === 'user'
    ? '# What Darce remembers about you\n\nEdit or delete lines freely. Darce reads this at the start of every session.\n'
    : `# What Darce remembers about ${cwd}\n\nEdit or delete lines freely. Darce reads this when working in this project.\n`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${header}\n${lines.join('\n')}\n`, { mode: 0o600 })
  return { added: true, path }
}

export function forget(scope: MemoryScope, cwd: string, match: string): number {
  const path = memoryPath(scope, cwd)
  if (!existsSync(path)) return 0
  const text = readFileSync(path, 'utf-8')
  const lines = text.split('\n')
  const needle = normalize(match)
  const kept = lines.filter(l => !(l.startsWith('- ') && normalize(l).includes(needle)))
  writeFileSync(path, kept.join('\n'), { mode: 0o600 })
  return lines.length - kept.length
}
