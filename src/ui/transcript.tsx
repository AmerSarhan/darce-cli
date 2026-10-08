import React from 'react'
import { Box, Text } from 'ink'
import { Markdown } from './Markdown.js'
import { theme } from './theme.js'
import { getTool } from '../tools/registry.js'

// Everything that has happened in the session. Committed items are printed
// once via <Static> and never re-rendered.
export type TranscriptItem =
  | { kind: 'banner'; id: string; version: string; model: string; cwd: string }
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; result: string; isError?: boolean; durationMs?: number }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }

let seq = 0
export const newId = (prefix = 'i') => `${prefix}${++seq}`

export function toolSummary(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'Read': case 'Write': case 'Edit': return s(input.file_path)
    case 'Bash': return s(input.command).split('\n')[0]!.slice(0, 100)
    case 'Glob': return s(input.pattern)
    case 'Grep': return `"${s(input.pattern)}"${input.path ? ` in ${s(input.path)}` : ''}`
    case 'WebFetch': return s(input.url)
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

export function ToolLine({ name, summary, status, headline, durationMs }: {
  name: string
  summary: string
  status: 'running' | 'done' | 'error'
  headline?: string
  durationMs?: number
}) {
  const t = theme()
  const marker = status === 'error' ? '✗' : changesProject(name) ? '●' : '○'
  const markerColor = status === 'error' ? t.danger : changesProject(name) ? t.toolWrite : t.faint
  return (
    <Box>
      <Text color={markerColor}>{marker} </Text>
      <Text color={t.tool} bold>{name}</Text>
      {summary ? <Text color={t.muted}> {summary}</Text> : null}
      {status !== 'running' && (headline || durationMs !== undefined) ? (
        <Text color={status === 'error' ? t.danger : t.faint}>
          {'  '}{headline}{headline && durationMs !== undefined ? ', ' : ''}{formatDuration(durationMs)}
        </Text>
      ) : null}
    </Box>
  )
}

export function TranscriptItemView({ item }: { item: TranscriptItem }) {
  const t = theme()
  switch (item.kind) {
    case 'banner':
      return (
        <Box marginBottom={1} flexDirection="column">
          <Text>
            <Text color={t.accent}>{'> '}</Text>
            <Text bold>Darce</Text>
            <Text color={t.faint}> v{item.version}  {item.model}  {item.cwd}</Text>
          </Text>
          <Text color={t.faint}>/model to switch models · /help for commands · Shift+Enter or Ctrl+J for a new line</Text>
        </Box>
      )
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
      return (
        <Box flexDirection="column" marginLeft={1} marginBottom={preview.length ? 1 : 0}>
          <ToolLine
            name={item.name}
            summary={item.summary}
            status={item.isError ? 'error' : 'done'}
            headline={resultHeadline(item)}
            durationMs={item.durationMs}
          />
          {preview.length > 0 && (
            <Box marginLeft={2} flexDirection="column">
              {preview.map((l, i) => <Text key={i} color={t.faint}>{l || ' '}</Text>)}
            </Box>
          )}
        </Box>
      )
    }
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
