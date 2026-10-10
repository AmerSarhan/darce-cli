import { Lexer, type Token, type Tokens } from 'marked'
import { Chalk } from 'chalk'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import { highlight, supportsLanguage } from 'cli-highlight'
import { theme } from './theme.js'
import { caps } from './termfx.js'

/**
 * Darce's terminal markdown renderer. Handles inline formatting everywhere (including
 * inside lists and tables), wraps with hanging indents, highlights code, and makes links clickable.
 */
const chalk = new Chalk()

function link(text: string, href: string): string {
  const t = theme()
  const styled = chalk.hex(t.tool).underline(text)
  if (!caps.links || !/^https?:|^mailto:/.test(href)) return text === href ? styled : `${styled} ${chalk.hex(t.faint)(`(${href})`)}`
  return `\x1b]8;;${href}\x07${styled}\x1b]8;;\x07`
}

function inline(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  const t = theme()
  return tokens.map(tok => {
    switch (tok.type) {
      case 'strong': return chalk.bold(inline((tok as Tokens.Strong).tokens))
      case 'em': return chalk.italic(inline((tok as Tokens.Em).tokens))
      case 'del': return chalk.strikethrough(inline((tok as Tokens.Del).tokens))
      case 'codespan': return chalk.hex(t.accent)(decode((tok as Tokens.Codespan).text))
      case 'link': {
        const l = tok as Tokens.Link
        const text = inline(l.tokens)
        return link(text || l.href, l.href)
      }
      case 'image': return chalk.hex(t.faint)(`[image: ${(tok as Tokens.Image).text || (tok as Tokens.Image).href}]`)
      case 'br': return '\n'
      case 'escape': return (tok as Tokens.Escape).text
      case 'html': return ''
      case 'text': {
        const tt = tok as Tokens.Text
        return tt.tokens ? inline(tt.tokens) : decode(tt.text)
      }
      default: return 'text' in tok ? decode(String((tok as { text: string }).text)) : ''
    }
  }).join('')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }
/** Undo marked's HTML escaping in one pass, so "&amp;lt;" becomes "&lt;", not "<". */
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e]!)

/** Wrap text to width, indenting every line; the first line can use a different prefix (e.g. a bullet). */
function wrap(text: string, width: number, indent: number, firstPrefix = ''): string {
  const pad = ' '.repeat(indent)
  const avail = Math.max(20, width - indent)
  return text
    .split('\n')
    .map((para, pi) => wrapAnsi(para, avail, { hard: true, trim: false })
      .split('\n')
      .map((line, li) => (pi === 0 && li === 0 && firstPrefix ? firstPrefix + line : pad + line))
      .join('\n'))
    .join('\n')
}

function code(text: string, lang: string | undefined, width: number, indent: number): string {
  const t = theme()
  let body = text
  if (lang && supportsLanguage(lang)) {
    try { body = highlight(text, { language: lang, ignoreIllegals: true }) } catch {}
  } else if (!lang) {
    try { body = highlight(text, { ignoreIllegals: true }) } catch {}
  }
  const bar = chalk.hex(t.faint)('│ ')
  const pad = ' '.repeat(indent)
  const label = lang ? `${pad}${chalk.hex(t.faint)(lang)}\n` : ''
  return label + body.split('\n').map(l => `${pad}${bar}${l}`).join('\n')
}

function list(tok: Tokens.List, width: number, indent: number): string {
  const t = theme()
  return tok.items.map((item, i) => {
    const marker = item.task
      ? (item.checked ? chalk.hex(t.success)('✓ ') : chalk.hex(t.faint)('○ '))
      : tok.ordered
        ? chalk.hex(t.muted)(`${Number(tok.start || 1) + i}. `)
        : chalk.hex(t.accent)('• ')
    const markerWidth = stringWidth(marker)
    const parts: string[] = []
    let first = true
    for (const child of item.tokens) {
      if (child.type === 'list') {
        parts.push(list(child as Tokens.List, width, indent + markerWidth))
      } else if (child.type === 'text' || child.type === 'paragraph') {
        const text = inline((child as Tokens.Text).tokens ?? [{ type: 'text', raw: (child as Tokens.Text).text, text: (child as Tokens.Text).text } as Token])
        parts.push(wrap(text, width, indent + markerWidth, first ? ' '.repeat(indent) + marker : ''))
        first = false
      } else {
        parts.push(block(child, width, indent + markerWidth))
      }
    }
    if (first) parts.unshift(' '.repeat(indent) + marker)
    return parts.join('\n')
  }).join('\n')
}

