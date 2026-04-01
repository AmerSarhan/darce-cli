import type { Message, StreamEvent, ToolContext, ContentBlock, ToolUseContent } from '../types.js'
import type { Provider, OpenRouterTool } from '../providers/provider.js'
import { getTool, allTools } from '../tools/registry.js'
import { toAPITools } from '../tools/registry.js'
import { addUsage } from '../state/costTracker.js'
import { debug } from '../utils/logger.js'

export type QueryParams = {
  messages: Message[]
  model: string
  provider: Provider
  cwd: string
  systemPrompt: string
  maxTurns?: number
  readFiles: Set<string>
  abortSignal?: AbortSignal
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

  const toolContext: ToolContext = {
    cwd: params.cwd,
    readFiles: params.readFiles,
    abortSignal: params.abortSignal,
  }

  // Prepend system message
  const systemMessage: Message = { role: 'system', content: systemPrompt }

  while (true) {
    turnCount++
    if (turnCount > maxTurns) {
      return { reason: 'max_turns', messages }
    }

    if (params.abortSignal?.aborted) {
      return { reason: 'aborted', messages }
    }

    // Stream from provider
    const allMessages = [systemMessage, ...messages]
    const toolUseBlocks: ToolUseContent[] = []
    let assistantMessage: Message | null = null

    for await (const event of provider.stream(allMessages, params.model, tools)) {
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
      return { reason: 'error', messages }
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

    async function executeTool(block: ToolUseContent): Promise<{ block: ToolUseContent; result: string; isError?: boolean }> {
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
        return { block, result: tool.formatResult(result.data), isError: result.isError }
      } catch (err: any) {
        return { block, result: `Tool error: ${err.message}`, isError: true }
      }
    }

    // Execute all tools and yield live events
    const allBlocks = [...concurrent, ...sequential]
    for (const block of allBlocks) {
      // Tell the REPL which tool is running
      yield { type: 'tool_executing', name: block.name, input: block.input } as StreamEvent

      const { result, isError } = await executeTool(block)

      // Tell the REPL the result
      yield { type: 'tool_result_ready', name: block.name, result, isError } as StreamEvent

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

    // Loop continues — model will see tool results
  }
}
