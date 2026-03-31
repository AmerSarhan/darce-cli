import React, { useDeferredValue } from 'react'
import { Box, Text, Static } from 'ink'
import { Message } from './Message.js'
import { Markdown } from './Markdown.js'
import type { Message as MessageType } from '../types.js'

type Props = {
  messages: MessageType[]
  streamingText: string | null
}

export function Messages({ messages, streamingText }: Props) {
  const deferredMessages = useDeferredValue(messages)

  // Show only complete lines of streaming text
  const visibleStreaming = streamingText
    ? streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null
    : null

  return (
    <Box flexDirection="column">
      <Static items={deferredMessages.map((msg, i) => ({ ...msg, key: i }))}>
        {(msg: MessageType & { key: number }) => (
          <Message key={msg.key} message={msg} />
        )}
      </Static>

      {visibleStreaming && (
        <Box marginBottom={1}>
          <Markdown text={visibleStreaming} />
        </Box>
      )}
    </Box>
  )
}
