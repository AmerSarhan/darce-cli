import React from 'react'
import { Box, Text } from 'ink'
import { formatCostSummary, formatTokenCount } from '../state/costTracker.js'

type Props = {
  model: string
  cwd: string
}

export function StatusBar({ model, cwd }: Props) {
  const shortModel = model.split('/').pop() || model
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const shortCwd = home ? cwd.replace(home, '~') : cwd

  return (
    <Box>
      <Text dimColor>{shortModel}</Text>
      <Text dimColor> · </Text>
      <Text dimColor>{formatTokenCount()} tokens</Text>
      <Text dimColor> · </Text>
      <Text dimColor>{formatCostSummary()}</Text>
      <Text dimColor> · </Text>
      <Text dimColor>{shortCwd}</Text>
    </Box>
  )
}
