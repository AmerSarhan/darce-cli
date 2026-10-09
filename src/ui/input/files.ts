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
