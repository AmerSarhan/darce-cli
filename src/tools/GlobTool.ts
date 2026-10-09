import { z } from 'zod'
import { globby } from 'globby'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { DEEP_IGNORE, walk } from '../utils/walk.js'
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
      // Inside one repository, honour its .gitignore. Anywhere else (a folder full of projects) stream the
      // walk and stop early, so a broad pattern can't keep the CPU busy after the answer is in
      const inRepo = existsSync(join(searchDir, '.git'))
      if (!inRepo) {
        const { files, truncated } = await walk(searchDir, input.pattern, { max: 500, budgetMs: 10_000 })
        if (truncated && files.length < 500) {
          return { data: [`Search took over 10s in ${input.path ?? 'this folder'}. Use a narrower path or pattern, e.g. path: "my-app/src".`], isError: true }
        }
        return { data: files }
      }
      const search = globby(input.pattern, {
        cwd: searchDir,
        gitignore: true,
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
