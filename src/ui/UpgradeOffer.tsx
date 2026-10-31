import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'

export type UpgradePlan = 'builder' | 'power'

export const PLAN_PITCH: Record<UpgradePlan, { name: string; price: string; adds: string }> = {
  builder: { name: 'Builder', price: '$15/month', adds: 'bigger models like Claude Sonnet 5.5, and about 7× the Free allowance each week' },
  power: { name: 'Power', price: '$65/month', adds: 'every model, and about 4× the Builder allowance each week' },
}

/** Shown where the prompt was when the allowance runs out or a model is above the plan: checkout is one key away. */
export function UpgradeOffer({ plan }: { plan: UpgradePlan }) {
  const t = theme()
  const p = PLAN_PITCH[plan]
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1} marginBottom={1}>
      <Text>
        <Text bold>{p.name}</Text><Text color={t.muted}> · {p.price} · cancel any time</Text>
      </Text>
      <Text>Adds {p.adds}.</Text>
      <Box marginTop={1}>
        <Text>
          <Text color={t.accent} bold>u</Text><Text color={t.muted}> upgrade (opens checkout, already signed in)   </Text>
          <Text color={t.accent} bold>m</Text><Text color={t.muted}> pick another model   </Text>
          <Text color={t.accent} bold>esc</Text><Text color={t.muted}> not now</Text>
        </Text>
      </Box>
    </Box>
  )
}
