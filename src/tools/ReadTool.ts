import { z } from 'zod'
import { open, readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to read'),
  offset: z.number().int().positive().optional().describe('Line number to start from (1-based)'),
  limit: z.number().int().positive().optional().describe('Max lines to read'),
})

type Input = z.infer<typeof inputSchema>
type Output = {
  filePath: string
  content: string
  totalLines: number // 0 when the file was too big to count
  isTruncated: boolean
  nextOffset?: number // set when the output cap stopped the read early
  error?: string
}

const MAX_LINE = 2000
const MAX_OUTPUT = 100_000
// Above this, stream the requested lines instead of loading the file
const MAX_WHOLE_FILE = 10_000_000

export const ReadTool: ToolDef<typeof inputSchema, Output> = {
  name: 'Read',
  description: 'Read a file and display contents with line numbers. Use this to understand code before modifying it. Long files are cut off; use offset and limit to read further.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<Output>> {
    const fail = (error: string): ToolResult<Output> => ({ data: { filePath: String(input.file_path ?? ''), content: '', totalLines: 0, isTruncated: false, error }, isError: true })
    if (!input.file_path) return fail('file_path is required')
    const filePath = resolve(context.cwd, String(input.file_path))
    try {
      const info = await stat(filePath)
      if (info.isDirectory()) return fail(`${input.file_path} is a directory. Use Glob or \`ls\` to list it.`)
      if (!info.isFile()) return fail(`${input.file_path} is not a regular file.`)

      const fh = await open(filePath, 'r')
      const head = Buffer.alloc(Math.min(8192, info.size))
      try { await fh.read(head, 0, head.length, 0) } finally { await fh.close() }
      if (head.includes(0)) return fail(`${input.file_path} is a binary file (${info.size} bytes); it can't be shown as text.`)

      const offset = (input.offset ?? 1) - 1
      const limit = input.limit ?? 2000
      const out: string[] = []
      let size = 0
      let nextOffset: number | undefined
      let lineNo = 0
      let more = false
      const take = (line: string): boolean => {
        lineNo++
        if (lineNo <= offset) return true
        if (out.length >= limit) { more = true; return false }
        const text = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… (line truncated, ${line.length} chars)` : line
        const numbered = `${lineNo}\t${text}`
        if (size + numbered.length > MAX_OUTPUT && out.length) { nextOffset = lineNo; more = true; return false }
        out.push(numbered)
        size += numbered.length + 1
        return true
      }

      let totalLines = 0
      if (info.size <= MAX_WHOLE_FILE) {
        const lines = (await readFile(filePath, 'utf-8')).split('\n')
        totalLines = lines.length
        for (const line of lines) if (!take(line)) break
      } else {
        const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity })
        for await (const line of rl) if (!take(line)) break
        rl.close()
      }

      context.readFiles.add(filePath)
      if (!out.length) return { data: { filePath: input.file_path, content: `(nothing at line ${offset + 1}: the file has ${lineNo} lines)`, totalLines, isTruncated: false } }
      return { data: { filePath: input.file_path, content: out.join('\n'), totalLines, isTruncated: more, nextOffset } }
    } catch (err: any) {
      return fail(`Could not read ${input.file_path}: ${err.message}`)
    }
  },

  formatResult(output: Output): string {
    if (output.error) return `Error: ${output.error}`
    if (!output.content) return `Error: Could not read ${output.filePath}`
    let result = output.content
    if (output.nextOffset) {
      result += `\n... (output capped at ${MAX_OUTPUT / 1000}KB; continue with offset: ${output.nextOffset}${output.totalLines ? `, ${output.totalLines} total lines` : ''})`
    } else if (output.isTruncated) {
      result += `\n... (truncated${output.totalLines ? `, ${output.totalLines} total lines` : ''}; use offset and limit to read more)`
    }
    return result
  },

  activityDescription(input) {
    return input.file_path ? `Reading ${input.file_path}` : 'Reading file'
  },
}
