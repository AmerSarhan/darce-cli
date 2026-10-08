import { z } from 'zod'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { htmlToMarkdown, cap } from '../web/html.js'
import { scrapifyFetch } from '../web/scrapify.js'

const inputSchema = z.object({
  url: z.string().describe('URL to load in a stealth browser'),
})

type Input = z.infer<typeof inputSchema>
type Output = { url: string; status: number; title: string; body: string }

export const StealthFetchTool: ToolDef<typeof inputSchema, Output> = {
  name: 'StealthFetch',
  description: 'Load a page in a stealth browser that renders JavaScript and gets past bot walls (Cloudflare and similar). Slower than WebFetch — use it when WebFetch is blocked or returns an empty JavaScript app. Not for pages behind a login.',
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: Input, context: ToolContext): Promise<ToolResult<Output>> {
    try {
      const s = await scrapifyFetch(input.url, 'stealthy', context.abortSignal)
      const { title, markdown } = htmlToMarkdown(s.html || '', input.url)
      return { data: { url: input.url, status: s.status, title: title || s.title, body: cap(markdown || s.bodyText) } }
    } catch (err) {
      return { data: { url: input.url, status: 0, title: '', body: (err as Error).message }, isError: true }
    }
  },

  formatResult(o: Output): string {
    return `Status: ${o.status} (stealth browser)\n${o.title ? `Title: ${o.title}\n` : ''}\n${o.body}`
  },

  activityDescription(input) {
    return input.url ? `Stealth-loading ${input.url}` : 'Stealth-loading page'
  },
}
