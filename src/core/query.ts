import type { Message, StreamEvent, ToolContext, ContentBlock, ToolUseContent, ToolDisplay, SpawnRequest } from '../types.js'
import type { Provider, OpenRouterTool } from '../providers/provider.js'
import { getTool, allTools } from '../tools/registry.js'
import { toAPITools } from '../tools/registry.js'
import { addUsage } from '../state/costTracker.js'
import { debug, trace } from '../utils/logger.js'
import { shouldCompact, compactMessages } from './conversation.js'
import { redactSecrets } from '../utils/redact.js'

export type QueryParams = {
  messages: Message[]
  /** A fixed model, or a getter read before every request (lets the user shift gears mid-task) */
  model: string | (() => string)
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
  beforeChange?: (call: { id: string; name: string; input: Record<string, unknown> }) => void
  /** Limit which tools the model is offered (threads get a subset) */
  toolFilter?: (name: string) => boolean
  /** Lets the Agent tool start sub-agent threads */
  spawnAgent?: (req: SpawnRequest) => Promise<{ report: string; isError?: boolean }>
}

export type QueryResult = {
  reason: 'completed' | 'max_turns' | 'error' | 'aborted'
  messages: Message[]
}

export async function* query(params: QueryParams): AsyncGenerator<StreamEvent, QueryResult> {
  const { provider, systemPrompt, maxTurns = 50 } = params
  let messages = [...params.messages]
  let turnCount = 0
  // Threads only exist where something can run them (the interactive app)
  const tools = toAPITools().filter(t => (t.function.name !== 'Agent' || !!params.spawnAgent) && (!params.toolFilter || params.toolFilter(t.function.name)))
  const retriedToolIds = new Set<string>()

  const toolContext: ToolContext = {
    cwd: params.cwd,
    readFiles: params.readFiles,
    abortSignal: params.abortSignal,
    passEnv: params.passEnv,
    spawnAgent: params.spawnAgent,
  }

  // Prepend system message
  const systemMessage: Message = { role: 'system', content: systemPrompt }

  while (true) {
    turnCount++
    if (turnCount > maxTurns) {
      trace('max_turns', { turns: maxTurns })
      return { reason: 'max_turns', messages }
    }

    if (shouldCompact(messages)) {
      messages = compactMessages(messages)
      debug('Context compacted')
    }

    if (params.abortSignal?.aborted) {
      return { reason: 'aborted', messages }
    }

    // Stream from provider — the model is re-read every turn
    const model = typeof params.model === 'function' ? params.model() : params.model
    const allMessages = [systemMessage, ...messages]
    const toolUseBlocks: ToolUseContent[] = []
    let assistantMessage: Message | null = null

    for await (const event of provider.stream(allMessages, model, tools, params.abortSignal)) {
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
        addUsage(model, event.usage)
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

    const record = (id: string, content: string, isError?: boolean) => {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] })
    }

    // Approve one call (approvals are always asked one at a time)
    async function approve(block: ToolUseContent): Promise<{ ok: true; via?: string } | { ok: false; denied: string }> {
      if (params.abortSignal?.aborted) return { ok: false, denied: 'Not run: the user interrupted.' }
      const asked = Date.now()
      const decision = params.authorize
        ? await params.authorize({ id: block.id, name: block.name, input: block.input })
        : { allow: true as const }
      if (Date.now() - asked > 500) trace('approval', { tool: block.name, waitedMs: Date.now() - asked, allowed: decision.allow })
      return decision.allow ? { ok: true, via: decision.via } : { ok: false, denied: `Not run: ${decision.reason}` }
    }

    function finish(block: ToolUseContent, executed: { result: string; isError?: boolean; display?: ToolDisplay }, started: number): StreamEvent {
      // Never send credentials to the model, even if a file or command printed them
      const { text: result, count: redacted } = redactSecrets(executed.result)
      trace('tool', { tool: block.name, ms: Date.now() - started, error: !!executed.isError, chars: result.length })
      if (executed.isError && !retriedToolIds.has(block.id)) retriedToolIds.add(block.id)
      record(block.id, result, executed.isError)
      return { type: 'tool_result_ready', id: block.id, name: block.name, result, isError: executed.isError, durationMs: Date.now() - started, display: executed.display, redacted }
    }

    // Run the calls in the model's order. Consecutive read-only, concurrency-safe calls (reads,
    // searches, research threads) run at the same time; anything that changes the project runs alone.
    debug(`Executing ${toolUseBlocks.length} tool(s)`)
    let i = 0
    while (i < toolUseBlocks.length) {
      const first = toolUseBlocks[i]!
      const parallelOk = (b: ToolUseContent) => { const t = getTool(b.name); return !!(t?.isReadOnly && t?.isConcurrencySafe) }
      const batch: ToolUseContent[] = [first]
      if (parallelOk(first)) while (i + batch.length < toolUseBlocks.length && parallelOk(toolUseBlocks[i + batch.length]!)) batch.push(toolUseBlocks[i + batch.length]!)
      i += batch.length

      const approved: { block: ToolUseContent; via?: string }[] = []
      for (const block of batch) {
        const a = await approve(block)
        if (!a.ok) {
          if (!params.abortSignal?.aborted) yield { type: 'tool_result_ready', id: block.id, name: block.name, result: a.denied, isError: true, durationMs: 0, denied: true }
          record(block.id, a.denied, true)
        } else approved.push({ block, via: a.via })
      }
      if (!approved.length) continue

      if (approved.length === 1) {
        const { block, via } = approved[0]!
        if (!getTool(block.name)?.isReadOnly) params.beforeChange?.({ id: block.id, name: block.name, input: block.input })
        yield { type: 'tool_executing', id: block.id, name: block.name, input: block.input, via }
        const started = Date.now()
        yield finish(block, await executeTool(block), started)
        continue
      }

      for (const { block, via } of approved) yield { type: 'tool_executing', id: block.id, name: block.name, input: block.input, via }
      const started = Date.now()
      const done = await Promise.all(approved.map(({ block }) => executeTool(block)))
      for (const executed of done) yield finish(executed.block, executed, started)
    }

    if (params.abortSignal?.aborted) {
      return { reason: 'aborted', messages }
    }
    // Loop continues — model will see tool results
  }
}
