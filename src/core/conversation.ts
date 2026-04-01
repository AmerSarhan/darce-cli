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
  const recent = messages.slice(-6)

  // Build a summary of the middle messages
  const middle = messages.slice(1, -6)
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
