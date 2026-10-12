import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isUtf8 } from 'node:buffer'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { fileDiff } from '../utils/diff.js'
import { tasteForEdit } from '../taste/check.js'

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
      const buf = await readFile(filePath)
      // Decoding Latin-1, UTF-16 etc. as UTF-8 would replace every non-ASCII byte on write
      if (!isUtf8(buf)) return { data: `${input.file_path} is not UTF-8 text; Edit would corrupt it. Use Bash (e.g. iconv or a script) instead.`, isError: true }
      const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? '\ufeff' : ''
      const content = buf.toString('utf-8', bom ? 3 : 0)

      let oldString = input.old_string
      let newString = input.new_string
      // Models write \n; Windows files have \r\n, and new lines should match the rest of the file
      if (content.includes('\r\n')) {
        const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n')
        const allCrlf = !/(?<!\r)\n/.test(content)
        if (allCrlf || (!content.includes(oldString) && content.includes(crlf(oldString)))) { oldString = crlf(oldString); newString = crlf(newString) }
      }

      if (!content.includes(oldString)) {
        return { data: `String not found in ${input.file_path}. Make sure old_string matches exactly.`, isError: true }
      }

      const matches = content.split(oldString).length - 1
      if (matches > 1 && !input.replace_all) {
        return { data: `Found ${matches} matches. Provide more context to make it unique, or set replace_all: true.`, isError: true }
      }

      // Use a replacer function so "$&", "$1" etc. in new_string are inserted literally
      const updated = input.replace_all
        ? content.split(oldString).join(newString)
        : content.replace(oldString, () => newString)

      await writeFile(filePath, bom + updated, 'utf-8')
      const display = fileDiff(String(input.file_path), content, updated)
      const taste = tasteForEdit(filePath, String(input.file_path), updated, display, context.cwd)
      return { data: `File updated: ${input.file_path} (+${display.added} -${display.removed})${taste}`, display }
    } catch (err: any) {
      return { data: `Error editing file: ${err.message}`, isError: true }
    }
  },

  formatResult(output: string): string { return output },
  activityDescription(input) {
    return input.file_path ? `Editing ${input.file_path}` : 'Editing file'
  },
}
