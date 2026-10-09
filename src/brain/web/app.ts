/// <reference lib="dom" />
import { hierarchy, pack } from 'd3-hierarchy'

/* Darce brain view: the codebase as a map of folders and files, with Darce's attention moving across it live.
   Reads leave a soft white glow, edits an orange pulse; the timeline replays the session step by step. */

type Graph = { name: string; files: { p: string; n: number }[]; edges: [number, number][]; truncated: boolean }
type Diff = { path: string; created: boolean; added: number; removed: number; hunks: { lines: { kind: 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number }[] }[] }
type Ev = { type: string; at: number; [k: string]: any }

type FNode = {
  i: number; p: string; name: string; n: number; color: string
  x: number; y: number; r: number; fx: number; fy: number; fr: number // current and animate-from
  read: number; edit: number; spark: number; spawn: number
  changed: boolean; added: number; removed: number; visited: boolean
  imports: number[]; usedBy: number[]
}
type Folder = { path: string; name: string; x: number; y: number; r: number; depth: number }
type Fx = { kind: 'ripple' | 'shock' | 'float' | 'spark' | 'pulse'; x: number; y: number; t0: number; dur: number; text?: string; color?: string; r?: number; a?: number; b?: number }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const params = new URLSearchParams(location.search)
const TOKEN = params.get('t') ?? ''
const api = (path: string) => fetch(`${path}${path.includes('?') ? '&' : '?'}t=${TOKEN}`).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
const ORANGE = '#e8892b'
const WORLD = 1000

