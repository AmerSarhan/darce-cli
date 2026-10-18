import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { gitFiles, walk } from '../../utils/walk.js'

// Project file list for @mentions, loaded once in the background. Bounded, so starting Darce in a
// folder of many projects (with all their node_modules) can't pin the CPU and freeze the UI.
const MAX = 20_000
let cache: { cwd: string; files: string[] } | null = null
let loading: Promise<string[]> | null = null

export function projectFiles(cwd: string): string[] {
  if (cache?.cwd === cwd) return cache.files
  if (!loading) {
    loading = (async () => {
      const files = (await gitFiles(cwd, MAX)) ?? (await walk(cwd, '**/*', { max: MAX, budgetMs: 1_500, deep: 6 })).files
      cache = { cwd, files }
      return files
    })()
      .catch(() => [])
      .finally(() => { loading = null })
  }
  return []
}

/** Files named with @path in a message: existing files only, once each. Trailing punctuation ("@src/a.ts,") is not part of the path. */
export function mentionedFiles(text: string, cwd: string): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = []
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    for (const rel of new Set([m[1]!, m[1]!.replace(/[.,;:!?)\]}'"`]+$/, '')])) {
      const abs = resolve(cwd, rel)
      try {
        if (!rel || !existsSync(abs) || !statSync(abs).isFile()) continue
      } catch { continue }
      if (!out.some(f => f.abs === abs)) out.push({ rel, abs })
      break
    }
  }
  return out
}
