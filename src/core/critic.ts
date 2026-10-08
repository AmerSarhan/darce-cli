import type { Provider } from '../providers/provider.js'
import type { FileDiff } from '../utils/diff.js'
import { addUsage } from '../state/costTracker.js'

/** A different vendor than the one doing the work, so the review has different blind spots. */
export function pickCritic(workingModel: string, preferred?: string): string {
  if (preferred) return preferred
  return workingModel.startsWith('anthropic/') ? 'google/gemini-3.8-flash' : 'anthropic/claude-haiku-5.5'
}

function diffText(d: FileDiff): string {
  return d.hunks
    .map(h => h.lines.map(l => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text).join('\n'))
    .join('\n...\n')
}

export type Verdict = { ok: true } | { ok: false; issue: string }

/** Ask a second model whether an edit introduces a bug. Returns quickly; never throws. */
export async function reviewEdit(provider: Provider, model: string, task: string, diff: FileDiff, signal?: AbortSignal): Promise<Verdict | null> {
  const prompt = [
    `A coding agent made this change while working on: "${task.slice(0, 500)}"`,
    `File: ${diff.path}`,
    '```diff',
    diffText(diff).slice(0, 12_000),
    '```',
    'Does this change introduce a bug, security problem, or obvious mistake?',
    'Reply with exactly "OK" if not. Otherwise reply with ONE short sentence naming the most important problem (max 20 words).',
  ].join('\n')

  let text = ''
  try {
    for await (const e of provider.stream(
      [{ role: 'system', content: 'You are a terse, precise code reviewer.' }, { role: 'user', content: prompt }],
      model,
      [],
      signal,
    )) {
      if (e.type === 'text_delta') text += e.text
      if (e.type === 'message_complete') addUsage(model, e.usage)
      if (e.type === 'error') return null
    }
  } catch {
    return null
  }
  const answer = text.trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!answer) return null
  return /^ok\b[.!]?$/i.test(answer) ? { ok: true } : { ok: false, issue: answer.split('\n')[0]!.slice(0, 200) }
}
