import React from 'react'
import { Box, Text, useAnimation } from 'ink'
import { theme } from './theme.js'
import type { PlanDisplay } from '../types.js'

const PULSE = ['◐', '◓', '◑', '◒']

/** Live checklist of the agent's plan; the current step pulses. */
export function PlanPanel({ plan, live }: { plan: PlanDisplay; live: boolean }) {
  const t = theme()
  const { frame } = useAnimation({ interval: 120, isActive: live })
  const done = plan.items.filter(i => i.status === 'done').length
  return (
    <Box flexDirection="column" marginLeft={1} marginBottom={1}>
      <Text color={t.muted}>
        Plan <Text color={t.faint}>{done}/{plan.items.length}</Text>
        {'  '}
        <Text color={t.accent}>{'━'.repeat(Math.round((done / plan.items.length) * 16))}</Text>
        <Text color={t.faint}>{'━'.repeat(16 - Math.round((done / plan.items.length) * 16))}</Text>
      </Text>
      {plan.items.map((item, i) => (
        <Text key={i} wrap="truncate-end">
          {item.status === 'done'
            ? <Text color={t.success}>✓ <Text color={t.faint} strikethrough>{item.text}</Text></Text>
            : item.status === 'in_progress'
              ? <Text color={t.accent}>{live ? PULSE[frame % PULSE.length] : '◐'} <Text color={t.text} bold>{item.text}</Text></Text>
              : <Text color={t.faint}>○ {item.text}</Text>}
        </Text>
      ))}
    </Box>
  )
}
