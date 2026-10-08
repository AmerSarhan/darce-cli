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
  mode?: string
  tainted?: boolean
  gear?: { index: number; total: number }
  critic?: boolean
  learn?: boolean
}

function shortPath(cwd: string): string {
  const home = homedir()
  const p = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
  const parts = p.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p
}

export function StatusBar({ model, cwd, contextTokens, hint, mode = 'auto', tainted = false, gear, critic = false, learn = false }: Props) {
  const t = theme()
  const window = getModelProfile(model)?.contextWindow || 128000
  const pct = Math.min(100, Math.round((contextTokens / window) * 100))
  const shortModel = model.split('/').pop() || model

  return (
    <Box marginTop={1} flexDirection="column">
      {hint ? <Text color={t.accent}>{hint}</Text> : null}
      <Text wrap="truncate-end">
        <Text color={mode === 'full' ? t.warning : mode === 'plan' ? t.tool : t.muted}>{mode}</Text>
        {tainted ? <Text color={t.warning}> · web content</Text> : null}
        <Text color={t.faint}> · </Text>
        {gear && gear.index >= 0 ? <Text color={t.accent}>{'▮'.repeat(gear.index + 1)}<Text color={t.faint}>{'▯'.repeat(gear.total - gear.index - 1)}</Text> </Text> : null}
        <Text color={t.faint}>{shortModel}{critic ? ' + critic' : ''}{learn ? ' · learn' : ''} · {formatTokenCount()} tokens · {formatCostSummary()}</Text>
        {pct > 0 ? <Text color={pct >= 80 ? t.warning : t.faint}> · {pct}% context</Text> : null}
        <Text color={t.faint}> · {shortPath(cwd)}</Text>
      </Text>
    </Box>
  )
}
