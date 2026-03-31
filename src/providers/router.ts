import type { Message, RouterConfig } from '../types.js'
import { estimateMessagesTokens } from '../utils/tokens.js'

function hasToolResults(messages: Message[]): boolean {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') return true
      }
    }
  }
  return false
}

function countToolRounds(messages: Message[]): number {
  let rounds = 0
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && 'type' in block && block.type === 'tool_use') {
          rounds++
          break
        }
      }
    }
  }
  return rounds
}

function hasImageContent(message: Message): boolean {
  if (Array.isArray(message.content)) {
    return message.content.some(b => typeof b === 'object' && 'type' in b && (b as any).type === 'image')
  }
  return false
}

function matchesCondition(condition: string, messages: Message[]): boolean {
  const tokens = estimateMessagesTokens(messages)
  const lastMsg = messages[messages.length - 1]

  switch (condition) {
    case 'large-context':
      return tokens > 100000
    case 'quick-question':
      return tokens < 500 && !hasToolResults(messages)
    case 'complex-reasoning':
      return countToolRounds(messages) >= 3 && tokens > 10000
    case 'image-input':
      return lastMsg ? hasImageContent(lastMsg) : false
    default:
      return false
  }
}

export function selectModel(messages: Message[], config: RouterConfig): string {
  for (const rule of config.rules) {
    if (matchesCondition(rule.when, messages)) {
      return rule.use
    }
  }
  return config.default
}
