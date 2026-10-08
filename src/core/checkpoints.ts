import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileDiff, type FileDiff } from '../utils/diff.js'

/**
 * Snapshots of the working tree taken before every change Darce makes — including
 * changes made by shell commands — so /undo can put files back exactly.
 *
 * In a git repository each snapshot is a commit object (tracked + untracked files,
 * respecting .gitignore) stored under refs/darce/<session>/<n>. Your branch, index and
 * stash are never touched. Outside git, Edit and Write keep in-memory file backups.
 */
export type Checkpoint = {
  n: number
  label: string
  at: number
  toolUseId?: string // links the snapshot to the step that followed it (for rewind)
  commit?: string // git mode
  files?: Map<string, string | null> // fallback mode: path → previous content (null = did not exist)
}

export type UndoResult =
  | { ok: true; label: string; restored: string[]; removed: string[] }
  | { ok: false; reason: string }

export class Checkpoints {
  private stack: Checkpoint[] = []
  private counter = 0
  private root: string | null = null
  private gitDir: string | null = null

  constructor(private cwd: string, private sessionId: string) {
    try {
      this.root = this.git(['rev-parse', '--show-toplevel'], cwd).trim()
      this.gitDir = resolve(this.root, this.git(['rev-parse', '--git-dir'], this.root).trim())
    } catch {
      this.root = null
    }
  }

  get mode(): 'git' | 'files' {
    return this.root ? 'git' : 'files'
  }

  get count(): number {
    return this.stack.length
  }

  list(): readonly Checkpoint[] {
    return this.stack
  }

