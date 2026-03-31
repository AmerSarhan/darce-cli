import { z } from 'zod'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path for the new file'),
  content: z.string().describe('Content to write'),
})

type Input = z.infer<typeof inputSchema>

export const WriteTool: ToolDef<typeof inputSchema, string> = {
  name: 'Write',
  description: 'Create a new file or overwrite an existing file with the given content.',
  inputSchema,
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input: Input, context: ToolContext): Promise<ToolResult<string>> {
    if (!input.file_path) return { data: 'Error: file_path is required', isError: true }
    const filePath = resolve(context.cwd, String(input.file_path))
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, input.content, 'utf-8')
      return { data: `File written: ${input.file_path}` }
    } catch (err: any) {
      return { data: `Error writing file: ${err.message}`, isError: true }
    }
  },

  formatResult(output: string): string { return output },
  activityDescription(input) {
    return input.file_path ? `Writing ${input.file_path}` : 'Writing file'
  },
}
