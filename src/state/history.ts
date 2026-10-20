import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writePrivate } from '../utils/privateFile.js'

// Prompt history shared across sessions (newest first). Resolved per call so tests can point HOME elsewhere.
const historyPath = () => join(homedir(), '.darce', 'prompt-history.json')
const MAX_ENTRIES = 200
// Big pastes made the file hundreds of MB, rewritten on every Enter; they're still recalled in this session
const MAX_ENTRY_CHARS = 20_000

const keep = (x: unknown): x is string => typeof x === 'string' && x.length <= MAX_ENTRY_CHARS

export function loadHistory(): string[] {
  try {
    const data = JSON.parse(readFileSync(historyPath(), 'utf-8'))
    return Array.isArray(data) ? data.filter(keep) : []
  } catch {
    return []
  }
}

/** Save after a prompt (history[0] is the newest). Merges with the file first so other windows' prompts survive. */
export function saveHistory(history: string[]) {
  try {
    const merged = [...new Set([...history.slice(0, 1), ...loadHistory(), ...history.slice(1)])]
    writePrivate(historyPath(), JSON.stringify(merged.filter(keep).slice(0, MAX_ENTRIES)))
  } catch {}
}
