import { z } from 'zod'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { discoverSkills, loadSkill } from '../core/skills.js'

const inputSchema = z.object({
  name: z.string().describe('Name of the skill to load (from the Skills list in your instructions)'),
})

type Input = z.infer<typeof inputSchema>
type Output = { name: string; body: string; dir?: string }

export const SkillTool: ToolDef<typeof inputSchema, Output> = {
  name: 'Skill',
  description: 'Load a skill: packaged instructions for a kind of task. Call it before starting work that matches a skill\'s description, then follow what it says.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<Output>> {
    const skill = loadSkill(context.cwd, input.name)
    if (!skill) {
      const names = discoverSkills(context.cwd).map(s => s.name).join(', ')
      return { data: { name: input.name, body: `No skill named "${input.name}". Available: ${names || '(none)'}` }, isError: true }
    }
    return { data: skill }
  },

  formatResult(o: Output): string {
    return `${o.body}${o.dir ? `\n\n(Skill files live in ${o.dir} — use Read for any file this skill references, relative to that folder.)` : ''}`
  },

  activityDescription(input) {
    return input.name ? `Loading skill ${input.name}` : 'Loading skill'
  },
}
