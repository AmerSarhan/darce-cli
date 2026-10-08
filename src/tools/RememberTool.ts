import { z } from 'zod'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { remember } from '../core/memory.js'
import { resetContext } from '../core/context.js'
import { redactSecrets } from '../utils/redact.js'

const inputSchema = z.object({
  scope: z.enum(['user', 'project']).describe('user: about the person and how they like to work (applies everywhere). project: about this codebase.'),
  note: z.string().max(400).describe('One short, durable, generalizable fact or preference, written as an instruction to your future self'),
})

type Input = z.infer<typeof inputSchema>

export const RememberTool: ToolDef<typeof inputSchema, string> = {
  name: 'Remember',
  description: 'Save a short note to your long-term memory so future sessions know it. Use it when the user corrects you, states a preference, or you discover a non-obvious fact about the project (how it ships, a gotcha, a convention). Never store secrets, credentials or one-off task details.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: false,

  async call(input: Input, context: ToolContext): Promise<ToolResult<string>> {
    const { text, count } = redactSecrets(input.note)
    if (count) return { data: 'Not saved: the note contained something that looks like a secret.', isError: true }
    const r = remember(input.scope, context.cwd, text)
    resetContext()
    return { data: r.added ? `Remembered (${input.scope}): ${text}` : 'Already remembered.' }
  },

  formatResult(o: string): string { return o },
  activityDescription() { return 'Saving to memory' },
}
