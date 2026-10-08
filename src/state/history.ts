import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { writePrivate } from '../utils/privateFile.js'

// Prompt history shared across sessions (newest first)
const HISTORY_PATH = join(homedir(), '.darce', 'prompt-history.json')

export function loadHistory(): string[] {
  try {
    const data = JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'))
    return Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function saveHistory(history: string[]) {
  try {
    writePrivate(HISTORY_PATH, JSON.stringify(history.slice(0, 200)))
  } catch {}
}
