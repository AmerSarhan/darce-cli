import { parseSSEFrames } from '../core/streaming.js'
import { debug, trace } from '../utils/logger.js'
import type { Message, StreamEvent, TokenUsage, ContentBlock } from '../types.js'
import type { Provider, OpenRouterTool } from './provider.js'
import { getModelProfile } from '../config/models.js'

/** Unknown models are assumed to accept images (the request fails loudly if not). */
function canSeeImages(model: string): boolean {
  const profile = getModelProfile(model)
  return !profile || profile.strengths.includes('vision')
}

function toOpenRouterMessages(messages: Message[], vision = true): Array<Record<string, unknown>> {
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

    // Text, optionally with images (OpenAI-compatible content parts)
    const textContent = blocks
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('')
    const images = blocks.filter(b => b.type === 'image')
    // A model that can't see images rejects any request containing one, even from earlier turns
    if (images.length > 0 && !vision) {
      const note = `[${images.length === 1 ? 'An image was' : `${images.length} images were`} shared here; the current model can't view images.]`
      result.push({ role: msg.role, content: textContent ? `${textContent}\n${note}` : note })
      continue
    }
    if (images.length > 0) {
      result.push({
        role: msg.role,
        content: [
          ...(textContent ? [{ type: 'text', text: textContent }] : []),
          ...images.map(img => ({ type: 'image_url', image_url: { url: `data:${(img as any).mediaType};base64,${(img as any).data}` } })),
        ],
      })
      continue
    }
    result.push({ role: msg.role, content: textContent || '' })
  }

  return result
}

export class OpenRouterProvider implements Provider {
  private baseUrl: string

  constructor(private apiKey: string, baseUrl?: string) {
    this.baseUrl = baseUrl || 'https://openrouter.ai/api'
  }

  /** Switch accounts without restarting. */
  private sessionId?: string
  setSession(id: string) { this.sessionId = id }

  setCredentials(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey
    if (baseUrl) this.baseUrl = baseUrl
  }

  /**
   * Stream one completion. A watchdog cancels the request when nothing arrives for STALL_MS
   * (OpenRouter sends keep-alive comments while a model thinks, so silence means a stuck provider).
   * A stall before any output is retried once; a stall mid-answer is reported instead of hanging.
   */
  async *stream(messages: Message[], model: string, tools: OpenRouterTool[], signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const STALL_MS = Number(process.env.DARCE_STALL_MS) || 45_000
    for (let attempt = 0; attempt < 2; attempt++) {
      const stall = new AbortController()
      const forward = () => stall.abort()
      if (signal?.aborted) return
      signal?.addEventListener('abort', forward, { once: true })
      let stalled = false
      let produced = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; stall.abort() }, STALL_MS) }
      arm()
      try {
        for await (const ev of this.streamOnce(messages, model, tools, stall.signal, arm)) {
          if (ev.type === 'error') trace('error', { model, error: ev.error.slice(0, 200) })
          if (ev.type !== 'request_start' && ev.type !== 'waiting') produced = true
          yield ev
        }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', forward)
      }
      if (signal?.aborted) trace('aborted', { model })
      if (stalled) trace('stall', { model, attempt, produced, after: STALL_MS })
      if (!stalled || signal?.aborted) return
      const secs = Math.round(STALL_MS / 1000)
      if (produced) {
        yield { type: 'error', error: `${model} stopped responding for ${secs}s mid-answer. Send your message again, or switch model with Shift+↑/↓.` }
        return
      }
      debug(`No response from ${model} in ${secs}s, retrying once`)
    }
    yield { type: 'error', error: `${model} didn't respond after two tries. Its provider may be overloaded: switch model with Shift+↑/↓ or /model.` }
  }

  private async *streamOnce(messages: Message[], model: string, tools: OpenRouterTool[], signal: AbortSignal, onActivity: () => void): AsyncGenerator<StreamEvent> {
    yield { type: 'request_start' }

    const body: Record<string, unknown> = {
      model,
      messages: toOpenRouterMessages(messages, canSeeImages(model)),
      stream: true,
    }
    if (tools.length > 0) {
      body.tools = tools
    }
    if (this.sessionId) body.session_id = this.sessionId
    const t0 = Date.now()
    const since = () => Date.now() - t0
    let keepalives = 0
    let cachedTokens = 0
    let firstByte = false
    let firstToken = false
    trace('request', { model, messages: messages.length, kb: Math.round(JSON.stringify(body).length / 1024), tools: tools.length })

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
          signal,
        })

        onActivity()
        trace('headers', { model, status: response.status, ms: since() })
        if (response.status === 429 && retries < maxRetries) {
          retries++
          const delay = Math.min(1000 * Math.pow(2, retries), 8000)
          debug(`Rate limited, retrying in ${delay}ms (attempt ${retries})`)
          await new Promise(r => setTimeout(r, delay))
          if (signal?.aborted) return
          continue
        }

        if (!response.ok) {
          const errorText = await response.text()
          let message = errorText
          try { const j = JSON.parse(errorText); message = j.message || j.error?.message || (typeof j.error === 'string' ? j.error : '') || errorText } catch {}
          yield { type: 'error', error: response.status === 403 || response.status === 429 ? message : `API error ${response.status}: ${message}` }
          return
        }

        break
      } catch (err) {
        if (signal?.aborted) return
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
        let readResult: ReadableStreamReadResult<Uint8Array>
        try {
          readResult = await reader.read()
        } catch (err) {
          if (signal?.aborted) return
          yield { type: 'error', error: `Connection lost: ${(err as Error).message}` }
          return
        }
        const { done, value } = readResult
        if (done) { trace('stream_end', { model, ms: since(), keepalives, sawDone: false }); break }
        onActivity()
        if (!firstByte) { firstByte = true; trace('first_byte', { model, ms: since() }) }

        const text = decoder.decode(value, { stream: true })
        keepalives += text.split('OPENROUTER PROCESSING').length - 1
        // The server says how long it has been waiting for a provider to start
        const wait = /: darce waiting (\d+)s( hedged)?/g
        let w: RegExpExecArray | null, lastWait: RegExpExecArray | null = null
        while ((w = wait.exec(text))) lastWait = w
        if (lastWait && !firstToken) yield { type: 'waiting', seconds: Number(lastWait[1]), hedged: !!lastWait[2] }
        buffer += text
        const { frames, remaining } = parseSSEFrames(buffer)
        buffer = remaining

        for (const frame of frames) {
          if (frame.data === '[DONE]') {
            trace('done', { model, ms: since(), tokens: usage.total_tokens, cached: cachedTokens, keepalives, chars: fullContent.length, toolCalls: activeToolCalls.size })
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
          if (!firstToken && (chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.delta?.tool_calls)) {
            firstToken = true
            trace('first_token', { model, ms: since(), keepalives })
          }
          if (chunk.error) {
            const message = String(chunk.error?.message ?? chunk.error)
            trace('upstream_error', { model, ms: since(), error: message.slice(0, 200) })
            if (!fullContent && activeToolCalls.size === 0) { yield { type: 'error', error: `${model.split('/').pop()}: ${message}` }; return }
          }

          // Extract usage if present
          if (chunk.usage) {
            cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
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
