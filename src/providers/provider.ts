import type { Message, StreamEvent } from '../types.js'

export type OpenRouterTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface Provider {
  stream(messages: Message[], model: string, tools: OpenRouterTool[], signal?: AbortSignal): AsyncGenerator<StreamEvent>
  listModels(): Promise<Array<{ id: string; name: string }>>
  setCredentials?(apiKey: string, baseUrl?: string): void
  /** Keeps a conversation on one upstream provider so its prompt cache is reused */
  setSession?(id: string): void
}
