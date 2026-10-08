import { z } from 'zod'
import { globby } from 'globby'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'

// Dependency and build folders at any depth (a workspace often holds many projects)
const DEEP_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.next/**', '**/build/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/target/**', '**/.turbo/**', '**/coverage/**', '**/.cache/**']
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g., "**/*.ts", "src/**/*.tsx")'),
  path: z.string().optional().describe('Directory to search in (default: cwd)'),
})

type Input = z.infer<typeof inputSchema>

export const GlobTool: ToolDef<typeof inputSchema, string[]> = {
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns file paths sorted by modification time.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<string[]>> {
    const searchDir = input.path ? resolve(context.cwd, input.path) : context.cwd
    try {
      // Reading every .gitignore is slow in a folder full of projects; only do it inside one repository
      const inRepo = existsSync(join(searchDir, '.git'))
      const search = globby(input.pattern, {
        cwd: searchDir,
        gitignore: inRepo,
        ignore: DEEP_IGNORE,
        absolute: false,
        followSymbolicLinks: false,
        suppressErrors: true,
      })
      const files = await Promise.race([search, new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 20_000).unref())])
      if (files === 'timeout') {
        return { data: [`Search took over 20s in ${input.path ?? 'this folder'}. Use a narrower path or pattern, e.g. path: "my-app/src".`], isError: true }
      }
      return { data: files.slice(0, 500) }
    } catch (err: any) {
      return { data: [], isError: true }
    }
  },

  formatResult(output: string[]): string {
    if (output.length === 0) return 'No files found.'
    let result = output.join('\n')
    if (output.length === 500) result += '\n... (results capped at 500)'
    return result
  },

  activityDescription(input) {
    return input.pattern ? `Searching: ${input.pattern}` : 'Searching files'
  },
}
