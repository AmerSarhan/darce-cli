import { z } from 'zod'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { htmlToMarkdown, looksBlocked, cap } from '../web/html.js'
import { scrapifyConfig, scrapifyFetch } from '../web/scrapify.js'
import { VERSION } from '../version.js'

const inputSchema = z.object({
  url: z.string().describe('URL to fetch'),
  raw: z.boolean().optional().describe('Return the raw response body instead of readable markdown (for APIs, JSON, source files)'),
  headers: z.record(z.string(), z.string()).optional().describe('Optional HTTP headers'),
})

type Input = z.infer<typeof inputSchema>
type Output = { status: number; url: string; title?: string; body: string; via: 'direct' | 'stealth' }

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export const WebFetchTool: ToolDef<typeof inputSchema, Output> = {
  name: 'WebFetch',
  description: 'Fetch a URL. Web pages come back as readable markdown; JSON and text come back as-is (or pass raw: true). If a page is blocked by a bot wall, Darce retries in stealth mode automatically when it is configured.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<Output>> {
    let status = 0
    let body = ''
    let contentType = ''
    try {
      const res = await fetch(input.url, {
        headers: { 'User-Agent': input.headers?.['User-Agent'] ?? `${BROWSER_UA} Darce/${VERSION}`, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...(input.headers ?? {}) },
        signal: context.abortSignal ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        redirect: 'follow',
      })
      status = res.status
      contentType = res.headers.get('content-type') ?? ''
      body = await res.text()
    } catch (err) {
      body = `Fetch error: ${(err as Error).message}`
    }

    const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body)
    if ((status === 0 || looksBlocked(status, body)) && scrapifyConfig()) {
      try {
        const s = await scrapifyFetch(input.url, 'stealthy', context.abortSignal)
        const page = input.raw ? { title: s.title, markdown: s.html } : htmlToMarkdown(s.html || s.bodyText, input.url)
        return { data: { status: s.status, url: input.url, title: page.title || s.title, body: cap(page.markdown || s.bodyText), via: 'stealth' } }
      } catch (err) {
        body += `\n\n(Stealth retry failed: ${(err as Error).message})`
      }
    }

    if (status === 0) return { data: { status, url: input.url, body, via: 'direct' }, isError: true }
    if (isHtml && !input.raw) {
      const { title, markdown } = htmlToMarkdown(body, input.url)
      return { data: { status, url: input.url, title, body: cap(markdown), via: 'direct' }, isError: status >= 400 }
    }
    return { data: { status, url: input.url, body: cap(body), via: 'direct' }, isError: status >= 400 }
  },

  formatResult(o: Output): string {
    return `Status: ${o.status}${o.via === 'stealth' ? ' (fetched in stealth mode)' : ''}\n${o.title ? `Title: ${o.title}\n` : ''}\n${o.body}`
  },

  activityDescription(input) {
    return input.url ? `Fetching ${input.url}` : 'Fetching URL'
  },
}
