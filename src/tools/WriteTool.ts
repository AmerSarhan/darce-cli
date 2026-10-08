import { z } from 'zod'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { fileDiff } from '../utils/diff.js'

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
      const before = await readFile(filePath, 'utf-8').catch(() => null)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, input.content, 'utf-8')
      // Writing a file also marks it as read, so it can be edited next
      context.readFiles.add(filePath)
      const display = fileDiff(String(input.file_path), before, input.content)
      return {
        data: before === null ? `File created: ${input.file_path} (${display.added} lines)` : `File written: ${input.file_path} (+${display.added} -${display.removed})`,
        display,
      }
    } catch (err: any) {
      return { data: `Error writing file: ${err.message}`, isError: true }
    }
  },

  formatResult(output: string): string { return output },
  activityDescription(input) {
    return input.file_path ? `Writing ${input.file_path}` : 'Writing file'
  },
}
