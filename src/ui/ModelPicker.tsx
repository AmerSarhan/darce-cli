import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { getModels, getModelProfile, popularModels, recentModels, displayName, vendorOf, priceLevel } from '../config/models.js'
import { rank } from './input/complete.js'
import { theme } from './theme.js'
import type { ModelProfile } from '../types.js'

type Props = {
  currentModel: string
  onSelect: (model: string) => void
  onClose: () => void
}

type Row = { kind: 'header'; label: string } | { kind: 'model'; model: ModelProfile }

const VISIBLE = 14

function formatContext(tokens: number): string {
  if (!tokens) return ''
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
  return `${Math.round(tokens / 1000)}k`
}

/** Sections when browsing: Recent, Popular for coding, then every model newest first. */
function browseRows(all: ModelProfile[]): Row[] {
  const byId = new Map(all.map(m => [m.id, m]))
  const pick = (ids: string[]) => ids.map(id => byId.get(id) ?? getModelProfile(id)).filter((m): m is ModelProfile => !!m)
  const recent = pick(recentModels()).slice(0, 4)
  const popular = pick(popularModels(15)).filter(m => !recent.some(r => r.id === m.id))
  const shown = new Set([...recent, ...popular].map(m => m.id))
  const rest = all.filter(m => !shown.has(m.id))
  const rows: Row[] = []
  if (recent.length) rows.push({ kind: 'header', label: 'Recent' }, ...recent.map(model => ({ kind: 'model' as const, model })))
  rows.push({ kind: 'header', label: 'Most popular' }, ...popular.map(model => ({ kind: 'model' as const, model })))
  if (rest.length) rows.push({ kind: 'header', label: `All models (${all.length})` }, ...rest.map(model => ({ kind: 'model' as const, model })))
  return rows
}

export function ModelPicker({ currentModel, onSelect, onClose }: Props) {
  const t = theme()
  const [query, setQuery] = useState('')
  const all = getModels()

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return browseRows(all)
    // Every typed word must appear in the name or id; rank by popularity, then newest
    const words = q.split(/\s+/)
    const popRank = new Map(popularModels(200).map((id, i) => [id, i]))
    const direct = all
      .filter(m => { const hay = `${displayName(m)} ${m.id}`.toLowerCase(); return words.every(w => hay.includes(w)) })
      .sort((a, b) => (popRank.get(a.id) ?? 999) - (popRank.get(b.id) ?? 999) || (b.created ?? 0) - (a.created ?? 0))
    const list = direct.length ? direct : rank(all, q, m => `${m.id} ${m.name ?? ''}`, 40)
    return list.slice(0, 60).map(model => ({ kind: 'model' as const, model }))
  }, [query, all])

  const selectable = rows.map((r, i) => (r.kind === 'model' ? i : -1)).filter(i => i >= 0)
  const startAt = Math.max(0, selectable.findIndex(i => (rows[i] as { model: ModelProfile }).model.id === currentModel))
  const [cursor, setCursor] = useState(query ? 0 : startAt)
  const pos = Math.min(cursor, Math.max(0, selectable.length - 1))
  const rowIndex = selectable[pos] ?? 0

  const top = Math.max(0, Math.min(rowIndex - Math.floor(VISIBLE / 2), rows.length - VISIBLE))
  const visible = rows.slice(top, top + VISIBLE)

  useInput((ch, key) => {
    if (key.escape) { onClose(); return }
    if (key.return) {
      const r = rows[rowIndex]
      if (r?.kind === 'model') onSelect(r.model.id)
      return
    }
    if (key.upArrow) { setCursor(Math.max(0, pos - 1)); return }
    if (key.downArrow) { setCursor(Math.min(selectable.length - 1, pos + 1)); return }
    if (key.pageUp) { setCursor(Math.max(0, pos - VISIBLE)); return }
    if (key.pageDown) { setCursor(Math.min(selectable.length - 1, pos + VISIBLE)); return }
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setCursor(0); return }
    if (ch && !key.ctrl && !key.meta && !key.tab) { setQuery(q => q + ch); setCursor(0) }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold>Choose a model</Text>
        <Text color={t.faint}>↑↓ move · enter select · esc close</Text>
      </Box>
      <Text>
        <Text color={t.accent}>› </Text>
        {query ? <Text>{query}</Text> : <Text color={t.faint}>type to search {all.length} models</Text>}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 && <Text color={t.faint}>No models match "{query}". Try a vendor (claude, gpt, gemini) or a model name.</Text>}
        {visible.map((r, i) => {
          if (r.kind === 'header') {
            return <Text key={`h${top + i}`} color={t.muted} bold>{top + i === 0 ? '' : '\n'}{r.label}</Text>
          }
          const m = r.model
          const active = top + i === rowIndex
          const current = m.id === currentModel
          const tags = m.strengths.filter(s => s === 'vision' || s === 'reasoning').join(', ')
          return (
            <Box key={m.id}>
              <Box width={34}>
                <Text color={active ? t.accent : t.text} bold={active} wrap="truncate-end">
                  {active ? '▸ ' : '  '}{displayName(m)}
                </Text>
              </Box>
              <Box width={11}><Text color={t.faint} wrap="truncate-end">{vendorOf(m.id)}</Text></Box>
              <Box width={6}><Text color={priceLevel(m) === 'free' ? t.success : t.muted}>{priceLevel(m)}</Text></Box>
              <Box width={7}><Text color={t.faint}>{formatContext(m.contextWindow)}</Text></Box>
              <Text color={t.faint} wrap="truncate-end">{tags}</Text>
              {current ? <Text color={t.success}>  ● current</Text> : null}
            </Box>
          )
        })}
      </Box>
      {selectable.length > VISIBLE ? <Text color={t.faint}>{pos + 1} of {selectable.length}</Text> : null}
    </Box>
  )
}
