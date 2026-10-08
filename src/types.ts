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

export type ImageContent = {
  type: 'image'
  mediaType: string // image/png, image/jpeg, …
  data: string // base64
  name?: string
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent | ImageContent

export type Message = {
  role: Role
  content: string | ContentBlock[]
}

// === Stream Events ===

export type StreamEvent =
  | { type: 'request_start'; model?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; json: string }
  | { type: 'tool_use_end'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_complete'; message: Message; usage: TokenUsage }
  | { type: 'tool_executing'; id: string; name: string; input: Record<string, unknown>; via?: string }
  | { type: 'tool_result_ready'; id: string; name: string; result: string; isError?: boolean; durationMs: number; display?: ToolDisplay; denied?: boolean; redacted?: number }
  | { type: 'error'; error: string }

export type SpinnerMode = 'idle' | 'requesting' | 'thinking' | 'responding' | 'tool-input' | 'tool-use'

// === Token / Cost ===

export type TokenUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

// === Tool Types ===

export type PlanDisplay = { kind: 'plan'; items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }> }
export type ToolDisplay = import('./utils/diff.js').FileDiff | PlanDisplay

export type ToolResult<T = unknown> = {
  data: T
  isError?: boolean
  /** Rich rendering for the terminal (never sent to the model) */
  display?: ToolDisplay
}

export type ToolContext = {
  cwd: string
  readFiles: Set<string>
  abortSignal?: AbortSignal
  passEnv?: string[]
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

export type PermissionMode = 'auto' | 'ask' | 'plan' | 'full'

export type DarceConfig = {
  /** auto: run safe steps, ask before risky ones (default) · ask: ask before any change · plan: read-only · full: never ask */
  mode?: PermissionMode
  apiKey: string
  apiBase?: string
  router: RouterConfig
  theme: 'dark' | 'light' | 'auto'
  shell: string
  maxTurns: number
  historyPath: string
  /** Models for Shift+↑/↓, cheapest first */
  gears?: string[]
  /** Second-opinion reviews of every edit */
  critic?: boolean
  criticModel?: string
  /** Used for messages with images when the current model can't see them */
  visionModel?: string
  /** Suggest the next prompt after each task (uses a small fast model) */
  suggestions?: boolean
  suggestModel?: string
  /** Models raced by /derby */
  derbyModels?: string[]
  /** Environment variables Bash may see even though they look like secrets */
  passEnv?: string[]
}

// === Model Info ===

export type ModelProfile = {
  id: string
  name?: string
  created?: number
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
  mode: PermissionMode
}
