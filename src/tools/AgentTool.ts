import { z } from 'zod'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'

const inputSchema = z.object({
  description: z.string().min(1).max(60).describe('A 3–6 word label shown to the user, e.g. "Find all auth call sites"'),
  prompt: z.string().min(1).describe('The complete task. The thread can\'t see this conversation, so include every detail it needs: goal, relevant paths, constraints, and what to report back.'),
  kind: z.enum(['explore', 'work']).default('explore').describe('explore: read and search only, and several run at the same time. work: may edit files and run commands, runs one at a time, with the same approvals as you.'),
})

type Input = z.infer<typeof inputSchema>

export const AgentTool: ToolDef<typeof inputSchema, string> = {
  name: 'Agent',
  description: [
    'Start a thread: a sub-agent with its own fresh context that works on one focused task and returns a report.',
    'Use explore threads to research in parallel (call Agent several times in one reply and they run at the same time),',
    'or to keep a large search out of your own context. Use a work thread for a self-contained change.',
    'Skip it for small tasks you can do directly in a few steps.',
  ].join(' '),
  inputSchema,
  // The thread's own tool calls are approved and snapshotted individually, so starting one is harmless
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<string>> {
    if (!context.spawnAgent) return { data: 'Threads are only available in the interactive app. Do the task directly.', isError: true }
    const { report, isError } = await context.spawnAgent({ description: input.description, prompt: input.prompt, kind: input.kind })
    return { data: report || '(the thread finished without a report)', isError }
  },

  formatResult(output: string): string { return output },
  activityDescription(input) {
    return input.description ? `Thread: ${input.description}` : 'Starting a thread'
  },
}
