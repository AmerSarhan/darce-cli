import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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

/** Images stay in the last few messages only: a saved session with every screenshot in it grows to hundreds of MB. */
const KEEP_IMAGES = 6
function withoutOldImages(messages: Message[]): Message[] {
  const from = messages.length - KEEP_IMAGES
  return messages.map((m, i) => i >= from || typeof m.content === 'string' || !m.content.some(b => b.type === 'image')
    ? m
    : { ...m, content: m.content.map(b => b.type === 'image' ? { type: 'text' as const, text: `[image${b.name ? ` ${b.name}` : ''} not kept in the saved session]` } : b) })
}

/** The session file's mtime, to notice when another Darce window wrote it since. */
export function sessionMtime(sessionId: string): number | undefined {
  try { return statSync(join(sessionsDir(), `${sessionId}.json`)).mtimeMs } catch { return undefined }
}

/**
 * Saves the conversation. `since` is the mtime from our last save or load: if the file changed after it, another
 * window is continuing the same conversation, so this one forks to a new session instead of overwriting it.
 * Throws when the file can't be written (full disk, permissions).
 */
export function saveSession(sessionId: string, messages: Message[], cwd: string, since?: number): { sessionId: string; mtimeMs: number } {
  ensureDir()
  const now = sessionMtime(sessionId)
  if (since !== undefined && now !== undefined && now !== since) sessionId = randomUUID()
  const file = `${sessionId}.json`
  const data = { sessionId, cwd, messages: withoutOldImages(messages), savedAt: new Date().toISOString() }
  writePrivate(join(sessionsDir(), file), JSON.stringify(data))
  const mtimeMs = statSync(join(sessionsDir(), file)).mtimeMs
  try {
    const entries = readIndex()
    entries[file] = { ...summarize(data, file), mtimeMs }
    writeIndex(entries)
  } catch {}
  return { sessionId, mtimeMs }
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
  if (prune(next)) changed = true
  if (changed || Object.keys(known).length !== Object.keys(next).length) writeIndex(next)
  return Object.entries(next)
}

const KEEP_SESSIONS = 300
const PRUNE_AFTER_MS = 60 * 86400_000
/** Beyond the newest 300, sessions untouched for 60 days are deleted, so the folder doesn't grow forever. */
function prune(entries: Record<string, IndexEntry>): boolean {
  const old = Object.entries(entries).sort(([, a], [, b]) => b.mtimeMs - a.mtimeMs).slice(KEEP_SESSIONS)
    .filter(([, e]) => Date.now() - e.mtimeMs > PRUNE_AFTER_MS)
  for (const [file] of old) {
    try { unlinkSync(join(sessionsDir(), file)); delete entries[file] } catch {}
  }
  return old.length > 0
}

/** Past conversations, newest first. */
export function listSessions(limit = 60): SessionSummary[] {
  return indexedSessions()
    .filter(([, e]) => !e.corrupt)
    .map(([, { mtimeMs, corrupt, ...summary }]) => summary)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
    .slice(0, limit)
}

export function loadSession(sessionId: string): { sessionId: string; messages: Message[]; cwd: string; mtimeMs?: number } | null {
  try {
    const mtimeMs = sessionMtime(sessionId)
    const data = JSON.parse(readFileSync(join(sessionsDir(), `${sessionId}.json`), 'utf-8'))
    return { sessionId: data.sessionId ?? sessionId, messages: Array.isArray(data.messages) ? data.messages : [], cwd: data.cwd ?? '', mtimeMs }
  } catch {
    return null
  }
}
