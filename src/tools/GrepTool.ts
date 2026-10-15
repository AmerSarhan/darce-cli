import { z } from 'zod'
import { spawn, spawnSync } from 'node:child_process'

const MAX_CHARS = 30000
const SKIP_DIRS = ['node_modules', '.git', 'dist', '.next', 'build', '.venv', 'venv', '__pycache__', 'target', '.turbo', 'coverage']

/** ripgrep is fast but often not installed; fall back to the system grep so search always works. */
let rgAvailable: boolean | undefined
function hasRipgrep(): boolean {
  if (rgAvailable === undefined) {
    try { rgAvailable = spawnSync('rg', ['--version'], { stdio: 'ignore', timeout: 3000 }).status === 0 } catch { rgAvailable = false }
  }
  return rgAvailable
}
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { stat } from 'node:fs/promises'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'

const inputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('File or directory to search in (default: cwd)'),
  glob: z.string().optional().describe('Glob filter for files (e.g. "*.ts")'),
})

type Input = z.infer<typeof inputSchema>

export const GrepTool: ToolDef<typeof inputSchema, string> = {
  name: 'Grep',
  description: 'Search file contents using a regex. Returns matching lines with file paths and line numbers.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<string>> {
    const searchPath = input.path ? resolve(context.cwd, input.path) : context.cwd
    // rg matches globs against paths relative to its cwd (absolute ones when the search path isn't under it,
    // e.g. /var vs /private/var), so "src/*.ts" only works when rg runs from the folder being searched
    const isDir = await stat(searchPath).then(s => s.isDirectory(), () => false)
    // grep's --exclude-dir also matches the folder being searched, so asking for a path inside
    // node_modules would exclude everything: keep only skips below the path
    const rel = relative(context.cwd, searchPath)
    const within = (rel.startsWith('..') || isAbsolute(rel) ? searchPath : rel).split(/[\\/]/)

    // A leading (?i) is how models ask for case-insensitive search; GNU grep -E rejects it, so turn it into -i
    const ignoreCase = input.pattern.startsWith('(?i)')
    const pattern = ignoreCase ? input.pattern.slice(4) : input.pattern
    // A glob that names a skipped folder (e.g. "dist/**/*.js") asks for it
    const globParts = input.glob ? input.glob.split(/[\\/]/) : []
    const asked = SKIP_DIRS.filter(d => !globParts.includes(d))
    const skip = asked.filter(d => !within.includes(d))

    const args = [
      '--line-number',
      '--no-heading',
      '--color', 'never',
      '--max-count', '100',
      '--with-filename',
      // Minified bundles produce enormous single-line matches
      '--max-columns', '400', '--max-columns-preview',
      ...(ignoreCase ? ['--ignore-case'] : []),
      // rg lets a later glob override an earlier one: the filter goes first so a skip still wins over it
      ...(input.glob ? ['--glob', input.glob] : []),
      // Dependency and build folders at any depth below the search folder, even outside a git repository
      ...asked.flatMap(d => ['--glob', `!**/${d}/**`]),
      // -e and --: a pattern or path starting with '-' is not an option
      '-e', pattern, '--', isDir ? '.' : searchPath,
    ]

    const rg = hasRipgrep()
    const bin = rg ? 'rg' : 'grep'
    // grep's --include only sees the file name, so "src/**/*.ts" becomes "*.ts"
    const include = input.glob?.split(/[\\/]/).pop()
    const grepArgs = ['-rnHIE', '-m', '100', ...(ignoreCase ? ['-i'] : []), ...skip.map(d => `--exclude-dir=${d}`), ...(include ? [`--include=${include}`] : []), '-e', pattern, '--', searchPath]

    return new Promise((resolvePromise) => {
      const proc = spawn(bin, rg ? args : grepArgs, {
        cwd: rg && isDir ? searchPath : context.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      })

      let stdout = ''
      let stderr = ''
      // Cut at a line break so the last match isn't half a path
      const capped = () => {
        const cut = stdout.lastIndexOf('\n', MAX_CHARS)
        return stdout.slice(0, cut > 0 ? cut : MAX_CHARS).trimEnd()
      }

      let truncated = false
      // rg ran inside the folder and prints ./a.ts: report full paths, as grep does
      const prefix = rg && isDir ? searchPath.replace(/[\\/]$/, '') + sep : ''
      const full = (s: string) => prefix ? s.replace(/^\.[\\/]/gm, prefix) : s
      let partial = '' // a line split across chunks, rewritten once it's whole
      // Decode as UTF-8 across chunk boundaries so multibyte characters aren't split
      proc.stdout.setEncoding('utf8').on('data', (data: string) => {
        const text = partial + data
        const cut = text.lastIndexOf('\n') + 1
        partial = text.slice(cut)
        stdout += full(text.slice(0, cut))
        // Enough to work with: stop searching instead of reading the whole disk
        if (stdout.length + partial.length > MAX_CHARS && !truncated) { truncated = true; proc.kill() }
      })
      proc.stderr.setEncoding('utf8').on('data', (data: string) => { if (stderr.length < 4000) stderr += data })

      proc.on('error', () => {
        resolvePromise({ data: `Search failed: ${bin} could not be started.`, isError: true })
      })

      proc.on('close', (code, signal) => {
        stdout += full(partial)
        if (truncated) {
          resolvePromise({ data: capped() + '\n... (more matches; use a narrower path or pattern)' })
        } else if (signal && !stdout) {
          resolvePromise({ data: 'Search took over 30s. Use a narrower path or a glob filter.', isError: true })
        } else if (code === 1 && !stdout) {
          resolvePromise({ data: 'No matches found.' })
        } else if (stdout) {
          // Exit 2 with matches means some files couldn't be read (permissions, broken links): keep the matches
          const first = stderr.split('\n')[0]?.trim().replace(/^rg: \.[\\/]/, `rg: ${prefix}`)
          const note = code === 0 || signal ? '' : `\n(some files could not be searched: ${first || `exit code ${code}`})`
          resolvePromise({ data: (stdout.length > MAX_CHARS ? capped() + '\n... (truncated)' : stdout.trimEnd()) + note })
        } else {
          resolvePromise({ data: stderr.trim() || 'Grep failed', isError: true })
        }
      })
    })
  },

  formatResult(output: string): string { return output },
  activityDescription(input) {
    return input.pattern ? `Searching: ${input.pattern}` : 'Searching content'
  },
}
