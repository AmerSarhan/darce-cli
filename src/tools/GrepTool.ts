import { z } from 'zod'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
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
  description: 'Search file contents using regex. Uses ripgrep (rg) for speed. Returns matching lines with file paths and line numbers.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<string>> {
    const searchPath = input.path ? resolve(context.cwd, input.path) : context.cwd

    const args = [
      '--line-number',
      '--no-heading',
      '--color', 'never',
      '--max-count', '100',
      // Minified bundles produce enormous single-line matches
      '--max-columns', '400', '--max-columns-preview',
      // Dependency and build folders at any depth, even outside a git repository
      ...['node_modules', '.git', 'dist', '.next', 'build', '.venv', 'venv', '__pycache__', 'target', '.turbo', 'coverage'].flatMap(d => ['--glob', `!**/${d}/**`]),
    ]
    if (input.glob) {
      args.push('--glob', input.glob)
    }
    args.push(input.pattern, searchPath)

    return new Promise((resolvePromise) => {
      const proc = spawn('rg', args, {
        cwd: context.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      })

      let stdout = ''
      let stderr = ''

      let truncated = false
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
        // Enough to work with: stop searching instead of reading the whole disk
        if (stdout.length > 30000 && !truncated) { truncated = true; proc.kill() }
      })
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

      proc.on('error', () => {
        // rg not found, suggest install
        resolvePromise({ data: 'ripgrep (rg) not found. Install it: https://github.com/BurntSushi/ripgrep#installation', isError: true })
      })

      proc.on('close', (code, signal) => {
        if (truncated) {
          resolvePromise({ data: stdout.slice(0, 30000).trimEnd() + '\n... (more matches; use a narrower path or pattern)' })
        } else if (signal && !stdout) {
          resolvePromise({ data: 'Search took over 30s. Use a narrower path or a glob filter.', isError: true })
        } else if (code === 1) {
          // No matches
          resolvePromise({ data: 'No matches found.' })
        } else if (code === 0) {
          if (stdout.length > 30000) {
            stdout = stdout.slice(0, 30000) + '\n... (truncated)'
          }
          resolvePromise({ data: stdout.trimEnd() })
        } else {
          resolvePromise({ data: stderr || 'Grep failed', isError: true })
        }
      })
    })
  },

  formatResult(output: string): string { return output },
  activityDescription(input) {
    return input.pattern ? `Searching: ${input.pattern}` : 'Searching content'
  },
}
