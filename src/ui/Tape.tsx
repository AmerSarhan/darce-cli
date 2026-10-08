import React from 'react'
import { Box, Text, useWindowSize } from 'ink'
import { theme } from './theme.js'
import { DiffView } from './DiffView.js'
import type { FileDiff } from '../utils/diff.js'

export type TapeFrame = { label: string; at: number }

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * The Scrubber Tape: every change Darce made this session as a strip of frames.
 * ←/→ scrubs, the preview shows what that step changed, Enter rewinds to before it.
 */
export function Tape({ frames, index, preview }: { frames: TapeFrame[]; index: number; preview: FileDiff[] | null }) {
  const t = theme()
  const { columns } = useWindowSize()
  const width = Math.max(40, (columns || 80) - 4)

  // A window of frames around the cursor that fits the terminal width
  const cell = (f: TapeFrame) => f.label.split(' ').slice(0, 2).join(' ').slice(0, 22)
  let start = index
  let end = index + 1
  let used = cell(frames[index]!).length + 4
  while (true) {
    const canLeft = start > 0 && used + cell(frames[start - 1]!).length + 4 < width
    if (canLeft) { start--; used += cell(frames[start]!).length + 4 }
    const canRight = end < frames.length && used + cell(frames[end]!).length + 4 < width
    if (canRight) { used += cell(frames[end]!).length + 4; end++ }
    if (!canLeft && !canRight) break
  }

  const added = preview?.reduce((n, d) => n + d.added, 0) ?? 0
  const removed = preview?.reduce((n, d) => n + d.removed, 0) ?? 0

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold>Rewind</Text>
        <Text color={t.faint}>step {index + 1} of {frames.length} · {clock(frames[index]!.at)}</Text>
      </Box>
      <Text>
        {start > 0 ? <Text color={t.faint}>◂ </Text> : <Text>  </Text>}
        {frames.slice(start, end).map((f, i) => {
          const at = start + i
          const active = at === index
          return (
            <Text key={at}>
              <Text color={active ? t.accent : at > index ? t.faint : t.muted} bold={active} inverse={active}> {cell(f)} </Text>
              {at < end - 1 ? <Text color={t.faint}>─</Text> : null}
            </Text>
          )
        })}
        {end < frames.length ? <Text color={t.faint}> ▸</Text> : null}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={t.muted}>
          {frames[index]!.label}
          {preview ? <Text color={t.faint}>   {preview.length} file{preview.length === 1 ? '' : 's'} <Text color={t.diffAdd}>+{added}</Text> <Text color={t.diffDel}>−{removed}</Text></Text> : null}
        </Text>
        {preview === null ? <Text color={t.faint}>Preview needs a git repository.</Text> : null}
        {preview?.length === 0 ? <Text color={t.faint}>This step did not change any files.</Text> : null}
        {preview?.slice(0, 2).map(d => (
          <Box key={d.path} flexDirection="column">
            <Text color={t.text}>{d.path}</Text>
            <DiffView diff={d} maxLines={12} />
          </Box>
        ))}
        {preview && preview.length > 2 ? <Text color={t.faint}>… and {preview.length - 2} more files</Text> : null}
      </Box>
      <Box marginTop={1}>
        <Text color={t.faint}>
          <Text color={t.accent}>←/→</Text> scrub   <Text color={t.accent}>enter</Text> rewind files and conversation to before this step   <Text color={t.accent}>esc</Text> close
        </Text>
      </Box>
    </Box>
  )
}