  private git(args: string[], cwd = this.root ?? this.cwd, env?: NodeJS.ProcessEnv, input?: string): string {
    return execFileSync('git', args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      encoding: 'utf-8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    })
  }

  /** Write the current working tree (tracked + untracked, minus ignored) as a tree object. */
  private writeTree(): string {
    const dir = mkdtempSync(join(tmpdir(), 'darce-idx-'))
    const index = join(dir, 'index')
    try {
      // Start from the real index so git can reuse its stat cache (fast on big repos)
      const real = join(this.gitDir!, 'index')
      if (existsSync(real)) copyFileSync(real, index)
      const env = { GIT_INDEX_FILE: index }
      this.git(['add', '-A', '--', '.'], this.root!, env)
      return this.git(['write-tree'], this.root!, env).trim()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Take a snapshot before a change. `paths` is used outside git (Edit/Write targets). */
  snapshot(label: string, paths: string[] = [], toolUseId?: string): Checkpoint | null {
    const n = ++this.counter
    if (this.root) {
      try {
        const tree = this.writeTree()
        const commit = this.git(
          ['commit-tree', tree, '-m', `darce checkpoint ${n}: ${label}`],
          this.root,
          { GIT_AUTHOR_NAME: 'darce', GIT_AUTHOR_EMAIL: 'darce@localhost', GIT_COMMITTER_NAME: 'darce', GIT_COMMITTER_EMAIL: 'darce@localhost' },
        ).trim()
        this.git(['update-ref', `refs/darce/${this.sessionId}/${n}`, commit])
        const cp: Checkpoint = { n, label, at: Date.now(), commit, toolUseId }
        this.stack.push(cp)
        return cp
      } catch {
        return null
      }
    }
    if (paths.length === 0) return null
    const files = new Map<string, string | null>()
    for (const p of paths) {
      const abs = resolve(this.cwd, p)
      try {
        files.set(abs, existsSync(abs) ? readFileSync(abs, 'utf-8') : null)
      } catch {
        // unreadable — skip
      }
    }
    const cp: Checkpoint = { n, label, at: Date.now(), files, toolUseId }
    this.stack.push(cp)
    return cp
  }

  /**
   * Restore the working tree to just before the most recent change that actually
   * changed something. Steps that changed nothing (e.g. a curl) are skipped over.
   */
  undo(): UndoResult {
    const skipped: string[] = []
    while (true) {
      const cp = this.stack.pop()
      if (!cp) {
        return { ok: false, reason: skipped.length ? `Nothing to undo: Darce's recent steps did not change any files (${skipped.join(', ')}).` : 'Nothing to undo in this session.' }
      }
      let result: UndoResult
      try {
        result = cp.commit ? this.restoreGit(cp) : this.restoreFiles(cp)
      } catch (err) {
        this.stack.push(cp)
        return { ok: false, reason: `Could not undo: ${(err as Error).message.split('\n')[0]}` }
      }
      if (!result.ok || result.restored.length || result.removed.length) return result
      skipped.push(cp.label)
    }
  }

  private restoreGit(cp: Checkpoint): UndoResult {
    const target = `${cp.commit}^{tree}`
    const current = this.writeTree()
    const changed = this.git(['diff', '--name-status', '--no-renames', target, current])
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [status, ...rest] = line.split('\t')
        return { status: status!, path: rest.join('\t') }
      })

    // Files that exist now but not in the snapshot were created by the change — remove them
    const removed = changed.filter(c => c.status === 'A').map(c => c.path)
    for (const p of removed) {
      try { unlinkSync(join(this.root!, p)) } catch {}
    }

    // Write back only files that differ (modified or deleted) — untouched files keep their mtimes
    const toRestore = changed.filter(c => c.status !== 'A').map(c => c.path)
    if (toRestore.length) {
      const dir = mkdtempSync(join(tmpdir(), 'darce-idx-'))
      try {
        const env = { GIT_INDEX_FILE: join(dir, 'index') }
        this.git(['read-tree', target], this.root!, env)
        this.git(['checkout-index', '-f', '--stdin'], this.root!, env, toRestore.join('\n') + '\n')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    this.git(['update-ref', '-d', `refs/darce/${this.sessionId}/${cp.n}`])
    return { ok: true, label: cp.label, restored: toRestore, removed }
  }

  private restoreFiles(cp: Checkpoint): UndoResult {
    const restored: string[] = []
    const removed: string[] = []
    for (const [abs, content] of cp.files ?? []) {
      if (content === null) {
        try { unlinkSync(abs); removed.push(abs) } catch {}
      } else {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
        restored.push(abs)
      }
    }
    return { ok: true, label: cp.label, restored, removed }
  }

  /** What step i changed: its snapshot vs the next one (or the current files for the last step). */
  stepDiff(i: number): FileDiff[] | null {
    const cp = this.stack[i]
    if (!cp) return []
    if (cp.files) {
      return [...cp.files.entries()].map(([abs, before]) => {
        let after = ''
        try { after = readFileSync(abs, 'utf-8') } catch {}
        return fileDiff(abs, before, after)
      })
    }
    if (!this.root || !cp.commit) return null
    const next = this.stack[i + 1]?.commit
    return this.diffTrees(`${cp.commit}^{tree}`, next ? `${next}^{tree}` : this.writeTree())
  }

  private diffTrees(a: string, b: string): FileDiff[] {
    const changes = this.git(['diff', '--name-status', '--no-renames', a, b]).split('\n').filter(Boolean)
    return changes.map(line => {
      const [status, ...rest] = line.split('\t')
      const path = rest.join('\t')
      const read = (tree: string) => { try { return this.git(['show', `${tree}:${path}`]) } catch { return null } }
      return fileDiff(path, status === 'A' ? null : read(a), status === 'D' ? '' : read(b) ?? '')
    })
  }

  /** Put the files back to how they were right before step i; steps i… are discarded. */
  rewindTo(i: number): UndoResult {
    const cp = this.stack[i]
    if (!cp) return { ok: false, reason: 'That step no longer exists.' }
    try {
      let result: UndoResult
      if (cp.commit) {
        result = this.restoreGit(cp)
        for (const later of this.stack.slice(i + 1)) {
          try { this.git(['update-ref', '-d', `refs/darce/${this.sessionId}/${later.n}`]) } catch {}
        }
      } else {
        // Fallback mode: unwind file backups newest-first
        const restored = new Set<string>()
        const removed = new Set<string>()
        for (const step of this.stack.slice(i).reverse()) {
          const r = this.restoreFiles(step)
          if (r.ok) { r.restored.forEach(f => restored.add(f)); r.removed.forEach(f => removed.add(f)) }
        }
        result = { ok: true, label: cp.label, restored: [...restored], removed: [...removed] }
      }
      this.stack = this.stack.slice(0, i)
      return result
    } catch (err) {
      return { ok: false, reason: `Could not rewind: ${(err as Error).message.split('\n')[0]}` }
    }
  }

  private baseline: string | null = null

  get gitRoot(): string | null {
    return this.root
  }

  /** A commit of the current working tree (tracked + untracked), not added to the undo stack. */
  commitWorkingTree(message: string): string | null {
    if (!this.root) return null
    try {
      const tree = this.writeTree()
      return this.git(['commit-tree', tree, '-m', message], this.root, {
        GIT_AUTHOR_NAME: 'darce', GIT_AUTHOR_EMAIL: 'darce@localhost', GIT_COMMITTER_NAME: 'darce', GIT_COMMITTER_EMAIL: 'darce@localhost',
      }).trim()
    } catch {
      return null
    }
  }

  /** Record the state at session start so /diff can show everything Darce changed. */
  markBaseline() {
    if (!this.root || this.baseline) return
    try { this.baseline = this.writeTree() } catch {}
  }

  /** Everything changed since checkpoint `index` was taken, including shell commands' effects (git mode only). */
  diffSince(index: number): FileDiff[] | null {
    const cp = this.stack[index]
    if (!this.root || !cp?.commit) return null
    try { return this.diffTrees(`${cp.commit}^{tree}`, this.writeTree()) } catch { return null }
  }

  /** Every file that differs from the session baseline (or the oldest snapshot). */
  sessionDiff(): FileDiff[] | null {
    if (!this.root) return null
    const base = this.baseline ?? (this.stack[0]?.commit ? `${this.stack[0].commit}^{tree}` : null)
    if (!base) return []
    return this.diffTrees(base, this.writeTree())
  }

  /** Remove this session's refs (called on exit). Snapshots remain recoverable via reflog-free objects until git gc. */
  cleanup() {
    if (!this.root) return
    for (const cp of this.stack) {
      try { this.git(['update-ref', '-d', `refs/darce/${this.sessionId}/${cp.n}`]) } catch {}
    }
  }
}
