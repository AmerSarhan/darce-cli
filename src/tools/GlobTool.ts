import { z } from 'zod'
import { globby } from 'globby'
import { resolve } from 'node:path'
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
      const files = await globby(input.pattern, {
        cwd: searchDir,
        gitignore: true,
        ignore: ['node_modules/**', '.git/**', 'dist/**'],
        absolute: false,
      })
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
