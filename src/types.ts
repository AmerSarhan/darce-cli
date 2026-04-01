import { z } from 'zod'

// === Message Types ===

export type Role = 'user' | 'assistant' | 'system'

export type TextContent = {
  type: 'text'
  text: string
}

export type ToolUseContent = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolResultContent = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent

export type Message = {
  role: Role
  content: string | ContentBlock[]
}

// === Stream Events ===

export type StreamEvent =
  | { type: 'request_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; json: string }
  | { type: 'tool_use_end'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_complete'; message: Message; usage: TokenUsage }
  | { type: 'error'; error: string }

export type SpinnerMode = 'idle' | 'requesting' | 'thinking' | 'responding' | 'tool-input' | 'tool-use'

// === Token / Cost ===

export type TokenUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

// === Tool Types ===

export type ToolResult<T = unknown> = {
  data: T
  isError?: boolean
}

export type ToolContext = {
  cwd: string
  readFiles: Set<string>
  abortSignal?: AbortSignal
}

// === Config Types ===

export type RouterRule = {
  when: 'large-context' | 'quick-question' | 'complex-reasoning' | 'image-input'
  use: string
}

export type RouterConfig = {
  default: string
  budget?: 'low' | 'medium' | 'high'
  rules: RouterRule[]
}

export type DarceConfig = {
  apiKey: string
  apiBase?: string
  router: RouterConfig
  theme: 'dark' | 'light' | 'auto'
  shell: string
  maxTurns: number
  historyPath: string
}

// === Model Info ===

export type ModelProfile = {
  id: string
  strengths: string[]
  contextWindow: number
  costPer1kInput: number
  costPer1kOutput: number
}

// === App State ===

export type AppState = {
  config: DarceConfig
  messages: Message[]
  streamingText: string | null
  spinnerMode: SpinnerMode
  currentModel: string
  sessionId: string
  cwd: string
  readFiles: Set<string>
  modelOverride: string | null
}
