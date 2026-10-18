import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path'
import { fileDiff, type FileDiff } from '../utils/diff.js'

/**
 * Snapshots of the working tree taken around every change Darce makes — including
 * changes made by shell commands — so /undo can put files back exactly.
 *
 * In a git repository each snapshot is a commit object (tracked + untracked files,
 * respecting .gitignore) stored under refs/darce/<session>/<n>, plus the tree right after
 * the step. Undo reverts only what that step changed, and leaves alone anything that was
 * changed again since (your own edits). Files git doesn't see (ignored, outside the repo)
 * are kept as byte backups; HEAD and the index are recorded so a `git commit` can be undone.
 * Removed files go to .git/darce-trash instead of being deleted. Your branch, index and
 * stash are never touched except to undo what Darce did to them.
 * Outside git, Edit and Write keep byte backups; shell commands can't be snapshotted.
 */
type Head = { ref: string | null; sha: string | null }
type Extra = { before: Buffer | null; after?: Buffer | null }

export type Checkpoint = {
  n: number
  label: string
  at: number
  toolUseId?: string // links the snapshot to the step that followed it (for rewind)
  commit?: string // git: the working tree before the step
  after?: string // git: the tree right after the step, once it finished
  head?: Head
  headAfter?: Head
  indexCopy?: string // git: the real index before a step that ran git
  indexBefore?: string
  indexAfter?: string
  files?: Map<string, Extra> // byte backups: files git doesn't see, or every file outside git
  ignoredBefore?: Set<string> // git: ignored files that existed before a shell step
  tooBig?: Map<string, string> // untracked files left out of the snapshot → size:mtime before the step
  blind?: boolean // a shell step outside git: nothing to restore from
}

export type UndoResult =
  | { ok: true; label: string; restored: string[]; removed: string[]; kept?: string[]; notes?: string[] }
  | { ok: false; reason: string }

// Untracked files above this aren't copied into .git on every step (videos, datasets, archives)
const BIG = 25 * 1024 * 1024
// Ignored files backed up around a shell step: small ones only (.env, local config)
const IGNORED_MAX_FILE = 1024 * 1024
const IGNORED_MAX_TOTAL = 8 * 1024 * 1024
const TRASH_DAYS = 7

const same = (a: Buffer | null | undefined, b: Buffer | null | undefined) => (a == null || b == null ? a == b : a.equals(b))
const readOrNull = (abs: string): Buffer | null => { try { return readFileSync(abs) } catch { return null } }
const short = (sha: string) => sha.slice(0, 7)
const stamp = (abs: string) => { try { const st = statSync(abs); return `${st.size}:${st.mtimeMs}` } catch { return 'gone' } }
// Compare paths the way git sees them (/var → /private/var on macOS), even for files that don't exist yet
function realPath(abs: string): string {
  try { return realpathSync(abs) } catch {}
  try { return join(realpathSync(dirname(abs)), basename(abs)) } catch { return abs }
}

