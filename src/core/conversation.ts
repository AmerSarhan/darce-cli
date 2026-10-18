import type { Message, ContentBlock, ToolUseContent } from '../types.js'
import { estimateMessagesTokens } from '../utils/tokens.js'

const MAX_CONTEXT_TOKENS = 100000  // Compact when over this
const TRIM_KEEP = 2048  // chars kept at each end of a trimmed tool result

export function shouldCompact(messages: Message[]): boolean {
  return estimateMessagesTokens(messages) > MAX_CONTEXT_TOKENS
}

/** Index of the user's latest typed message (tool results don't count). */
function lastUserTurn(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user' && !isToolResult(messages[i]!)) return i
  return -1
}

function trimMiddle(text: string): string {
  if (text.length <= TRIM_KEEP * 2 + 200) return text
  return `${text.slice(0, TRIM_KEEP)}\n[trimmed ${text.length - TRIM_KEEP * 2} characters]\n${text.slice(-TRIM_KEEP)}`
}

/** Shrink bulky blocks in place of dropping messages; tool_use/tool_result ids are untouched. */
function slim(m: Message, trimResults: boolean, dropImages: boolean): Message {
  if (!Array.isArray(m.content) || (!trimResults && !dropImages)) return m
  let changed = false
  const content = m.content.map((b): ContentBlock => {
    if (trimResults && b.type === 'tool_result') {
      const text = trimMiddle(b.content)
      if (text !== b.content) { changed = true; return { ...b, content: text } }
    }
    if (dropImages && b.type === 'image') {
      changed = true
      return { type: 'text', text: `\n[Image${b.name ? ` ${b.name}` : ''} removed to save context]` }
    }
    return b
  })
  return changed ? { ...m, content } : m
}

function slimAll(messages: Message[], trimBefore: number): Message[] {
  const turn = lastUserTurn(messages)
  return messages.map((m, i) => slim(m, i < trimBefore, i < turn))
}

export function compactMessages(messages: Message[]): Message[] {
  // Old tool output and images go first: often enough on its own, and nothing is lost from the thread
  const wasOver = shouldCompact(messages)
  const slimmed = slimAll(messages, messages.length - 6)
  if (wasOver && !shouldCompact(slimmed)) return slimmed
  const out = dropMiddle(slimmed)
  // Still too big: the kept tail itself is bulky
  return shouldCompact(out) ? slimAll(out, out.length) : out
}

function dropMiddle(messages: Message[]): Message[] {
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

export const MISSING_RESULT = 'No result: this tool call was interrupted before it ran.'

/**
 * Give every tool_use a tool_result in the messages right after it. A history without one is
 * rejected by every provider, so a session saved that way (crash, cut-off call) would never recover.
 */
export function repairToolPairs(messages: Message[]): Message[] {
  let out: Message[] | null = null
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    const uses = m.role === 'assistant' && Array.isArray(m.content) ? m.content.filter((b): b is ToolUseContent => b.type === 'tool_use') : []
    let j = i + 1
    const answered = new Set<string>()
    while (uses.length && j < messages.length && isToolResult(messages[j]!)) {
      for (const b of messages[j]!.content as ContentBlock[]) if (b.type === 'tool_result') answered.add(b.tool_use_id)
      j++
    }
    const missing = uses.filter(u => !answered.has(u.id))
    if (missing.length) out ??= messages.slice(0, i)
    out?.push(...messages.slice(i, j), ...missing.map((u): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: u.id, content: MISSING_RESULT, is_error: true }] })))
    i = j - 1
  }
  return out ?? messages
}

/** Keep roughly the last `keep` messages, cutting only at a safe boundary. */
export function keepRecent(messages: Message[], keep: number): Message[] {
  if (messages.length <= keep) return messages
  return messages.slice(safeStart(messages, messages.length - keep))
}

const usesTool = (m: Message, ids: (id: string) => boolean) =>
  m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && ids(b.id))

/**
 * Where to cut the conversation when the files are rewound to before step `toolUseId` (-1: not in it).
 * Normally right before the reply that took that step. When no change from the same turn is left
 * (`kept` holds the steps that stay), the user's request goes too: left unanswered at the end, it
 * reads as still to do, and the model does the rewound work again on the next message.
 */
export function rewindCut(messages: Message[], toolUseId: string, kept: Set<string>): number {
  const at = messages.findIndex(m => usesTool(m, id => id === toolUseId))
  if (at < 0) return -1
  let ask = at - 1
  while (ask >= 0 && !(messages[ask]!.role === 'user' && !isToolResult(messages[ask]!))) ask--
  if (ask < 0) return at
  return messages.slice(ask + 1, at).some(m => usesTool(m, id => kept.has(id))) ? at : ask
}

export const STOPPED_NOTE = '(Stopped by the user before this reply finished.)'

/**
 * After the user stops a turn, close it with a short reply. Otherwise the stopped request sits
 * unanswered next to the user's new message, and the model often answers the old one instead.
 */
export function markStopped(messages: Message[]): Message[] {
  const last = messages.at(-1)
  return last?.role === 'user' ? [...messages, { role: 'assistant', content: STOPPED_NOTE }] : messages
}
