import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, symlinkSync, copyFileSync, mkdirSync, rmSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { query } from './query.js'
import { toolRisk } from './risk.js'
import { buildSystemPrompt } from './context.js'
import { getModelProfile } from '../config/models.js'
import { fileDiff, type FileDiff } from '../utils/diff.js'
import type { Provider } from '../providers/provider.js'
import type { Message } from '../types.js'

/**
 * Model Derby: the same task, several models, each in its own throwaway git worktree.
 * Nothing touches your files until you pick a winner.
 */
export type Racer = {
  model: string
  status: 'starting' | 'running' | 'done' | 'error' | 'stopped'
  activity: string
  steps: number
  cost: number
  ms: number
  answer: string
  error?: string
  diffs: FileDiff[]
  dir?: string
}

const SHARED_DIRS = ['node_modules', '.venv', 'venv', 'vendor', '.next']

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
}

export function defaultRacers(current: string, configured?: string[]): string[] {
  const pool = configured?.length ? configured : [current, 'anthropic/claude-sonnet-5.5', 'openai/gpt-5.6-sol', 'google/gemini-3.1-pro-preview']
  return [...new Set(pool)].slice(0, 3)
}

export class Derby {
  racers: Racer[]
  private controller = new AbortController()
  private startedAt = Date.now()

  constructor(
    private root: string,
    private base: string, // commit of the working tree at the start
    models: string[],
    private onUpdate: () => void,
  ) {
    this.racers = models.map(model => ({ model, status: 'starting', activity: 'setting up', steps: 0, cost: 0, ms: 0, answer: '', diffs: [] }))
  }

  async run(task: string, history: Message[], provider: Provider, passEnv?: string[]): Promise<void> {
    await Promise.all(this.racers.map(r => this.race(r, task, history, provider, passEnv)))
  }

  private async race(r: Racer, task: string, history: Message[], provider: Provider, passEnv?: string[]) {
    const update = () => { r.ms = Date.now() - this.startedAt; this.onUpdate() }
    try {
      r.dir = mkdtempSync(join(tmpdir(), 'darce-derby-'))
      git(['worktree', 'add', '--detach', '--quiet', r.dir, this.base], this.root)
      // Share heavy ignored folders so builds and tests work in the worktree
      for (const d of SHARED_DIRS) {
        const src = join(this.root, d)
        if (existsSync(src) && !existsSync(join(r.dir, d))) {
          try { symlinkSync(src, join(r.dir, d), 'dir') } catch {}
        }
      }
      r.status = 'running'
      r.activity = 'thinking'
      update()

      const price = getModelProfile(r.model)
      const gen = query({
        messages: [...history, { role: 'user', content: task }],
        model: r.model,
        provider,
        cwd: r.dir,
        systemPrompt: buildSystemPrompt(r.dir),
        maxTurns: 30,
        readFiles: new Set(),
        abortSignal: this.controller.signal,
        passEnv,
        // Racers run unattended: anything beyond the project is declined, never asked
        authorize: async call => {
          const risk = toolRisk(call.name, call.input, r.dir!)
          return risk.level <= 1 ? { allow: true as const } : { allow: false as const, reason: `declined during a derby (${risk.reason}).` }
        },
      })
      let result = await gen.next()
      while (!result.done) {
        const e = result.value
        if (e.type === 'tool_executing') { r.steps++; r.activity = `${e.name}`; update() }
        if (e.type === 'text_delta') { r.answer += e.text; if (r.activity !== 'writing') { r.activity = 'writing'; update() } }
        if (e.type === 'request_start') { r.answer = ''; r.activity = 'thinking'; update() }
        if (e.type === 'message_complete' && price) {
          r.cost += (e.usage.prompt_tokens / 1000) * price.costPer1kInput + (e.usage.completion_tokens / 1000) * price.costPer1kOutput
        }
        if (e.type === 'error') { r.error = e.error }
        result = await gen.next()
      }
      if (result.value.reason === 'aborted') r.status = 'stopped'
      else if (result.value.reason === 'error') { r.status = 'error'; r.error ??= 'request failed' }
      else r.status = 'done'
      r.diffs = this.collectDiffs(r.dir)
      r.activity = r.status
    } catch (err) {
      r.status = 'error'
      r.error = (err as Error).message.split('\n')[0]
    }
    update()
  }

  private collectDiffs(dir: string): FileDiff[] {
    // Stage everything except the shared folders we symlinked in
    git(['add', '-A', '--', '.', ...SHARED_DIRS.map(d => `:!${d}`)], dir)
    const lines = git(['diff', '--cached', '--name-status', '--no-renames', this.base], dir).split('\n').filter(Boolean)
    return lines.map(line => {
      const [status, ...rest] = line.split('\t')
      const path = rest.join('\t')
      const before = status === 'A' ? null : (() => { try { return git(['show', `${this.base}:${path}`], dir) } catch { return null } })()
      const after = status === 'D' ? '' : (() => { try { return readFileSync(join(dir, path), 'utf-8') } catch { return '' } })()
      return fileDiff(path, before, after)
    })
  }

  stop() {
    this.controller.abort()
  }

  /** Copy the winner's changes into the real working tree. */
  apply(i: number): { files: number } {
    const r = this.racers[i]!
    if (!r.dir) return { files: 0 }
    for (const d of r.diffs) {
      const target = join(this.root, d.path)
      const source = join(r.dir, d.path)
      if (existsSync(source)) {
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(source, target)
      } else {
        try { unlinkSync(target) } catch {}
      }
    }
    return { files: r.diffs.length }
  }

  cleanup() {
    for (const r of this.racers) {
      if (!r.dir) continue
      try { git(['worktree', 'remove', '--force', r.dir], this.root) } catch {
        try { rmSync(r.dir, { recursive: true, force: true }) } catch {}
      }
    }
    try { git(['worktree', 'prune'], this.root) } catch {}
  }
}
