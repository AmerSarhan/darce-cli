import React from 'react'
import { isAbsolute, relative, resolve } from 'node:path'
import { Box, Text } from 'ink'
import { Markdown } from './Markdown.js'
import { theme } from './theme.js'
import { getTool } from '../tools/registry.js'
import { DiffView } from './DiffView.js'
import { link } from './termfx.js'
import type { ToolDisplay, PlanDisplay } from '../types.js'
import { PlanPanel } from './PlanPanel.js'
import { Welcome } from './Welcome.js'
import { Receipt, type ReceiptData } from './Receipt.js'
import { TasteView } from './TasteView.js'

// Everything that has happened in the session. Committed items are printed
// once via <Static> and never re-rendered.
export type TranscriptItem =
  | { kind: 'banner'; id: string; version: string; model: string; cwd: string; mode?: string; account?: string }
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; result: string; isError?: boolean; durationMs?: number; display?: ToolDisplay; approval?: string; path?: string }
  | { kind: 'expanded'; id: string; name: string; summary: string; result: string; display?: ToolDisplay }
  | { kind: 'receipt'; id: string; data: ReceiptData }
  | { kind: 'plan'; id: string; plan: PlanDisplay }
  | { kind: 'critic'; id: string; model: string; path: string; issue?: string }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }

let seq = 0
export const newId = (prefix = 'i') => `${prefix}${++seq}`

/** Show paths relative to the project when they are inside it. */
export function displayPath(p: string, cwd = process.cwd()): string {
  if (!p) return p
  const abs = isAbsolute(p) ? p : resolve(cwd, p)
  const rel = relative(cwd, abs)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p
}

export function toolSummary(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'Read': case 'Write': case 'Edit': return displayPath(s(input.file_path))
    case 'Bash': return s(input.command).split('\n')[0]!.slice(0, 100)
    case 'Glob': return s(input.pattern)
    case 'Grep': return `"${s(input.pattern)}"${input.path ? ` in ${displayPath(s(input.path))}` : ''}`
    case 'WebFetch': case 'StealthFetch': return s(input.url)
    case 'WebSearch': return `"${s(input.query)}"`
    case 'Skill': return s(input.name)
    case 'Remember': return `${s(input.scope)}: ${s(input.note)}`
    case 'Agent': return `${s(input.kind) === 'work' ? 'work' : 'explore'} · ${s(input.description)}`
    case 'Image': return displayPath(s(input.file_path))
    default: return ''
  }
}

const changesProject = (name: string) => getTool(name)?.isReadOnly === false

