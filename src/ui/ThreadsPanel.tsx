import React from 'react'
import { Box, Text, useAnimation } from 'ink'
import { theme } from './theme.js'
import type { Thread } from '../core/threads.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const secs = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`)

/** Live view of the threads working right now (shown above the prompt while they run). */
export function ThreadsPanel({ threads, title = 'Threads' }: { threads: Thread[]; title?: string }) {
  const t = theme()
  const live = threads.filter(th => th.status === 'running' || th.status === 'queued')
  const { frame } = useAnimation({ interval: 80, isActive: live.length > 0 })
  if (!threads.length) return null
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={t.muted}>
        <Text bold color={t.text}>{title}</Text>  {live.length ? `${live.length} working` : 'all finished'}
      </Text>
      {threads.map(th => {
        const icon = th.status === 'done' ? '✓' : th.status === 'error' ? '✗' : th.status === 'stopped' ? '■' : th.status === 'queued' ? '·' : FRAMES[frame % FRAMES.length]
        const color = th.status === 'done' ? t.success : th.status === 'error' ? t.danger : th.status === 'queued' ? t.faint : t.accent
        const elapsed = th.status === 'queued' ? '' : secs(th.status === 'running' ? Date.now() - th.startedAt : th.ms)
        return (
          <Box key={th.id}>
            <Text color={color}>  {icon} </Text>
            <Box width={34}><Text bold={th.status === 'running'} wrap="truncate-end">{th.title}</Text></Box>
            <Box width={9}><Text color={t.faint}>{th.kind}</Text></Box>
            <Box flexGrow={1}><Text color={th.status === 'error' ? t.danger : t.muted} wrap="truncate-end">{th.status === 'error' ? th.error : th.activity}</Text></Box>
            <Text color={t.faint}> {th.steps ? `${th.steps} steps · ` : ''}{elapsed}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
