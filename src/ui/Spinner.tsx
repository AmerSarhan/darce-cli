import React from 'react'
import { Text, useAnimation } from 'ink'
import { theme } from './theme.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Activity line for the live region: what Darce is doing, for how long, and how to stop it. */
export function Spinner({ label, startedAt }: { label: string; startedAt: number }) {
  const { frame } = useAnimation({ interval: 80 })
  const t = theme()
  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  return (
    <Text>
      <Text color={t.accent}>{FRAMES[frame % FRAMES.length]} </Text>
      <Text color={t.muted}>{label}</Text>
      <Text color={t.faint}>  {seconds}s · esc to stop</Text>
    </Text>
  )
}
