import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { Browser, findChrome } from './chrome.js'
import { detectorScript, judge, type Box, type Collected, type PageHit } from './detect.js'
import { analyzeSystem, type SystemReport } from './system.js'
import { analyzeProject, type Spot } from './project.js'
import { scanTaste } from './scan.js'
import { TASTE_RULES, type TasteRule } from './check.js'
import { brain, type BrainEvent } from '../brain/bus.js'

/**
 * The taste studio: a small window that shows your page as it renders, pins what looks generated,
 * and lets you choose what Darce fixes. Like /brain it listens on 127.0.0.1 only, every API call
 * needs the token in the link, and the Host header must match (no DNS rebinding).
 */

export type View = 'desktop' | 'mobile'
export type Pin = { view: View; box: Box }
export type Issue = {
  id: string
  /** page: a thing you can point at; system: how the page's colors and type hang together; code: how it's built */
  kind: 'page' | 'system' | 'code'
  rule: TasteRule
  title: string
  label: string
  why: string
  fix: string
  where?: { file: string; line: number; code: string }
  pins: Pin[]
  /** The visible text a page finding sits in */
  seen?: string
  /** Every place a code finding applies to */
  spots?: Spot[]
  detail?: string
  decision: 'fix' | 'keep'
  kept?: boolean // kept on an earlier visit
}
type Shot = { width: number; height: number; data: Buffer }
type Phase = 'starting' | 'capturing' | 'ready' | 'fixing' | 'checking' | 'error'

export type StudioSource = {
  cwd: string
  /** Hand the chosen fixes to Darce. Resolves when Darce has finished the turn. */
  fix: (prompt: string, shown: string) => Promise<void>
  busy: () => boolean
  /** What Darce is waiting for you to approve, if anything. */
  pending: () => { command: string; reason: string } | null
  /** Answer that approval from the studio. Returns false if it was already answered. */
  decide: (allow: boolean) => boolean
  /** One quiet line back in the terminal. */
  say: (text: string) => void
}

const WHY: Record<TasteRule, string> = {
  'ai-gradient': 'Purple-to-blue (or rainbow) gradients are the default palette of generated pages. People recognize it in a second.',
  'gradient-text': 'Gradient-filled headlines are the most copied hero treatment of the last few years.',
  'emoji-icon': 'Emoji standing in for icons read as a first draft, and they look different on every device.',
  'stripe-border': 'A colored stripe down one side of a card is a template default for "this is highlighted".',
  'glow-blob': 'Blurred color blobs are decoration standing in for design.',
  'filler-copy': 'Words and phrasings like these could describe any product, so readers skim past them. (Word list from no-ai-slop.)',
  'fake-proof': 'Placeholder names and claims nobody can check read as filler. Real proof is specific and sourced.',
  'accent-sprawl': 'Many unrelated accent colors make a page look assembled rather than designed.',
  'hover-lift': 'Lifting every card on hover suggests it can be clicked, even when it can\'t.',
  'stock-palette': 'The accent colors are the framework\'s defaults, unchanged. It\'s the most common sign that no one chose a brand color.',
  'type-scale': 'With this many text sizes there\'s no scale left: neighbouring sizes are too close to tell apart, so hierarchy goes flat.',
  'radius-sprawl': 'So many corner radii that shapes stop reading as one family.',
  'font-sprawl': 'Several typefaces compete for the same jobs.',
  'pasted-styles': 'The same long class list is copied wherever it was needed instead of being one component. Changes have to be made in every copy, and the copies drift.',
  'big-component': 'One file holds a whole screen\'s worth of state and markup. It\'s hard to change one part without breaking another.',
  'hardcoded-colors': 'Colors are typed out by hand across many files instead of living in one palette.',
}
const FIX: Record<TasteRule, string> = {
  'ai-gradient': 'Use a solid surface in the project\'s own colors, or keep a gradient within one hue.',
  'gradient-text': 'Set the headline in solid ink and let size and weight carry it.',
  'emoji-icon': 'Use an icon from the project\'s icon set, or no icon.',
  'stripe-border': 'Show state with a fill or weight change instead of a side stripe.',
  'glow-blob': 'Remove it.',
  'filler-copy': 'Say the specific thing the product does.',
  'fake-proof': 'Keep it only if it\'s real and you can back it up; otherwise use real names and numbers, or remove it.',
  'accent-sprawl': 'Keep one brand accent plus status colors; map the rest to those or to neutrals.',
  'hover-lift': 'Use a quiet border or background change, only on things that can be clicked.',
  'stock-palette': 'Pick a brand accent that fits the product, define it as a token, and use it in place of the stock colors.',
  'type-scale': 'Pick 6 to 10 sizes as tokens and map every text size onto the nearest one.',
  'radius-sprawl': 'Pick a few radii as tokens (small, medium, large) and map the rest onto them.',
  'font-sprawl': 'Use one family for text, and a second only for a clearly different job (code, display).',
  'pasted-styles': 'Extract one component (or class) and use it at every copy.',
  'big-component': 'Split it into smaller components, each owning its own state.',
  'hardcoded-colors': 'Define each color once as a token (CSS variable or theme color) and replace the hand-typed values.',
}