const COLORS: [RegExp, string][] = [
  [/\.(m?[jt]sx?|cjs|cts|mts)$/, '#7c9cf0'],
  [/\.py$/, '#8fc77a'],
  [/\.(go|rs|java|kt|swift|c|cc|cpp|h|hpp|rb|php|cs|scala|dart|ex|exs|zig)$/, '#c49af0'],
  [/\.(css|scss|sass|less|html?|vue|svelte|astro)$/, '#5ec4c8'],
  [/\.(md|mdx|txt|rst|adoc)$/, '#8d8d97'],
  [/\.(json|ya?ml|toml|ini|env|xml|csv)$/, '#cfae6e'],
  [/\.(sh|zsh|bash|sql|prisma|graphql|gql|dockerfile)$|Dockerfile$|Makefile$/, '#b2b2bb'],
]
const colorOf = (p: string) => COLORS.find(([re]) => re.test(p))?.[1] ?? '#6c6c76'
const rgba = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`
// A faint, fixed starfield behind the map for depth
const STARS = Array.from({ length: 220 }, (_, i) => { const r = (n: number) => { const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x) }; return { x: r(1), y: r(2), s: 0.4 + r(3) * 0.9, a: 0.05 + r(4) * 0.22 } })

// ── State ─────────────────────────────────────────────────────────
let graph: Graph | null = null
let nodes: FNode[] = []
let byPath = new Map<string, FNode>()
let folders: Folder[] = []
let layoutAt = 0
const fx: Fx[] = []
let hover: FNode | null = null
let focus: Set<string> | null = null // files in the selected timeline step
let findHits: Set<FNode> | null = null
let follow = true
let busy = false
let changedCount = 0

// Camera: world → screen. Eased toward a target so moves feel physical.
const cam = { x: WORLD / 2, y: WORLD / 2, k: 1 }
const camTo = { x: WORLD / 2, y: WORLD / 2, k: 1 }
let userMovedAt = 0

// Darce's attention: a comet that flies between files
const comet = { x: WORLD / 2, y: WORLD / 2, sx: WORLD / 2, sy: WORLD / 2, tx: WORLD / 2, ty: WORLD / 2, cx: 0, cy: 0, t0: 0, dur: 1, trail: [] as { x: number; y: number }[], visible: false, onArrive: null as null | (() => void) }

// ── Canvas ────────────────────────────────────────────────────────
const canvas = $<HTMLCanvasElement>('map')
const ctx = canvas.getContext('2d')!
let W = 0, H = 0, DPR = 1
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2)
  W = window.innerWidth; H = window.innerHeight
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
  dirty = true
}
window.addEventListener('resize', () => { resize(); fit(false) })

/** The part of the screen the map can use (not under the feed, top bar or timeline). */
function viewport() {
  const narrow = W < 960
  const feed = narrow ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--feed-w')) + 28
  const bottom = narrow ? H * 0.38 + 80 : 80
  return { x0: 14, y0: 72, x1: W - feed, y1: H - bottom }
}
function center() { const v = viewport(); return { cx: (v.x0 + v.x1) / 2, cy: (v.y0 + v.y1) / 2 } }
const toScreen = (x: number, y: number) => { const { cx, cy } = center(); return { x: (x - cam.x) * cam.k + cx, y: (y - cam.y) * cam.k + cy } }
const toWorld = (sx: number, sy: number) => { const { cx, cy } = center(); return { x: (sx - cx) / cam.k + cam.x, y: (sy - cy) / cam.k + cam.y } }

function fit(animate = true, only?: FNode[]) {
  const v = viewport()
  let x0 = 0, y0 = 0, x1 = WORLD, y1 = WORLD
  if (only?.length) {
    x0 = Math.min(...only.map(n => n.x - n.r)); y0 = Math.min(...only.map(n => n.y - n.r))
    x1 = Math.max(...only.map(n => n.x + n.r)); y1 = Math.max(...only.map(n => n.y + n.r))
    const pad = 60; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
  } else if (folders[0]) {
    const f = folders[0]; x0 = f.x - f.r; y0 = f.y - f.r; x1 = f.x + f.r; y1 = f.y + f.r
  }
  const k = Math.min((v.x1 - v.x0) / (x1 - x0), (v.y1 - v.y0) / (y1 - y0)) * 0.94
  camTo.x = (x0 + x1) / 2; camTo.y = (y0 + y1) / 2; camTo.k = Math.min(k, only?.length ? 4 : 50)
  if (!animate) Object.assign(cam, camTo)
  dirty = true
}

// ── Layout: folders packed as circles, files as dots inside ──────
type Tree = { name: string; path: string; children?: Tree[]; file?: number }
function layout(g: Graph) {
  const root: Tree = { name: g.name, path: '', children: [] }
  g.files.forEach((f, i) => {
    const parts = f.p.split('/')
    let at = root
    for (let k = 0; k < parts.length - 1; k++) {
      const path = parts.slice(0, k + 1).join('/')
      let next = at.children!.find(c => c.path === path && c.children)
      if (!next) { next = { name: parts[k]!, path, children: [] }; at.children!.push(next) }
      at = next
    }
    at.children!.push({ name: parts[parts.length - 1]!, path: f.p, file: i })
  })
  const h = hierarchy(root).sum(d => (d.file !== undefined ? Math.pow(Math.max(g.files[d.file]!.n, 6), 0.55) : 0)).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const packed = pack<Tree>().size([WORLD, WORLD]).padding(d => Math.max(1.5, 9 - d.depth * 2))(h)

  const prev = byPath
  const now = performance.now()
  const next: FNode[] = []
  const nextFolders: Folder[] = []
  for (const d of packed.descendants()) {
    if (d.data.file !== undefined) {
      const f = g.files[d.data.file]!
      const old = prev.get(f.p)
      const n: FNode = old ?? { i: 0, p: f.p, name: d.data.name, n: f.n, color: colorOf(f.p), x: d.x, y: d.y, r: d.r, fx: d.x, fy: d.y, fr: 0, read: 0, edit: 0, spark: 0, spawn: layoutAt ? now : 0, changed: false, added: 0, removed: 0, visited: false, imports: [], usedBy: [] }
      if (old) { n.fx = old.x; n.fy = old.y; n.fr = old.r }
      n.i = next.length; n.n = f.n; n.x = d.x; n.y = d.y; n.r = d.r; n.imports = []; n.usedBy = []
      next.push(n)
    } else nextFolders.push({ path: d.data.path, name: d.data.name, x: d.x, y: d.y, r: d.r, depth: d.depth })
  }
  // file index in graph → node
  const idx = new Map<number, FNode>()
  packed.leaves().forEach(l => { if (l.data.file !== undefined) idx.set(l.data.file, next.find(n => n.p === g.files[l.data.file!]!.p)!) })
  for (const [a, b] of g.edges) {
    const na = idx.get(a), nb = idx.get(b)
    if (na && nb) { na.imports.push(nb.i); nb.usedBy.push(na.i) }
  }
  nodes = next; folders = nextFolders; byPath = new Map(nodes.map(n => [n.p, n]))
  layoutAt = now
  $('s-files').textContent = nodes.length.toLocaleString()
}

// ── Effects ───────────────────────────────────────────────────────
const add = (f: Fx) => { fx.push(f); dirty = true }
/** Signals along import links: a read looks outward at what the file uses; an edit ripples to everything that depends on it. */
function signal(n: FNode, dir: 'out' | 'in', color: string) {
  const list = (dir === 'out' ? n.imports : n.usedBy).slice(0, 14)
  const now = performance.now()
  list.forEach((j, k) => add({ kind: 'pulse', x: 0, y: 0, a: dir === 'out' ? n.i : n.i, b: j, t0: now + 120 + k * 70, dur: 900, color }))
}
function flyTo(n: FNode | null, onArrive?: () => void) {
  const tx = n ? n.x : folders[0]?.x ?? WORLD / 2, ty = n ? n.y : folders[0]?.y ?? WORLD / 2
  comet.visible = true
  comet.sx = comet.x; comet.sy = comet.y; comet.tx = tx; comet.ty = ty
  const dx = tx - comet.sx, dy = ty - comet.sy, dist = Math.hypot(dx, dy)
  // Curve slightly, like a thrown object, never a straight robotic line
  comet.cx = (comet.sx + tx) / 2 - dy * 0.22; comet.cy = (comet.sy + ty) / 2 + dx * 0.22
  comet.t0 = performance.now(); comet.dur = reduce ? 1 : Math.max(380, Math.min(900, dist * 1.6 + 260))
  comet.onArrive = onArrive ?? null
  if (follow && n && Date.now() - userMovedAt > 4000) {
    camTo.x = camTo.x * 0.35 + tx * 0.65; camTo.y = camTo.y * 0.35 + ty * 0.65
    camTo.k = Math.max(camTo.k, Math.min(camTo.k * 1.15, baseK() * 1.45))
  }
  dirty = true
}
const baseK = () => { const v = viewport(); return Math.min(v.x1 - v.x0, v.y1 - v.y0) / ((folders[0]?.r ?? WORLD / 2) * 2) * 0.94 }

// ── Drawing ───────────────────────────────────────────────────────
let dirty = true
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const back = (t: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2) }

function frame() {
  requestAnimationFrame(frame)
  const now = performance.now()
  // camera easing
  const moving = Math.abs(cam.x - camTo.x) + Math.abs(cam.y - camTo.y) > 0.05 || Math.abs(cam.k - camTo.k) > 0.0005
  if (moving) { const a = reduce ? 1 : 0.11; cam.x += (camTo.x - cam.x) * a; cam.y += (camTo.y - cam.y) * a; cam.k += (camTo.k - cam.k) * a }
  const relayout = now - layoutAt < 900
  const cometMoving = comet.visible && now - comet.t0 < comet.dur + 400
  const hot = busy || nodes.some(n => now - n.edit < 3200 || now - n.read < 2000 || now - n.spark < 1400)
  if (!(dirty || moving || relayout || cometMoving || hot || fx.length)) return
  dirty = false
  draw(now, relayout)
}

function draw(now: number, relayout: boolean) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  // Deep background with a faint warm light where Darce is
  ctx.fillStyle = '#07070a'; ctx.fillRect(0, 0, W, H)
  const cs = toScreen(comet.x, comet.y)
  for (const st of STARS) {
    const x = ((st.x * W - (cam.x - WORLD / 2) * cam.k * 0.06) % W + W) % W, y = ((st.y * H - (cam.y - WORLD / 2) * cam.k * 0.06) % H + H) % H
    ctx.fillStyle = `rgba(255,255,255,${st.a})`; ctx.fillRect(x, y, st.s, st.s)
  }
  if (comet.visible) {
    const g = ctx.createRadialGradient(cs.x, cs.y, 0, cs.x, cs.y, 420)
    g.addColorStop(0, busy ? 'rgba(232,137,43,0.07)' : 'rgba(232,137,43,0.035)'); g.addColorStop(1, 'rgba(232,137,43,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  }

  const { cx, cy } = center()
  ctx.setTransform(DPR * cam.k, 0, 0, DPR * cam.k, DPR * (cx - cam.x * cam.k), DPR * (cy - cam.y * cam.k))
  const px = 1 / cam.k // one screen pixel in world units
  const t = relayout ? ease(Math.min(1, (now - layoutAt) / 900)) : 1

  // Folders
  for (const f of folders) {
    if (f.r * cam.k < 3) continue
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2)
    ctx.fillStyle = f.depth === 0 ? 'rgba(255,255,255,0.012)' : `rgba(255,255,255,${0.014 + Math.min(f.depth, 4) * 0.006})`
    ctx.fill()
    ctx.lineWidth = px; ctx.strokeStyle = f.depth === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.075)'; ctx.stroke()
  }

  // The import network, faint: the codebase as connected tissue rather than loose bubbles
  if (graph && graph.edges.length < 6000 && !focus && !findHits) {
    ctx.lineWidth = 0.8 * px; ctx.strokeStyle = hover ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.055)'
    ctx.beginPath()
    for (const n of nodes) for (const j of n.imports) {
      const m = nodes[j]!
      const mx = (n.x + m.x) / 2 - (m.y - n.y) * 0.18, my = (n.y + m.y) / 2 + (m.x - n.x) * 0.18
      ctx.moveTo(n.x, n.y); ctx.quadraticCurveTo(mx, my, m.x, m.y)
    }
    ctx.stroke()
  }
  // Import lines for the file under the cursor
  const lens = hover
  if (lens) {
    ctx.lineWidth = 1.2 * px
    const curve = (a: FNode, b: FNode, color: string) => {
      const mx = (a.x + b.x) / 2 - (b.y - a.y) * 0.18, my = (a.y + b.y) / 2 + (b.x - a.x) * 0.18
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(mx, my, b.x, b.y); ctx.strokeStyle = color; ctx.stroke()
    }
    for (const j of lens.imports) curve(lens, nodes[j]!, 'rgba(232,137,43,0.55)')
    for (const j of lens.usedBy) curve(nodes[j]!, lens, 'rgba(124,156,240,0.5)')
  }

  // Files
  const related = lens ? new Set([lens.i, ...lens.imports, ...lens.usedBy]) : null
  for (const n of nodes) {
    const x = n.fx + (n.x - n.fx) * t, y = n.fy + (n.y - n.fy) * t
    let r = n.fr + (n.r - n.fr) * t
    if (n.spawn && now - n.spawn < 900) r *= back(Math.min(1, (now - n.spawn) / 900))
    const editHeat = Math.max(0, 1 - (now - n.edit) / 3200)
    const readHeat = Math.max(0, 1 - (now - n.read) / 2000)
    if (editHeat > 0) r *= 1 + 0.35 * Math.sin(Math.min(1, (now - n.edit) / 600) * Math.PI) * editHeat
    let alpha = 0.62
    if (focus) alpha = focus.has(n.p) ? 1 : 0.1
    else if (findHits) alpha = findHits.has(n) ? 1 : 0.12
    else if (related) alpha = related.has(n.i) ? 1 : 0.22

    if (readHeat > 0) glow(x, y, r * (2.2 + 3 * readHeat), `rgba(255,255,255,${0.32 * readHeat})`)
    if (editHeat > 0) glow(x, y, r * (2.6 + 5 * editHeat), `rgba(232,137,43,${0.55 * editHeat})`)

    ctx.globalAlpha = alpha
    const rr = Math.max(r * 0.84, 0.7 * px)
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2)
    if (n.changed) {
      glow(x, y, rr * 1.9, 'rgba(232,137,43,0.22)')
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2)
      const g = ctx.createRadialGradient(x - rr * 0.35, y - rr * 0.35, rr * 0.1, x, y, rr)
      g.addColorStop(0, '#ffb565'); g.addColorStop(1, '#d9741a')
      ctx.fillStyle = g; ctx.fill()
    } else {
      ctx.fillStyle = rgba(n.color, n.visited ? 0.42 : 0.2); ctx.fill()
      ctx.lineWidth = 1.1 * px; ctx.strokeStyle = rgba(n.color, n.visited ? 0.95 : 0.6); ctx.stroke()
    }
    if (n.visited && !n.changed) { ctx.beginPath(); ctx.arc(x, y, rr + 2.5 * px, 0, Math.PI * 2); ctx.lineWidth = 1 * px; ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke() }
    if (n === hover || (findHits?.has(n) && findHits.size < 40)) { ctx.beginPath(); ctx.arc(x, y, rr + 1.5 * px, 0, Math.PI * 2); ctx.lineWidth = 2 * px; ctx.strokeStyle = '#fff'; ctx.stroke() }
    ctx.globalAlpha = 1
    if (now - n.spark < 1400) sparkle(x, y, r, (now - n.spark) / 1400, px)
  }

  // Effects in world space
  for (let i = fx.length - 1; i >= 0; i--) {
    const e = fx[i]!
    const p = (now - e.t0) / e.dur
    if (p >= 1) { fx.splice(i, 1); continue }
    if (p < 0 && e.kind !== 'pulse') continue
    if (e.kind === 'pulse') {
      if (p < 0) continue
      const a = nodes[e.a!], b = nodes[e.b!]
      if (!a || !b) continue
      const mx = (a.x + b.x) / 2 - (b.y - a.y) * 0.18, my = (a.y + b.y) / 2 + (b.x - a.x) * 0.18
      const q = ease(p), u = 1 - q
      const x = u * u * a.x + 2 * u * q * mx + q * q * b.x, y = u * u * a.y + 2 * u * q * my + q * q * b.y
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(mx, my, b.x, b.y)
      ctx.lineWidth = 1 * px; ctx.strokeStyle = (e.color ?? '#fff').replace('ALPHA', String(0.22 * (1 - p))); ctx.stroke()
      glow(x, y, 7 * px, (e.color ?? '#fff').replace('ALPHA', '0.9'))
      ctx.beginPath(); ctx.arc(x, y, 1.6 * px, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill()
      if (p > 0.92) b.spark = Math.max(b.spark, performance.now() - 300)
      continue
    }
    if (e.kind === 'ripple' || e.kind === 'shock') {
      const rings = e.kind === 'shock' ? 2 : 1
      for (let k = 0; k < rings; k++) {
        const q = Math.max(0, p - k * 0.18)
        if (q <= 0) continue
        ctx.beginPath(); ctx.arc(e.x, e.y, (e.r ?? 6) + q * (e.kind === 'shock' ? 70 : 34) * px * 2.2, 0, Math.PI * 2)
        ctx.lineWidth = (e.kind === 'shock' ? 2.4 : 1.4) * px * (1 - q)
        ctx.strokeStyle = e.color ?? (e.kind === 'shock' ? ORANGE : 'rgba(255,255,255,0.9)')
        ctx.globalAlpha = 1 - q; ctx.stroke(); ctx.globalAlpha = 1
      }
    }
  }

  // Comet
  if (comet.visible) {
    const p = Math.min(1, (now - comet.t0) / comet.dur)
    const q = ease(p), u = 1 - q
    const x = u * u * comet.sx + 2 * u * q * comet.cx + q * q * comet.tx
    const y = u * u * comet.sy + 2 * u * q * comet.cy + q * q * comet.ty
    if (p >= 1 && comet.onArrive) { const f = comet.onArrive; comet.onArrive = null; f() }
    comet.x = x; comet.y = y
    comet.trail.push({ x, y }); if (comet.trail.length > 26) comet.trail.shift()
    if (p >= 1 && comet.trail.length > 1) comet.trail.shift()
    for (let k = 1; k < comet.trail.length; k++) {
      const a = comet.trail[k - 1]!, b = comet.trail[k]!
      const f = k / comet.trail.length
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
      ctx.lineWidth = 3.2 * px * f; ctx.strokeStyle = `rgba(232,137,43,${0.5 * f})`; ctx.lineCap = 'round'; ctx.stroke()
    }
    const pulse = busy ? 1 + Math.sin(now / 260) * 0.18 : 1
    glow(x, y, 16 * px * pulse, 'rgba(232,137,43,0.55)')
    ctx.beginPath(); ctx.arc(x, y, 3.2 * px * pulse, 0, Math.PI * 2); ctx.fillStyle = '#fff4e6'; ctx.fill()
  }

  // Screen-space text: folder names, labels for big or busy files, floating +/− counts
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  for (const f of folders) {
    const sr = f.r * cam.k
    if (f.depth === 0 || sr < 38 || f.depth > 3 + Math.log2(Math.max(1, cam.k / baseK()))) continue
    const s = toScreen(f.x, f.y - f.r)
    ctx.font = `500 ${Math.min(13, 9 + sr / 60)}px -apple-system, "SF Pro Text", system-ui, sans-serif`
    const label = f.name
    const w = ctx.measureText(label).width + 12
    ctx.fillStyle = 'rgba(7,7,10,0.85)'; roundRect(s.x - w / 2, s.y - 9, w, 18, 6); ctx.fill()
    ctx.fillStyle = focus || findHits ? 'rgba(255,255,255,0.3)' : 'rgba(220,220,228,0.62)'
    ctx.fillText(label, s.x, s.y)
  }
  // File labels: centred under their dot so each clearly belongs to it, most important first, never overlapping
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = []
  const free = (b: { x0: number; y0: number; x1: number; y1: number }) => !placed.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)
  const rank = (n: FNode) => (n === hover ? 1e9 : 0) + (now - n.edit < 3200 ? 1e8 : 0) + (now - n.read < 1600 ? 1e7 : 0) + (n.changed ? 1e6 : 0) + (focus?.has(n.p) ? 1e6 : 0) + n.r * cam.k
  const candidates = nodes.filter(n => {
    const sr = n.r * cam.k
    return n === hover || now - n.edit < 3200 || now - n.read < 1600 || ((focus ? focus.has(n.p) : findHits ? findHits.has(n) && findHits.size < 30 : true) && (sr > 7 || n.changed))
  }).sort((a, b) => rank(b) - rank(a)).slice(0, 220)
  ctx.textAlign = 'center'
  for (const n of candidates) {
    const s2 = toScreen(n.x, n.y)
    const sr = n.r * cam.k * 0.84
    const hotEdit = now - n.edit < 3200, hotRead = now - n.read < 1600
    ctx.font = `${hotEdit || hotRead || n === hover ? 600 : 450} 11px -apple-system, "SF Pro Text", system-ui, sans-serif`
    const w = ctx.measureText(n.name).width
    const inside = w + 8 < sr * 2 && sr > 14
    const ly = inside ? s2.y : s2.y + sr + 9
    const box = { x0: s2.x - w / 2 - 3, y0: ly - 7, x1: s2.x + w / 2 + 3, y1: ly + 7 }
    if (!free(box) && n !== hover) continue
    placed.push(box)
    ctx.fillStyle = hotEdit ? '#ffcf99' : hotRead || n === hover ? '#ffffff' : n.changed ? '#ffcf99' : inside ? 'rgba(235,235,240,0.82)' : 'rgba(205,205,214,0.62)'
    ctx.fillText(n.name, s2.x, ly)
  }
  ctx.textAlign = 'left'
  for (const e of fx) {
    if (e.kind !== 'float') continue
    const p = (now - e.t0) / e.dur
    const s = toScreen(e.x, e.y)
    ctx.globalAlpha = p < 0.15 ? p / 0.15 : 1 - Math.max(0, (p - 0.55) / 0.45)
    ctx.font = '600 12px ui-monospace, "SF Mono", Menlo, monospace'
    ctx.fillStyle = e.color ?? '#a6f0cb'
    ctx.fillText(e.text ?? '', s.x + 10, s.y - 14 - ease(p) * 26)
    ctx.globalAlpha = 1
  }
}

function glow(x: number, y: number, r: number, color: string) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
}
function sparkle(x: number, y: number, r: number, p: number, px: number) {
  for (let k = 0; k < 5; k++) {
    const a = k * 1.2566 + p * 2, d = r + (4 + p * 14) * px
    ctx.globalAlpha = (1 - p) * 0.9
    ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 1.4 * px, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill()
  }
  ctx.globalAlpha = 1
}
function roundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}

// ── Pointer: pan, zoom, hover, click ─────────────────────────────
let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null
canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, cx: camTo.x, cy: camTo.y, moved: false }; canvas.setPointerCapture(e.pointerId) })
canvas.addEventListener('pointermove', e => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; canvas.classList.add('dragging') }
    if (drag.moved) { camTo.x = drag.cx - dx / cam.k; camTo.y = drag.cy - dy / cam.k; cam.x = camTo.x; cam.y = camTo.y; userMovedAt = Date.now(); dirty = true }
    return
  }
  const w = toWorld(e.clientX, e.clientY)
  let best: FNode | null = null, bd = Infinity
  for (const n of nodes) {
    const d = Math.hypot(n.x - w.x, n.y - w.y)
    if (d < Math.max(n.r, 5 / cam.k) && d < bd) { best = n; bd = d }
  }
  if (best !== hover) { hover = best; dirty = true; canvas.classList.toggle('pointing', !!best); tip(best, e.clientX, e.clientY) }
  else if (best) tip(best, e.clientX, e.clientY)
})
canvas.addEventListener('pointerup', e => {
  canvas.classList.remove('dragging')
  const wasDrag = drag?.moved
  drag = null
  if (!wasDrag && hover) openFile(hover.p)
  else if (!wasDrag && !hover) { const w = toWorld(e.clientX, e.clientY); const f = folders.filter(f => f.depth > 0 && Math.hypot(f.x - w.x, f.y - w.y) < f.r).pop(); if (f) zoomToFolder(f) }
})
canvas.addEventListener('pointerleave', () => { hover = null; tip(null, 0, 0); dirty = true })
canvas.addEventListener('wheel', e => {
  e.preventDefault()
  const before = toWorld(e.clientX, e.clientY)
  const k = Math.max(baseK() * 0.5, Math.min(60, camTo.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018))))
  cam.k = camTo.k = k
  const after = toWorld(e.clientX, e.clientY)
  cam.x = camTo.x = cam.x + before.x - after.x; cam.y = camTo.y = cam.y + before.y - after.y
  userMovedAt = Date.now(); dirty = true
}, { passive: false })

function zoomToFolder(f: Folder) {
  const v = viewport()
  camTo.x = f.x; camTo.y = f.y; camTo.k = Math.min(v.x1 - v.x0, v.y1 - v.y0) / (f.r * 2) * 0.9
  userMovedAt = Date.now(); dirty = true
}

const tipEl = $('tip')
function tip(n: FNode | null, x: number, y: number) {
  if (!n) { tipEl.classList.remove('on'); return }
  const bits = [`${n.n.toLocaleString()} lines`]
  if (n.imports.length) bits.push(`imports ${n.imports.length}`)
  if (n.usedBy.length) bits.push(`used by ${n.usedBy.length}`)
  const status = n.changed ? `<span class="add">+${n.added}</span> <span class="del">−${n.removed}</span> this session` : n.visited ? 'read by Darce' : ''
  tipEl.innerHTML = `<div class="p">${esc(n.p)}</div><div class="s">${bits.join(' · ')}${status ? ' · ' + status : ''}</div>`
  tipEl.style.left = `${Math.min(x + 14, W - 350)}px`; tipEl.style.top = `${Math.min(y + 16, H - 70)}px`
  tipEl.classList.add('on')
}

// ── Keys and find ────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if ((e.target as HTMLElement).tagName === 'INPUT') { if (e.key === 'Escape') { (e.target as HTMLInputElement).value = ''; findHits = null; (e.target as HTMLInputElement).blur(); dirty = true } return }
  if (e.key === 'f' || e.key === 'F') { follow = !follow; banner(follow ? 'Following Darce' : 'Free camera'); if (follow) userMovedAt = 0 }
  else if (e.key === '0' || e.key === 'r') { userMovedAt = 0; fit() }
  else if (e.key === 'Escape') { closeDrawer(); goLive() }
  else if (e.key === '/') { e.preventDefault(); $('find').focus() }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stepBy(e.key === 'ArrowLeft' ? -1 : 1)
})
const findEl = $<HTMLInputElement>('find')
findEl.addEventListener('input', () => {
  const q = findEl.value.trim().toLowerCase()
  findHits = q ? new Set(nodes.filter(n => n.p.toLowerCase().includes(q))) : null
  dirty = true
})
findEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !findHits?.size) return
  const list = [...findHits]
  if (list.length === 1) { fit(true, list); openFile(list[0]!.p) } else fit(true, list.slice(0, 200))
  userMovedAt = Date.now()
})

let bannerTimer = 0
function banner(text: string) {
  const b = $('banner'); b.textContent = text; b.classList.add('on')
  clearTimeout(bannerTimer); bannerTimer = window.setTimeout(() => b.classList.remove('on'), 1600)
}

// ── Feed ─────────────────────────────────────────────────────────
const items = $('items')
let answerEl: HTMLDivElement | null = null
let answerText = ''
const pendingRows = new Map<string, HTMLElement>()
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
function push(el: HTMLElement) {
  $('empty')?.remove()
  const atBottom = items.scrollHeight - items.scrollTop - items.clientHeight < 80
  el.classList.add('it'); items.appendChild(el)
  while (items.children.length > 400) items.firstChild?.remove()
  if (atBottom) items.scrollTop = items.scrollHeight
}
function el(cls: string, html: string) { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d }
function row(kind: string, icon: string, html: string, meta = '', path?: string) {
  const r = el(`row ${kind}${path ? ' link' : ''}`, `<span class="ic">${icon}</span><span class="tx">${html}</span><span class="meta">${meta}</span>`)
  if (path) r.addEventListener('click', () => { const n = byPath.get(path); if (n) { fit(true, [n]); userMovedAt = Date.now() } openFile(path) })
  return r
}
function setStatus(text: string, kind: '' | 'busy' | 'ask' = '') {
  const s = $('status'); s.className = kind; (s.lastElementChild as HTMLElement).textContent = text
}

const VERB: Record<string, [string, string, string]> = {
  Read: ['read', '◉', 'Reading'], Edit: ['edit', '✎', 'Editing'], Write: ['edit', '✚', 'Writing'], Bash: ['run', '❯', 'Running'],
  Grep: ['read', '⌕', 'Searching'], Glob: ['read', '⌕', 'Looking for files'], WebFetch: ['run', '↗', 'Reading the web'], WebSearch: ['run', '↗', 'Searching the web'],
  Agent: ['run', '⑃', 'Starting a thread'], Image: ['edit', '◐', 'Making an image'], TodoWrite: ['read', '☰', 'Planning'], Plan: ['read', '☰', 'Planning'],
}

function onEvent(e: Ev) {
  switch (e.type) {
    case 'hello':
      $('model').textContent = String(e.model ?? '').split('/').pop() ?? ''
      setStatus('Ready')
      break
    case 'prompt': {
      busy = true; answerEl = null; answerText = ''
      push(el('prompt', esc(String(e.text))))
      setStatus('Thinking', 'busy'); intro(false)
      if (e.model) $('model').textContent = String(e.model).split('/').pop() ?? ''
      flyTo(null)
      break
    }
    case 'text': {
      answerText += String(e.delta)
      if (!answerEl && !answerText.trim()) break // whitespace before a tool call: no empty card
      if (!answerEl) { answerEl = el('answer', '') as HTMLDivElement; push(answerEl) }
      answerText = answerText.replace(/^\s+/, '')
      answerEl.textContent = answerText.length > 1600 ? answerText.slice(0, 1600) + '…' : answerText
      answerEl.classList.toggle('long', answerEl.scrollHeight > 320)
      setStatus('Writing', 'busy')
      items.scrollTop = items.scrollHeight
      break
    }
    case 'tool_start': {
      answerEl = null; answerText = ''
      const [kind, icon, verb] = VERB[String(e.name)] ?? ['run', '•', String(e.name)]
      const path = typeof e.path === 'string' && e.path ? e.path : undefined
      const label = path ? `<code>${esc(path)}</code>` : e.command ? `<code>${esc(String(e.command))}</code>` : esc(String(e.detail ?? ''))
      const r = row(`${kind} pending`, icon, `${verb} ${label}`, '', path)
      pendingRows.set(String(e.id), r); push(r)
      setStatus(path ? `${verb} ${path.split('/').pop()}` : `${verb}${e.command ? ' ' + String(e.command).slice(0, 40) : ''}`, 'busy')
      const n = path ? byPath.get(path) : null
      flyTo(n ?? null, () => {
        if (!n) { add({ kind: 'ripple', x: comet.x, y: comet.y, t0: performance.now(), dur: 900, r: 4, color: 'rgba(124,156,240,0.9)' }); return }
        if (kind === 'read') { n.read = performance.now(); n.visited = true; add({ kind: 'ripple', x: n.x, y: n.y, t0: performance.now(), dur: 800, r: n.r }); signal(n, 'out', 'rgba(255,255,255,ALPHA)') }
        else add({ kind: 'ripple', x: n.x, y: n.y, t0: performance.now(), dur: 700, r: n.r, color: 'rgba(232,137,43,0.8)' })
      })
      break
    }
    case 'tool_end': {
      const r = pendingRows.get(String(e.id)); pendingRows.delete(String(e.id))
      const secs = typeof e.ms === 'number' ? (e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)}s` : `${e.ms}ms`) : ''
      if (r) {
        r.classList.remove('pending')
        if (e.error) { r.classList.add('fail'); (r.querySelector('.meta') as HTMLElement).textContent = `failed ${secs}` }
        else if (e.diff) (r.querySelector('.meta') as HTMLElement).innerHTML = `<span class="add">+${e.diff.added}</span> <span class="del">−${e.diff.removed}</span>`
        else { if (e.name === 'Bash') r.classList.add('ok'); (r.querySelector('.meta') as HTMLElement).textContent = e.name === 'Bash' ? `✓ ${secs}` : secs }
      }
      const now = performance.now()
      if (e.diff && typeof e.diff.path === 'string') {
        let n = byPath.get(e.diff.path)
        if (!n && graph) { scheduleRefresh(); break }
        if (n) {
          n.edit = now; n.changed = true; n.added += e.diff.added; n.removed += e.diff.removed; n.visited = true
          add({ kind: 'shock', x: n.x, y: n.y, t0: now, dur: 1100, r: n.r })
          add({ kind: 'float', x: n.x, y: n.y, t0: now, dur: 1800, text: `+${e.diff.added} −${e.diff.removed}` })
          signal(n, 'in', 'rgba(232,137,43,ALPHA)') // everything that imports this file may feel the change
          changedCount = nodes.filter(m => m.changed).length; $('s-changed').textContent = String(changedCount)
        }
      }
      for (const p of (e.matches as string[] | undefined) ?? []) { const n = byPath.get(p); if (n) { n.spark = now + Math.random() * 500; n.visited = true } }
      if (e.name === 'Bash' && e.mayChangeFiles) scheduleRefresh()
      break
    }
    case 'ask': {
      push(el('ask', `Waiting for you in the terminal${e.reason ? `: ${esc(String(e.reason))}` : ''}<code>${esc(String(e.command ?? ''))}</code>`))
      setStatus('Needs your OK in the terminal', 'ask')
      break
    }
    case 'voice':
      push(row('voice', '♪', `“${esc(String(e.line))}”`))
      break
    case 'error':
      push(row('fail', '!', `<span class="error">${esc(String(e.message))}</span>`))
      break
    case 'checkpoint':
      refreshTimeline()
      break
    case 'turn_end': {
      busy = false; answerEl = null
      const files = (e.files as { path: string; added: number; removed: number }[] | undefined) ?? []
      const d = document.createElement('dl'); d.className = 'receipt'
      d.innerHTML = `<dt>files</dt><dd>${files.length ? files.map(f => `${esc(f.path.split('/').pop()!)} <span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`).slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '') : 'none changed'}</dd>` +
        `<dt>time</dt><dd>${fmtMs(Number(e.ms ?? 0))}${e.cost ? ` · $${Number(e.cost).toFixed(4)}` : ''}</dd>`
      push(d)
      setStatus(e.stopped ? 'Stopped' : 'Ready')
      refreshTimeline(); scheduleRefresh()
      break
    }
  }
  dirty = true
}
const fmtMs = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`)

// ── Timeline ─────────────────────────────────────────────────────
let steps: { n: number; label: string; at: number }[] = []
let stepAt: number | null = null
async function refreshTimeline() {
  try {
    const s = await api('/api/state')
    const known = steps.length
    steps = s.timeline
    const ticks = $('ticks')
    for (let i = known; i < steps.length; i++) {
      const b = document.createElement('button')
      b.className = `tick new${/^Bash/.test(steps[i]!.label) ? ' bash' : ''}`
      b.title = `${i + 1}. ${steps[i]!.label}`
      b.addEventListener('click', () => selectStep(i))
      ticks.appendChild(b)
    }
    ticks.scrollLeft = ticks.scrollWidth
    $('tl-label').textContent = steps.length ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : 'No steps yet'
    $('s-steps').textContent = String(steps.length)
    for (const c of s.changed as { path: string; added: number; removed: number }[]) {
      const n = byPath.get(c.path); if (n && !n.changed) { n.changed = true; n.added = c.added; n.removed = c.removed }
    }
    changedCount = nodes.filter(m => m.changed).length; $('s-changed').textContent = String(changedCount)
    dirty = true
  } catch { /* server gone; the event stream shows that */ }
}
async function selectStep(i: number) {
  if (i < 0 || i >= steps.length) return
  stepAt = i
  document.querySelectorAll('.tick').forEach((t, k) => t.classList.toggle('on', k === i))
  $('live').classList.remove('on')
  const diffs: Diff[] = await api(`/api/step?i=${i}`)
  focus = diffs.length ? new Set(diffs.map(d => d.path)) : null
  const hit = diffs.map(d => byPath.get(d.path)).filter(Boolean) as FNode[]
  if (hit.length) { fit(true, hit); userMovedAt = Date.now() }
  const now = performance.now()
  hit.forEach((n, k) => setTimeout(() => add({ kind: 'shock', x: n.x, y: n.y, t0: performance.now(), dur: 1000, r: n.r }), k * 90))
  void now
  showDiffs(`Step ${i + 1}`, steps[i]!.label, diffs)
}
function stepBy(d: number) { if (!steps.length) return; selectStep(stepAt === null ? (d < 0 ? steps.length - 1 : 0) : Math.max(0, Math.min(steps.length - 1, stepAt + d))) }
function goLive() {
  stepAt = null; focus = null
  document.querySelectorAll('.tick').forEach(t => t.classList.remove('on'))
  $('live').classList.add('on'); userMovedAt = 0; fit(); dirty = true
}
$('live').addEventListener('click', () => { closeDrawer(); goLive() })

// ── Drawer: a file, or the changes of a step ─────────────────────
const drawer = $('drawer')
function openDrawer(title: string, sub: string) { $('d-title').textContent = title; $('d-sub').textContent = sub; drawer.classList.add('open') }
function closeDrawer() { drawer.classList.remove('open') }
$('d-close').addEventListener('click', () => { closeDrawer(); if (stepAt !== null) goLive() })

function diffHtml(d: Diff) {
  const out: string[] = [`<div class="ftitle">${esc(d.path)}<span class="meta">${d.created ? 'new file · ' : ''}<span class="add">+${d.added}</span> <span class="del">−${d.removed}</span></span></div>`]
  d.hunks.forEach((h, k) => {
    if (k > 0) out.push('<div class="gap">⋯</div>')
    h.lines.forEach((l, j) => {
      const cls = l.kind === 'add' ? 'a' : l.kind === 'del' ? 'd' : ''
      const no = l.kind === 'del' ? l.oldNo : l.newNo
      out.push(`<div class="ln ${cls}" style="animation-delay:${Math.min(j * 12, 600)}ms"><span class="n">${no ?? ''}</span><span class="c">${l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '} ${esc(l.text)}</span></div>`)
    })
  })
  return out.join('')
}
function showDiffs(title: string, sub: string, diffs: Diff[]) {
  openDrawer(title, sub)
  $('dbody').innerHTML = diffs.length ? diffs.map(diffHtml).join('') : '<div class="hidden-note">No file changes in this step.</div>'
  $('dbody').scrollTop = 0
}
async function openFile(path: string) {
  openDrawer(path, '')
  $('dbody').innerHTML = '<div class="hidden-note">Loading…</div>'
  const f = await api(`/api/file?path=${encodeURIComponent(path)}`)
  if (f.hidden) { $('dbody').innerHTML = '<div class="hidden-note">This file can hold secrets, so it isn\'t shown here.</div>'; return }
  if (f.diff) { $('d-sub').textContent = 'changed this session'; $('dbody').innerHTML = diffHtml(f.diff) }
  else if (f.content !== null) {
    const lines = String(f.content).split('\n').slice(0, 3000)
    $('d-sub').textContent = `${lines.length.toLocaleString()} lines`
    $('dbody').innerHTML = lines.map((l, i) => `<div class="ln"><span class="n">${i + 1}</span><span class="c">${esc(l)}</span></div>`).join('')
  } else $('dbody').innerHTML = '<div class="hidden-note">This file is too large to show, or it no longer exists.</div>'
  $('dbody').scrollTop = 0
}

