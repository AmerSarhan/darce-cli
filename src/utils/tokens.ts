// Fast approximation: ~4 chars per token (good enough for UI display)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: string | unknown[] }>): number {
  let total = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      total += estimateTokens(JSON.stringify(msg.content))
    }
  }
  return total
}
