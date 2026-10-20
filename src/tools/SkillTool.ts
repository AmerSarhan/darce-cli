import { z } from 'zod'
import { join } from 'node:path'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { discoverSkills, loadSkill } from '../core/skills.js'

const inputSchema = z.object({
  name: z.string().describe('Name of the skill to load (from the Skills list in your instructions)'),
})

type Input = z.infer<typeof inputSchema>
type Output = { name: string; body: string; dir?: string }

// A skill is instructions, not data; a huge one would fill the context on its own
const MAX_BODY = 50_000

export const SkillTool: ToolDef<typeof inputSchema, Output> = {
  name: 'Skill',
  description: 'Load a skill: packaged instructions for a kind of task. Call it before starting work that matches a skill\'s description, then follow what it says.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<Output>> {
    let skill: Output | null
    try {
      skill = loadSkill(context.cwd, input.name)
    } catch (err) {
      return { data: { name: input.name, body: `Error: skill "${input.name}" is no longer readable (${(err as Error).message})` }, isError: true }
    }
    if (!skill) {
      const names = discoverSkills(context.cwd).map(s => s.name).join(', ')
      return { data: { name: input.name, body: `No skill named "${input.name}". Available: ${names || '(none)'}` }, isError: true }
    }
    if (skill.body.length > MAX_BODY) {
      const where = skill.dir ? ` Use Read on ${join(skill.dir, 'SKILL.md')} for the rest.` : ''
      skill = { ...skill, body: `${skill.body.slice(0, MAX_BODY)}\n…(skill truncated at ${MAX_BODY} characters.${where})` }
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
