import React from 'react'
import { Text } from 'ink'
import { theme } from './theme.js'
import { TASTE_RULES, type TasteFinding } from '../taste/check.js'

/** One quiet line under an edit: what the taste check caught. Darce has the details and fixes them. */
export function TasteView({ findings }: { findings: TasteFinding[] }) {
  const t = theme()
  const kinds = [...new Set(findings.map(f => TASTE_RULES[f.rule].toLowerCase()))]
  const list = kinds.length > 2 ? `${kinds.slice(0, 2).join(', ')} and ${kinds.length - 2} more` : kinds.join(' and ')
  return (
    <Text>
      <Text color={t.faint}>{'  '}taste: </Text>
      <Text color={t.muted}>{list}</Text>
      <Text color={t.faint}>, sent to Darce</Text>
    </Text>
  )
}
