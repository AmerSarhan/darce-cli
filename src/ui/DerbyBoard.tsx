import React from 'react'
import { Box, Text, useAnimation } from 'ink'
import { theme } from './theme.js'
import { DiffView } from './DiffView.js'
import { Markdown } from './Markdown.js'
import type { Racer } from '../core/derby.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const ANSWER_LINES = 18
const answerLines = (s: string) => s.trim().split('\n').length

function secs(ms: number) {
  return `${Math.round(ms / 1000)}s`
}

export function DerbyBoard({ task, racers, selected, finished, variant = 'derby' }: { task: string; racers: Racer[]; selected: number; finished: boolean; variant?: 'derby' | 'swarm' }) {
  const swarm = variant === 'swarm'
  const t = theme()
  const { frame } = useAnimation({ interval: 80, isActive: !finished })
  const pick = racers[selected]
  const cheapest = Math.min(...racers.filter(r => r.status === 'done' && r.diffs.length).map(r => r.cost))

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold>{swarm ? 'Swarm' : 'Derby'} <Text color={t.muted}>"{task.length > 60 ? task.slice(0, 57) + '…' : task}"</Text></Text>
        <Text color={t.faint}>{finished ? 'all finished' : `${racers.filter(r => r.status === 'running' || r.status === 'starting').length} running`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {racers.map((r, i) => {
          const active = i === selected
          const added = r.diffs.reduce((n, d) => n + d.added, 0)
          const removed = r.diffs.reduce((n, d) => n + d.removed, 0)
          const icon = r.status === 'done' ? '✓' : r.status === 'error' ? '✗' : r.status === 'stopped' ? '■' : FRAMES[frame % FRAMES.length]
          const iconColor = r.status === 'done' ? t.success : r.status === 'error' ? t.danger : t.accent
          return (
            <Box key={`${r.model}-${i}`}>
              <Text color={active ? t.accent : t.faint}>{active ? '▸' : ' '} {i + 1} </Text>
              <Box width={30}><Text bold={active} wrap="truncate-end">{swarm ? r.title : r.model.split('/').pop()}</Text></Box>
              <Text color={iconColor}>{icon} </Text>
              <Box width={26}>
                {r.status === 'done' || r.status === 'stopped'
                  ? <Text>{r.diffs.length} files <Text color={t.diffAdd}>+{added}</Text> <Text color={t.diffDel}>−{removed}</Text></Text>
                  : r.status === 'error'
                    ? <Text color={t.danger} wrap="truncate-end">{r.error}</Text>
                    : <Text color={t.muted} wrap="truncate-end">{r.activity} · step {r.steps}</Text>}
              </Box>
              <Box width={10}><Text color={r.cost === cheapest && finished ? t.success : t.faint}>${r.cost.toFixed(4)}</Text></Box>
              <Text color={t.faint}>{secs(r.ms)}</Text>
            </Box>
          )
        })}
      </Box>
      {pick && pick.status !== 'done' && pick.status !== 'error' && pick.status !== 'stopped' ? (
        <Box marginTop={1}><Text color={t.faint}>{swarm ? pick.title : pick.model.split('/').pop()} is still working ({pick.activity}).</Text></Box>
      ) : null}
      {pick && !pick.diffs.length && pick.status === 'done' && pick.answer.trim() ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.muted}>{swarm ? pick.title : pick.model.split('/').pop()}'s answer{answerLines(pick.answer) > ANSWER_LINES ? ` (first ${ANSWER_LINES} lines; enter shows all)` : ''}</Text>
          <Markdown text={pick.answer.trim().split('\n').slice(0, ANSWER_LINES).join('\n')} />
        </Box>
      ) : pick && pick.diffs.length && (pick.status === 'done' || finished) ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.muted}>{swarm ? pick.title : pick.model}{pick.answer ? ': ' : ''}<Text color={t.text}>{pick.answer.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 220)}</Text></Text>
          {pick.diffs.slice(0, 2).map(d => (
            <Box key={d.path} flexDirection="column" marginTop={1}>
              <Text>{d.path}</Text>
              <DiffView diff={d} maxLines={14} />
            </Box>
          ))}
          {pick.diffs.length > 2 ? <Text color={t.faint}>… and {pick.diffs.length - 2} more files</Text> : null}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={t.faint}>
          {finished
            ? swarm
              ? <><Text color={t.accent}>1-{racers.length} / ↑↓</Text> inspect   <Text color={t.accent}>enter</Text> merge all threads   <Text color={t.accent}>esc</Text> discard all</>
              : <><Text color={t.accent}>1-{racers.length} / ↑↓</Text> compare   <Text color={t.accent}>enter</Text> {pick?.diffs.length ? 'apply this one' : 'use this answer'}   <Text color={t.accent}>esc</Text> discard all</>
            : swarm
              ? <><Text color={t.accent}>1-{racers.length} / ↑↓</Text> inspect   <Text color={t.accent}>esc</Text> stop the swarm</>
              : <><Text color={t.accent}>1-{racers.length} / ↑↓</Text> inspect   <Text color={t.accent}>enter</Text> use a finished one now   <Text color={t.accent}>esc</Text> stop the race</>}
        </Text>
      </Box>
    </Box>
  )
}
