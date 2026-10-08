import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'

export type ReceiptData = {
  files: { path: string; added: number; removed: number; created: boolean }[]
  commands: number
  approvedByYou: number
  denied: number
  maxRisk: number
  redacted: number
  models: string[]
  tokens: number
  cost: number
  ms: number
  undoable: boolean
  stopped: boolean
}

const RISK = ['read-only', 'changed the project', 'reached outside', 'destructive']

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** End-of-task summary: what changed, what ran, who approved it, what it cost. */
export function Receipt({ r }: { r: ReceiptData }) {
  const t = theme()
  const added = r.files.reduce((n, f) => n + f.added, 0)
  const removed = r.files.reduce((n, f) => n + f.removed, 0)
  const row = (label: string, value: React.ReactNode) => (
    <Box>
      <Box width={8}><Text color={t.faint}>{label}</Text></Box>
      <Text>{value}</Text>
    </Box>
  )
  const fileList = r.files.slice(0, 3).map(f => f.path.split('/').pop()).join(', ') + (r.files.length > 3 ? ` +${r.files.length - 3} more` : '')

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.faint} paddingX={1} marginBottom={1} alignSelf="flex-start">
      {r.files.length > 0
        ? row('files', <Text>{r.files.length} changed <Text color={t.diffAdd}>+{added}</Text> <Text color={t.diffDel}>−{removed}</Text><Text color={t.faint}>  {fileList}</Text></Text>)
        : row('files', <Text color={t.faint}>none changed</Text>)}
      {r.commands > 0 && row('shell', <Text>{r.commands} command{r.commands === 1 ? '' : 's'}<Text color={t.faint}>{r.approvedByYou ? `  ${r.approvedByYou} approved by you` : ''}{r.denied ? `  ${r.denied} denied` : ''}</Text></Text>)}
      {row('risk', <Text color={t.risk[r.maxRisk]}>{'█'.repeat(r.maxRisk)}{'░'.repeat(3 - r.maxRisk)} <Text color={t.muted}>{RISK[r.maxRisk]}</Text>{r.redacted ? <Text color={t.faint}>  {r.redacted} secret{r.redacted === 1 ? '' : 's'} redacted</Text> : null}</Text>)}
      {row('model', <Text>{r.models.map(m => m.split('/').pop()).join(' → ')}<Text color={t.faint}>  {tokens(r.tokens)} tokens · ${r.cost.toFixed(4)}</Text></Text>)}
      {row('time', <Text>{duration(r.ms)}{r.stopped ? <Text color={t.warning}>  stopped early</Text> : null}<Text color={t.faint}>{r.undoable && r.files.length ? '   /undo · /diff · /rewind' : ''}</Text></Text>)}
    </Box>
  )
}
