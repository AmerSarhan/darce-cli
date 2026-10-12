import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Just enough of the Chrome DevTools Protocol to render a page and look at it: the user's own
 * Chrome (or Edge, Brave, Chromium) in headless mode, a throwaway profile, and Node's built-in
 * WebSocket. Nothing is downloaded.
 */

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Arc.app/Contents/MacOS/Arc',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser'],
  win32: [
    join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ],
}

export function findChrome(): string | null {
  if (process.env.DARCE_CHROME && existsSync(process.env.DARCE_CHROME)) return process.env.DARCE_CHROME
  return (CANDIDATES[process.platform] ?? []).find(p => p && existsSync(p)) ?? null
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const PROFILE_PREFIX = 'darce-chrome-'
// Browsers still open when Darce exits (crash, Ctrl+C mid-check) are killed and their profiles removed
const live = new Set<Browser>()
let exitHooked = false
let swept = false

/** Is the Chrome that holds this profile still running? (Its SingletonLock points at "host-pid".) */
function profileInUse(dir: string): boolean {
  try {
    const pid = Number(/-(\d+)$/.exec(readlinkSync(join(dir, 'SingletonLock')))?.[1])
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Profiles left behind by earlier runs that were killed before cleaning up (each is 10-60 MB). */
function sweepStaleProfiles() {
  if (swept) return
  swept = true
  const dir = tmpdir(), cutoff = Date.now() - 60 * 60_000
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    if (!n.startsWith(PROFILE_PREFIX)) continue
    const p = join(dir, n)
    try {
      if (statSync(p).mtimeMs > cutoff || profileInUse(p)) continue
      void rm(p, { recursive: true, force: true }).catch(() => {})
    } catch { /* gone already */ }
  }
}

export class Browser {
  private ws?: WebSocket
  private proc?: ChildProcess
  private profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX))
  private seq = 0
  private closed = false
  private pending = new Map<number, Pending>()
  private listeners = new Set<(method: string, params: any, session?: string) => void>()

  static async launch(timeoutMs = 15_000): Promise<Browser> {
    const bin = findChrome()
    if (!bin) throw new Error('No Chrome, Edge or Chromium found. Install Chrome, or set DARCE_CHROME to a Chromium-based browser.')
    sweepStaleProfiles()
    if (!exitHooked) {
      exitHooked = true
      process.on('exit', () => { for (const b of live) b.killNow() })
    }
    const b = new Browser()
    live.add(b)
    try {
      const proc = b.proc = spawn(bin, [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${b.profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
        '--mute-audio', '--disable-background-networking', '--disable-sync', '--force-color-profile=srgb', 'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      // Without an 'error' listener a failed spawn (EACCES, ENOENT) is an uncaught exception
      proc.on('error', () => b.ended())
      proc.once('exit', () => b.ended())
      const wsUrl = await new Promise<string>((ok, fail) => {
        let buf = ''
        const timer = setTimeout(() => fail(new Error('Chrome did not start in time')), timeoutMs)
        const onData = (d: Buffer) => {
          buf += d.toString()
          const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
          if (!m) return
          clearTimeout(timer)
          // Keep draining stderr (a full pipe would stall Chrome) without keeping what it says
          proc.stderr!.off('data', onData)
          proc.stderr!.resume()
          ok(m[1]!)
        }
        proc.stderr!.on('data', onData)
        proc.once('exit', code => { clearTimeout(timer); fail(new Error(`Chrome exited (${code})`)) })
        proc.once('error', err => { clearTimeout(timer); fail(new Error(`Couldn't start ${bin}: ${err.message}`)) })
      })
      const ws = b.ws = new WebSocket(wsUrl)
      await new Promise<void>((ok, fail) => {
        ws.onopen = () => ok()
        ws.onerror = () => fail(new Error('Could not connect to Chrome'))
        ws.onclose = () => fail(new Error('Could not connect to Chrome'))
      })
      ws.onerror = null
      ws.onclose = () => b.ended()
      ws.onmessage = ev => {
        let msg: any
        try { msg = JSON.parse(String(ev.data)) } catch { return }
        if (msg.id && b.pending.has(msg.id)) {
          const p = b.pending.get(msg.id)!
          b.pending.delete(msg.id); clearTimeout(p.timer)
          if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
        } else if (msg.method) for (const l of b.listeners) l(msg.method, msg.params, msg.sessionId)
      }
      return b
    } catch (err) {
      b.close()
      throw err
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed || !this.ws) return Promise.reject(new Error('Chrome closed'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (err) {
        this.pending.delete(id); clearTimeout(timer); reject(err as Error)
      }
    })
  }

  /** Resolve on the first matching event, or after `timeoutMs` (never rejects). */
  waitFor(method: string, sessionId: string, timeoutMs: number): Promise<boolean> {
    return new Promise(ok => {
      const done = (v: boolean) => { this.listeners.delete(l); clearTimeout(t); ok(v) }
      const l = (m: string, _p: any, s?: string) => { if (m === method && s === sessionId) done(true) }
      const t = setTimeout(() => done(false), timeoutMs)
      this.listeners.add(l)
    })
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    await this.send('Page.enable', {}, sessionId)
    await this.send('Runtime.enable', {}, sessionId)
    return new Page(this, sessionId)
  }

  private failPending(err: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
  }

  private removeProfile() {
    try { rmSync(this.profile, { recursive: true, force: true, maxRetries: 2 }) } catch { /* Chrome may still hold files */ }
  }

  /** Chrome went away (exited, crashed, never started, or dropped the connection). */
  private ended() {
    this.closed = true
    this.failPending(new Error('Chrome closed'))
    try { this.ws?.close() } catch { /* already closed */ }
    // Once the process is gone nothing writes to the profile any more
    if (!this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null || this.proc.pid === undefined) {
      live.delete(this)
      this.removeProfile()
    } else {
      try { this.proc.kill() } catch { /* already gone */ }
    }
  }

  close() {
    this.closed = true
    this.failPending(new Error('Browser closed'))
    try { this.ws?.close() } catch { /* already closed */ }
    if (this.proc?.pid !== undefined && this.proc.exitCode === null && this.proc.signalCode === null) {
      try { this.proc.kill() } catch { /* already gone */ } // the profile goes on its 'exit'
    } else {
      live.delete(this)
      this.removeProfile()
    }
  }

  /** At process exit there's no later tick: kill hard and remove the profile right away. */
  private killNow() {
    try { this.proc?.kill('SIGKILL') } catch { /* already gone */ }
    this.removeProfile()
  }
}

export class Page {
  constructor(private b: Browser, private session: string) {}

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    return this.b.send<T>(method, params, this.session, timeoutMs)
  }

  async viewport(width: number, height: number, mobile: boolean) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile })
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile })
    // Reduced motion: well-made pages render their final state instead of mid-animation
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  }

  async goto(url: string, settleMs = 900) {
    const loaded = this.b.waitFor('Page.loadEventFired', this.session, 20_000)
    const r = await this.send<{ errorText?: string }>('Page.navigate', { url })
    if (r.errorText) throw new Error(`Couldn't open ${url}: ${r.errorText}`)
    await loaded
    // Walk down the page so lazy images and scroll reveals render, then back to the top
    await this.eval(`(async () => { const h = Math.min(document.documentElement.scrollHeight, 12000); for (let y = 0; y < h; y += innerHeight * 0.8) { scrollTo(0, y); await new Promise(r => setTimeout(r, 60)) } scrollTo(0, 0) })()`, true)
    await new Promise(r => setTimeout(r, settleMs))
  }

  async eval<T = unknown>(expression: string, awaitPromise = false): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  /** The whole page as a JPEG, capped in height so a long page stays a reasonable size. */
  async screenshot(width: number, maxHeight = 9000): Promise<{ data: Buffer; width: number; height: number }> {
    const height = Math.min(maxHeight, Math.max(1, await this.eval<number>('Math.ceil(document.documentElement.scrollHeight)')))
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 82, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }, 60_000)
    return { data: Buffer.from(r.data, 'base64'), width, height }
  }
}
