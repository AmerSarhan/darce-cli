import fg from 'fast-glob'
import { spawn } from 'node:child_process'

// Dependency and build folders at any depth (a workspace often holds many projects)
export const DEEP_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.next/**', '**/build/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/target/**', '**/.turbo/**', '**/coverage/**', '**/.cache/**', '**/Pods/**', '**/vendor/**']

/**
 * Files matching a pattern, streamed so a huge folder can't hang Darce: stops at `max` results or
 * after `budgetMs`, whichever comes first, and says whether it stopped early.
 */
export async function walk(cwd: string, pattern: string, opts: { max: number; budgetMs: number; deep?: number }): Promise<{ files: string[]; truncated: boolean }> {
  const stream = fg.stream(pattern, { cwd, ignore: DEEP_IGNORE, onlyFiles: true, dot: false, followSymbolicLinks: false, suppressErrors: true, deep: opts.deep })
  const files: string[] = []
  const t0 = Date.now()
  for await (const f of stream) {
    files.push(String(f))
    if (files.length >= opts.max || Date.now() - t0 > opts.budgetMs) return { files, truncated: true }
  }
  return { files, truncated: false }
}

/** Tracked and untracked-but-not-ignored files from git, or null outside a repository. Runs in its own process. */
export function gitFiles(cwd: string, max: number): Promise<string[] | null> {
  return new Promise(resolve => {
    const git = spawn('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    const out: string[] = []
    let rest = ''
    git.stdout.on('data', (d: Buffer) => {
      const parts = (rest + d.toString('utf8')).split('\0')
      rest = parts.pop() ?? ''
      for (const p of parts) if (p) out.push(p)
      if (out.length >= max) git.kill()
    })
    git.on('close', code => resolve(code === 0 || out.length >= max ? out.slice(0, max) : null))
    git.on('error', () => resolve(null))
  })
}
