import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Message } from '../types.js'
import { writePrivate } from '../utils/privateFile.js'

// Read on each call so tests (and a changed HOME) see the right folder
const sessionsDir = () => join(homedir(), '.darce', 'sessions')
// Dot-named so it is never mistaken for a session file
const indexPath = () => join(sessionsDir(), '.index.json')

function ensureDir() {
  if (!existsSync(sessionsDir())) mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 })
}

export type SessionSummary = {
  sessionId: string
  cwd: string
  savedAt: string
  title: string
  count: number
  /** Last thing Darce said, for the preview */
  lastReply: string
}

/** A session's summary plus the file mtime it was taken from; a changed mtime means re-read. */
type IndexEntry = SessionSummary & { mtimeMs: number; corrupt?: boolean }

export function saveSession(sessionId: string, messages: Message[], cwd: string) {
  ensureDir()
  const file = `${sessionId}.json`
  const data = { sessionId, cwd, messages, savedAt: new Date().toISOString() }
  writePrivate(join(sessionsDir(), file), JSON.stringify(data))
  try {
    const entries = readIndex()
    entries[file] = { ...summarize(data, file), mtimeMs: statSync(join(sessionsDir(), file)).mtimeMs }
    writeIndex(entries)
  } catch {}
}

export function loadLatestSession(cwd: string): { sessionId: string; messages: Message[] } | null {
  // Newest first; a file that turns out unreadable is skipped for the next one
  const candidates = indexedSessions().filter(([, e]) => !e.corrupt && e.cwd === cwd).sort(([, a], [, b]) => (a.savedAt < b.savedAt ? 1 : -1))
  for (const [file] of candidates) {
    try {
      const data = JSON.parse(readFileSync(join(sessionsDir(), file), 'utf-8'))
      if (data.cwd === cwd && Array.isArray(data.messages)) return { sessionId: data.sessionId ?? file.replace(/\.json$/, ''), messages: data.messages }
    } catch {}
  }
  return null
}

/** The user's own words from a stored user message (drops Darce's notes and attachments). */
function userText(content: unknown): string {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : ''
  return raw.split('\n').filter(l => !l.startsWith('[Note from Darce:')).join('\n').trim()
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim()
}

function summarize(data: any, file: string): SessionSummary {
  const messages: Array<{ role: string; content: unknown }> = Array.isArray(data.messages) ? data.messages : []
  // Title: the first real request, skipping greetings like "hey" or "yo"
  const users = messages.filter(m => m.role === 'user' && userText(m.content))
  const firstUser = users.find(m => userText(m.content).split(/\s+/).length >= 3) ?? users[0]
  const title = firstUser ? userText(firstUser.content).split('\n')[0]!.slice(0, 120) : '(no messages)'
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && assistantText(m.content))
  return {
    sessionId: data.sessionId ?? file.replace(/\.json$/, ''),
    cwd: data.cwd ?? '',
    savedAt: data.savedAt ?? '',
    title: title || '(attachment only)',
    count: messages.length,
    lastReply: lastAssistant ? assistantText(lastAssistant.content).replace(/\s+/g, ' ').slice(0, 240) : '',
  }
}

function readIndex(): Record<string, IndexEntry> {
  try {
    const j = JSON.parse(readFileSync(indexPath(), 'utf-8'))
    return j?.v === 1 && j.entries && typeof j.entries === 'object' ? j.entries : {}
  } catch {
    return {}
  }
}

function writeIndex(entries: Record<string, IndexEntry>) {
  try { writePrivate(indexPath(), JSON.stringify({ v: 1, entries })) } catch {}
}

/**
 * Every session file with its summary. Only files that are new or changed since the index was
 * written get parsed (a missing index means one full scan), so listing stays cheap as sessions pile up.
 */
function indexedSessions(): Array<[string, IndexEntry]> {
  ensureDir()
  const known = readIndex()
  const next: Record<string, IndexEntry> = {}
  let changed = false
  for (const file of readdirSync(sessionsDir())) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue
    let mtimeMs: number
    try { mtimeMs = statSync(join(sessionsDir(), file)).mtimeMs } catch { continue }
    const entry = known[file]
    if (entry && entry.mtimeMs === mtimeMs) { next[file] = entry; continue }
    changed = true
    try {
      next[file] = { ...summarize(JSON.parse(readFileSync(join(sessionsDir(), file), 'utf-8')), file), mtimeMs }
    } catch {
      // Remembered as unreadable until the file changes again
      next[file] = { sessionId: file.replace(/\.json$/, ''), cwd: '', savedAt: '', title: '', count: 0, lastReply: '', mtimeMs, corrupt: true }
    }
  }
  if (changed || Object.keys(known).length !== Object.keys(next).length) writeIndex(next)
  return Object.entries(next)
}

/** Past conversations, newest first. */
export function listSessions(limit = 60): SessionSummary[] {
  return indexedSessions()
    .filter(([, e]) => !e.corrupt)
    .map(([, { mtimeMs, corrupt, ...summary }]) => summary)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
    .slice(0, limit)
}

export function loadSession(sessionId: string): { sessionId: string; messages: Message[]; cwd: string } | null {
  try {
    const data = JSON.parse(readFileSync(join(sessionsDir(), `${sessionId}.json`), 'utf-8'))
    return { sessionId: data.sessionId ?? sessionId, messages: data.messages ?? [], cwd: data.cwd ?? '' }
  } catch {
    return null
  }
}