export class Checkpoints {
  private stack: Checkpoint[] = []
  private counter = 0
  private root: string | null = null
  private gitDir: string | null = null
  private baseline: string | null = null
  private baselineRun: Promise<void> | null = null
  // One git operation at a time: snapshots, diffs and undo share the session index
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private cwd: string, private sessionId: string) {
    try {
      this.root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim()
      this.gitDir = resolve(this.root, execFileSync('git', ['rev-parse', '--git-dir'], { cwd: this.root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim())
      this.pruneTrash()
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

  get gitRoot(): string | null {
    return this.root
  }

  list(): readonly Checkpoint[] {
    return this.stack
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => {})
    return p
  }

  private git(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; cwd?: string } = {}): Promise<string> {
    return new Promise((res, rej) => {
      const child = execFile('git', args, {
        cwd: opts.cwd ?? this.root ?? this.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        encoding: 'utf-8',
        maxBuffer: 256 * 1024 * 1024,
        timeout: 120_000,
      }, (err, stdout) => (err ? rej(err) : res(stdout)))
      child.stdin?.end(opts.input ?? '')
    })
  }

  private get sessionIndex(): string {
    return join(this.gitDir!, `darce-index-${this.sessionId}`)
  }

  private async bigUntracked(): Promise<string[]> {
    const out = await this.git(['ls-files', '-z', '--others', '--exclude-standard'])
    const big: string[] = []
    for (const p of out.split('\0')) {
      if (!p) continue
      try { if (statSync(join(this.root!, p)).size > BIG) big.push(p) } catch {}
      if (big.length >= 200) break
    }
    return big
  }

  /**
   * Write the working tree (tracked + untracked, minus ignored and very large untracked files) as a tree.
   * The session keeps its own index file so git's stat cache survives between steps: only files that
   * changed get hashed again.
   */
  private async writeTree(): Promise<{ tree: string; tooBig: string[] }> {
    const index = this.sessionIndex
    if (!existsSync(index)) {
      const real = join(this.gitDir!, 'index')
      if (existsSync(real)) copyFileSync(real, index)
    }
    const env = { GIT_INDEX_FILE: index }
    const tooBig = await this.bigUntracked()
    if (tooBig.length) await this.git(['rm', '--cached', '-q', '--ignore-unmatch', '--', ...tooBig.map(p => `:(literal)${p}`)], { env })
    await this.git(['add', '-A', '--', '.', ...tooBig.map(p => `:(exclude,literal)${p}`)], { env })
    return { tree: (await this.git(['write-tree'], { env })).trim(), tooBig }
  }

  private async head(): Promise<Head> {
    const ref = await this.git(['symbolic-ref', '-q', 'HEAD']).then(s => s.trim() || null, () => null)
    const sha = await this.git(['rev-parse', '-q', '--verify', 'HEAD']).then(s => s.trim() || null, () => null)
    return { ref, sha }
  }

  // What's staged, not the index file itself: `git status` rewrites its timestamps without changing anything
  private async indexSig(): Promise<string | undefined> {
    const staged = await this.git(['ls-files', '-s', '-z']).catch(() => null)
    return staged == null ? undefined : createHash('sha1').update(staged).digest('hex')
  }

  /** Small ignored files (.env and friends), which a shell step can change without git noticing. */
  private async ignoredFiles(): Promise<{ names: Set<string>; bytes: Map<string, Buffer> }> {
    const out = await this.git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
    const names = new Set<string>()
    const bytes = new Map<string, Buffer>()
    let total = 0
    for (const p of out.split('\0')) {
      // Ignored folders (node_modules/, dist/) come back collapsed and are left alone
      if (!p || p.endsWith('/')) continue
      const abs = join(this.root!, p)
      names.add(abs)
      if (bytes.size >= 300) continue
      try {
        const st = lstatSync(abs)
        if (!st.isFile() || st.size > IGNORED_MAX_FILE || total + st.size > IGNORED_MAX_TOTAL) continue
        bytes.set(abs, readFileSync(abs))
        total += st.size
      } catch {}
    }
    return { names, bytes }
  }

  private async isIgnored(abs: string): Promise<boolean> {
    const rel = relative(this.root!, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) return true
    return this.git(['check-ignore', '-q', '--', rel]).then(() => true, () => false)
  }

  private async commitTree(tree: string, message: string): Promise<string> {
    return (await this.git(['commit-tree', tree, '-m', message], {
      env: { GIT_AUTHOR_NAME: 'darce', GIT_AUTHOR_EMAIL: 'darce@localhost', GIT_COMMITTER_NAME: 'darce', GIT_COMMITTER_EMAIL: 'darce@localhost' },
    })).trim()
  }

  /**
   * Take a snapshot before a change. `paths` are the files an Edit/Write is about to touch;
   * `shell` marks a step that can change anything (Bash).
   */
  snapshot(label: string, paths: string[] = [], toolUseId?: string, shell = paths.length === 0): Promise<Checkpoint | null> {
    return this.serial(async () => {
      const n = ++this.counter
      const abs = paths.map(p => realPath(resolve(this.cwd, p)))
      if (!this.root) {
        if (!abs.length) {
          // Nothing to restore from: record the step so /undo can say so instead of skipping past it
          const cp: Checkpoint = { n, label, at: Date.now(), toolUseId, blind: shell }
          if (shell) this.stack.push(cp)
          return shell ? cp : null
        }
        const cp: Checkpoint = { n, label, at: Date.now(), toolUseId, files: new Map(abs.map(p => [p, { before: readOrNull(p) }])) }
        this.stack.push(cp)
        return cp
      }
      try {
        const [{ tree, tooBig }, head] = await Promise.all([this.writeTree(), this.head()])
        const commit = await this.commitTree(tree, `darce checkpoint ${n}: ${label}`)
        await this.git(['update-ref', `refs/darce/${this.sessionId}/${n}`, commit])
        const cp: Checkpoint = { n, label, at: Date.now(), commit, toolUseId, head, tooBig: tooBig.length ? new Map(tooBig.map(p => [p, stamp(join(this.root!, p))])) : undefined }
        // Files git won't see: Edit/Write targets that are ignored or outside the repo
        const unseen: string[] = []
        for (const p of abs) if (await this.isIgnored(p)) unseen.push(p)
        if (unseen.length) cp.files = new Map(unseen.map(p => [p, { before: readOrNull(p) }]))
        if (shell) {
          const ign = await this.ignoredFiles()
          cp.ignoredBefore = ign.names
          cp.files ??= new Map()
          for (const [p, b] of ign.bytes) if (!cp.files.has(p)) cp.files.set(p, { before: b })
          // A shell step may run git: keep the index so `git add` / `git commit` can be undone
          if (/\bgit\b/.test(label)) {
            const real = join(this.gitDir!, 'index')
            if (existsSync(real)) { cp.indexCopy = join(this.gitDir!, `darce-index-${this.sessionId}-${n}.bak`); cpSync(real, cp.indexCopy, { preserveTimestamps: true }); cp.indexBefore = await this.indexSig() }
          }
        }
        this.stack.push(cp)
        return cp
      } catch {
        return null
      }
    })
  }

  /** Record how the files looked right after a step, so undo can tell its changes from later ones. */
  afterChange(toolUseId: string): Promise<void> {
    return this.serial(async () => {
      const cp = [...this.stack].reverse().find(c => c.toolUseId === toolUseId)
      if (!cp || cp.blind) return
      if (cp.files) for (const [p, e] of cp.files) e.after = readOrNull(p)
      if (!this.root || !cp.commit) return
      try {
        const [{ tree }, head] = await Promise.all([this.writeTree(), this.head()])
        cp.after = tree
        cp.headAfter = head
        if (cp.indexCopy) cp.indexAfter = await this.indexSig()
        if (cp.ignoredBefore) {
          // Ignored files the step created
          const ign = await this.ignoredFiles()
          for (const [p, b] of ign.bytes) if (!cp.ignoredBefore.has(p) && !cp.files?.has(p)) (cp.files ??= new Map()).set(p, { before: null, after: b })
          for (const [p, e] of cp.files ?? []) if (e.after === undefined) e.after = readOrNull(p)
        }
      } catch {}
    })
  }

  /** Move a file Darce created to the trash instead of deleting it. */
  private trash(abs: string, n: number) {
    const base = this.gitDir ? join(this.gitDir, 'darce-trash', this.sessionId, String(n)) : join(tmpdir(), 'darce-trash', this.sessionId, String(n))
    const rel = this.root && !relative(this.root, abs).startsWith('..') ? relative(this.root, abs) : abs.replace(/^[/\\]+/, '').replace(/:/g, '')
    const dest = join(base, rel)
    mkdirSync(dirname(dest), { recursive: true })
    try { renameSync(abs, dest) } catch { copyFileSync(abs, dest); unlinkSync(abs) }
    // Folders the file was the last thing in go too (git doesn't track empty folders)
    let dir = dirname(abs)
    const stop = this.root ?? this.cwd
    while (dir.startsWith(stop) && dir !== stop) {
      try { if (readdirSync(dir).length) break; rmdirSync(dir) } catch { break }
      dir = dirname(dir)
    }
  }

  private pruneTrash() {
    const dir = join(this.gitDir!, 'darce-trash')
    try {
      for (const s of readdirSync(dir)) {
        const p = join(dir, s)
        if (Date.now() - statSync(p).mtimeMs > TRASH_DAYS * 86_400_000) rmSync(p, { recursive: true, force: true })
      }
    } catch {}
  }

  /** Undo one step: put back what it changed, unless it was changed again since. */
  private async restoreStep(cp: Checkpoint): Promise<UndoResult> {
    if (cp.blind) {
      return { ok: false, reason: `Can't undo "${cp.label}": this folder isn't a git repository, so shell commands aren't snapshotted. Run \`git init\` once and every step becomes undoable.` }
    }
    const restored: string[] = []
    const removed: string[] = []
    const kept: string[] = []
    const notes: string[] = []

    if (cp.commit && this.root) {
      const pre = `${cp.commit}^{tree}`
      const { tree: now } = await this.writeTree()
      const post = cp.after ?? now
      const changed = (await this.git(['diff', '--name-status', '-z', '--no-renames', pre, post])).split('\0').filter(Boolean)
      const since = cp.after ? new Set((await this.git(['diff', '--name-only', '-z', '--no-renames', post, now])).split('\0').filter(Boolean)) : new Set<string>()
      const toRestore: string[] = []
      for (let i = 0; i + 1 < changed.length; i += 2) {
        const status = changed[i]!, path = changed[i + 1]!
        if (since.has(path)) { kept.push(path); continue }
        if (status === 'A') {
          try { this.trash(join(this.root, path), cp.n); removed.push(path) } catch {}
        } else toRestore.push(path)
      }
      if (toRestore.length) {
        const index = join(this.gitDir!, `darce-index-${this.sessionId}-restore`)
        try {
          await this.git(['read-tree', pre], { env: { GIT_INDEX_FILE: index } })
          await this.git(['checkout-index', '-f', '-z', '--stdin'], { env: { GIT_INDEX_FILE: index }, input: toRestore.join('\0') + '\0' })
          restored.push(...toRestore)
        } finally {
          rmSync(index, { force: true })
        }
      }
      // Only worth saying if the step actually touched one of them
      const touched = [...(cp.tooBig ?? [])].filter(([p, st]) => stamp(join(this.root!, p)) !== st).map(([p]) => p)
      if (touched.length) notes.push(`Too large to snapshot (over ${BIG / 1024 / 1024} MB), so not restored: ${touched.slice(0, 3).join(', ')}${touched.length > 3 ? '…' : ''}`)

      // A commit (or `git add`) made during the step
      const a = cp.head, b = cp.headAfter
      if (a && b) {
        const cur = await this.head()
        const moved = a.sha !== b.sha || a.ref !== b.ref
        let headBack = false
        if (moved && cur.sha === b.sha && cur.ref === b.ref) {
          headBack = true
          if (a.ref !== b.ref && a.ref) await this.git(['symbolic-ref', 'HEAD', a.ref])
          else if (a.sha && b.sha) await this.git(['update-ref', '-m', 'darce undo', b.ref ?? 'HEAD', a.sha, b.sha])
          notes.push(a.ref !== b.ref ? `Switched back to ${a.ref?.replace('refs/heads/', '')}` : `Moved ${(b.ref ?? 'HEAD').replace('refs/heads/', '')} back to ${short(a.sha ?? '')} (the commit is still in the reflog)`)
        } else if (moved) {
          notes.push('HEAD moved again after this step, so it was left where it is')
        }
        if (cp.indexCopy && existsSync(cp.indexCopy) && cp.indexBefore !== cp.indexAfter && (headBack || (await this.indexSig()) === cp.indexAfter)) {
          // Keep the old timestamp: a newer one would make git trust stale stat data ("racy clean")
          cpSync(cp.indexCopy, join(this.gitDir!, 'index'), { preserveTimestamps: true })
          notes.push('Restored the staging area')
        }
      }
      try { await this.git(['update-ref', '-d', `refs/darce/${this.sessionId}/${cp.n}`]) } catch {}
      if (cp.indexCopy) rmSync(cp.indexCopy, { force: true })
    }

    for (const [abs, e] of cp.files ?? []) {
      const current = readOrNull(abs)
      const after = e.after === undefined ? current : e.after
      if (same(e.before, after)) continue
      if (!same(current, after)) { kept.push(abs); continue }
      if (e.before === null) {
        try { this.trash(abs, cp.n); removed.push(abs) } catch {}
      } else {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, e.before)
        restored.push(abs)
      }
    }
    return { ok: true, label: cp.label, restored, removed, kept, notes }
  }

  /**
   * Undo the most recent step that changed something. Steps that changed nothing (e.g. a curl) are skipped over.
   */
  undo(): Promise<UndoResult> {
    return this.serial(async () => {
      const skipped: string[] = []
      while (true) {
        const cp = this.stack.pop()
        if (!cp) {
          return { ok: false, reason: skipped.length ? `Nothing to undo: Darce's recent steps did not change any files (${skipped.join(', ')}).` : 'Nothing to undo in this session.' }
        }
        let result: UndoResult
        try {
          result = await this.restoreStep(cp)
        } catch (err) {
          this.stack.push(cp)
          return { ok: false, reason: `Could not undo: ${(err as Error).message.split('\n')[0]}` }
        }
        if (!result.ok || result.restored.length || result.removed.length || result.kept?.length || result.notes?.length) return result
        skipped.push(cp.label)
      }
    })
  }

  /** Put the files back to how they were right before step i, undoing steps newest-first; steps i… are discarded. */
  rewindTo(i: number): Promise<UndoResult> {
    return this.serial(async () => {
      const cp = this.stack[i]
      if (!cp) return { ok: false, reason: 'That step no longer exists.' }
      const restored = new Set<string>(), removed = new Set<string>(), kept = new Set<string>()
      const notes: string[] = []
      try {
        while (this.stack.length > i) {
          const step = this.stack[this.stack.length - 1]!
          const r = await this.restoreStep(step)
          this.stack.pop()
          if (!r.ok) { notes.push(r.reason); continue }
          r.restored.forEach(f => { restored.add(f); removed.delete(f) })
          r.removed.forEach(f => { removed.add(f); restored.delete(f) })
          r.kept?.forEach(f => kept.add(f))
          notes.push(...(r.notes ?? []))
        }
        return { ok: true, label: cp.label, restored: [...restored], removed: [...removed], kept: [...kept], notes: [...new Set(notes)] }
      } catch (err) {
        return { ok: false, reason: `Could not rewind: ${(err as Error).message.split('\n')[0]}` }
      }
    })
  }

  /** What step i changed: its snapshot vs the tree right after it (or the next snapshot, or the files now). */
  stepDiff(i: number): Promise<FileDiff[] | null> {
    return this.serial(async () => {
      const cp = this.stack[i]
      if (!cp) return []
      const extra = [...(cp.files ?? [])].map(([abs, e]) => fileDiff(abs, e.before?.toString('utf-8') ?? null, (e.after === undefined ? readOrNull(abs) : e.after)?.toString('utf-8') ?? ''))
      if (!this.root || !cp.commit) return cp.blind ? null : extra
      const next = this.stack[i + 1]?.commit
      const end = cp.after ?? (next ? `${next}^{tree}` : (await this.writeTree()).tree)
      return [...(await this.diffTrees(`${cp.commit}^{tree}`, end)), ...extra.filter(d => d.added || d.removed || d.created || d.binary)]
    })
  }

  private async diffTrees(a: string, b: string): Promise<FileDiff[]> {
    const parts = (await this.git(['diff', '--name-status', '-z', '--no-renames', a, b])).split('\0').filter(Boolean)
    const out: FileDiff[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]!, path = parts[i + 1]!
      const read = (tree: string) => this.git(['show', `${tree}:${path}`]).catch(() => null)
      out.push(fileDiff(path, status === 'A' ? null : await read(a), status === 'D' ? '' : (await read(b)) ?? ''))
    }
    return out
  }

  /** A commit of the current working tree (tracked + untracked), not added to the undo stack. */
  commitWorkingTree(message: string): Promise<string | null> {
    if (!this.root) return Promise.resolve(null)
    return this.serial(async () => {
      try { return await this.commitTree((await this.writeTree()).tree, message) } catch { return null }
    })
  }

  /** Record the state at session start so /diff can show everything Darce changed. Runs in the background. */
  markBaseline(): Promise<void> {
    if (!this.root || this.baselineRun) return this.baselineRun ?? Promise.resolve()
    this.baselineRun = this.serial(async () => {
      try { this.baseline = (await this.writeTree()).tree } catch {}
    })
    return this.baselineRun
  }

  /** Everything changed since checkpoint `index` was taken, including shell commands' effects (git mode only). */
  diffSince(index: number): Promise<FileDiff[] | null> {
    return this.serial(async () => {
      const cp = this.stack[index]
      if (!this.root || !cp?.commit) return null
      try { return await this.diffTrees(`${cp.commit}^{tree}`, (await this.writeTree()).tree) } catch { return null }
    })
  }

  /** Every file that differs from the session baseline (or the oldest snapshot). */
  sessionDiff(): Promise<FileDiff[] | null> {
    if (!this.root) return Promise.resolve(null)
    return this.serial(async () => {
      const base = this.baseline ?? (this.stack[0]?.commit ? `${this.stack[0].commit}^{tree}` : null)
      if (!base) return []
      return this.diffTrees(base, (await this.writeTree()).tree)
    })
  }

  /** Remove this session's refs and index files (called on exit). Snapshot objects stay until git gc. */
  cleanup() {
    if (!this.root) return
    const refs = this.stack.filter(cp => cp.commit).map(cp => `delete refs/darce/${this.sessionId}/${cp.n}\n`).join('')
    try { if (refs) execFileSync('git', ['update-ref', '--stdin'], { cwd: this.root, input: refs, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000 }) } catch {}
    for (const cp of this.stack) if (cp.indexCopy) rmSync(cp.indexCopy, { force: true })
    rmSync(this.sessionIndex, { force: true })
  }
}
