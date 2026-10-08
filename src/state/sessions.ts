import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Message } from '../types.js'
import { writePrivate } from '../utils/privateFile.js'

const SESSIONS_DIR = join(homedir(), '.darce', 'sessions')

function ensureDir() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 })
}

export function saveSession(sessionId: string, messages: Message[], cwd: string) {
  ensureDir()
  const data = { sessionId, cwd, messages, savedAt: new Date().toISOString() }
  writePrivate(join(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify(data))
}

export function loadLatestSession(cwd: string): { sessionId: string; messages: Message[] } | null {
  ensureDir()
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))

  // Find most recent session for this cwd
  let latest: { sessionId: string; messages: Message[]; savedAt: string } | null = null
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'))
      if (data.cwd === cwd && (!latest || data.savedAt > latest.savedAt)) {
        latest = data
      }
    } catch {}
  }

  return latest ? { sessionId: latest.sessionId, messages: latest.messages } : null
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

/** Past conversations, newest first. */
export function listSessions(limit = 60): SessionSummary[] {
  ensureDir()
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
  const out: SessionSummary[] = []
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'))
      const messages: Array<{ role: string; content: unknown }> = data.messages ?? []
      // Title: the first real request, skipping greetings like "hey" or "yo"
      const users = messages.filter(m => m.role === 'user' && userText(m.content))
      const firstUser = users.find(m => userText(m.content).split(/\s+/).length >= 3) ?? users[0]
      const title = firstUser ? userText(firstUser.content).split('\n')[0]!.slice(0, 120) : '(no messages)'
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && assistantText(m.content))
      out.push({
        sessionId: data.sessionId ?? file.replace(/\.json$/, ''),
        cwd: data.cwd ?? '',
        savedAt: data.savedAt ?? '',
        title: title || '(attachment only)',
        count: messages.length,
        lastReply: lastAssistant ? assistantText(lastAssistant.content).replace(/\s+/g, ' ').slice(0, 240) : '',
      })
    } catch {}
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)).slice(0, limit)
}

export function loadSession(sessionId: string): { sessionId: string; messages: Message[]; cwd: string } | null {
  try {
    const data = JSON.parse(readFileSync(join(SESSIONS_DIR, `${sessionId}.json`), 'utf-8'))
    return { sessionId: data.sessionId ?? sessionId, messages: data.messages ?? [], cwd: data.cwd ?? '' }
  } catch {
    return null
  }
}
