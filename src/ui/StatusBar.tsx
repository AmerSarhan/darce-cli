import React from 'react'
import { Box, Text } from 'ink'
import { formatCostSummary, formatTokenCount } from '../state/costTracker.js'
import { estimateMessagesTokens } from '../utils/tokens.js'
import type { Message } from '../types.js'

const MAX_CONTEXT_TOKENS = 100000

type Props = {
  model: string
  cwd: string
  messages?: Message[]
}

export function StatusBar({ model, cwd, messages }: Props) {
  const shortModel = model.split('/').pop() || model
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const shortCwd = home ? cwd.replace(home, '~') : cwd

  const ctxPercent = messages && messages.length > 0
    ? Math.round((estimateMessagesTokens(messages) / MAX_CONTEXT_TOKENS) * 100)
    : 0

  return (
    <Box>
      <Text dimColor>{shortModel}</Text>
      <Text dimColor> · </Text>
      <Text dimColor>{formatTokenCount()} tokens</Text>
      <Text dimColor> · </Text>
      <Text dimColor>{formatCostSummary()}</Text>
      {ctxPercent > 0 && (
        <>
          <Text dimColor> · </Text>
          <Text dimColor color={ctxPercent > 80 ? 'yellow' : undefined}>~{ctxPercent}% ctx</Text>
        </>
      )}
      <Text dimColor> · </Text>
      <Text dimColor>{shortCwd}</Text>
    </Box>
  )
}
