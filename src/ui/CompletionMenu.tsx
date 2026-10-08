import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'

export type MenuItem = { label: string; detail?: string; hint?: string }

export function CompletionMenu({ items, selected, title }: { items: MenuItem[]; selected: number; title?: string }) {
  const t = theme()
  const width = Math.min(34, Math.max(...items.map(i => i.label.length + (i.hint ? i.hint.length + 1 : 0))) + 2)
  return (
    <Box flexDirection="column" marginLeft={2}>
      {items.map((item, i) => {
        const active = i === selected
        return (
          <Box key={item.label}>
            <Box width={width + 2}>
              <Text color={active ? t.accent : t.text} bold={active} wrap="truncate-end">
                {active ? '▸ ' : '  '}{item.label}{item.hint ? <Text color={t.faint}> {item.hint}</Text> : null}
              </Text>
            </Box>
            {item.detail ? <Text color={active ? t.muted : t.faint} wrap="truncate-end">{item.detail}</Text> : null}
          </Box>
        )
      })}
      <Text color={t.faint}>  {title ?? 'tab completes · ↑↓ choose · esc dismiss'}</Text>
    </Box>
  )
}
