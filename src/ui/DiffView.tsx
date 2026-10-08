import React from 'react'
import { Box, Text } from 'ink'
import { highlight, supportsLanguage } from 'cli-highlight'
import { extname } from 'node:path'
import { theme } from './theme.js'
import type { FileDiff } from '../utils/diff.js'

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.swift': 'swift', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cs': 'csharp', '.php': 'php',
  '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.md': 'markdown',
  '.css': 'css', '.scss': 'scss', '.html': 'xml', '.xml': 'xml', '.vue': 'xml', '.svelte': 'xml',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.sql': 'sql', '.graphql': 'graphql', '.dockerfile': 'dockerfile',
}

function languageFor(path: string): string | undefined {
  const lang = EXT_LANG[extname(path).toLowerCase()] ?? (/dockerfile$/i.test(path) ? 'dockerfile' : undefined)
  return lang && supportsLanguage(lang) ? lang : undefined
}

function colorize(code: string, lang?: string): string {
  if (!lang || !code.trim()) return code
  try {
    return highlight(code, { language: lang, ignoreIllegals: true })
  } catch {
    return code
  }
}

const MAX_LINES = 40

export function DiffView({ diff, maxLines = MAX_LINES }: { diff: FileDiff; maxLines?: number }) {
  const t = theme()
  const lang = languageFor(diff.path)
  const width = String(Math.max(1, ...diff.hunks.flatMap(h => h.lines.map(l => l.newNo ?? l.oldNo ?? 0)))).length

  let shown = 0
  const total = diff.hunks.reduce((n, h) => n + h.lines.length, 0)
  const blocks: React.ReactNode[] = []

  diff.hunks.forEach((hunk, hi) => {
    if (shown >= maxLines) return
    if (hi > 0) blocks.push(<Text key={`gap${hi}`} color={t.faint}>{' '.repeat(width + 1)}⋮</Text>)
    for (const [li, line] of hunk.lines.entries()) {
      if (shown >= maxLines) break
      shown++
      const no = String(line.kind === 'del' ? line.oldNo : line.newNo).padStart(width)
      const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
      const bg = line.kind === 'add' ? t.diffAddBg : line.kind === 'del' ? t.diffDelBg : undefined
      const signColor = line.kind === 'add' ? t.diffAdd : line.kind === 'del' ? t.diffDel : t.faint
      blocks.push(
        <Box key={`${hi}-${li}`}>
          <Text color={t.faint}>{no} </Text>
          <Text backgroundColor={bg} color={signColor}>{sign} </Text>
          <Text backgroundColor={bg} wrap="truncate-end">{colorize(line.text, lang) || ' '}</Text>
        </Box>,
      )
    }
  })

  return (
    <Box flexDirection="column" marginLeft={2}>
      {blocks}
      {total > shown && <Text color={t.faint}>{' '.repeat(width + 1)}… {total - shown} more lines · Ctrl+O shows the full diff</Text>}
    </Box>
  )
}
