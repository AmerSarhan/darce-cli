import { parseSSEFrames } from '../core/streaming.js'
import { debug } from '../utils/logger.js'
import type { Message, StreamEvent, TokenUsage, ContentBlock } from '../types.js'
import type { Provider, OpenRouterTool } from './provider.js'

function toOpenRouterMessages(messages: Message[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content })
      continue
    }

    const blocks = msg.content as ContentBlock[]

    // tool_result blocks → each becomes a separate "tool" role message
    const toolResults = blocks.filter(b => b.type === 'tool_result')
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        if (tr.type === 'tool_result') {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          })
        }
      }
      continue
    }

    // tool_use blocks → assistant message with tool_calls array
    const toolUses = blocks.filter(b => b.type === 'tool_use')
    if (toolUses.length > 0) {
      const textParts = blocks.filter(b => b.type === 'text')
      result.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.map(t => (t as any).text).join('') : null,
        tool_calls: toolUses.map(t => ({
          id: (t as any).id,
          type: 'function',
          function: {
            name: (t as any).name,
            arguments: JSON.stringify((t as any).input),
          },
        })),
      })
      continue
    }

    // Plain text blocks
    const textContent = blocks
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('')
    result.push({ role: msg.role, content: textContent || '' })
  }

  return result
}

export class OpenRouterProvider implements Provider {
  private baseUrl: string

  constructor(private apiKey: string, baseUrl?: string) {
    this.baseUrl = baseUrl || 'https://openrouter.ai/api'
  }

  async *stream(messages: Message[], model: string, tools: OpenRouterTool[]): AsyncGenerator<StreamEvent> {
    yield { type: 'request_start' }

    const body: Record<string, unknown> = {
      model,
      messages: toOpenRouterMessages(messages),
      stream: true,
    }
    if (tools.length > 0) {
      body.tools = tools
    }

    let response: Response
    let retries = 0
    const maxRetries = 3

    while (true) {
      try {
        response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://darce.dev',
            'X-Title': 'Darce',
          },
          body: JSON.stringify(body),
        })

        if (response.status === 429 && retries < maxRetries) {
          retries++
          const delay = Math.min(1000 * Math.pow(2, retries), 8000)
          debug(`Rate limited, retrying in ${delay}ms (attempt ${retries})`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }

        if (!response.ok) {
          const errorText = await response.text()
          yield { type: 'error', error: `API error ${response.status}: ${errorText}` }
          return
        }

        break
      } catch (err) {
        if (retries < maxRetries) {
          retries++
          const delay = Math.min(1000 * Math.pow(2, retries), 8000)
          debug(`Network error, retrying in ${delay}ms`, err)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        yield { type: 'error', error: `Network error: ${err}` }
        return
      }
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''
    let usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

    // Track active tool calls
    const activeToolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let toolEndsEmitted = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const { frames, remaining } = parseSSEFrames(buffer)
        buffer = remaining

        for (const frame of frames) {
          if (frame.data === '[DONE]') {
            // Build final message
            const contentBlocks: ContentBlock[] = []
            if (fullContent) {
              contentBlocks.push({ type: 'text', text: fullContent })
            }
            for (const tc of activeToolCalls.values()) {
              try {
                contentBlocks.push({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name,
                  input: JSON.parse(tc.arguments || '{}'),
                })
              } catch {
                contentBlocks.push({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name,
                  input: {},
                })
              }
            }

            yield {
              type: 'message_complete',
              message: {
                role: 'assistant',
                content: contentBlocks.length > 0 ? contentBlocks : fullContent,
              },
              usage,
            }
            return
          }

          let chunk: any
          try {
            chunk = JSON.parse(frame.data!)
          } catch {
            continue
          }

          // Extract usage if present
          if (chunk.usage) {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens ?? 0,
              completion_tokens: chunk.usage.completion_tokens ?? 0,
              total_tokens: chunk.usage.total_tokens ?? 0,
            }
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue

          const delta = choice.delta
          if (!delta) continue

          // Text content
          if (delta.content) {
            fullContent += delta.content
            yield { type: 'text_delta', text: delta.content }
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0

              if (tc.id) {
                // New tool call starting
                activeToolCalls.set(index, {
                  id: tc.id,
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                })
                yield {
                  type: 'tool_use_start',
                  id: tc.id,
                  name: tc.function?.name ?? '',
                }
              } else if (activeToolCalls.has(index)) {
                // Continuation of existing tool call
                const active = activeToolCalls.get(index)!
                if (tc.function?.name) active.name = tc.function.name
                if (tc.function?.arguments) {
                  active.arguments += tc.function.arguments
                  yield {
                    type: 'tool_use_delta',
                    id: active.id,
                    json: tc.function.arguments,
                  }
                }
              }
            }
          }

          // Check for finish_reason to emit tool_use_end (once only)
          if (!toolEndsEmitted && (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop')) {
            toolEndsEmitted = true
            for (const tc of activeToolCalls.values()) {
              let parsedInput: Record<string, unknown> = {}
              try { parsedInput = JSON.parse(tc.arguments || '{}') } catch {}
              yield {
                type: 'tool_use_end',
                id: tc.id,
                name: tc.name,
                input: parsedInput,
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    })
    const data = await res.json() as { data: Array<{ id: string; name: string }> }
    return data.data.map(m => ({ id: m.id, name: m.name }))
  }
}
