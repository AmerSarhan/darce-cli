import { z } from 'zod'
import type { ToolDef } from './Tool.js'
import type { ToolResult } from '../types.js'

const item = z.object({
  text: z.string().describe('What this step does, in plain words'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('Exactly one item should be in_progress while you work'),
})

const inputSchema = z.object({
  items: z.array(item).min(1).max(20).describe('The full plan. Each call replaces the previous one.'),
})

type Input = z.infer<typeof inputSchema>
export type PlanItem = z.infer<typeof item>

export const PlanTool: ToolDef<typeof inputSchema, PlanItem[]> = {
  name: 'Plan',
  description: 'Write or update your step-by-step plan, shown live to the user as a checklist. Use it for any task with more than about three steps: create it before starting, and update it as each step starts and finishes.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: false,

  async call(input: Input): Promise<ToolResult<PlanItem[]>> {
    return { data: input.items, display: { kind: 'plan', items: input.items } }
  },

  formatResult(items: PlanItem[]): string {
    const done = items.filter(i => i.status === 'done').length
    const current = items.find(i => i.status === 'in_progress')
    return `Plan updated: ${done}/${items.length} done${current ? `, now: ${current.text}` : ''}.`
  },

  activityDescription() {
    return 'Updating the plan'
  },
}