function table(tok: Tokens.Table, width: number): string {
  const t = theme()
  const header = tok.header.map(c => inline(c.tokens))
  const rows = tok.rows.map(r => r.map(c => inline(c.tokens)))
  const cols = header.length
  const widths = Array.from({ length: cols }, (_, i) => Math.max(stringWidth(header[i] ?? ''), ...rows.map(r => stringWidth(r[i] ?? ''))))
  const total = widths.reduce((a, b) => a + b, 0) + cols * 3 + 1
  if (total > width) {
    // Too wide for the terminal: fall back to "header: value" blocks per row
    return rows.map(r => r.map((v, i) => `${chalk.hex(t.muted)(header[i] ?? '')}: ${v}`).join('\n')).join('\n\n')
  }
  const line = (l: string, m: string, r: string) => chalk.hex(t.faint)(l + widths.map(w => '─'.repeat(w + 2)).join(m) + r)
  const row = (cells: string[], bold = false) => chalk.hex(t.faint)('│') + cells.map((c, i) => ` ${bold ? chalk.bold(c) : c}${' '.repeat(widths[i]! - stringWidth(c))} `).join(chalk.hex(t.faint)('│')) + chalk.hex(t.faint)('│')
  return [line('┌', '┬', '┐'), row(header, true), line('├', '┼', '┤'), ...rows.map(r => row(r)), line('└', '┴', '┘')].join('\n')
}

/** A WHY that only says the change was simple teaches nothing; some models write one anyway. */
export function isFillerWhy(body: string): boolean {
  const b = body.trim()
  // "This was a simple rename" teaches nothing; neither does commentary on the answer itself ("The analysis focuses on…")
  return /^\W*(this|it|that)\s+(is|was)\s+(just\s+|only\s+)?(a|an)?\s*(simple|straightforward|routine|basic|minor|trivial|standard|small|quick)\b/i.test(b)
    || /^\W*(the|this|my)\s+(analysis|review|overview|summary|assessment|evaluation|response|answer|approach)\s+(focuses|looks|covers|highlights|is|was|aims|takes)\b/i.test(b)
}

function block(tok: Token, width: number, indent = 0): string {
  const t = theme()
  switch (tok.type) {
    case 'heading': {
      const h = tok as Tokens.Heading
      const text = inline(h.tokens)
      return h.depth <= 2 ? chalk.bold.hex(t.accent)(text) : chalk.bold(text)
    }
    case 'paragraph': {
      const p = tok as Tokens.Paragraph
      // "WHY: …" paragraphs get Darce's WHY tag, as on the website
      const why = /^\s*(?:\*\*|__)?WHY:?(?:\*\*|__)?:?\s+/.exec(p.raw)
      if (why) {
        if (isFillerWhy(p.raw.slice(why[0].length))) return ''
        const t = theme()
        const tag = chalk.bgHex(t.accent).hex('#09090b').bold(' WHY ') + ' '
        const body = wrap(tag + inline(Lexer.lexInline(p.raw.slice(why[0].length).trim())), width, indent + 6)
        return ' '.repeat(indent) + body.slice(indent + 6) // tag line starts at the normal margin; the rest hangs under the text
      }
      return wrap(inline(p.tokens), width, indent)
    }
    case 'text': return wrap(inline((tok as Tokens.Text).tokens) || decode((tok as Tokens.Text).text), width, indent)
    case 'list': return list(tok as Tokens.List, width, indent)
    case 'code': return code((tok as Tokens.Code).text, (tok as Tokens.Code).lang?.split(/\s/)[0] || undefined, width, indent)
    case 'blockquote': {
      const inner = (tok as Tokens.Blockquote).tokens.map(b => block(b, width - 2)).join('\n\n')
      return inner.split('\n').map(l => `${' '.repeat(indent)}${chalk.hex(t.accent)('▎ ')}${chalk.hex(t.muted)(l)}`).join('\n')
    }
    case 'table': return table(tok as Tokens.Table, width)
    case 'hr': return chalk.hex(t.faint)('─'.repeat(Math.min(width, 40)))
    case 'html': return ''
    case 'space': return ''
    default: return 'text' in tok ? wrap(decode(String((tok as { text: string }).text)), width, indent) : ''
  }
}

export function renderTerminalMarkdown(source: string, width: number): string {
  const tokens = new Lexer({ gfm: true }).lex(source)
  return tokens.map(tok => block(tok, width)).filter(s => s !== '').join('\n\n')
}
