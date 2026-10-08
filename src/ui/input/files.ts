import { globby } from 'globby'

// Project file list for @mentions, loaded once in the background.
let cache: { cwd: string; files: string[] } | null = null
let loading: Promise<string[]> | null = null

export function projectFiles(cwd: string): string[] {
  if (cache?.cwd === cwd) return cache.files
  if (!loading) {
    loading = globby('**/*', {
      cwd,
      gitignore: true,
      dot: false,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', '.next/**', 'coverage/**'],
      onlyFiles: true,
      followSymbolicLinks: false,
    })
      .then(files => {
        cache = { cwd, files: files.slice(0, 20_000) }
        return cache.files
      })
      .catch(() => [])
      .finally(() => { loading = null })
  }
  return []
}
