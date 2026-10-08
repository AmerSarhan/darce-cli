import type { Provider } from '../providers/provider.js'
import type { ContentBlock, Message } from '../types.js'
import { addUsage } from '../state/costTracker.js'

// Fast non-reasoning model: answers in ~2s (reasoning "flash" models took 15-20s)
export const DEFAULT_SUGGEST_MODEL = 'qwen/qwen3-coder-next'

/** A compact transcript of the last few turns: what the user asked, what Darce did and said. */
function recap(messages: Message[]): string {
  const lines: string[] = []
  for (const m of messages.slice(-14)) {
    if (typeof m.content === 'string') {
      if (m.role === 'user') lines.push(`User: ${m.content.replace(/\[Note from Darce:[^\]]*\]\s*/g, '').split('\n\nFiles the user attached:')[0]!.slice(0, 400)}`)
      else if (m.role === 'assistant') lines.push(`Darce: ${m.content.slice(0, 500)}`)
      continue
    }
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'text' && b.text.trim()) lines.push(`${m.role === 'user' ? 'User' : 'Darce'}: ${b.text.slice(0, 500)}`)
      if (b.type === 'tool_use') lines.push(`Darce ran ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`)
    }
  }
  return lines.slice(-20).join('\n')
}

/**
 * Predict the user's most likely next request. Returns null when there's no
 * confident guess, on any error, or when it would take too long.
 */
export async function predictNext(provider: Provider, model: string, messages: Message[], signal?: AbortSignal): Promise<string | null> {
  const prompt = [
    'Here is the end of a session between a developer and Darce, a coding agent in their terminal:',
    '',
    recap(messages),
    '',
    'Predict the single most likely next thing the developer will type. Write it exactly as they would: a short instruction in their voice, under 12 words, no quotes, no trailing period.',
    'Good examples: "run the tests", "commit this", "now add the same check to signup", "deploy it to staging".',
    'If there is no clear next step, reply with exactly NONE.',
  ].join('\n')

  let text = ''
  const timeout = AbortSignal.timeout(8000)
  try {
    for await (const e of provider.stream(
      [{ role: 'system', content: 'You predict what a developer will type next. Reply with the prediction only.' }, { role: 'user', content: prompt }],
      model,
      [],
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    )) {
      if (e.type === 'text_delta') text += e.text
      if (e.type === 'message_complete') addUsage(model, e.usage)
      if (e.type === 'error') return null
    }
  } catch {
    return null
  }
  const guess = text.trim().split('\n')[0]!.replace(/^["'`>\s-]+|["'`.\s]+$/g, '')
  if (!guess || /^none$/i.test(guess) || guess.length > 100) return null
  return guess
}
