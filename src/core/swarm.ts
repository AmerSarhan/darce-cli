import { buildSystemPrompt } from './context.js'
import type { Provider } from '../providers/provider.js'

export type SwarmPart = { title: string; prompt: string }

const PLANNER = `You are planning a swarm: parallel worker threads, each in its own copy of this repository.
Split the user's task into 2 to 4 parts that can be done at the same time without waiting for each other.
- Each part should touch different files where possible. Never split one file's change across parts.
- No part may depend on another part's output. Shared groundwork (a type, a helper) belongs to exactly one part, and the others must not need it.
- If the task can't be split cleanly, return a single part: that is better than a bad split.
- Each prompt must be complete and self-contained: goal, the relevant paths you can see in the project overview, constraints, and how to check the work (tests or build command).
Reply with JSON only, no prose:
{"parts":[{"title":"3 to 6 words","prompt":"..."}]}`

/** Ask the model to split a task into independent parts. Throws with a readable message on failure. */
export async function planSwarm(task: string, provider: Provider, model: string, cwd: string, signal?: AbortSignal): Promise<SwarmPart[]> {
  let text = ''
  for await (const e of provider.stream(
    [
      { role: 'system', content: `${buildSystemPrompt(cwd)}\n\n${PLANNER}` },
      { role: 'user', content: `Task: ${task}` },
    ],
    model,
    [],
    signal,
  )) {
    if (e.type === 'text_delta') text += e.text
    if (e.type === 'error') throw new Error(e.error)
  }
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let parsed: { parts?: Array<{ title?: unknown; prompt?: unknown }> }
  try { parsed = JSON.parse(json) } catch { throw new Error('The planner did not return a usable plan. Try rephrasing the task.') }
  const parts = (parsed.parts ?? [])
    .filter(p => typeof p.title === 'string' && typeof p.prompt === 'string' && p.prompt.trim())
    .map(p => ({ title: String(p.title).slice(0, 60), prompt: String(p.prompt) }))
    .slice(0, 4)
  if (!parts.length) throw new Error('The planner returned no parts. Try rephrasing the task.')
  return parts
}

/** Note each worker gets about the others, so it stays in its lane. */
export function laneNote(parts: SwarmPart[], index: number): string {
  const others = parts.filter((_, i) => i !== index).map(p => `- ${p.title}`).join('\n')
  return others
    ? `Other threads are working on these parts at the same time, in separate copies of the repo:\n${others}\nOnly change what your own part needs; don't do their work.`
    : ''
}
