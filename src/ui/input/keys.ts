import type { Key } from 'ink'
import type { EditorAction } from './editor.js'

export type InputIntent =
  | { kind: 'edit'; action: EditorAction }
  | { kind: 'submit' }
  | { kind: 'interrupt' } // Ctrl+C
  | { kind: 'escape' }
  | { kind: 'modelPicker' }
  | { kind: 'clearScreen' }
  | { kind: 'cycleMode' }
  | { kind: 'expand' }
  | { kind: 'none' }

const edit = (action: EditorAction): InputIntent => ({ kind: 'edit', action })

/**
 * Translate an Ink keypress into an intent. Works with legacy terminals and,
 * when the kitty keyboard protocol is active, adds Shift+Enter / Ctrl+M.
 */
export function intentFor(input: string, key: Key): InputIntent {
  if (key.ctrl && input === 'c') return { kind: 'interrupt' }
  if (key.escape) return { kind: 'escape' }

  // Newline: Shift+Enter or Alt+Enter (kitty / most modern terminals), or Ctrl+J everywhere
  if (key.return && (key.shift || key.meta)) return edit({ type: 'newline' })
  if (input === '\n' || (key.ctrl && input === 'j')) return edit({ type: 'newline' })
  if (key.return) return { kind: 'submit' }

  if (key.ctrl) {
    switch (input) {
      case 'a': return edit({ type: 'lineStart' })
      case 'e': return edit({ type: 'lineEnd' })
      case 'b': return edit({ type: 'left' })
      case 'f': return edit({ type: 'right' })
      case 'k': return edit({ type: 'killToEnd' })
      case 'u': return edit({ type: 'killToStart' })
      case 'w': return edit({ type: 'killWordBack' })
      case 'y': return edit({ type: 'yank' })
      case 'd': return edit({ type: 'delete' })
      case 'h': return edit({ type: 'backspace' })
      case 'l': return { kind: 'clearScreen' }
      case 'o': return { kind: 'expand' }
      case 'p':
      case 'm': return { kind: 'modelPicker' }
    }
    if (key.leftArrow) return edit({ type: 'wordLeft' })
    if (key.rightArrow) return edit({ type: 'wordRight' })
    return { kind: 'none' }
  }

  if (key.meta) {
    if (key.leftArrow || input === 'b') return edit({ type: 'wordLeft' })
    if (key.rightArrow || input === 'f') return edit({ type: 'wordRight' })
    if (key.backspace) return edit({ type: 'killWordBack' })
    return { kind: 'none' }
  }

  if (key.backspace) return edit({ type: 'backspace' })
  if (key.delete) return edit({ type: 'delete' })
  if (key.leftArrow) return edit({ type: 'left' })
  if (key.rightArrow) return edit({ type: 'right' })
  if (key.upArrow) return edit({ type: 'up' })
  if (key.downArrow) return edit({ type: 'down' })
  if (key.home) return edit({ type: 'lineStart' })
  if (key.end) return edit({ type: 'lineEnd' })
  if (key.tab && key.shift) return { kind: 'cycleMode' }
  if (key.tab || key.pageUp || key.pageDown) return { kind: 'none' }

  if (input) return edit({ type: 'insert', text: input })
  return { kind: 'none' }
}
