import type { Message, StreamEvent, ToolContext, ContentBlock, ToolUseContent, ToolDisplay } from '../types.js'
import type { Provider, OpenRouterTool } from '../providers/provider.js'
import { getTool, allTools } from '../tools/registry.js'
import { toAPITools } from '../tools/registry.js'
import { addUsage } from '../state/costTracker.js'
import { debug } from '../utils/logger.js'
import { shouldCompact, compactMessages } from './conversation.js'
import { redactSecrets } from '../utils/redact.js'

export type QueryParams = {
  messages: Message[]
  model: string
  provider: Provider
  cwd: string
  systemPrompt: string
  maxTurns?: number
  readFiles: Set<string>
  abortSignal?: AbortSignal
  passEnv?: string[]
  /** Decide whether a tool call may run. Omitted = always allowed. */
  authorize?: (call: { id: string; name: string; input: Record<string, unknown> }) => Promise<{ allow: true; via?: string } | { allow: false; reason: string }>
  /** Called right before a tool that changes the project runs (used for undo snapshots). */
  beforeChange?: (call: { name: string; input: Record<string, unknown> }) => void
}

export type QueryResult = {
  reason: 'completed' | 'max_turns' | 'error' | 'aborted'
  messages: Message[]
}

export async function* query(params: QueryParams): AsyncGenerator<StreamEvent, QueryResult> {
  const { provider, systemPrompt, maxTurns = 50 } = params
  let messages = [...params.messages]
  let turnCount = 0
  const tools = toAPITools()
  const retriedToolIds = new Set<string>()

  const toolContext: ToolContext = {
    cwd: params.cwd,
    readFiles: params.readFiles,
    abortSignal: params.abortSignal,
    passEnv: params.passEnv,
  }

  // Prepend system message
  const systemMessage: Message = { role: 'system', content: systemPrompt }

  while (true) {
    turnCount++
    if (turnCount > maxTurns) {
      return { reason: 'max_turns', messages }
    }

    if (shouldCompact(messages)) {
      messages = compactMessages(messages)
      debug('Context compacted')
    }

    if (params.abortSignal?.aborted) {
      return { reason: 'aborted', messages }
    }

    // Stream from provider
    const allMessages = [systemMessage, ...messages]
    const toolUseBlocks: ToolUseContent[] = []
    let assistantMessage: Message | null = null

    for await (const event of provider.stream(allMessages, params.model, tools, params.abortSignal)) {
      yield event

      if (event.type === 'tool_use_end') {
        toolUseBlocks.push({
          type: 'tool_use',
          id: event.id,
          name: event.name,
          input: event.input,
        })
      }

      if (event.type === 'message_complete') {
        assistantMessage = event.message
        addUsage(params.model, event.usage)
      }

      if (event.type === 'error') {
        return { reason: 'error', messages }
      }
    }

    if (!assistantMessage) {
      // A partial answer is dropped on abort — history stays consistent
      return { reason: params.abortSignal?.aborted ? 'aborted' : 'error', messages }
    }

    messages.push(assistantMessage)

    // No tool calls — conversation complete
    if (toolUseBlocks.length === 0) {
      return { reason: 'completed', messages }
    }

    // Execute tools
    debug(`Executing ${toolUseBlocks.length} tool(s)`)

    // Separate concurrent-safe and sequential tools
    const concurrent: ToolUseContent[] = []
    const sequential: ToolUseContent[] = []

    for (const block of toolUseBlocks) {
      const tool = getTool(block.name)
      if (tool?.isReadOnly && tool?.isConcurrencySafe) {
        concurrent.push(block)
      } else {
        sequential.push(block)
      }
    }

    async function executeTool(block: ToolUseContent): Promise<{ block: ToolUseContent; result: string; isError?: boolean; display?: ToolDisplay }> {
      const tool = getTool(block.name)
      if (!tool) {
        return { block, result: `Unknown tool: ${block.name}`, isError: true }
      }
      // Validate input with Zod schema
      const parsed = tool.inputSchema.safeParse(block.input)
      if (!parsed.success) {
        const errors = parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ')
        return { block, result: `Invalid input: ${errors}`, isError: true }
      }
      try {
        const result = await tool.call(parsed.data, toolContext)
        return { block, result: tool.formatResult(result.data), isError: result.isError, display: result.display }
      } catch (err: any) {
        return { block, result: `Tool error: ${err.message}`, isError: true }
      }
    }

    // Execute all tools and yield live events
    const allBlocks = [...concurrent, ...sequential]
    for (const block of allBlocks) {
      // Every tool_use needs a tool_result, even when the user stops Darce mid-way
      if (params.abortSignal?.aborted) {
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: block.id, content: 'Not run: the user interrupted.', is_error: true }],
        })
        continue
      }

      const decision = params.authorize
        ? await params.authorize({ id: block.id, name: block.name, input: block.input })
        : { allow: true as const }

      if (!decision.allow) {
        const denied = `Not run: ${decision.reason}`
        yield { type: 'tool_result_ready', id: block.id, name: block.name, result: denied, isError: true, durationMs: 0, denied: true }
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: denied, is_error: true }] })
        continue
      }

      if (!getTool(block.name)?.isReadOnly) params.beforeChange?.({ name: block.name, input: block.input })

      yield { type: 'tool_executing', id: block.id, name: block.name, input: block.input, via: decision.via }

      const started = Date.now()
      const executed = await executeTool(block)
      const isError = executed.isError
      // Never send credentials to the model, even if a file or command printed them
      const result = redactSecrets(executed.result).text
      const durationMs = Date.now() - started

      // Track retried tool IDs to avoid infinite retry loops
      if (isError) {
        if (retriedToolIds.has(block.id)) {
          debug(`Tool ${block.name} (${block.id}) already retried, not retrying again`)
        } else {
          retriedToolIds.add(block.id)
          debug(`Tool ${block.name} (${block.id}) errored, marking for retry`)
        }
      }

      yield { type: 'tool_result_ready', id: block.id, name: block.name, result, isError, durationMs, display: executed.display }

      // Add to message history for the model
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
          is_error: isError,
        }],
      })
    }

    if (params.abortSignal?.aborted) {
      return { reason: 'aborted', messages }
    }
    // Loop continues — model will see tool results
  }
}