const KIND_ORDER = { page: 0, system: 1, code: 2 } as const

const VIEWS: Record<View, { width: number; height: number; mobile: boolean }> = {
  desktop: { width: 1440, height: 900, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
}
const DEV_PORTS = [3000, 5173, 4321, 3001, 8080, 5174, 4200, 8000, 5000, 3333, 8888]
const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.npmrc|\.netrc|\.darcerc)$/i
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm' }

/** The folder the process listening on a port runs from (macOS/Linux, via lsof). undefined = can't tell. */
function serverDir(port: number): Promise<string | null | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined)
  return new Promise(ok => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 2000 }, (err, out) => {
      const pid = String(out ?? '').trim().split('\n')[0]
      if (err || !pid) return ok(err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null)
      execFile('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { timeout: 2000 }, (e2, o2) => {
        const dir = String(o2 ?? '').split('\n').find(l => l.startsWith('n'))?.slice(1)
        ok(e2 || !dir ? undefined : dir)
      })
    })
  })
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/** A dev server on a usual port that answers with HTML and runs from this project. */
async function findDevServer(cwd?: string): Promise<string | null> {
  const tries = DEV_PORTS.map(async port => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 1200)
    try {
      const r = await fetch(`http://localhost:${port}/`, { signal: ctl.signal, redirect: 'follow' })
      const type = r.headers.get('content-type') ?? ''
      await r.body?.cancel()
      if (!type.includes('text/html')) return null
      if (cwd) {
        // An open port isn't necessarily this project: another app's server would show the wrong page
        const dir = await serverDir(port)
        const root = resolve(cwd)
        if (dir !== undefined && (!dir || !(within(dir, root) || within(root, dir)) || dir === '/')) return null
      }
      return `http://localhost:${port}/`
    } catch { return null } finally { clearTimeout(t) }
  })
  const found = await Promise.all(tries)
  return found.find(Boolean) ?? null
}

/** A static page in the project: index.html at the root, or in public/ or dist/. */
function findStaticPage(cwd: string): string | null {
  for (const p of ['index.html', 'public/index.html', 'dist/index.html', 'build/index.html', 'out/index.html']) if (existsSync(join(cwd, p))) return p
  return null
}

const keepFile = (cwd: string) => join(cwd, '.darce', 'taste.json')
/** What "keep" remembers an issue by: stable across runs, not tied to line numbers that shift. */
const keyOf = (i: Pick<Issue, 'kind' | 'rule' | 'where' | 'label' | 'spots'>) =>
  i.kind === 'system' ? `system|${i.rule}`
  : i.spots ? `code|${i.rule}|${i.where?.code ?? i.label}`
  : `${i.rule}|${i.where ? `${i.where.file}|${i.where.code.replace(/\s+/g, ' ').trim().slice(0, 100)}` : i.label}`

