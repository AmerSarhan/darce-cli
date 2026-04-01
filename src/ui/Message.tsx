import React from 'react'
import { Box, Text } from 'ink'
import { Markdown } from './Markdown.js'
import type { Message as MessageType, ContentBlock } from '../types.js'

type Props = { message: MessageType }

export function Message({ message }: Props) {
  if (typeof message.content === 'string') {
    if (message.role === 'user') {
      return (
        <Box marginBottom={1}>
          <Text bold color="magenta">{'> '}</Text>
          <Text>{message.content}</Text>
        </Box>
      )
    }
    if (message.role === 'assistant') {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Markdown text={message.content} />
        </Box>
      )
    }
    return null
  }

  // Content blocks
  const blocks = message.content as ContentBlock[]
  return (
    <Box flexDirection="column" marginBottom={1}>
      {blocks.map((block, i) => (
        <ContentBlockView key={i} block={block} role={message.role} />
      ))}
    </Box>
  )
}

function ContentBlockView({ block, role }: { block: ContentBlock; role: string }) {
  switch (block.type) {
    case 'text':
      if (role === 'user') {
        return (
          <Box>
            <Text bold color="magenta">{'> '}</Text>
            <Text>{block.text}</Text>
          </Box>
        )
      }
      return <Markdown text={block.text} />

    case 'tool_use':
      return (
        <Box flexDirection="column" marginLeft={1}>
          <Box>
            <Text color="cyan" bold>{block.name} </Text>
            <Text dimColor>{formatToolSummary(block.name, block.input)}</Text>
          </Box>
        </Box>
      )

    case 'tool_result': {
      const lines = block.content.split('\n')
      const preview = lines.length > 20
        ? [...lines.slice(0, 15), `  ... (${lines.length - 15} more lines)`].join('\n')
        : block.content
      return (
        <Box flexDirection="column" marginLeft={1}>
          <Text dimColor>{truncate(preview, 2000)}</Text>
        </Box>
      )
    }

    default:
      return null
  }
}

// Show the key info, not raw JSON
function formatToolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return String(input.description || input.command || '')
    case 'Read':
      return String(input.file_path || '')
    case 'Write':
      return String(input.file_path || '')
    case 'Edit':
      return String(input.file_path || '')
    case 'Glob':
      return String(input.pattern || '')
    case 'Grep':
      return `${input.pattern || ''}${input.path ? ` in ${input.path}` : ''}`
    case 'WebFetch':
      return String(input.url || '')
    default: {
      const entries = Object.entries(input)
      if (entries.length === 0) return ''
      const first = entries[0]!
      const val = typeof first[1] === 'string' ? first[1] : JSON.stringify(first[1])
      return val.length > 80 ? val.slice(0, 77) + '...' : val
    }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '...'
}
