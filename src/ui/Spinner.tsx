import React, { useState, useEffect } from 'react'
import { Text } from 'ink'
import type { SpinnerMode } from '../types.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const MODE_LABELS: Record<SpinnerMode, string> = {
  idle: '',
  requesting: 'Thinking',
  thinking: 'Reasoning',
  responding: '',
  'tool-input': 'Preparing tool',
  'tool-use': 'Running',
}

type Props = { mode: SpinnerMode }

export function Spinner({ mode }: Props) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (mode === 'idle' || mode === 'responding') return
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % FRAMES.length)
    }, 80)
    return () => clearInterval(timer)
  }, [mode])

  if (mode === 'idle' || mode === 'responding') return null

  const label = MODE_LABELS[mode]
  return (
    <Text dimColor>
      {FRAMES[frame]} {label}
    </Text>
  )
}
