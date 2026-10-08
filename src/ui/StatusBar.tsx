import React from 'react'
import { Box, Text } from 'ink'
import { formatCostSummary, formatTokenCount } from '../state/costTracker.js'
import { getModelProfile } from '../config/models.js'
import { theme } from './theme.js'
import { homedir } from 'node:os'

type Props = {
  model: string
  cwd: string
  contextTokens: number
  hint?: string
}

function shortPath(cwd: string): string {
  const home = homedir()
  return home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

export function StatusBar({ model, cwd, contextTokens, hint }: Props) {
  const t = theme()
  const window = getModelProfile(model)?.contextWindow || 128000
  const pct = Math.min(100, Math.round((contextTokens / window) * 100))
  const shortModel = model.split('/').pop() || model

  return (
    <Box marginTop={1} flexDirection="column">
      {hint ? <Text color={t.accent}>{hint}</Text> : null}
      <Box>
      <Text color={t.faint}>
        {shortModel} · {formatTokenCount()} tokens · {formatCostSummary()}
        {pct > 0 ? ' · ' : ''}
      </Text>
      {pct > 0 && <Text color={pct >= 80 ? t.warning : t.faint}>{pct}% context</Text>}
      <Text color={t.faint} wrap="truncate-start"> · {shortPath(cwd)}</Text>
      </Box>
    </Box>
  )
}
