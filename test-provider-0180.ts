// Provider and side-model fixes: last SSE frame at EOF, Esc during a snapshot, timeouts on suggest/critic/listModels, HTML error pages.
// Everything runs against local mock servers or a mock provider: no network, no credentials.
import './test-home.js'
import http from 'node:http'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenRouterProvider } from './src/providers/openrouter.js'
import { query } from './src/core/query.js'
import { registerAllTools } from './src/tools/index.js'
import { predictNext } from './src/core/suggest.js'
import { reviewEdit } from './src/core/critic.js'
import type { Provider } from './src/providers/provider.js'
import type { Message, StreamEvent } from './src/types.js'

type Test = (name: string, fn: () => boolean | Promise<boolean>) => Promise<void>

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const txt = (s: string, fin?: string) => ({ choices: [{ delta: { content: s }, finish_reason: fin ?? null }] })
const NO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

const scenarios: Record<string, (res: http.ServerResponse) => Promise<void> | void> = {
  async eofNoBlank(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame(txt('Hello')))
    await sleep(20)
    res.end(`data: ${JSON.stringify(txt(' world', 'stop'))}\n`)
  },
  usageNoBlank(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame(txt('Hi', 'stop')))
    res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}`)
  },
  cutOff(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(frame(txt('Half an ans')))
  },
  html403(res) {
    res.writeHead(403, { 'content-type': 'text/html' })
    res.end('<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>' + '<div class="cf">x</div>'.repeat(300) + '</body></html>')
  },
  longText400(res) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('bad request '.repeat(200))
  },
  async keepalive(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (let i = 0; i < 40 && !res.destroyed; i++) { res.write(': OPENROUTER PROCESSING\n\n'); await sleep(50) }
    res.end()
  },
  models500(res) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('oops')
  },
  async modelsSlow(res) {
    await sleep(2000)
    if (!res.destroyed) res.end('{"data":[]}')
  },
}

async function collect(p: Provider): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of p.stream([{ role: 'user', content: 'hi' }], 'm/x', [])) out.push(e)
  return out
}

/** A provider that streams some text and then goes quiet until the caller gives up. */
function partialProvider(text: string): Provider {
  return {
    async *stream(_m, _model, _t, signal) {
      yield { type: 'text_delta', text }
      await new Promise<void>(r => { if (signal?.aborted) r(); signal?.addEventListener('abort', () => r(), { once: true }) })
    },
    async listModels() { return [] },
  }
}

export async function testProvider0180(test: Test) {
  const server = http.createServer((req, res) => {
    req.resume()
    void scenarios[req.url!.split('/')[1]!]?.(res)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const P = (name: string) => new OpenRouterProvider('test', `http://127.0.0.1:${port}/${name}`)

  try {
    await test('Provider: a last frame without its blank line still completes the answer', async () => {
      const ev = await collect(P('eofNoBlank'))
      const done = ev.find(e => e.type === 'message_complete')
      return !ev.some(e => e.type === 'error') && !!done && done.type === 'message_complete' && JSON.stringify(done.message.content).includes('Hello world')
    })

    await test('Provider: a trailing usage frame without its blank line keeps the usage', async () => {
      const done = (await collect(P('usageNoBlank'))).find(e => e.type === 'message_complete')
      return done?.type === 'message_complete' && done.usage.total_tokens === 9
    })

    await test('Provider: a stream that ends mid-answer is still an error', async () => {
      const ev = await collect(P('cutOff'))
      return !ev.some(e => e.type === 'message_complete') && ev.some(e => e.type === 'error' && /closed mid-answer/.test(e.error))
    })

    await test('Provider: an HTML error page is reduced to its title', async () => {
      const err = (await collect(P('html403'))).find(e => e.type === 'error')
      return err?.type === 'error' && err.error.length < 200 && err.error.includes('Attention Required') && !err.error.includes('<')
    })

    await test('Provider: a long plain error body is capped', async () => {
      const err = (await collect(P('longText400'))).find(e => e.type === 'error')
      return err?.type === 'error' && err.error.startsWith('API error 400: bad request') && err.error.length <= 330
    })

    await test('Provider: listModels rejects on an HTTP error', async () => {
      try { await P('models500').listModels(); return false } catch (err) { return /HTTP 500/.test((err as Error).message) }
    })

    await test('Provider: listModels gives up after its timeout', async () => {
      const t0 = Date.now()
      try { await P('modelsSlow').listModels(150); return false } catch { return Date.now() - t0 < 1500 }
    })

    await test('Suggest: a timeout mid-stream returns no guess instead of half a sentence', async () => {
      const t0 = Date.now()
      const guess = await predictNext(partialProvider('run the'), 'm/x', [{ role: 'user', content: 'add a users table' }], undefined, 150)
      return guess === null && Date.now() - t0 < 1500
    })

    await test('Critic: a timeout mid-stream returns no verdict', async () => {
      const diff = { path: 'a.ts', hunks: [], added: 1, removed: 0 } as any
      return await reviewEdit(partialProvider('OK'), 'm/x', 'task', diff, undefined, 150) === null
    })

    await test('Critic: keep-alives alone cannot hold the review open past its timeout', async () => {
      const diff = { path: 'a.ts', hunks: [], added: 1, removed: 0 } as any
      const t0 = Date.now()
      const v = await reviewEdit(P('keepalive'), 'm/x', 'task', diff, new AbortController().signal, 250)
      return v === null && Date.now() - t0 < 1500
    })

    await test('Query: Esc during the snapshot stops a Write and still answers its tool call', async () => {
      registerAllTools()
      const dir = mkdtempSync(join(tmpdir(), 'darce-q0180-'))
      const target = join(dir, 'b.txt')
      const provider: Provider = {
        async *stream() {
          yield { type: 'message_complete', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: target, content: 'x' } }] }, usage: NO_USAGE }
        },
        async listModels() { return [] },
      }
      const ac = new AbortController()
      let after = 0
      const results: string[] = []
      const gen = query({
        messages: [{ role: 'user', content: 'go' }], model: 'm/x', provider, cwd: dir, systemPrompt: 's', readFiles: new Set(), abortSignal: ac.signal, maxTurns: 1,
        beforeChange: async () => { ac.abort() },
        afterChange: () => { after++ },
      })
      let r = await gen.next()
      while (!r.done) { if (r.value.type === 'tool_result_ready') results.push(r.value.result); r = await gen.next() }
      const msgs = r.value.messages as Message[]
      const paired = msgs.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'w1' && b.is_error))
      return !existsSync(target) && results[0] === 'Not run: the user interrupted.' && paired && after === 1 && r.value.reason === 'aborted'
    })
  } finally {
    server.closeAllConnections()
    server.close()
  }
}
