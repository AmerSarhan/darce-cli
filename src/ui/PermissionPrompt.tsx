import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'
import type { Risk } from '../core/risk.js'

export type PermissionRequest = {
  id: string
  name: string
  summary: string
  detail: string // full command or path
  risk: Risk
  trustKey?: string // offered for "always allow"
}

const LEVEL_LABEL = ['read-only', 'changes the project', 'reaches outside', 'destructive'] as const

export function PermissionPrompt({ req }: { req: PermissionRequest }) {
  const t = theme()
  const color = t.risk[req.risk.level]
  const meter = '█'.repeat(req.risk.level) + '░'.repeat(3 - req.risk.level)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold>
          Allow <Text color={t.tool}>{req.name}</Text>?
        </Text>
        <Text color={color}>{meter} {LEVEL_LABEL[req.risk.level]}</Text>
      </Box>
      <Text>{req.detail}</Text>
      <Text color={t.muted}>{req.risk.reason}</Text>
      <Box marginTop={1}>
        <Text>
          <Text color={t.accent} bold>y</Text><Text color={t.muted}> allow once   </Text>
          {req.trustKey ? (
            <>
              <Text color={t.accent} bold>a</Text><Text color={t.muted}> always allow "{req.trustKey}" here   </Text>
            </>
          ) : null}
          <Text color={t.accent} bold>n</Text><Text color={t.muted}> deny   </Text>
          <Text color={t.accent} bold>esc</Text><Text color={t.muted}> deny and stop</Text>
        </Text>
      </Box>
    </Box>
  )
}
