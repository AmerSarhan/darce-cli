import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { getModels } from '../config/models.js'

type Props = {
  currentModel: string
  onSelect: (model: string) => void
  onClose: () => void
}

const VISIBLE = 12

function formatPrice(per1k: number): string {
  const perM = per1k * 1000
  if (perM === 0) return 'free'
  return `$${perM < 1 ? perM.toFixed(2) : perM.toFixed(perM < 10 ? 1 : 0)}`
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
  return `${Math.round(tokens / 1000)}k`
}

export function ModelPicker({ currentModel, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(() =>
    Math.max(0, getModels().findIndex(m => m.id === currentModel))
  )

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    const models = getModels()
    if (!q) return models
    return models.filter(m => m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q))
  }, [query])

  const cursor = Math.min(selected, Math.max(0, filtered.length - 1))
  const start = Math.max(0, Math.min(cursor - Math.floor(VISIBLE / 2), filtered.length - VISIBLE))
  const visible = filtered.slice(start, start + VISIBLE)

  useInput((ch, key) => {
    if (key.escape) { onClose(); return }
    if (key.return) { if (filtered[cursor]) onSelect(filtered[cursor].id); return }
    if (key.upArrow) { setSelected(Math.max(0, cursor - 1)); return }
    if (key.downArrow) { setSelected(Math.min(filtered.length - 1, cursor + 1)); return }
    if (key.pageUp) { setSelected(Math.max(0, cursor - VISIBLE)); return }
    if (key.pageDown) { setSelected(Math.min(filtered.length - 1, cursor + VISIBLE)); return }
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setSelected(0); return }
    if (ch && !key.ctrl && !key.meta && !key.tab) { setQuery(q => q + ch); setSelected(0) }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Select Model <Text dimColor>(type to search, ↑↓ Enter, Esc to cancel)</Text></Text>
      <Text>
        <Text color="cyan">› </Text>
        {query || <Text dimColor>search {getModels().length} models…</Text>}
      </Text>
      <Text> </Text>
      {visible.length === 0 && <Text dimColor>  No models match "{query}"</Text>}
      {visible.map((model, i) => {
        const isSelected = start + i === cursor
        return (
          <Box key={model.id}>
            <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
              {isSelected ? '▸ ' : '  '}
              {model.id}
            </Text>
            <Text color="gray" dimColor>
              {'  '}{formatContext(model.contextWindow)} ctx · {formatPrice(model.costPer1kInput)}/{formatPrice(model.costPer1kOutput)} per M
              {model.strengths.length > 0 ? ` · ${model.strengths.join(', ')}` : ''}
            </Text>
            {model.id === currentModel && <Text color="green"> ●</Text>}
          </Box>
        )
      })}
      {filtered.length > VISIBLE && (
        <Text dimColor>  {cursor + 1}/{filtered.length}</Text>
      )}
    </Box>
  )
}