function readKeep(cwd: string): Set<string> {
  try { return new Set((JSON.parse(readFileSync(keepFile(cwd), 'utf-8')).keep ?? []) as string[]) } catch { return new Set() }
}
function writeKeep(cwd: string, keys: Set<string>) {
  let j: Record<string, unknown> = {}
  try { j = JSON.parse(readFileSync(keepFile(cwd), 'utf-8')) } catch { /* new file */ }
  j.keep = [...keys].sort()
  mkdirSync(dirname(keepFile(cwd)), { recursive: true })
  writeFileSync(keepFile(cwd), JSON.stringify(j, null, 2) + '\n')
}

const tokens = (s: string) => new Set(s.split(/[\s"'`{}()]+/).filter(t => t.length > 2))

const TEXT_RULES = new Set<TasteRule>(['emoji-icon', 'filler-copy', 'fake-proof'])
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean)

/**
 * Find where a rendered hit comes from. Text findings must match their text: the flagged word plus
 * a run of the words around it, allowing for prose wrapped across lines. Visual findings match on
 * their class list. When nothing matches well enough, there's no location, and the fix request
 * carries the visible text instead, which is better than a confident wrong file.
 */
function locate(hit: PageHit, code: { file: string; lines: string[]; flagged: Map<number, TasteRule[]> }[]): Issue['where'] {
  const textRule = TEXT_RULES.has(hit.rule)
  const word = (hit.label.match(/"([^"]+)"/)?.[1] ?? hit.label.match(/^emoji (.+)$/)?.[1] ?? '').toLowerCase()
  const seen = words(hit.text.replace(/\p{Extended_Pictographic}|\uFE0F/gu, ' '))
  // Three-word runs from the visible text; at least one must be in the source next to the word
  const runs = seen.length >= 3 ? seen.slice(0, -2).map((_, i) => seen.slice(i, i + 3).join(' ')) : seen.length ? [seen.join(' ')] : []
  const cls = tokens(hit.classes)
  let best: { file: string; line: number; score: number } | null = null
  for (const f of code) {
    const low = f.lines.map(l => l.toLowerCase())
    low.forEach((l, i) => {
      let score = 0
      if (textRule) {
        if (!word || !l.includes(word)) return
        const near = words(low.slice(Math.max(0, i - 2), i + 3).join(' ')).join(' ')
        const matched = runs.filter(r => near.includes(r)).length
        if (!matched && seen.length >= 3) return
        score = 5 + Math.min(matched, 6) + (f.flagged.get(i + 1)?.includes(hit.rule) ? 3 : 0)
      } else {
        if (!cls.size) return
        let n = 0
        for (const t of tokens(f.lines[i]!)) if (cls.has(t)) n++
        if (n < Math.min(4, cls.size)) return
        score = (n >= cls.size ? 6 : 3) + (f.flagged.get(i + 1)?.includes(hit.rule) ? 4 : 0)
      }
      if (!best || score > best.score) best = { file: f.file, line: i + 1, score }
    })
  }
  if (!best) return undefined
  const b = best as { file: string; line: number }
  const lines = code.find(c => c.file === b.file)!.lines
  return { file: b.file, line: b.line, code: lines[b.line - 1]!.trim().slice(0, 200) }
}

let running: { server: Server; url: string; refresh: (target?: string) => void } | null = null

export function studioUrl(): string | null { return running?.url ?? null }

export async function startStudio(src: StudioSource, target = ''): Promise<string> {
  if (running) { running.refresh(target || undefined); return running.url }
  const token = randomBytes(16).toString('hex')
  const dir = assetsDir()

  let phase: Phase = 'starting'
  let message = ''
  let version = 0
  let pageUrl: string | null = null
  let staticRoot: string | null = null
  let issues: Issue[] = []
  let system: SystemReport | null = null
  let shots: Partial<Record<View, Shot>> = {}
  let before: Partial<Record<View, Shot>> = {}
  let fixed: string[] = []
  let previous: number | null = null // how many were on the page before the last fix
  // What Darce is doing while it fixes, so you can follow along here instead of in the terminal
  let activity: { at: number; kind: 'read' | 'edit' | 'run' | 'search' | 'done' | 'error'; text: string }[] = []
  let saying = ''
  let unsubscribe: (() => void) | null = null
  const follow = () => {
    activity = []; saying = ''
    const wasActive = brain.active
    brain.active = true
    const off = brain.subscribe((e: BrainEvent) => {
      const push = (kind: (typeof activity)[number]['kind'], text: string) => { activity.push({ at: e.at, kind, text }); if (activity.length > 40) activity.shift(); version++ }
      const name = String(e.name ?? '')
      const path = e.path ? String(e.path) : ''
      if (e.type === 'tool_start') {
        if (name === 'Read') push('read', `Reading ${path}`)
        else if (name === 'Edit' || name === 'Write') push('edit', `Editing ${path}`)
        else if (name === 'Bash') push('run', `Running ${String(e.command ?? '').split('\n')[0]!.slice(0, 90)}`)
        else if (name === 'Grep' || name === 'Glob') push('search', `Searching ${String(e.detail ?? '').slice(0, 80)}`)
        else if (name === 'Skill') push('read', `Loading the ${String(e.detail ?? 'design')} skill`)
      } else if (e.type === 'tool_end' && e.diff) {
        const d = e.diff as { path: string; added: number; removed: number }
        push('done', `Changed ${d.path}  +${d.added} −${d.removed}`)
      } else if (e.type === 'error') push('error', String(e.message ?? 'Something went wrong').slice(0, 160))
      else if (e.type === 'text') {
        saying = (saying + String(e.delta ?? '')).slice(-600)
      }
    })
    // Leave /brain recording if it was open; otherwise go back to recording nothing
    unsubscribe = () => { off(); if (!wasActive) brain.active = false; unsubscribe = null }
  }
  let fixStarted = 0
  let wanted = target
  const set = (p: Phase, m = '') => { phase = p; message = m; version++ }

  async function resolveTarget(port: number, wanted: string): Promise<string | null> {
    staticRoot = null
    if (/^https?:\/\//.test(wanted)) return wanted
    if (wanted) {
      const abs = resolve(src.cwd, wanted)
      if (existsSync(abs) && statSync(abs).isFile() && /\.html?$/.test(abs)) { staticRoot = dirname(abs); return `http://127.0.0.1:${port}/site/${token}/${encodeURIComponent(abs.slice(staticRoot.length + 1))}` }
      if (/^:?\d+$/.test(wanted)) return `http://localhost:${wanted.replace(':', '')}/`
      if (/^localhost[:/]/.test(wanted)) return `http://${wanted}`
      if (wanted.startsWith('/')) { const dev = await findDevServer(src.cwd); if (dev) return new URL(wanted, dev).href }
    }
    const dev = await findDevServer(src.cwd)
    if (dev) return dev
    const page = findStaticPage(src.cwd)
    if (page) { staticRoot = dirname(join(src.cwd, page)); return `http://127.0.0.1:${port}/site/${token}/index.html` }
    return null
  }

  async function capture(port: number, wanted: string) {
    set('capturing', 'Looking for your page')
    const keep = readKeep(src.cwd)
    try {
      pageUrl = await resolveTarget(port, wanted)
      // Source rules over the whole project: they place pins on lines and catch what isn't on this page
      set('capturing', pageUrl ? `Opening ${pageUrl.replace(/\/site\/[0-9a-f]+\//, '/')}` : 'Reading your code')
      const scan = scanTaste(src.cwd, '.')
      const code = scan.results.map(r => {
        const abs = resolve(src.cwd, r.path)
        let lines: string[] = []
        try { lines = readFileSync(abs, 'utf-8').split('\n') } catch { /* gone */ }
        const flagged = new Map<number, TasteRule[]>()
        for (const f of r.findings) flagged.set(f.line, [...(flagged.get(f.line) ?? []), f.rule])
        return { file: r.path, lines, flagged, findings: r.findings }
      })
      // Also look for page text in UI files that had no findings (so a pin can still point at its file)
      const allUi = scanAllUi(src.cwd, code.map(c => c.file))

      const pageHits: Partial<Record<View, PageHit[]>> = {}
      shots = {}
      system = null
      if (pageUrl) {
        if (!findChrome()) throw new Error('Taste studio renders your page in Chrome, and no Chrome, Edge or Chromium was found. Install Chrome (or set DARCE_CHROME) and check again.')
        const browser = await Browser.launch()
        try {
          const page = await browser.newPage()
          for (const view of ['desktop', 'mobile'] as View[]) {
            const v = VIEWS[view]
            set('capturing', view === 'desktop' ? 'Rendering at desktop width' : 'Rendering at phone width')
            await page.viewport(v.width, v.height, v.mobile)
            await page.goto(pageUrl)
            const got = await page.eval<Collected>(detectorScript())
            pageHits[view] = judge(got.cands)
            if (view === 'desktop') system = analyzeSystem(got.sys)
            shots[view] = await page.screenshot(v.width)
          }
        } finally { browser.close() }
      }

      // Page hits become issues, merged across views when they come from the same place
      set('capturing', 'Matching what\'s on the page to your code')
      const byKey = new Map<string, Issue>()
      const usedLines = new Set<string>()
      let n = 0
      for (const view of ['desktop', 'mobile'] as View[]) {
        for (const h of pageHits[view] ?? []) {
          const where = locate(h, [...code, ...allUi])
          const key = where ? `${h.rule}|${where.file}|${where.line}` : `${h.rule}|${h.label}|${h.text.slice(0, 40)}`
          let issue = byKey.get(key)
          if (!issue) {
            issue = { id: `i${++n}`, kind: 'page', rule: h.rule, title: TASTE_RULES[h.rule], label: h.label, seen: TEXT_RULES.has(h.rule) ? h.text.slice(0, 160) : undefined, why: WHY[h.rule], fix: FIX[h.rule], where, pins: [], decision: 'fix' }
            byKey.set(key, issue)
          }
          if (!issue.pins.some(p => p.view === view && Math.abs(p.box.x - h.box.x) < 4 && Math.abs(p.box.y - h.box.y) < 4)) issue.pins.push({ view, box: h.box })
          if (where) usedLines.add(`${where.file}|${where.line}`)
        }
      }
      // Source findings the page didn't show (other routes, hover states, unused components)
      for (const c of code) for (const f of c.findings) {
        if (usedLines.has(`${c.file}|${f.line}`)) continue
        const key = `${f.rule}|${c.file}|${f.line}`
        if (byKey.has(key)) continue
        byKey.set(key, { id: `i${++n}`, kind: 'code', rule: f.rule, title: TASTE_RULES[f.rule], label: f.text, why: WHY[f.rule], fix: FIX[f.rule], where: { file: c.file, line: f.line, code: (c.lines[f.line - 1] ?? '').trim().slice(0, 200) }, pins: [], decision: 'fix' })
      }
      // How the page's system holds together, and how the project is built
      for (const f of system?.findings ?? []) {
        byKey.set(`sys|${f.rule}`, { id: `i${++n}`, kind: 'system', rule: f.rule, title: TASTE_RULES[f.rule], label: f.label, detail: f.detail, why: WHY[f.rule], fix: FIX[f.rule], pins: f.boxes.map(box => ({ view: 'desktop' as View, box })), decision: 'fix' })
      }
      for (const f of analyzeProject(src.cwd)) {
        const first = f.spots[0]
        byKey.set(`code|${f.rule}|${f.label}`, { id: `i${++n}`, kind: 'code', rule: f.rule, title: TASTE_RULES[f.rule], label: f.label, detail: f.detail, why: WHY[f.rule], fix: FIX[f.rule], where: first ? { file: first.file, line: first.line, code: f.code ?? '' } : undefined, spots: f.spots, pins: [], decision: 'keep' })
      }
      issues = [...byKey.values()]
      for (const i of issues) if (keep.has(keyOf(i))) { i.decision = 'keep'; i.kept = true }
      // On the page first (in reading order), then the rest by file
      issues.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (b.pins.length ? 1 : 0) - (a.pins.length ? 1 : 0) || (a.pins[0]?.box.y ?? 0) - (b.pins[0]?.box.y ?? 0) || (a.where?.file ?? '').localeCompare(b.where?.file ?? '') || (a.where?.line ?? 0) - (b.where?.line ?? 0))
      // Code-only findings start unselected: the page is what you're looking at
      for (const i of issues) if (i.kind === 'code' && !i.kept) i.decision = 'keep'
      set('ready')
      return true
    } catch (err) {
      set('error', (err as Error).message)
      return false
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const port = (server.address() as { port: number }).port
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'text/plain', 'Forbidden')

    // The project's own static page, for headless Chrome to render
    if (url.pathname.startsWith(`/site/${token}/`)) {
      if (!staticRoot) return send(res, 404, 'text/plain', 'Not found')
      const rel = decodeURIComponent(url.pathname.slice(`/site/${token}/`.length)) || 'index.html'
      const abs = resolve(staticRoot, rel)
      if (!abs.startsWith(resolve(staticRoot) + sep) || SECRET_NAME.test(abs.split(sep).pop() ?? '')) return send(res, 403, 'text/plain', 'Forbidden')
      try { return send(res, 200, MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream', readFileSync(abs)) } catch { return send(res, 404, 'text/plain', 'Not found') }
    }
    if (url.pathname.startsWith('/api/') && url.searchParams.get('t') !== token) return send(res, 403, 'text/plain', 'This link has expired. Run /taste in Darce for a new one.')

    try {
      switch (url.pathname) {
        case '/':
          return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(dir, 'index.html')))
        case '/app.js':
          return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(join(dir, 'app.js')))
        case '/api/state':
          return json(res, {
            phase, message, version,
            elapsed: phase === 'fixing' ? Date.now() - fixStarted : 0,
            ask: phase === 'fixing' ? src.pending() : null,
            activity: activity.slice(-12),
            // The last full sentence Darce wrote, as a one-line "what it's thinking"
            saying: phase === 'fixing' ? (saying.replace(/\s+/g, ' ').match(/[^.!?]*[.!?](?=[^.!?]*$)/)?.[0] ?? '').trim().slice(0, 220) : '',
          })
        case '/api/decide': {
          if (req.method !== 'POST') return send(res, 405, 'text/plain', 'POST only')
          const body = JSON.parse(await readBody(req)) as { allow: boolean }
          return json(res, { ok: src.decide(!!body.allow) })
        }
        case '/api/report':
          return json(res, {
            phase, message, version,
            target: pageUrl ? pageUrl.replace(/^http:\/\/127\.0\.0\.1:\d+\/site\/[0-9a-f]+\//, '') : null,
            cwd: src.cwd,
            views: Object.fromEntries(Object.entries(shots).map(([k, s]) => [k, { width: s!.width, height: s!.height }])),
            compare: Object.keys(before).length > 0,
            fixed,
            previous,
            system: system && { colors: system.colors, sizes: system.sizes.map(({ value, n }) => ({ value, n })), radii: system.radii.map(({ value, n }) => ({ value, n })), fonts: system.fonts },
            issues,
          })
        case '/api/shot': {
          const view = url.searchParams.get('view') as View
          const s = (url.searchParams.get('when') === 'before' ? before : shots)[view]
          return s ? send(res, 200, 'image/jpeg', s.data) : send(res, 404, 'text/plain', 'No screenshot')
        }
        case '/api/fix': {
          if (req.method !== 'POST') return send(res, 405, 'text/plain', 'POST only')
          if (phase === 'fixing' || phase === 'checking' || phase === 'capturing') return send(res, 409, 'text/plain', 'Busy')
          if (src.busy()) return send(res, 409, 'text/plain', 'Darce is working on something else. Try again when it finishes.')
          const body = JSON.parse(await readBody(req)) as { fix: string[]; keep: string[] }
          const chosen = issues.filter(i => body.fix.includes(i.id))
          // Remember what you chose to keep, so it stays out of the way next time
          const keep = readKeep(src.cwd)
          const was = [...keep].join('\n')
          for (const i of issues) {
            // Code-only findings start unselected; only an explicit Keep on something you saw is remembered
            if (body.keep.includes(i.id) && (i.kind !== 'code' || i.kept)) keep.add(keyOf(i)) // code starts on Keep, so only a kept page or system item is a choice
            if (body.fix.includes(i.id)) keep.delete(keyOf(i))
          }
          if ([...keep].join('\n') !== was) writeKeep(src.cwd, keep)
          if (!chosen.length) return json(res, { ok: true, nothing: true })
          before = shots
          previous = issues.filter(i => i.pins.length && !i.kept).length
          fixed = chosen.map(i => i.id)
          fixStarted = Date.now()
          set('fixing', `Fixing ${chosen.length} thing${chosen.length === 1 ? '' : 's'}`)
          const prompt = fixPrompt(chosen, pageUrl)
          follow()
          void src.fix(prompt, `Fix ${chosen.length} thing${chosen.length === 1 ? '' : 's'} from the taste studio`).then(async () => {
            unsubscribe?.()
            await capture(port, wanted)
            set('ready')
          }, err => { unsubscribe?.(); set('error', (err as Error).message) })
          return json(res, { ok: true })
        }
        case '/api/recheck': {
          if (req.method !== 'POST') return send(res, 405, 'text/plain', 'POST only')
          if (phase === 'fixing' || phase === 'capturing' || phase === 'checking') return send(res, 409, 'text/plain', 'Busy')
          before = {}; fixed = []; previous = null
          void capture(port, wanted)
          return json(res, { ok: true })
        }
        default:
          return send(res, 404, 'text/plain', 'Not found')
      }
    } catch (err) {
      return send(res, 500, 'text/plain', (err as Error).message)
    }
  })

  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(7338, '127.0.0.1', () => ok())
  }).catch(() => new Promise<void>(ok => server.listen(0, '127.0.0.1', () => ok())))
  server.unref()
  const port = (server.address() as { port: number }).port
  const studio = `http://127.0.0.1:${port}/?t=${token}`
  const announce = (ok: boolean) => {
    if (!ok) return src.say(`Taste studio: ${message}`)
    const onPage = issues.filter(i => i.pins.length && !i.kept).length
    const elsewhere = issues.filter(i => !i.pins.length && !i.kept).length
    src.say(pageUrl
      ? onPage ? `Taste studio: ${onPage} thing${onPage === 1 ? '' : 's'} on the page look generated${elsewhere ? `, ${elsewhere} more in the code` : ''}. Choose what to fix in the window.` : `Taste studio: nothing on the page looks generated${elsewhere ? ` (${elsewhere} in code that isn't on this page)` : ''}.`
      : `Taste studio: no running page found, so it's showing the code only. Start your dev server and press Check again.`)
  }
  running = {
    server, url: studio,
    refresh: (t?: string) => { if (t !== undefined) wanted = t; if (phase !== 'fixing' && phase !== 'capturing') { before = {}; fixed = []; previous = null; void capture(port, wanted).then(announce) } },
  }
  void capture(port, wanted).then(announce)
  return studio
}

