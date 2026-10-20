import { join } from 'node:path'
import { homedir } from 'node:os'
import { writePrivate } from '../utils/privateFile.js'
import { readSettingsFile, ConfigFileError } from '../config/config.js'
import { trace } from '../utils/logger.js'

// "Always allow" rules, per project directory: { "/path/to/repo": ["npm install", "git push"] }
const trustPath = () => join(homedir(), '.darce', 'trust.json')

const rules = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

export function trustedKeys(cwd: string): Set<string> {
  try {
    return new Set(rules(readSettingsFile(trustPath())[cwd]))
  } catch {
    // Broken file (backed up by readSettingsFile): nothing is trusted, so everything asks
    return new Set()
  }
}

/** Save an "always allow" rule. Returns why it couldn't be saved, or null. A broken trust.json is left alone, not replaced. */
export function addTrust(cwd: string, key: string): string | null {
  try {
    const all = readSettingsFile(trustPath())
    all[cwd] = [...new Set([...rules(all[cwd]), key])]
    writePrivate(trustPath(), JSON.stringify(all, null, 2))
    return null
  } catch (err) {
    // Called from a keypress handler, where a throw would take the whole app down
    const message = err instanceof ConfigFileError ? err.message : `Couldn't save the rule: ${(err as Error).message}`
    trace('config_error', { file: 'trust.json', error: message })
    return message
  }
}