function formatDuration(ms?: number): string {
  if (ms === undefined) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Short, honest one-line outcome for a finished tool call. */
function resultHeadline(item: Extract<TranscriptItem, { kind: 'tool' }>): string {
  const lines = item.result.split('\n').filter(l => l.trim())
  if (item.isError) return lines[0]?.replace(/^Error:\s*/i, '') ?? 'failed'
  if (item.display?.kind === 'diff') {
    const d = item.display
    return d.created ? `created, ${d.added} line${d.added === 1 ? '' : 's'}` : `+${d.added} −${d.removed}`
  }
  switch (item.name) {
    case 'Read': return `${Math.max(0, item.result.split('\n').length)} lines`
    case 'Glob': return item.result.startsWith('No ') ? 'no matches' : `${lines.length} files`
    case 'Grep': return lines.length === 0 || /no matches/i.test(item.result) ? 'no matches' : `${lines.length} matches`
    default: return ''
  }
}

/** Which tools show an output preview, and how many lines. */
function previewLines(item: Extract<TranscriptItem, { kind: 'tool' }>): string[] {
  if (item.isError) return []
  const max = item.name === 'Bash' ? 8 : item.name === 'Grep' || item.name === 'Glob' ? 5 : 0
  if (!max) return []
  const lines = item.result.replace(/\n+$/, '').split('\n')
  if (lines.length <= max) return lines
  // For commands the end of the output (test summary, error) matters most
  return item.name === 'Bash'
    ? [`… ${lines.length - max} earlier lines`, ...lines.slice(-max)]
    : [...lines.slice(0, max), `… ${lines.length - max} more`]
}

export function ToolLine({ name, summary, status, headline, durationMs, approval, path }: {
  name: string
  summary: string
  status: 'running' | 'done' | 'error'
  headline?: string
  durationMs?: number
  approval?: string
  path?: string
}) {
  const t = theme()
  const marker = status === 'error' ? '✗' : changesProject(name) ? '●' : '○'
  const markerColor = status === 'error' ? t.danger : changesProject(name) ? t.toolWrite : t.faint
  return (
    <Box>
      <Text color={markerColor}>{marker} </Text>
      <Text color={t.tool} bold>{name}</Text>
      {summary ? <Text color={t.muted}> {path ? link(summary, path) : summary}</Text> : null}
      {status !== 'running' && (headline || durationMs !== undefined) ? (
        <Text color={status === 'error' ? t.danger : t.faint}>
          {'  '}{headline}{headline && durationMs !== undefined ? ', ' : ''}{formatDuration(durationMs)}
        </Text>
      ) : null}
      {approval ? <Text color={t.faint}>  · {approval}</Text> : null}
    </Box>
  )
}

export function TranscriptItemView({ item }: { item: TranscriptItem }) {
  const t = theme()
  switch (item.kind) {
    case 'banner':
      return <Welcome info={{ version: item.version, model: item.model, mode: item.mode ?? 'auto', cwd: item.cwd, account: item.account }} />
    case 'user':
      return (
        <Box marginBottom={1}>
          <Text color={t.accent}>{'> '}</Text>
          <Text bold>{item.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box marginBottom={1}>
          <Markdown text={item.text} />
        </Box>
      )
    case 'tool': {
      const preview = previewLines(item)
      const diff = !item.isError && item.display?.kind === 'diff' ? item.display : null
      return (
        <Box flexDirection="column" marginLeft={1} marginBottom={preview.length || diff ? 1 : 0}>
          <ToolLine
            name={item.name}
            summary={item.summary}
            status={item.isError ? 'error' : 'done'}
            headline={resultHeadline(item)}
            durationMs={item.durationMs}
            approval={item.approval}
            path={item.path}
          />
          {diff && <DiffView diff={diff} maxLines={diff.created ? 12 : 40} />}
          {diff?.taste?.length ? <TasteView findings={diff.taste} /> : null}
          {preview.length > 0 && (
            <Box marginLeft={2} flexDirection="column">
              {preview.map((l, i) => <Text key={i} color={t.faint}>{l || ' '}</Text>)}
            </Box>
          )}
        </Box>
      )
    }
    case 'expanded':
      return (
        <Box flexDirection="column" marginLeft={1} marginBottom={1}>
          {item.display?.kind === 'diff'
            ? <Text><Text bold>{item.summary}</Text><Text color={t.faint}>  {item.display.created ? `new file, ${item.display.added} line${item.display.added === 1 ? '' : 's'}` : `+${item.display.added} −${item.display.removed}`}</Text></Text>
            : <Text color={t.muted}>Full output of {item.name} {item.summary}</Text>}
          {item.display?.kind === 'diff'
            ? <DiffView diff={item.display} maxLines={Infinity} />
            : <Box marginLeft={2}><Text color={t.faint}>{item.result || '(no output)'}</Text></Box>}
        </Box>
      )
    case 'receipt':
      return <Receipt r={item.data} />
    case 'plan':
      return <PlanPanel plan={item.plan} live={false} />
    case 'critic':
      return (
        <Box marginLeft={3} marginBottom={item.issue ? 1 : 0}>
          {item.issue
            ? <Text><Text color={t.warning}>⚑ </Text><Text color={t.muted}>{item.model.split('/').pop()} on {item.path.split('/').pop()}: </Text><Text>{item.issue}</Text><Text color={t.faint}>  (Darce sees this with your next message)</Text></Text>
            : <Text color={t.faint}>✓ {item.model.split('/').pop()} reviewed {item.path.split('/').pop()}: no issues</Text>}
        </Box>
      )
    case 'system':
      return (
        <Box marginBottom={1}>
          <Text color={t.muted}>{item.text}</Text>
        </Box>
      )
    case 'error':
      return (
        <Box marginBottom={1}>
          <Text color={t.danger}>✗ {item.text}</Text>
        </Box>
      )
  }
}
