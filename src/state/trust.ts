import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

// "Always allow" rules, per project directory: { "/path/to/repo": ["npm install", "git push"] }
const TRUST_PATH = join(homedir(), '.darce', 'trust.json')

function load(): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(TRUST_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

export function trustedKeys(cwd: string): Set<string> {
  return new Set(load()[cwd] ?? [])
}

export function addTrust(cwd: string, key: string) {
  const all = load()
  all[cwd] = [...new Set([...(all[cwd] ?? []), key])]
  mkdirSync(dirname(TRUST_PATH), { recursive: true })
  writeFileSync(TRUST_PATH, JSON.stringify(all, null, 2), { mode: 0o600 })
}
