import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { writePrivate } from '../utils/privateFile.js'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import type { DarceConfig, RouterConfig } from '../types.js'

const DEFAULT_ROUTER: RouterConfig = {
  default: 'anthropic/claude-haiku-5.5',
  budget: 'medium',
  rules: [],
}

const DEFAULTS: DarceConfig = {
  apiKey: '',
  router: DEFAULT_ROUTER,
  theme: 'dark',
  shell: process.env.SHELL || process.env.COMSPEC || 'bash',
  maxTurns: 50,
  historyPath: join(homedir(), '.darce', 'history'),
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/** A settings file that exists but can't be parsed. Writers refuse rather than replace it with `{}` plus one key. */
export class ConfigFileError extends Error {}

const GLOBAL_RC = () => join(homedir(), '.darcerc')

function errorLine(raw: string, err: Error): number {
  const line = /line (\d+)/.exec(err.message)
  if (line) return Number(line[1])
  const pos = /position (\d+)/.exec(err.message)
  return raw.slice(0, pos ? Number(pos[1]) : raw.length).split('\n').length
}

/** Keep one private copy of a broken file's exact contents, however many times it's read. */
function backUpBad(path: string, raw: string): string {
  const dir = dirname(path), prefix = `${basename(path)}.bad-`
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(prefix) && readFileSync(join(dir, f), 'utf-8') === raw) return join(dir, f)
    }
  } catch { /* unreadable folder: still try to save a copy */ }
  const copy = join(dir, prefix + new Date().toISOString().replace(/[:.]/g, '-'))
  try { writePrivate(copy, raw) } catch { return '' }
  return copy
}

const tilde = (p: string) => p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p

/**
 * A JSON settings file as an object: {} when missing or empty, ConfigFileError when it can't be
 * read or parsed (the broken file is copied to <name>.bad-<time> first).
 */
export function readSettingsFile(path: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ConfigFileError(`${tilde(path)} can't be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}): fix its permissions or delete it.`)
  }
  if (!raw.trim()) return {}
  let parsed: unknown
  let line = 0
  try { parsed = JSON.parse(raw) } catch (err) { line = errorLine(raw, err as Error) }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  const copy = backUpBad(path, raw)
  throw new ConfigFileError(`${tilde(path)} isn't valid JSON${line ? ` (line ${line})` : ' (not an object)'}: fix it or delete it.${copy ? ` A copy is saved as ${tilde(copy)}.` : ''}`)
}

/** Why ~/.darcerc can't be used, or null when it's fine (or absent). */
export function globalRcProblem(): string | null {
  try { readSettingsFile(GLOBAL_RC()); return null } catch (err) { return (err as Error).message }
}

/** Read-modify-write ~/.darcerc. Throws ConfigFileError instead of overwriting a file it couldn't read. */
export function updateGlobalRc(change: (rc: Record<string, unknown>) => void): void {
  const rc = readSettingsFile(GLOBAL_RC())
  change(rc)
  writePrivate(GLOBAL_RC(), JSON.stringify(rc, null, 2) + '\n')
}

function deepMerge(target: Record<string, unknown>, ...sources: (Record<string, unknown> | null)[]): Record<string, unknown> {
  const result = { ...target }
  for (const source of sources) {
    if (!source) continue
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof result[key] === 'object' && result[key] && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>)
      } else {
        result[key] = value
      }
    }
  }
  return result
}

const PROJECT_SAFE_KEYS = new Set(['theme', 'router'])

function pickProjectSettings(rc: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!rc) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rc)) {
    if (!PROJECT_SAFE_KEYS.has(k)) continue
    if (k === 'router' && v && typeof v === 'object') {
      const def = (v as Record<string, unknown>).default
      if (typeof def === 'string') out.router = { default: def }
    } else out[k] = v
  }
  return out
}

/** Save one setting to ~/.darcerc, keeping everything else in it. False when the file is broken (it's left alone). */
export function saveGlobalSetting(key: string, value: unknown): boolean {
  try {
    updateGlobalRc(rc => { rc[key] = value })
    return true
  } catch (err) {
    if (err instanceof ConfigFileError) return false
    throw err
  }
}

export function loadConfig(): DarceConfig {
  // A broken ~/.darcerc is reported by globalRcProblem(); here it just contributes nothing
  let globalRc: Record<string, unknown> | null = null
  try { globalRc = readSettingsFile(GLOBAL_RC()) } catch { /* see globalRcProblem() */ }
  // A project's own .darcerc comes with the repo, so it can't be trusted with keys, endpoints or
  // approval settings: only presentation and model choice are taken from it.
  const projectRc = pickProjectSettings(readJsonSafe(join(process.cwd(), '.darcerc')))

  const envOverrides: Record<string, unknown> = {}
  if (process.env.DARCE_API_KEY) envOverrides.apiKey = process.env.DARCE_API_KEY
  if (process.env.DARCE_API_BASE) envOverrides.apiBase = process.env.DARCE_API_BASE
  if (process.env.DARCE_MODE) envOverrides.mode = process.env.DARCE_MODE
  if (process.env.DARCE_MODEL) {
    envOverrides.router = { default: process.env.DARCE_MODEL }
  }

  return deepMerge(DEFAULTS as unknown as Record<string, unknown>, globalRc, projectRc, envOverrides) as unknown as DarceConfig
}
