import { readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { gitFiles, walk } from '../utils/walk.js'

/**
 * The codebase as the brain view draws it: files (with a size in lines) and the imports between them.
 * Built in small async batches so a big project never blocks Darce's screen.
 */
export type BrainGraph = {
  name: string
  files: { p: string; n: number }[]
  /** Index pairs: files[a] imports files[b] */
  edges: [number, number][]
  truncated: boolean
}

const MAX_FILES = 3000
const MAX_READ = 256 * 1024
const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock)$|\.(png|jpe?g|gif|webp|ico|icns|bmp|tiff?|svg|mp3|mp4|mov|wav|ogg|webm|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|tar|7z|rar|jar|wasm|exe|dll|so|dylib|bin|dat|db|sqlite3?|lockb|map|min\.js|min\.css|pyc|class|o|a)$/i
const JS = /\.(m?[jt]sx?|cjs|cts|mts)$/
const RESOLVE = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']

export async function buildGraph(cwd: string): Promise<BrainGraph> {
  const listed = (await gitFiles(cwd, MAX_FILES * 3)) ?? (await walk(cwd, '**/*', { max: MAX_FILES * 3, budgetMs: 2_000, deep: 8 })).files
  const paths = listed.map(p => p.split('\\').join('/')).filter(p => !SKIP.test(p))
  const truncated = paths.length > MAX_FILES
  const keep = paths.slice(0, MAX_FILES)
  const index = new Map(keep.map((p, i) => [p, i]))
  const files = keep.map(p => ({ p, n: 1 }))
  const edges: [number, number][] = []

  for (let i = 0; i < keep.length; i += 48) {
    await Promise.all(keep.slice(i, i + 48).map(async (p, j) => {
      const at = i + j
      try {
        const abs = join(cwd, p)
        const s = await stat(abs)
        if (s.size > MAX_READ) { files[at]!.n = Math.round(s.size / 40); return }
        const text = await readFile(abs, 'utf8')
        files[at]!.n = Math.max(1, text.split('\n').length)
        for (const target of importsOf(p, text)) {
          const to = resolveImport(target, index)
          if (to !== undefined && to !== at) edges.push([at, to])
        }
      } catch { /* unreadable: keep it as a small dot */ }
    }))
  }
  return { name: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd, files, edges, truncated }
}

/** Project-relative paths a file imports (relative imports only: those are the project's own wiring). */
export function importsOf(path: string, text: string): string[] {
  const dir = posix.dirname(path)
  const out: string[] = []
  if (JS.test(path)) {
    const re = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm
    for (const m of text.matchAll(re)) out.push(posix.normalize(posix.join(dir, m[1] ?? m[2] ?? m[3] ?? m[4]!)))
  } else if (path.endsWith('.py')) {
    for (const m of text.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import/gm)) {
      let base = dir
      for (let k = 1; k < m[1]!.length; k++) base = posix.dirname(base)
      out.push(posix.normalize(posix.join(base, m[2]!.split('.').join('/'))))
    }
  }
  return out.map(p => p.replace(/^\.\//, ''))
}

function resolveImport(target: string, index: Map<string, number>): number | undefined {
  // TypeScript ESM imports name the compiled .js file: try the .ts source too
  const stems = [target, target.replace(/\.(m|c)?js$/, '.$1ts'), target.replace(/\.(m|c)?js$/, '.tsx'), target.replace(/\.jsx$/, '.tsx')]
  for (const stem of stems) {
    for (const ext of RESOLVE) {
      const hit = index.get(stem + ext)
      if (hit !== undefined) return hit
    }
    const py = index.get(stem + '.py') ?? index.get(stem + '/__init__.py')
    if (py !== undefined) return py
  }
  return undefined
}

/** A path from a tool (absolute, or relative to the git root) as the page knows it: relative to the project. */
export function projectPath(cwd: string, p: string, gitRoot?: string | null): string {
  let abs = p
  if (!p.startsWith('/') && !/^[a-z]:[\\/]/i.test(p)) abs = gitRoot ? join(gitRoot, p) : join(cwd, p)
  const rel = posix.relative(cwd.split('\\').join('/'), abs.split('\\').join('/'))
  return rel.startsWith('..') ? '' : rel
}

