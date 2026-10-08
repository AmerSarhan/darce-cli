import { appendFileSync, mkdirSync, statSync, renameSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEBUG = process.env.DARCE_DEBUG === '1'

export function debug(...args: unknown[]) {
  if (DEBUG) {
    process.stderr.write(`[darce] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`)
  }
}

/**
 * Timing trace for diagnosing stalls: when requests start, when the first byte and first words
 * arrive, tool durations, approval waits, retries and errors. Never prompts, file contents or keys.
 * ~/.darce/logs/trace.log, one JSON object per line, rotated at 1 MB.
 */
const LOG_DIR = join(homedir(), '.darce', 'logs')
export const TRACE_PATH = join(LOG_DIR, 'trace.log')
const T0 = Date.now()
let ready = false

export function trace(event: string, data: Record<string, unknown> = {}): void {
  if (process.env.DARCE_TRACE === '0') return
  try {
    if (!ready) {
      mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
      try { if (statSync(TRACE_PATH).size > 1_000_000) renameSync(TRACE_PATH, `${TRACE_PATH}.1`) } catch {}
      ready = true
    }
    appendFileSync(TRACE_PATH, JSON.stringify({ t: new Date().toISOString(), up: Date.now() - T0, pid: process.pid, event, ...data }) + '\n', { mode: 0o600 })
  } catch {}
}

/** The last `n` trace events of this process, formatted for /debug. */
export function recentTrace(n = 40): string {
  try {
    const lines = readFileSync(TRACE_PATH, 'utf-8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const mine = lines.filter((e: { pid: number }) => e.pid === process.pid).slice(-n)
    if (!mine.length) return 'No events yet in this session.'
    return mine.map((e: Record<string, unknown>) => {
      const { t, up, pid, event, ...rest } = e
      const detail = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
      return `${String(t).slice(11, 19)}  ${String(event).padEnd(16)} ${detail}`
    }).join('\n')
  } catch {
    return 'No trace log yet.'
  }
}
