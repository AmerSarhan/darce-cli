import type { Message, StreamEvent } from '../types.js'

export type OpenRouterTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// Tool inputs whose JSON arguments never finished (cut off by max tokens or a dropped stream). Kept
// out of band so history still holds a valid `{}` input for the API.
const cutOffInputs = new WeakSet<object>()
export function markCutOff(input: Record<string, unknown>): Record<string, unknown> { cutOffInputs.add(input); return input }
export function isCutOff(input: Record<string, unknown>): boolean { return cutOffInputs.has(input) }

export interface Provider {
  stream(messages: Message[], model: string, tools: OpenRouterTool[], signal?: AbortSignal): AsyncGenerator<StreamEvent>
  listModels(): Promise<Array<{ id: string; name: string }>>
  setCredentials?(apiKey: string, baseUrl?: string): void
  /** Keeps a conversation on one upstream provider so its prompt cache is reused */
  setSession?(id: string): void
}