export function stopStudio() {
  running?.server.close()
  running = null
}

/** The fix request Darce receives: only what you picked, each with its place and the reason. */
function fixPrompt(chosen: Issue[], pageUrl: string | null): string {
  const rows = chosen.map((i, n) => {
    if (i.kind === 'page' || !i.detail) {
      const at = i.where ? `${i.where.file}:${i.where.line}` : 'on the rendered page; search the source (including data files) for the text below'
      const seen = i.seen ? `\n   Seen on the page in: "${i.seen}"` : ''
      return `${n + 1}. ${at}: ${i.title.toLowerCase()} (${i.label}). ${i.fix}${seen}${i.where?.code ? `\n   ${i.where.code}` : ''}`
    }
    const places = i.spots?.length ? `\n   Places: ${i.spots.slice(0, 12).map(s => `${s.file}:${s.line}`).join(', ')}${i.spots.length > 12 ? ` and ${i.spots.length - 12} more` : ''}` : ''
    const code = i.where?.code ? `\n   ${i.where.code}` : ''
    return `${n + 1}. ${i.title}: ${i.label}. ${i.detail} ${i.fix}${places}${code}`
  })
  return [
    'Load the ui-craft skill. In the taste studio, I reviewed what makes this UI look templated and chose these to fix:',
    '',
    ...rows,
    '',
    'Fix each one in the style the project already uses: its own colors, type, spacing and icon set. Where the project has tokens or components, use them; where it needs a new token or component, add one and use it at every place listed. Keep behavior and content meaning the same, and do not change anything that is not listed. Where copy is vague, write the specific thing the product does, using only facts from the code or the page. Never invent names, numbers or quotes: remove unsupported proof instead.',
    pageUrl ? 'The studio re-renders the page when you finish, so do not open a browser to check it.' : '',
  ].filter(Boolean).join('\n')
}

