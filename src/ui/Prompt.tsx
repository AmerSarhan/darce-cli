import React from 'react'
import { Box, Text } from 'ink'
import { cursorPosition, type EditorState } from './input/editor.js'
import { theme } from './theme.js'

type Props = {
  editor: EditorState
  busy: boolean
  dimmed?: boolean
  suggestion?: string | null
}

/** Renders the editable prompt. All key handling lives in REPL via input/keys.ts. */
export function Prompt({ editor, busy, dimmed = false, suggestion }: Props) {
  const t = theme()
  const { lines, line: cursorLine, col } = cursorPosition(editor)
  const empty = editor.text.length === 0

  return (
    <Box flexDirection="column">
      {lines.map((text, i) => {
        const prefix = i === 0 ? '> ' : '  '
        const hasCursor = !dimmed && i === cursorLine
        return (
          <Box key={i}>
            <Text color={dimmed ? t.faint : t.accent} bold>{prefix}</Text>
            {empty && i === 0 ? (
              <Text>
                {!dimmed && <Text inverse> </Text>}
                {suggestion && !busy && !dimmed
                  ? <Text><Text color={t.faint}>{suggestion}</Text><Text color={t.faint} dimColor>   tab ↹</Text></Text>
                  : <Text color={t.faint}>
                      {busy ? 'Type to queue a message · Esc stops Darce' : 'Ask Darce to change, fix or explain something'}
                    </Text>}
              </Text>
            ) : hasCursor ? (
              <Text>
                {text.slice(0, col)}
                <Text inverse>{text[col] ?? ' '}</Text>
                {text.slice(col + 1)}
              </Text>
            ) : (
              <Text color={dimmed ? t.faint : undefined}>{text || ' '}</Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