// ── Graph loading and refresh ────────────────────────────────────
let refreshTimer = 0
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = window.setTimeout(() => loadGraph(true), 1200) }
async function loadGraph(fresh = false) {
  const g: Graph = await api(`/api/graph${fresh ? '?fresh=1' : ''}`)
  const first = !graph
  graph = g
  $('project').textContent = g.name
  document.title = `${g.name} · Darce brain`
  layout(g)
  if (first) { fit(false); comet.x = comet.sx = comet.tx = folders[0]?.x ?? WORLD / 2; comet.y = comet.sy = comet.ty = folders[0]?.y ?? WORLD / 2; comet.visible = true; intro(true) }
  await refreshTimeline()
}
function intro(show: boolean) {
  const i = $('intro')
  if (!show) { i.classList.add('gone'); return }
  if (busy || items.querySelector('.prompt')) { i.classList.add('gone'); return }
  $('intro-title').textContent = `${graph?.name ?? 'Your project'} · ${nodes.length.toLocaleString()} files${graph?.truncated ? '+' : ''}`
  $('intro-sub').textContent = 'Ask Darce something in your terminal and watch it move through your code.'
  setTimeout(() => i.classList.add('gone'), 6000)
}

// ── Live connection ──────────────────────────────────────────────
function connect() {
  const es = new EventSource(`/api/events?t=${TOKEN}`)
  es.onmessage = m => { try { onEvent(JSON.parse(m.data)) } catch { /* ignore one bad event */ } }
  es.onerror = () => { setStatus('Darce is not running', ''); busy = false }
  es.onopen = () => { if ($('status').textContent === 'Darce is not running') setStatus('Ready') }
}

resize()
requestAnimationFrame(frame)
loadGraph().then(connect).catch(() => { $('intro-title').textContent = 'This link has expired'; $('intro-sub').textContent = 'Run /brain in Darce to open a fresh one.' })
