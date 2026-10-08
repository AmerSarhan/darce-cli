import React, { useEffect } from 'react'
import { Box, Text, useAnimation } from 'ink'
import { theme } from './theme.js'
import { mix, reducedMotion } from './Spinner.js'

// Two-line block wordmark: D A R C E
const WORDMARK = ['█▀▄ ▄▀█ █▀█ █▀▀ █▀▀', '█▄▀ █▀█ █▀▄ █▄▄ ██▄']
const FROM = '#FF7A3D'
const TO = '#F5C350'

export type WelcomeInfo = {
  version: string
  model: string
  mode: string
  cwd: string
  account?: string // "you@x.com · Power · 2,476 left"
}

function Wordmark({ reveal, sweep }: { reveal: number; sweep: number }) {
  const width = WORDMARK[0]!.length
  return (
    <Box flexDirection="column">
      {WORDMARK.map((row, r) => (
        <Text key={r}>
          {[...row].map((ch, i) => {
            if (i > reveal) return <Text key={i}> </Text>
            const base = mix(FROM, TO, i / (width - 1))
            const d = Math.abs(i - sweep)
            const glow = d < 3 ? 1 - d / 3 : 0
            return <Text key={i} color={mix(base, '#FFF4E0', glow * 0.85)}>{ch}</Text>
          })}
        </Text>
      ))}
    </Box>
  )
}

/** Plays once at startup in the live region, then hands off to the static card. */
export function Intro({ onDone, ready }: { onDone: () => void; ready: boolean }) {
  const { time } = useAnimation({ interval: 16, isActive: !reducedMotion })
  const width = WORDMARK[0]!.length
  const duration = 750
  const progress = Math.min(1, time / duration)
  useEffect(() => {
    if (reducedMotion || (progress >= 1 && ready) || time > 2000) onDone()
  }, [progress, ready, time, onDone])
  if (reducedMotion) return null
  const eased = 1 - Math.pow(1 - progress, 3)
  return (
    <Box paddingX={2} paddingY={1}>
      <Wordmark reveal={Math.floor(eased * (width + 2))} sweep={eased * (width + 6) - 3} />
    </Box>
  )
}

/** The welcome card printed once at the top of every session. */
export function Welcome({ info }: { info: WelcomeInfo }) {
  const t = theme()
  const key = (k: string, label: string) => (
    <Text>
      <Text color={t.accent} bold>{k}</Text>
      <Text color={t.faint}> {label}   </Text>
    </Text>
  )
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.faint} paddingX={2} paddingY={1} marginBottom={1}>
      <Box>
        <Wordmark reveal={99} sweep={-10} />
        <Box flexDirection="column" marginLeft={3}>
          <Text bold>v{info.version}</Text>
          <Text color={t.muted}>AI coding agent · 300+ models</Text>
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color={t.faint}>model </Text><Text>{info.model.split('/').pop()}</Text>
          <Text color={t.faint}>   mode </Text><Text>{info.mode}</Text>
          <Text color={t.faint}>   in </Text><Text>{info.cwd}</Text>
        </Text>
        {info.account ? <Text><Text color={t.faint}>you   </Text><Text>{info.account}</Text></Text> : null}
      </Box>
      <Box marginTop={1} flexWrap="wrap">
        {key('/', 'commands')}
        {key('@', 'attach a file')}
        {key('esc esc', 'rewind')}
        {key('shift+↑↓', 'change model')}
        {key('shift+tab', 'approval mode')}
      </Box>
    </Box>
  )
}
