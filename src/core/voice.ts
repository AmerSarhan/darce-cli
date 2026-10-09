import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trace } from '../utils/logger.js'

/**
 * Darce talking: short spoken updates ("Okay, found it, the test was racing the database").
 * The server writes the line and speaks it (ElevenLabs v4); here we decide when to speak and play the
 * audio in a separate process. Nothing in a task ever waits on voice: every call is fire-and-forget,
 * and any failure (no player, no network, limit reached) just means silence.
 */
export type VoiceEvent = 'hello' | 'start' | 'progress' | 'ask' | 'done' | 'error'

export const VOICE_NAMES = ['erik', 'joe', 'zara', 'callum', 'charlotte'] as const

/** A first name from an email like amer.sarhan@gmail.com → "Amer"; nothing if it doesn't look like one. */
export function firstNameFromEmail(email?: string): string {
  const local = (email ?? '').split('@')[0] ?? ''
  // "amer.sarhan" or "amer": a name. "xacom39771": a handle, so no name (/voice name sets one)
  const m = /^([a-z]{2,14})(?:[._\-+][a-z]|$)/i.exec(local)
  const first = m?.[1] ?? ''
  if (!first) return ''
  return first[0]!.toUpperCase() + first.slice(1).toLowerCase()
}

export type Player = { cmd: string; args: (file: string) => string[] }

let player: Player | null | undefined
/** The first audio player this machine has, found once. */
export function findPlayer(): Player | null {
  if (player !== undefined) return player
  const has = (c: string) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { stdio: 'ignore' }).status === 0
  const options: Player[] = process.platform === 'darwin'
    ? [{ cmd: 'afplay', args: f => [f] }]
    : process.platform === 'win32'
      ? [{ cmd: 'powershell', args: f => ['-NoProfile', '-Command', `Add-Type -AssemblyName presentationCore; $p=New-Object System.Windows.Media.MediaPlayer; $p.Open([uri]'${f}'); $p.Play(); while(-not $p.NaturalDuration.HasTimeSpan){Start-Sleep -m 50}; Start-Sleep -m ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 200)`] }]
      : [
          { cmd: 'mpg123', args: f => ['-q', f] },
          { cmd: 'ffplay', args: f => ['-nodisp', '-autoexit', '-loglevel', 'quiet', f] },
          { cmd: 'mpv', args: f => ['--no-video', '--really-quiet', f] },
          { cmd: 'cvlc', args: f => ['--play-and-exit', '--quiet', f] },
        ]
  player = options.find(p => has(p.cmd)) ?? null
  return player
}

export class Narrator {
  private playing: ChildProcess | null = null
  private next: { event: VoiceEvent; context: string } | null = null
  private fetching = false
  private lastSpokeAt = 0
  private generation = 0
  onLimit?: (message: string) => void
  /** Called with each line as it starts playing (the brain view shows it) */
  onLine?: (line: string) => void

  constructor(private opts: { apiKey: string; apiBase: string; name: () => string; voice: () => string; player?: () => Player | null }) {}

  /**
   * Say something. "ask", "done" and "error" matter, so they wait for the current line to finish;
   * "start" and "progress" are only worth saying in the moment, so they're dropped if Darce is busy talking.
   */
  say(event: VoiceEvent, context: string): void {
    const important = event === 'ask' || event === 'done' || event === 'error' || event === 'hello'
    if (this.playing || this.fetching) {
      if (important) this.next = { event, context }
      return
    }
    if (!important && Date.now() - this.lastSpokeAt < 8_000) return
    void this.speak(event, context)
  }

  /** Stop talking now (Ctrl+C, /voice off). */
  stop(): void {
    this.generation++
    this.next = null
    this.playing?.kill()
    this.playing = null
  }

  private async speak(event: VoiceEvent, context: string): Promise<void> {
    const p = (this.opts.player ?? findPlayer)()
    if (!p) return
    const gen = this.generation
    this.fetching = true
    const t0 = Date.now()
    try {
      const res = await fetch(`${this.opts.apiBase}/v1/voice`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, context: context.slice(0, 1500), name: this.opts.name(), voice: this.opts.voice() }),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 402) { const j = await res.json().catch(() => ({})) as { message?: string }; this.onLimit?.(j.message ?? 'Voice limit reached for this month.'); return }
      if (!res.ok) { trace('voice', { event, status: res.status }); return }
      const audio = Buffer.from(await res.arrayBuffer())
      if (gen !== this.generation) return // stopped while we were fetching
      const file = join(tmpdir(), `darce-voice-${process.pid}-${Date.now()}.mp3`)
      writeFileSync(file, audio)
      trace('voice', { event, ms: Date.now() - t0, line: decodeURIComponent(res.headers.get('x-darce-line') ?? '') })
      this.fetching = false
      this.onLine?.(decodeURIComponent(res.headers.get('x-darce-line') ?? ''))
      this.play(p, file)
    } catch (err) {
      trace('voice', { event, error: (err as Error).message })
    } finally {
      this.fetching = false
      if (!this.playing) this.drain()
    }
  }

  private play(p: Player, file: string): void {
    const child = spawn(p.cmd, p.args(file), { stdio: 'ignore', windowsHide: true })
    this.playing = child
    this.lastSpokeAt = Date.now()
    const done = () => {
      if (this.playing === child) this.playing = null
      try { unlinkSync(file) } catch { /* already gone */ }
      this.lastSpokeAt = Date.now()
      this.drain()
    }
    child.once('exit', done)
    child.once('error', done)
  }

  private drain(): void {
    const n = this.next
    if (!n || this.playing || this.fetching) return
    this.next = null
    void this.speak(n.event, n.context)
  }
}
