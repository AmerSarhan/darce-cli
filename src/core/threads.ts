import { query, type QueryParams } from './query.js'
import { buildSystemPrompt } from './context.js'
import { getModelProfile } from '../config/models.js'
import type { Provider } from '../providers/provider.js'
import type { Message } from '../types.js'

/**
 * Threads: sub-agents with their own fresh context, started by the main agent (Agent tool)
 * or by /swarm. Each reports back in text; the main conversation only sees the report.
 */
export type ThreadKind = 'explore' | 'work' | 'swarm'

export type Thread = {
  id: number
  title: string
  kind: ThreadKind
  model: string
  status: 'queued' | 'running' | 'done' | 'error' | 'stopped'
  activity: string
  steps: number
  cost: number
  startedAt: number
  ms: number
  /** Tool calls as one-line summaries, newest last */
  log: string[]
  report: string
  error?: string
}

/** Tools an explore thread may use: reading and research only. */
export const EXPLORE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'StealthFetch', 'Skill'])
/** Tools no thread may use: no nested threads, no plans or memory writes on the user's behalf. */
const NEVER_IN_THREADS = new Set(['Agent', 'Plan', 'Remember'])

export function threadSystemPrompt(cwd: string, kind: ThreadKind): string {
  const role = kind === 'explore'
    ? 'You are a read-only research thread. You can read files and search, but not edit anything or run commands.'
    : 'You are a worker thread. You can read, edit files and run commands for your task only; stay inside its scope.'
  return [
    buildSystemPrompt(cwd),
    '',
    '# You are a thread',
    `${role} The main Darce agent started you for one focused task; it can't see your steps, only your final reply, and you can't ask the user anything.`,
    'Work efficiently. When you are done, reply with a compact report for the main agent: what you found or changed, with file paths and line numbers, and anything left unresolved. No preamble, no WHY notes.',
  ].join('\n')
}

export type RunThreadOptions = {
  thread: Thread
  prompt: string
  history?: Message[]
  cwd: string
  provider: Provider
  passEnv?: string[]
  signal: AbortSignal
  authorize: NonNullable<QueryParams['authorize']>
  beforeChange?: QueryParams['beforeChange']
  onUpdate: () => void
  maxTurns?: number
}

/** One-line summary of a tool call for a thread's log. */
function describe(name: string, input: Record<string, unknown>): string {
  const v = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query ?? ''
  const s = String(v).replace(/\s+/g, ' ')
  return `${name} ${s.length > 70 ? s.slice(0, 67) + '…' : s}`.trim()
}

export async function runThread(o: RunThreadOptions): Promise<void> {
  const { thread: t } = o
  const update = () => { t.ms = Date.now() - t.startedAt; o.onUpdate() }
  const price = getModelProfile(t.model)
  t.status = 'running'
  t.activity = 'thinking'
  t.startedAt = Date.now()
  update()
  try {
    const allowed = (name: string) => !NEVER_IN_THREADS.has(name) && (t.kind !== 'explore' || EXPLORE_TOOLS.has(name))
    const gen = query({
      messages: [...(o.history ?? []), { role: 'user', content: o.prompt }],
      model: t.model,
      provider: o.provider,
      cwd: o.cwd,
      systemPrompt: threadSystemPrompt(o.cwd, t.kind),
      maxTurns: o.maxTurns ?? 40,
      readFiles: new Set(),
      abortSignal: o.signal,
      passEnv: o.passEnv,
      toolFilter: allowed,
      authorize: async call => (allowed(call.name) ? o.authorize(call) : { allow: false as const, reason: `${call.name} isn't available in this thread.` }),
      beforeChange: o.beforeChange,
    })
    let text = ''
    let result = await gen.next()
    while (!result.done) {
      const e = result.value
      if (e.type === 'request_start') { text = ''; t.activity = 'thinking'; update() }
      if (e.type === 'text_delta') { text += e.text; if (t.activity !== 'writing') { t.activity = 'writing'; update() } }
      if (e.type === 'tool_executing') { t.steps++; t.activity = describe(e.name, e.input); t.log.push(t.activity); update() }
      if (e.type === 'message_complete' && price) {
        t.cost += (e.usage.prompt_tokens / 1000) * price.costPer1kInput + (e.usage.completion_tokens / 1000) * price.costPer1kOutput
      }
      if (e.type === 'error') t.error = e.error
      result = await gen.next()
    }
    t.report = text.trim()
    const reason = result.value.reason
    if (reason === 'aborted') t.status = 'stopped'
    else if (reason === 'error') { t.status = 'error'; t.error ??= 'request failed' }
    else if (reason === 'max_turns') { t.status = 'done'; t.report ||= 'Stopped after reaching the step limit without a final report.' }
    else t.status = 'done'
  } catch (err) {
    t.status = 'error'
    t.error = (err as Error).message.split('\n')[0]
  }
  t.activity = t.status
  update()
}

/** Runs async jobs one at a time (work threads share the working tree, so they never overlap). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }
}
