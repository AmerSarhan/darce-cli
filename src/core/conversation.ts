import type { Message } from '../types.js'
import { estimateMessagesTokens } from '../utils/tokens.js'

const MAX_CONTEXT_TOKENS = 100000  // Compact when over this

export function shouldCompact(messages: Message[]): boolean {
  return estimateMessagesTokens(messages) > MAX_CONTEXT_TOKENS
}

export function compactMessages(messages: Message[]): Message[] {
  // Keep: first message (user's original request), last 6 messages (recent context)
  // Summarize everything in between as a system message
  if (messages.length <= 8) return messages

  const first = messages[0]!
  const start = safeStart(messages, messages.length - 6)
  if (start <= 1) return messages
  const recent = messages.slice(start)

  // Build a summary of the middle messages
  const middle = messages.slice(1, start)
  const toolCalls = middle.filter(m =>
    Array.isArray(m.content) && m.content.some(b => typeof b === 'object' && 'type' in b && (b.type === 'tool_use' || b.type === 'tool_result'))
  ).length
  const textMessages = middle.filter(m => typeof m.content === 'string' ||
    (Array.isArray(m.content) && m.content.some(b => typeof b === 'object' && 'type' in b && b.type === 'text'))
  ).length

  const summary: Message = {
    role: 'user',
    content: `[Context compacted: ${middle.length} messages removed (${textMessages} exchanges, ${toolCalls} tool operations). Continuing from recent context.]`
  }

  return [first, summary, ...recent]
}

const isToolResult = (m: Message) =>
  Array.isArray(m.content) && m.content.some(b => typeof b === 'object' && 'type' in b && b.type === 'tool_result')

/**
 * Move a cut point back so the kept tail never starts with a tool_result whose
 * tool_use was dropped — providers reject such histories.
 */
export function safeStart(messages: Message[], start: number): number {
  let i = Math.max(0, start)
  while (i > 0 && isToolResult(messages[i]!)) i--
  return i
}

/** Keep roughly the last `keep` messages, cutting only at a safe boundary. */
export function keepRecent(messages: Message[], keep: number): Message[] {
  if (messages.length <= keep) return messages
  return messages.slice(safeStart(messages, messages.length - keep))
}
