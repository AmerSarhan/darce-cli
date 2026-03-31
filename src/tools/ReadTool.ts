import { z } from 'zod'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to read'),
  offset: z.number().int().positive().optional().describe('Line number to start from (1-based)'),
  limit: z.number().int().positive().optional().describe('Max lines to read'),
})

type Input = z.infer<typeof inputSchema>
type Output = { filePath: string; content: string; totalLines: number; isTruncated: boolean }

export const ReadTool: ToolDef<typeof inputSchema, Output> = {
  name: 'Read',
  description: 'Read a file and display contents with line numbers. Use this to understand code before modifying it.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<Output>> {
    if (!input.file_path) return { data: { filePath: '', content: 'Error: file_path is required', totalLines: 0, isTruncated: false }, isError: true }
    const filePath = resolve(context.cwd, String(input.file_path))
    try {
      const raw = await readFile(filePath, 'utf-8')
      const allLines = raw.split('\n')
      const offset = (input.offset ?? 1) - 1
      const limit = input.limit ?? 2000
      const lines = allLines.slice(offset, offset + limit)

      const numbered = lines.map((line, i) => `${offset + i + 1}\t${line}`).join('\n')

      context.readFiles.add(filePath)

      return {
        data: {
          filePath: input.file_path,
          content: numbered,
          totalLines: allLines.length,
          isTruncated: allLines.length > offset + limit,
        },
      }
    } catch (err: any) {
      return { data: { filePath: input.file_path, content: '', totalLines: 0, isTruncated: false }, isError: true }
    }
  },

  formatResult(output: Output): string {
    if (!output.content) return `Error: Could not read ${output.filePath}`
    let result = output.content
    if (output.isTruncated) {
      result += `\n... (truncated, ${output.totalLines} total lines)`
    }
    return result
  },

  activityDescription(input) {
    return input.file_path ? `Reading ${input.file_path}` : 'Reading file'
  },
}
