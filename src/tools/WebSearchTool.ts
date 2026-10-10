import { z } from 'zod'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { looksBlocked } from '../web/html.js'
import { scrapifyConfig, scrapifyFetch } from '../web/scrapify.js'

const inputSchema = z.object({
  query: z.string().describe('What to search for'),
  max_results: z.number().int().min(1).max(15).optional().describe('How many results (default 8)'),
})

type Input = z.infer<typeof inputSchema>
type Result = { title: string; url: string; snippet: string }
type Output = { query: string; results: Result[]; via: 'direct' | 'stealth' }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', '#x27': "'", '#39': "'", lt: '<', gt: '>', nbsp: ' ' }

/** Plain text from a snippet of result HTML. Entities decode in one pass, so "&amp;lt;" stays "&lt;". */
const decode = (html: string) => {
  let s = html
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/<[^<>]*>/g, '') }
  return s
    .replace(/&(amp|quot|#x27|#39|lt|gt|nbsp);/g, (_, e: string) => ENTITIES[e]!)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse DuckDuckGo's HTML results page. */
export function parseDuckDuckGo(html: string): Result[] {
  const results: Result[] = []
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1)
  for (const block of blocks) {
    const a = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!a) continue
    let url = a[1]!.replace(/&amp;/g, '&')
    const uddg = url.match(/[?&]uddg=([^&]+)/)
    if (uddg) url = decodeURIComponent(uddg[1]!)
    if (url.startsWith('//')) url = `https:${url}`
    if (/duckduckgo\.com\/y\.js|\/\/duckduckgo\.com\/l\/\?.*ad_/.test(url)) continue // ads
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div)>/)?.[1] ?? ''
    results.push({ title: decode(a[2]!), url, snippet: decode(snippet) })
  }
  return results
}

export const WebSearchTool: ToolDef<typeof inputSchema, Output> = {
  name: 'WebSearch',
  description: 'Search the web and get titles, URLs and snippets. Use it to find current docs, changelogs, error messages and references, then read the best results with WebFetch.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<Output>> {
    const max = input.max_results ?? 8
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`
    let html = ''
    let status = 0
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: context.abortSignal ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      })
      status = res.status
      html = await res.text()
    } catch {}

    let results = parseDuckDuckGo(html)
    let via: Output['via'] = 'direct'
    if (results.length === 0 && (status === 0 || looksBlocked(status, html) || /anomaly|captcha/i.test(html)) && scrapifyConfig()) {
      try {
        const s = await scrapifyFetch(url, 'stealthy', context.abortSignal)
        results = parseDuckDuckGo(s.html)
        via = 'stealth'
      } catch {}
    }
    if (results.length === 0) {
      return { data: { query: input.query, results: [], via }, isError: status === 0 || status >= 400 }
    }
    return { data: { query: input.query, results: results.slice(0, max), via } }
  },

  formatResult(o: Output): string {
    if (o.results.length === 0) return `No results for "${o.query}" (the search may have been blocked; try different words, or fetch a known docs URL directly).`
    return o.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') + (o.via === 'stealth' ? '\n\n(searched in stealth mode)' : '')
  },

  activityDescription(input) {
    return input.query ? `Searching "${input.query}"` : 'Searching the web'
  },
}
