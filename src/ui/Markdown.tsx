import React from 'react'
import { Text } from 'ink'
import { marked } from 'marked'
import TerminalRenderer from 'marked-terminal'

// Configure marked for terminal output
marked.setOptions({
  renderer: new TerminalRenderer({
    reflowText: true,
    width: process.stdout.columns ? Math.min(process.stdout.columns - 4, 120) : 80,
  }) as any,
})

type Props = { text: string }

export function Markdown({ text }: Props) {
  if (!text.trim()) return null
  try {
    const rendered = marked.parse(text, { async: false }) as string
    // Remove trailing newlines from marked output
    return <Text>{rendered.replace(/\n+$/, '')}</Text>
  } catch {
    return <Text>{text}</Text>
  }
}
