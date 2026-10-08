import React, { useMemo } from 'react'
import { Text, useWindowSize } from 'ink'
import { Marked } from 'marked'
import { markedTerminal } from 'marked-terminal'

// One parser per terminal width — rebuilt only when the window is resized
const parsers = new Map<number, Marked>()

function parserFor(width: number): Marked {
  let parser = parsers.get(width)
  if (!parser) {
    // Ink wraps lines itself, so marked-terminal must not reflow (double wrapping garbles output)
    parser = new Marked().use(markedTerminal({ width, reflowText: false, tab: 2 }))
    parsers.set(width, parser)
  }
  return parser
}

export function renderMarkdown(text: string, width: number): string {
  try {
    return (parserFor(width).parse(text, { async: false }) as string).replace(/\n+$/, '')
  } catch {
    return text
  }
}

export function Markdown({ text }: { text: string }) {
  const { columns } = useWindowSize()
  const width = Math.max(40, Math.min((columns || 80) - 2, 120))
  const rendered = useMemo(() => (text.trim() ? renderMarkdown(text, width) : ''), [text, width])
  if (!rendered) return null
  return <Text>{rendered}</Text>
}
