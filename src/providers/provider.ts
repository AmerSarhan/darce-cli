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
  stream(messages: Message[], model: string, tools: OpenRouterTool[]): AsyncGenerator<StreamEvent>
  listModels(): Promise<Array<{ id: string; name: string }>>
}
