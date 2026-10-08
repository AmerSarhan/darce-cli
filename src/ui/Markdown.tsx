import React, { useMemo } from 'react'
import { Text, useWindowSize } from 'ink'
import { renderTerminalMarkdown } from './markdownRender.js'

export function renderMarkdown(text: string, width: number): string {
  try {
    return renderTerminalMarkdown(text, width)
  } catch {
    return text
  }
}

export function Markdown({ text }: { text: string }) {
  const { columns } = useWindowSize()
  const width = Math.max(40, Math.min((columns || 80) - 2, 110))
  const rendered = useMemo(() => (text.trim() ? renderMarkdown(text, width) : ''), [text, width])
  if (!rendered) return null
  return <Text>{rendered}</Text>
}
