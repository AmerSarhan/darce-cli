import { z } from 'zod'
import picomatch from 'picomatch'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { DEEP_IGNORE, gitFiles, walk } from '../utils/walk.js'
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
      const listed = existsSync(join(searchDir, '.git')) ? await gitFiles(searchDir, 200_000) : null
      if (!listed) {
        const { files, truncated } = await walk(searchDir, input.pattern, { max: 500, budgetMs: 10_000 })
        if (truncated && files.length < 500) {
          return { data: [`Search took over 10s in ${input.path ?? 'this folder'}. Use a narrower path or pattern, e.g. path: "my-app/src".`], isError: true }
        }
        return { data: files }
      }
      // git's own file list already leaves out what .gitignore ignores; it can still name files deleted since the last commit
      const matches = picomatch(input.pattern.replace(/^\.\//, ''))
      const skipped = picomatch(DEEP_IGNORE, { dot: true })
      const files: string[] = []
      for (const f of listed) {
        if (matches(f) && !skipped(f) && existsSync(join(searchDir, f))) files.push(f)
        if (files.length >= 500) break
      }
      return { data: files }
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
