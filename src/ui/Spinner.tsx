import React from 'react'
import { Text, useAnimation } from 'ink'
import { theme } from './theme.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const reducedMotion = !!process.env.DARCE_REDUCED_MOTION || process.env.TERM === 'dumb' || !process.stdout.isTTY

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0')
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`
}

/** Text with a soft highlight sweeping across it — Darce's "working" signature. */
export function Shimmer({ text, time, base, peak }: { text: string; time: number; base: string; peak: string }) {
  if (reducedMotion) return <Text color={base}>{text}</Text>
  const width = text.length + 12
  const head = ((time / 28) % width) - 6
  return (
    <Text>
      {[...text].map((ch, i) => {
        const d = Math.abs(i - head)
        const glow = d < 6 ? Math.cos((d / 6) * (Math.PI / 2)) ** 2 : 0
        return <Text key={i} color={mix(base, peak, glow)}>{ch}</Text>
      })}
    </Text>
  )
}

/** Activity line for the live region: what Darce is doing, for how long, and how to stop it. */
export function Spinner({ label, startedAt }: { label: string; startedAt: number }) {
  const { frame, time } = useAnimation({ interval: reducedMotion ? 1000 : 50 })
  const t = theme()
  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  const shown = label.length > 90 ? `${label.slice(0, 87)}…` : label
  return (
    <Text wrap="truncate-end">
      <Text color={t.accent}>{FRAMES[Math.floor(frame * (reducedMotion ? 1 : 0.6)) % FRAMES.length]} </Text>
      <Shimmer text={shown} time={time} base={t.muted} peak={t.text} />
      <Text color={t.faint}>  {seconds}s · esc to stop</Text>
    </Text>
  )
}
