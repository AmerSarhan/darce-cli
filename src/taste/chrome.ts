import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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

export class Browser {
  private ws!: WebSocket
  private proc!: ChildProcess
  private profile = mkdtempSync(join(tmpdir(), 'darce-chrome-'))
  private seq = 0
  private pending = new Map<number, Pending>()
  private listeners = new Set<(method: string, params: any, session?: string) => void>()

  static async launch(timeoutMs = 15_000): Promise<Browser> {
    const bin = findChrome()
    if (!bin) throw new Error('No Chrome, Edge or Chromium found. Install Chrome, or set DARCE_CHROME to a Chromium-based browser.')
    const b = new Browser()
    b.proc = spawn(bin, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${b.profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
      '--mute-audio', '--disable-background-networking', '--disable-sync', '--force-color-profile=srgb', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    const wsUrl = await new Promise<string>((ok, fail) => {
      let buf = ''
      const timer = setTimeout(() => fail(new Error('Chrome did not start in time')), timeoutMs)
      b.proc.stderr!.on('data', (d: Buffer) => {
        buf += d.toString()
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
        if (m) { clearTimeout(timer); ok(m[1]!) }
      })
      b.proc.once('exit', code => { clearTimeout(timer); fail(new Error(`Chrome exited (${code})`)) })
    })
    b.ws = new WebSocket(wsUrl)
    await new Promise<void>((ok, fail) => { b.ws.onopen = () => ok(); b.ws.onerror = () => fail(new Error('Could not connect to Chrome')) })
    b.ws.onmessage = ev => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && b.pending.has(msg.id)) {
        const p = b.pending.get(msg.id)!
        b.pending.delete(msg.id); clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
      } else if (msg.method) for (const l of b.listeners) l(msg.method, msg.params, msg.sessionId)
    }
    return b
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
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

  close() {
    try { this.ws?.close() } catch { /* already closed */ }
    try { this.proc?.kill() } catch { /* already gone */ }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser closed')) }
    this.pending.clear()
    setTimeout(() => { try { rmSync(this.profile, { recursive: true, force: true }) } catch { /* Chrome may still hold files */ } }, 500)
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
