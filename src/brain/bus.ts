/**
 * Events for the brain view (/brain). Darce reports what it does here; the local page listens.
 * Until /brain is opened nothing is recorded, so this costs nothing in a normal session.
 */
export type BrainEvent = { type: string; at: number; [key: string]: unknown }
type Listener = (e: BrainEvent) => void

const BACKLOG = 600

class BrainBus {
  active = false
  private log: BrainEvent[] = []
  private listeners = new Set<Listener>()
  private text = ''
  private textTimer: ReturnType<typeof setTimeout> | null = null

  emit(type: string, data: Record<string, unknown> = {}): void {
    if (!this.active) return
    if (type !== 'text') this.flushText()
    this.push({ type, at: Date.now(), ...data })
  }

  /** Streamed answer text arrives a few characters at a time; the page gets it in small batches. */
  streamText(delta: string): void {
    if (!this.active || !delta) return
    this.text += delta
    if (!this.textTimer) this.textTimer = setTimeout(() => this.flushText(), 90)
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  backlog(): readonly BrainEvent[] {
    return this.log
  }

  private flushText(): void {
    if (this.textTimer) { clearTimeout(this.textTimer); this.textTimer = null }
    if (!this.text) return
    const delta = this.text
    this.text = ''
    this.push({ type: 'text', at: Date.now(), delta })
  }

  private push(e: BrainEvent): void {
    this.log.push(e)
    if (this.log.length > BACKLOG) this.log.splice(0, this.log.length - BACKLOG)
    for (const fn of this.listeners) {
      try { fn(e) } catch { /* a closed page shouldn't break Darce */ }
    }
  }
}

export const brain = new BrainBus()
