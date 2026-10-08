import TurndownService from 'turndown'

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'form', 'button', 'nav', 'footer', 'head'] as any)

/** Readable markdown from a web page: drops scripts, nav and chrome, resolves relative links. */
export function htmlToMarkdown(html: string, baseUrl?: string): { title: string; markdown: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  // Prefer the main content region when the page marks one
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html
  let markdown = ''
  try {
    markdown = turndown.turndown(main)
  } catch {
    markdown = main.replace(/<[^>]+>/g, ' ')
  }
  if (baseUrl) {
    markdown = markdown.replace(/\]\((\/[^)\s]*)\)/g, (_m, path) => {
      try { return `](${new URL(path, baseUrl).toString()})` } catch { return `](${path})` }
    })
  }
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim()
  return { title, markdown }
}

/** Signs that a page is a bot wall rather than real content. */
export function looksBlocked(status: number, body: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true
  const head = body.slice(0, 5000).toLowerCase()
  return /just a moment|checking your browser|cf-browser-verification|captcha|access denied|attention required|enable javascript and cookies/.test(head)
}

export function cap(text: string, max = 40_000): string {
  return text.length > max ? `${text.slice(0, max)}\n\n…(truncated, ${text.length - max} more characters)` : text
}