/** Other source files (components, and the data files page copy often lives in), read only so pins can still point at a file. */
function scanAllUi(cwd: string, skip: string[]) {
  const out: { file: string; lines: string[]; flagged: Map<number, TasteRule[]> }[] = []
  const seen = new Set(skip)
  const walk = (d: string, depth: number) => {
    if (depth > 8 || out.length > 1500) return
    let names: string[] = []
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      if (name.startsWith('.') || ['node_modules', 'dist', 'build', 'out', '.next', 'coverage', 'vendor', 'public'].includes(name)) continue
      const p = join(d, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p, depth + 1)
      else if (/\.(tsx|jsx|vue|svelte|astro|html?|mdx?|ts|js|mjs|json|ya?ml)$/.test(name) && !/\.(d|config|test|spec)\.|lock/.test(name) && st.size < 400_000) {
        const rel = relative(cwd, p)
        if (seen.has(rel)) continue
        try { out.push({ file: rel, lines: readFileSync(p, 'utf-8').split('\n'), flagged: new Map() }) } catch { /* unreadable */ }
      }
    }
  }
  walk(cwd, 0)
  return out
}

/** Open the studio as its own app window (no tabs or address bar) when Chrome is installed. */
export function openStudioWindow(url: string, fallback: (url: string) => void) {
  if (process.env.DARCE_NO_BROWSER) return
  const chrome = findChrome()
  if (!chrome) return fallback(url)
  const args = [`--app=${url}`, '--window-size=1440,920']
  if (process.platform === 'darwin') {
    const app = chrome.split('/Contents/')[0]!
    execFile('open', ['-na', app, '--args', ...args], err => { if (err) fallback(url) })
  } else {
    try { spawn(chrome, args, { detached: true, stdio: 'ignore' }).unref() } catch { fallback(url) }
  }
}

function assetsDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [join(here, 'taste'), resolve(here, '../../dist/taste'), resolve(here, '../dist/taste')]
  return candidates.find(d => existsSync(join(d, 'index.html'))) ?? candidates[0]!
}

function readBody(req: IncomingMessage, max = 64_000): Promise<string> {
  return new Promise((ok, fail) => {
    let b = ''
    req.on('data', (c: Buffer) => { b += c; if (b.length > max) { fail(new Error('Too large')); req.destroy() } })
    req.on('end', () => ok(b))
    req.on('error', fail)
  })
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
  res.end(body)
}

function json(res: ServerResponse, data: unknown) {
  send(res, 200, 'application/json', JSON.stringify(data))
}
