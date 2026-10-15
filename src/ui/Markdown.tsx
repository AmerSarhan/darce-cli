import React, { useMemo } from 'react'
import { Text, useWindowSize } from 'ink'
import { renderTerminalMarkdown } from './markdownRender.js'
import { useHighlighter } from './highlight.js'

export function renderMarkdown(text: string, width: number, live = false): string {
  try {
    return renderTerminalMarkdown(text, width, { live })
  } catch {
    return text
  }
}

/** `live`: text still streaming in — rendered cheaply, highlighted once it's final. */
export function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  const { columns } = useWindowSize()
  const width = Math.max(40, Math.min((columns || 80) - 2, 110))
  // Code renders plain until the highlighter loads (just after startup), then again in color
  const highlighted = useHighlighter()
  const rendered = useMemo(() => (text.trim() ? renderMarkdown(text, width, live) : ''), [text, width, live, highlighted])
  if (!rendered) return null
  return <Text>{rendered}</Text>
}
