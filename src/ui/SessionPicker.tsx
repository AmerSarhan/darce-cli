import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { homedir } from 'node:os'
import { listSessions, type SessionSummary } from '../state/sessions.js'
import { theme } from './theme.js'

type Props = {
  cwd: string
  currentSessionId: string
  onSelect: (s: SessionSummary) => void
  onClose: () => void
}

const VISIBLE = 8

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const short = (p: string) => (p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p)

/** /resume: pick a past conversation to continue. */
export function SessionPicker({ cwd, currentSessionId, onSelect, onClose }: Props) {
  const t = theme()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const all = useMemo(() => listSessions().filter(s => s.sessionId !== currentSessionId && s.count > 0), [currentSessionId])
  const here = all.filter(s => s.cwd === cwd)
  // Start with this folder's conversations; fall back to everything when there are none
  const [everywhere, setEverywhere] = useState(here.length === 0)

  const rows = useMemo(() => {
    const pool = everywhere ? all : here
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return words.length ? pool.filter(s => words.every(w => `${s.title} ${s.lastReply} ${s.cwd}`.toLowerCase().includes(w))) : pool
  }, [all, here, everywhere, query])

  const pos = Math.min(cursor, Math.max(0, rows.length - 1))
  const start = Math.max(0, Math.min(pos - Math.floor(VISIBLE / 2), rows.length - VISIBLE))
  const pick = rows[pos]

  useInput((ch, key) => {
    if (key.escape) { onClose(); return }
    if (key.return) { if (pick) onSelect(pick); return }
    if (key.tab) { setEverywhere(e => !e); setCursor(0); return }
    if (key.upArrow) { setCursor(Math.max(0, pos - 1)); return }
    if (key.downArrow) { setCursor(Math.min(rows.length - 1, pos + 1)); return }
    if (key.pageUp) { setCursor(Math.max(0, pos - VISIBLE)); return }
    if (key.pageDown) { setCursor(Math.min(rows.length - 1, pos + VISIBLE)); return }
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setCursor(0); return }
    if (ch && !key.ctrl && !key.meta) { setQuery(q => q + ch); setCursor(0) }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold>Resume a conversation <Text color={t.muted}>{everywhere ? 'all folders' : short(cwd)}</Text></Text>
        <Text color={t.faint}>↑↓ move · tab {everywhere ? 'this folder' : 'all folders'} · enter resume · esc close</Text>
      </Box>
      <Text><Text color={t.accent}>› </Text>{query || <Text color={t.faint}>type to search</Text>}</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={t.faint}>{all.length === 0 ? 'No saved conversations yet.' : everywhere ? 'Nothing matches.' : 'No conversations in this folder. Press tab to see all folders.'}</Text>
        ) : rows.slice(start, start + VISIBLE).map((s, i) => {
          const active = start + i === pos
          return (
            <Box key={s.sessionId}>
              <Text color={active ? t.accent : t.faint}>{active ? '▸ ' : '  '}</Text>
              <Box flexGrow={1}><Text bold={active} wrap="truncate-end">{s.title}</Text></Box>
              <Text color={t.faint}>  {s.count} {s.count === 1 ? 'msg' : 'msgs'} · {ago(s.savedAt)}{everywhere ? ` · ${short(s.cwd)}` : ''}</Text>
            </Box>
          )
        })}
      </Box>
      {pick?.lastReply ? (
        <Box marginTop={1}>
          <Text color={t.muted} wrap="truncate-end">Last reply: <Text color={t.text}>{pick.lastReply}</Text></Text>
        </Box>
      ) : null}
    </Box>
  )
}
