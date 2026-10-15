import { useEffect, useState } from 'react'

// cli-highlight pulls in highlight.js: ~66ms to import, so it loads after the first paint, not before.
// Ink renders synchronously, so code shows plain until it's here and live views re-render once it lands.
type Highlighter = typeof import('cli-highlight')
let mod: Highlighter | null = null
let loading: Promise<void> | null = null
const waiting = new Set<() => void>()

export function loadHighlighter(): Promise<void> {
  loading ??= import('cli-highlight').then(m => { mod = m }, () => {}).finally(() => {
    for (const fn of waiting) fn()
    waiting.clear()
  })
  return loading
}

export const highlighterReady = () => mod !== null

/** Highlighted code, or the code unchanged when the language is unknown or the highlighter hasn't loaded yet. */
export function highlightCode(code: string, lang: string | undefined): string {
  if (!lang) return code
  if (!mod) { void loadHighlighter(); return code }
  if (!mod.supportsLanguage(lang)) return code
  try { return mod.highlight(code, { language: lang, ignoreIllegals: true }) } catch { return code }
}

/** `false` until the highlighter has loaded; a component reading it re-renders when it lands. */
export function useHighlighter(): boolean {
  const [ready, setReady] = useState(highlighterReady)
  useEffect(() => {
    if (ready) return
    const done = () => setReady(true)
    waiting.add(done)
    void loadHighlighter()
    return () => { waiting.delete(done) }
  }, [ready])
  return ready
}
