import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'

type Props = {
  onSubmit: (text: string) => void
  isLoading: boolean
  history: string[]
}

export function Prompt({ onSubmit, isLoading, history }: Props) {
  const [input, setInput] = useState('')
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [cursor, setCursor] = useState(0)

  useInput((ch, key) => {
    if (isLoading) return

    if (key.return) {
      const text = input.trim()
      if (text) {
        onSubmit(text)
        setInput('')
        setCursor(0)
        setHistoryIndex(-1)
      }
      return
    }

    if (key.upArrow) {
      if (history.length === 0) return
      const nextIndex = Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(nextIndex)
      const entry = history[nextIndex]!
      setInput(entry)
      setCursor(entry.length)
      return
    }

    if (key.downArrow) {
      if (historyIndex <= 0) {
        setHistoryIndex(-1)
        setInput('')
        setCursor(0)
        return
      }
      const nextIndex = historyIndex - 1
      setHistoryIndex(nextIndex)
      const entry = history[nextIndex]!
      setInput(entry)
      setCursor(entry.length)
      return
    }

    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setInput(prev => prev.slice(0, cursor - 1) + prev.slice(cursor))
        setCursor(c => c - 1)
      }
      return
    }

    if (key.leftArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }

    if (key.rightArrow) {
      setCursor(c => Math.min(input.length, c + 1))
      return
    }

    if (ch && !key.ctrl && !key.meta) {
      setInput(prev => prev.slice(0, cursor) + ch + prev.slice(cursor))
      setCursor(c => c + 1)
    }
  })

  if (isLoading) return null

  return (
    <Box>
      <Text bold color="magenta">{'> '}</Text>
      <Text>
        {input.slice(0, cursor)}
        <Text inverse>{input[cursor] || ' '}</Text>
        {input.slice(cursor + 1)}
      </Text>
    </Box>
  )
}
