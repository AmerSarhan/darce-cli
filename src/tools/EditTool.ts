import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to edit'),
  old_string: z.string().describe('Exact string to find and replace'),
  new_string: z.string().describe('Replacement string'),
  replace_all: z.boolean().default(false).optional().describe('Replace all occurrences'),
})

type Input = z.infer<typeof inputSchema>

export const EditTool: ToolDef<typeof inputSchema, string> = {
  name: 'Edit',
  description: 'Replace an exact string match in a file. The old_string must be unique unless replace_all is true. You must Read the file first.',
  inputSchema,
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input: Input, context: ToolContext): Promise<ToolResult<string>> {
    if (!input.file_path) return { data: 'Error: file_path is required', isError: true }
    const filePath = resolve(context.cwd, String(input.file_path))

    if (!context.readFiles.has(filePath)) {
      return { data: 'You must Read the file before editing it.', isError: true }
    }

    if (input.old_string === input.new_string) {
      return { data: 'old_string and new_string are identical — no changes needed.', isError: true }
    }

    try {
      const content = await readFile(filePath, 'utf-8')

      if (!content.includes(input.old_string)) {
        return { data: `String not found in ${input.file_path}. Make sure old_string matches exactly.`, isError: true }
      }

      const matches = content.split(input.old_string).length - 1
      if (matches > 1 && !input.replace_all) {
        return { data: `Found ${matches} matches. Provide more context to make it unique, or set replace_all: true.`, isError: true }
      }

      const updated = input.replace_all
        ? content.replaceAll(input.old_string, input.new_string)
        : content.replace(input.old_string, input.new_string)

      await writeFile(filePath, updated, 'utf-8')
      return { data: `File updated: ${input.file_path}` }
    } catch (err: any) {
      return { data: `Error editing file: ${err.message}`, isError: true }
    }
  },

  formatResult(output: string): string { return output },
  activityDescription(input) {
    return input.file_path ? `Editing ${input.file_path}` : 'Editing file'
  },
}
