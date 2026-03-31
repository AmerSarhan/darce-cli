import { z } from 'zod'
import type { ToolResult, ToolContext } from '../types.js'

export type ToolDef<I extends z.ZodType = z.ZodType, O = unknown> = {
  name: string
  description: string
  inputSchema: I
  isReadOnly: boolean
  isConcurrencySafe: boolean
  call(input: z.infer<I>, context: ToolContext): Promise<ToolResult<O>>
  formatResult(output: O): string
  activityDescription(input: Partial<z.infer<I>>): string
}
