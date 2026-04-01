import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DarceConfig, RouterConfig } from '../types.js'

const DEFAULT_ROUTER: RouterConfig = {
  default: 'qwen/qwen3-coder',
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

export function loadConfig(): DarceConfig {
  const globalRc = readJsonSafe(join(homedir(), '.darcerc'))
  const projectRc = readJsonSafe(join(process.cwd(), '.darcerc'))

  const envOverrides: Record<string, unknown> = {}
  if (process.env.DARCE_API_KEY) envOverrides.apiKey = process.env.DARCE_API_KEY
  if (process.env.DARCE_API_BASE) envOverrides.apiBase = process.env.DARCE_API_BASE
  if (process.env.DARCE_MODEL) {
    envOverrides.router = { default: process.env.DARCE_MODEL }
  }

  return deepMerge(DEFAULTS as unknown as Record<string, unknown>, globalRc, projectRc, envOverrides) as unknown as DarceConfig
}
