/// <reference lib="dom" />
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'

/* Darce brain view. Three questions, answered plainly:
   what is this project (files, map), what is Darce doing now (header + activity),
   and how is the file it's working on connected (what it uses, what uses it). */

type Graph = { name: string; files: { p: string; n: number }[]; edges: [number, number][]; truncated: boolean }
type Diff = { path: string; created: boolean; added: number; removed: number; hunks: { lines: { kind: 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number }[] }[] }
type Ev = { type: string; at: number; [k: string]: any }
type Status = 'none' | 'read' | 'changed'
type F = { i: number; p: string; name: string; dir: string; n: number; imports: number[]; usedBy: number[]; status: Status; added: number; removed: number }
type Dir = { path: string; name: string; dirs: string[]; files: number[]; open: boolean }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const TOKEN = new URLSearchParams(location.search).get('t') ?? ''
const api = (path: string) => fetch(`${path}${path.includes('?') ? '&' : '?'}t=${TOKEN}`).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const h = (tag: string, cls = '', html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e }

// Small line icons, drawn rather than borrowed from unicode
const ICON: Record<string, string> = {
  read: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
  write: '<path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z"/><path d="M8 7.5v4M6 9.5h4"/>',
  run: '<path d="M3 4.5l3.5 3.5L3 11.5M8.5 12h4.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  web: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  thread: '<path d="M4 2.5v11M4 8h4.5a3 3 0 0 0 3-3V2.5"/>',
  plan: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
  voice: '<path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="M11.5 5.5a3.5 3.5 0 0 1 0 5"/>',
  alert: '<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.5h.01"/>',
  chev: '<path d="M6 4l4 4-4 4"/>',
  file: '<path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z"/><path d="M9 1.5v4h4"/>',
}
const icon = (k: string) => `<svg class="i" viewBox="0 0 16 16" aria-hidden="true">${ICON[k] ?? ICON.file}</svg>`

// What each tool means, in words
type Tool = { kind: string; icon: string; doing: string; did: string }
const TOOL: Record<string, Tool> = {
  Read: { kind: 'read', icon: 'read', doing: 'Reading', did: 'Read' },
  Edit: { kind: 'edit', icon: 'edit', doing: 'Editing', did: 'Edited' },
  Write: { kind: 'edit', icon: 'write', doing: 'Writing', did: 'Wrote' },
  Bash: { kind: 'run', icon: 'run', doing: 'Running', did: 'Ran' },
  Grep: { kind: 'read', icon: 'search', doing: 'Searching for', did: 'Searched for' },
  Glob: { kind: 'read', icon: 'search', doing: 'Looking for files', did: 'Looked for files' },
  WebFetch: { kind: 'run', icon: 'web', doing: 'Reading', did: 'Read' },
  WebSearch: { kind: 'run', icon: 'web', doing: 'Searching the web for', did: 'Searched the web for' },
  StealthFetch: { kind: 'run', icon: 'web', doing: 'Reading', did: 'Read' },
  Agent: { kind: 'run', icon: 'thread', doing: 'Starting a helper for', did: 'Helper:' },
  Image: { kind: 'edit', icon: 'write', doing: 'Making an image', did: 'Made an image' },
  TodoWrite: { kind: 'plan', icon: 'plan', doing: 'Planning', did: 'Updated the plan' },
  Plan: { kind: 'plan', icon: 'plan', doing: 'Planning', did: 'Updated the plan' },
}
const toolOf = (name: string): Tool => TOOL[name] ?? { kind: 'run', icon: 'run', doing: name, did: name }

// ── State ────────────────────────────────────────────────────────
let graph: Graph | null = null
let files: F[] = []
let byPath = new Map<string, F>()
let dirs = new Map<string, Dir>()
let view: 'focus' | 'map' = 'focus'
let focused: F | null = null
let nowPath: string | null = null
let follow = true
let pickedAt = 0
let query = ''

// ── Header ───────────────────────────────────────────────────────
function setNow(html: string, kind: '' | 'busy' | 'ask' = '') {
  $('now').className = `now ${kind}`; $('now-text').innerHTML = html
}
const followBtn = $('follow')
followBtn.addEventListener('click', () => {
  follow = !follow; followBtn.setAttribute('aria-pressed', String(follow))
  banner(follow ? 'Following Darce: the middle shows each file it works on' : 'Not following: the middle stays on the file you pick')
  if (follow && nowPath) focusFile(nowPath)
})
function setView(v: 'focus' | 'map') {
  view = v
  $('v-focus').setAttribute('aria-pressed', String(v === 'focus')); $('v-map').setAttribute('aria-pressed', String(v === 'map'))
  renderStage()
}
$('v-focus').addEventListener('click', () => setView('focus'))
$('v-map').addEventListener('click', () => setView('map'))
let bannerT = 0
function banner(text: string) { const b = $('banner'); b.textContent = text; b.classList.add('on'); clearTimeout(bannerT); bannerT = window.setTimeout(() => b.classList.remove('on'), 2200) }

// ── Model ────────────────────────────────────────────────────────
function load(g: Graph) {
  const old = byPath
  graph = g
  files = g.files.map((f, i) => {
    const prev = old.get(f.p)
    const slash = f.p.lastIndexOf('/')
    return { i, p: f.p, name: f.p.slice(slash + 1), dir: slash < 0 ? '' : f.p.slice(0, slash), n: f.n, imports: [], usedBy: [], status: prev?.status ?? 'none', added: prev?.added ?? 0, removed: prev?.removed ?? 0 }
  })
  for (const [a, b] of g.edges) { files[a]!.imports.push(b); files[b]!.usedBy.push(a) }
  byPath = new Map(files.map(f => [f.p, f]))
  const prevDirs = dirs
  dirs = new Map()
  const dirOf = (path: string): Dir => {
    let d = dirs.get(path)
    if (d) return d
    d = { path, name: path.slice(path.lastIndexOf('/') + 1) || g.name, dirs: [], files: [], open: prevDirs.get(path)?.open ?? path === '' }
    dirs.set(path, d)
    if (path !== '') dirOf(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '').dirs.push(path)
    return d
  }
  dirOf('')
  for (const f of files) dirOf(f.dir).files.push(f.i)
  for (const d of dirs.values()) { d.dirs.sort(); d.files.sort((a, b) => files[a]!.name.localeCompare(files[b]!.name)) }
  if (focused) focused = byPath.get(focused.p) ?? null
  $('project').textContent = g.name
  document.title = `${g.name} · Darce`
  $('file-count').textContent = `${files.length.toLocaleString()}${g.truncated ? '+' : ''}`
}

function mark(path: string, status: Status, diff?: { added: number; removed: number }): F | null {
  const f = byPath.get(path)
  if (!f) return null
  if (status === 'changed' || f.status === 'none') f.status = status
  if (diff) { f.added += diff.added; f.removed += diff.removed }
  reveal(f.p)
  renderTree()
  flashRow(f.p, status === 'changed' ? 'flash-edit' : 'flash-read')
  updateMapCell(f)
  return f
}
function reveal(path: string) {
  let d = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  for (;;) { const dir = dirs.get(d); if (dir) dir.open = true; if (d === '') break; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '' }
}

// ── Files tree ───────────────────────────────────────────────────
const treeEl = $('tree')
function renderTree() {
  if (!dirs.get('')) return
  const out: string[] = []
  const q = query.toLowerCase()
  if (q) {
    for (const f of files.filter(f => f.p.toLowerCase().includes(q)).slice(0, 300)) out.push(fileRow(f, 0, true))
    if (!out.length) out.push('<div class="empty-note" style="margin:8px">No file matches.</div>')
  } else {
    const touched = touchedByDir()
    const walk = (d: Dir, depth: number) => {
      for (const sub of d.dirs) {
        const sd = dirs.get(sub)!
        const t = touched.get(sd.path)
        out.push(`<div class="row dir${sd.open ? ' open' : ''}" role="treeitem" aria-expanded="${sd.open}" data-dir="${esc(sd.path)}" style="padding-left:${8 + depth * 14}px"><span class="chev">${icon('chev')}</span><span class="nm">${esc(sd.name)}</span><span class="tail">${t?.changed ? '<i class="dot changed"></i>' : t?.read ? '<i class="dot read"></i>' : ''}</span></div>`)
        if (sd.open) walk(sd, depth + 1)
      }
      for (const i of d.files) out.push(fileRow(files[i]!, depth))
    }
    walk(dirs.get('')!, 0)
  }
  treeEl.innerHTML = out.join('')
}
function fileRow(f: F, depth: number, full = false) {
  const tail = f.status === 'changed' ? `<span class="add">+${f.added}</span><span class="del">−${f.removed}</span>` : f.status === 'read' ? '<i class="dot read"></i>' : ''
  return `<div class="row file ${f.status}${focused === f ? ' sel' : ''}" role="treeitem" data-file="${esc(f.p)}" style="padding-left:${26 + depth * 14}px" title="${esc(f.p)}"><span class="nm">${esc(full ? f.p : f.name)}</span><span class="tail">${tail}</span></div>`
}
function touchedByDir() {
  const m = new Map<string, { read: number; changed: number }>()
  for (const f of files) {
    if (f.status === 'none') continue
    let d = f.dir
    while (d) {
      const t = m.get(d) ?? { read: 0, changed: 0 }
      if (f.status === 'changed') t.changed++; else t.read++
      m.set(d, t)
      d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : ''
    }
  }
  return m
}
function flashRow(path: string, cls: string) {
  const r = treeEl.querySelector(`[data-file="${CSS.escape(path)}"]`) as HTMLElement | null
  if (!r) return
  r.classList.remove('flash-read', 'flash-edit'); void r.offsetWidth; r.classList.add(cls)
  r.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}
treeEl.addEventListener('click', e => {
  const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
  if (!row) return
  if (row.dataset.dir !== undefined) { const d = dirs.get(row.dataset.dir)!; d.open = !d.open; renderTree(); return }
  if (row.dataset.file) pick(row.dataset.file)
})
$<HTMLInputElement>('find').addEventListener('input', e => { query = (e.target as HTMLInputElement).value.trim(); renderTree() })
function pick(path: string) { pickedAt = Date.now(); if (view === 'map') { view = 'focus'; setView('focus') } focusFile(path) }

// ── Center: focus view ───────────────────────────────────────────
const stage = $('stage')
function focusFile(path: string) {
  const f = byPath.get(path)
  if (!f) return
  focused = f
  renderTree()
  if (view === 'focus') renderFocus()
  else updateMapNow()
}
function renderStage() { if (view === 'map') renderMap(); else renderFocus() }

function renderFocus(hit = false) {
  if (!graph) return
  if (!focused) { renderStarter(); return }
  const f = focused
  const uses = f.imports.map(i => files[i]!), usedBy = f.usedBy.map(i => files[i]!)
  const affected = f.status === 'changed'
  const mini = (g: F, side: 'uses' | 'usedby', k: number) =>
    `<button class="mini${side === 'usedby' && affected ? ' affected' : ''}" data-file="${esc(g.p)}" data-side="${side}" style="animation-delay:${k * 35}ms" title="${esc(g.p)}">${icon('file')}<span class="nm">${esc(g.name)}</span><span class="dir">${esc(g.dir || '/')}</span></button>`
  const list = (arr: F[], side: 'uses' | 'usedby') =>
    arr.length ? arr.slice(0, 10).map((g, k) => mini(g, side, k)).join('') + (arr.length > 10 ? `<div class="more">and ${arr.length - 10} more</div>` : '')
      : `<div class="empty-note">${side === 'uses' ? 'Doesn\'t import any other project file' : 'No other file imports it'}</div>`
  const n = usedBy.length
  const say = affected
    ? n ? `Darce changed this file. ${n === 1 ? 'The file on the right uses it, so it' : `The ${n} files on the right use it, so they`} may be affected.` : 'Darce changed this file. Nothing else in the project imports it.'
    : f.status === 'read' ? 'Darce read this file.' : nowPath === f.p ? 'Darce is looking at this file now.' : 'Darce hasn\'t touched this file yet.'
  stage.innerHTML = `<div class="focus" id="focus">
    <div class="bow" id="bow">
      <div class="col uses"><h3>Uses <small>${uses.length ? `· ${uses.length} file${uses.length === 1 ? '' : 's'} it imports` : ''}</small></h3>${list(uses, 'uses')}</div>
      <div class="card ${f.status}${hit ? ' hit' : ''}" id="card">
        <div class="path">${esc(f.dir ? f.dir + '/' : './')}</div>
        <div class="title">${esc(f.name)}</div>
        <div class="facts">
          <span class="pill">${f.n.toLocaleString()} lines</span>
          ${f.status === 'changed' ? `<span class="pill changed">Changed · +${f.added} −${f.removed}</span>` : f.status === 'read' ? '<span class="pill read">Read by Darce</span>' : ''}
        </div>
        <p class="say">${say}</p>
      </div>
      <div class="col usedby"><h3>Used by <small>${n ? `· ${n} file${n === 1 ? '' : 's'} import it` : ''}</small></h3>${list(usedBy, 'usedby')}</div>
      <svg class="links" id="links"></svg>
    </div>
    <div class="code" id="code"><div class="bar">Loading…</div></div>
  </div>`
  requestAnimationFrame(() => drawLinks(true))
  setTimeout(() => drawLinks(false), 450)
  void loadCode(f)
}

function drawLinks(animate: boolean) {
  const bow = document.getElementById('bow'), svg = document.getElementById('links'), card = document.getElementById('card')
  if (!bow || !svg || !card) return
  const W = bow.clientWidth, H = bow.clientHeight
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H))
  const cx0 = card.offsetLeft, cx1 = card.offsetLeft + card.offsetWidth, cy = card.offsetTop + card.offsetHeight / 2
  const paths: string[] = []
  bow.querySelectorAll<HTMLElement>('.mini').forEach(m => {
    const col = m.parentElement as HTMLElement
    const y = col.offsetTop + m.offsetTop + m.offsetHeight / 2
    const uses = m.dataset.side === 'uses'
    const x = uses ? col.offsetLeft + m.offsetLeft + m.offsetWidth : col.offsetLeft + m.offsetLeft
    const [a, b, ya, yb] = uses ? [x, cx0, y, cy] : [cx1, x, cy, y]
    const mid = (a + b) / 2
    paths.push(`<path class="${!uses && m.classList.contains('affected') ? 'hot' : ''}${animate ? ' draw' : ''}" d="M${a},${ya} C${mid},${ya} ${mid},${yb} ${b},${yb}"/>`)
  })
  svg.innerHTML = paths.join('')
  if (animate) svg.querySelectorAll('path').forEach((p, k) => { const len = (p as SVGPathElement).getTotalLength(); p.setAttribute('style', `--len:${len};animation-delay:${80 + k * 30}ms`) })
}
window.addEventListener('resize', () => { if (view === 'focus') drawLinks(false); else renderMap() })
stage.addEventListener('click', e => { const m = (e.target as HTMLElement).closest('[data-file]') as HTMLElement | null; if (m?.dataset.file) pick(m.dataset.file) })

const codeCache = new Map<string, any>()
async function loadCode(f: F) {
  const key = `${f.p}:${f.status}:${f.added}:${f.removed}`
  let data = codeCache.get(key)
  if (!data) { data = await api(`/api/file?path=${encodeURIComponent(f.p)}`).catch(() => null); if (data) codeCache.set(key, data) }
  const el = document.getElementById('code')
  if (!el || focused !== f) return
  if (!data) { el.innerHTML = '<div class="bar">Couldn\'t load this file.</div>'; return }
  if (data.hidden) { el.innerHTML = '<div class="bar">This file can hold secrets, so its contents aren\'t shown here.</div>'; return }
  if (data.diff) {
    const d: Diff = data.diff
    el.innerHTML = `<div class="bar"><b>What Darce changed</b><span class="add">+${d.added}</span><span class="del">−${d.removed}</span></div><div class="body">${diffLines(d)}</div>`
  } else if (data.content !== null) {
    const lines = String(data.content).split('\n')
    el.innerHTML = `<div class="bar"><b>Contents</b><span>${lines.length.toLocaleString()} lines</span></div><div class="body">${lines.slice(0, 600).map((l, i) => `<div class="ln"><span class="n">${i + 1}</span><span class="c">${esc(l)}</span></div>`).join('')}${lines.length > 600 ? `<div class="gap">… ${lines.length - 600} more lines</div>` : ''}</div>`
  } else el.innerHTML = '<div class="bar">This file is too large to show, or it was deleted.</div>'
}
function diffLines(d: Diff) {
  return d.hunks.map((hk, k) => (k ? '<div class="gap">⋯</div>' : '') + hk.lines.map(l => {
    const cls = l.kind === 'add' ? 'a' : l.kind === 'del' ? 'd' : ''
    return `<div class="ln ${cls}"><span class="n">${(l.kind === 'del' ? l.oldNo : l.newNo) ?? ''}</span><span class="c">${l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}${esc(l.text)}</span></div>`
  }).join('')).join('')
}

/** Before Darce opens anything: a way in, through the files the rest of the project depends on. */
function renderStarter() {
  const hubs = [...files].filter(f => f.usedBy.length > 0).sort((a, b) => b.usedBy.length - a.usedBy.length).slice(0, 8)
  stage.innerHTML = `<div class="empty-center"><div style="max-width:460px">
    <h3>Nothing open yet</h3>
    <p style="margin:0 0 18px">When Darce works on a file, it opens here: what the file uses on the left, what uses it on the right, and what changed below. You can also pick any file from the list.</p>
    ${hubs.length ? `<p style="margin:0 0 8px;color:var(--faint);font-size:12px">Most connected files in ${esc(graph?.name ?? 'this project')}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;text-align:left">${hubs.map((f, k) => `<button class="mini" data-file="${esc(f.p)}" style="animation-delay:${k * 40}ms">${icon('file')}<span class="nm">${esc(f.name)}</span><span class="dir">used by ${f.usedBy.length}</span></button>`).join('')}</div>` : ''}
  </div></div>`
}

// ── Center: map of the whole project ─────────────────────────────
type T = { name: string; path: string; children?: T[]; file?: number }
const cells = new Map<string, HTMLElement>()
function renderMap() {
  if (!graph) return
  stage.innerHTML = `<div class="caption"><h1>${esc(graph.name)}</h1><span>Each box is a file, sized by length and grouped by folder. Grey means Darce read it, orange means it changed it.</span></div><div class="treemap" id="tm" style="top:58px"></div>`
  const tm = $('tm')
  const W = tm.clientWidth, H = tm.clientHeight
  const root: T = { name: graph.name, path: '', children: [] }
  const folder = new Map<string, T>([['', root]])
  const get = (path: string): T => {
    let t = folder.get(path)
    if (t) return t
    t = { name: path.slice(path.lastIndexOf('/') + 1), path, children: [] }
    folder.set(path, t); get(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '').children!.push(t)
    return t
  }
  files.forEach(f => get(f.dir).children!.push({ name: f.name, path: f.p, file: f.i }))
  const hi = hierarchy(root).sum(d => (d.file !== undefined ? Math.pow(Math.max(files[d.file]!.n, 4), 0.7) : 0)).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const laid = treemap<T>().tile(treemapSquarify.ratio(1.3)).size([W, H]).paddingOuter(3).paddingTop(d => (d.depth > 0 && d.depth <= 2 && d.y1 - d.y0 > 44 ? 21 : 3)).paddingInner(2).round(true)(hi)
  const out: string[] = []
  for (const d of laid.descendants()) {
    const w = d.x1 - d.x0, ht = d.y1 - d.y0
    if (d.data.file !== undefined || d.depth === 0 || d.depth > 2 || w < 30 || ht < 30) continue
    out.push(`<div class="group" style="left:${d.x0}px;top:${d.y0}px;width:${w}px;height:${ht}px">${ht > 44 ? `<span class="gl">${esc(d.data.name)}</span>` : ''}</div>`)
  }
  for (const d of laid.leaves()) {
    const w = d.x1 - d.x0, ht = d.y1 - d.y0
    if (d.data.file === undefined || w < 2 || ht < 2) continue
    const f = files[d.data.file]!
    out.push(`<div class="cell ${f.status}${nowPath === f.p ? ' now' : ''}" data-file="${esc(f.p)}" style="left:${d.x0}px;top:${d.y0}px;width:${w}px;height:${ht}px">${w > 46 && ht > 18 ? `<span class="lb">${esc(f.name)}</span>` : ''}</div>`)
  }
  tm.innerHTML = out.join('')
  cells.clear()
  tm.querySelectorAll<HTMLElement>('.cell').forEach(c => cells.set(c.dataset.file!, c))
}
function updateMapCell(f: F) { const c = cells.get(f.p); if (c) { c.classList.remove('none', 'read', 'changed'); c.classList.add(f.status) } }
function updateMapNow() { cells.forEach((c, p) => c.classList.toggle('now', p === nowPath)) }

const tip = $('tip')
stage.addEventListener('mousemove', e => {
  const c = (e.target as HTMLElement).closest('.cell') as HTMLElement | null
  if (!c) { tip.classList.remove('on'); return }
  const f = byPath.get(c.dataset.file!)!
  tip.innerHTML = `${esc(f.p)}<div class="s">${f.n.toLocaleString()} lines · uses ${f.imports.length} · used by ${f.usedBy.length}${f.status === 'changed' ? ` · changed +${f.added} −${f.removed}` : f.status === 'read' ? ' · read by Darce' : ''}</div>`
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 330)}px`; tip.style.top = `${e.clientY + 16}px`; tip.classList.add('on')
})
stage.addEventListener('mouseleave', () => tip.classList.remove('on'))

// ── Activity ─────────────────────────────────────────────────────
const feed = $('feed')
let turnEl: HTMLElement | null = null
let stepsEl: HTMLElement | null = null
let replyEl: HTMLElement | null = null
let replyText = ''
let stepTotal = 0
const running = new Map<string, { li: HTMLElement; ev: Ev }>()
function append(el: HTMLElement, into: HTMLElement = feed) {
  $('feed-empty')?.remove()
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90
  into.appendChild(el)
  if (atBottom) feed.scrollTop = feed.scrollHeight
}
function ensureTurn() {
  if (turnEl) return
  turnEl = h('div', 'turn'); append(turnEl)
  newSteps()
}
function newSteps() { stepsEl = h('ol', 'steps'); stepsEl.style.counterReset = `s ${stepTotal}`; turnEl!.appendChild(stepsEl) }
function stepLabel(e: Ev, t: Tool, past: boolean) {
  const verb = past ? t.did : t.doing
  if (e.path) return `${verb} <code>${esc(String(e.path))}</code>`
  if (e.command) return `${verb} <code>${esc(String(e.command).slice(0, 160))}</code>`
  return `${verb}${e.detail ? ` <code>${esc(String(e.detail).slice(0, 100))}</code>` : ''}`
}

function onEvent(e: Ev) {
  switch (e.type) {
    case 'hello':
      $('model').textContent = String(e.model ?? '').split('/').pop() ?? ''
      setNow('<span>Ready. Ask Darce something in your terminal.</span>')
      break
    case 'prompt':
      turnEl = null; replyEl = null; replyText = ''
      ensureTurn()
      turnEl!.insertBefore(h('div', 'ask-you', `<span class="who">You asked</span>${esc(String(e.text))}`), stepsEl)
      if (e.model) $('model').textContent = String(e.model).split('/').pop() ?? ''
      setNow('<span>Thinking about your request</span>', 'busy')
      break
    case 'text':
      replyText += String(e.delta)
      if (!replyEl && !replyText.trim()) break
      ensureTurn()
      if (!replyEl) { replyEl = h('div', 'reply'); turnEl!.appendChild(replyEl) }
      replyText = replyText.replace(/^\s+/, '')
      replyEl.innerHTML = `<span class="who">Darce</span>${esc(replyText.length > 1400 ? replyText.slice(0, 1400) + '…' : replyText).replace(/(^|\n)\s*(?:\*\*)?WHY:?(?:\*\*)?:?\s*/g, '$1<span class="why">WHY</span>')}`
      replyEl.classList.toggle('long', replyEl.scrollHeight > 220)
      setNow('<span>Writing a reply</span>', 'busy')
      break
    case 'tool_start': {
      ensureTurn()
      if (replyEl) { replyEl = null; replyText = ''; newSteps() }
      const t = toolOf(String(e.name))
      const path = typeof e.path === 'string' && e.path ? e.path : null
      const li = h('li', `step running ${t.kind}${path ? ' link' : ''}`, `${icon(t.icon)}<span class="tx">${stepLabel(e, t, false)}</span><span class="meta"></span>`)
      if (path) li.dataset.file = path
      running.set(String(e.id), { li, ev: e }); append(li, stepsEl!)
      stepTotal++; $('step-count').textContent = `${stepTotal} step${stepTotal === 1 ? '' : 's'}`
      setNow(`<span>${t.doing} ${path ? `<b>${esc(path)}</b>` : e.command ? `<b>${esc(String(e.command).slice(0, 60))}</b>` : ''}</span>`, 'busy')
      if (path) {
        nowPath = path
        if (t.kind === 'read') mark(path, 'read')
        if (follow && Date.now() - pickedAt > 6000) focusFile(path)
        else updateMapNow()
      }
      break
    }
    case 'tool_end': {
      const r = running.get(String(e.id)); running.delete(String(e.id))
      const t = toolOf(String(e.name))
      const ms = Number(e.ms ?? 0), took = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
      if (r) {
        const { li, ev } = r
        li.classList.remove('running')
        ;(li.querySelector('.tx') as HTMLElement).innerHTML = stepLabel(ev, t, true)
        const meta = li.querySelector('.meta') as HTMLElement
        if (e.error) { li.classList.add('fail'); meta.textContent = 'failed' }
        else if (e.diff) meta.innerHTML = `<span class="add">+${e.diff.added}</span> <span class="del">−${e.diff.removed}</span>`
        else if (Array.isArray(e.matches)) meta.textContent = `${e.matches.length} file${e.matches.length === 1 ? '' : 's'}`
        else meta.textContent = took
      }
      if (e.diff && typeof e.diff.path === 'string' && !e.error) {
        const f = mark(e.diff.path, 'changed', e.diff)
        if (!f) scheduleRefresh()
        else if (view === 'focus' && (focused === f || (follow && Date.now() - pickedAt > 6000))) { focused = f; renderTree(); renderFocus(true) }
      }
      if (e.name === 'Bash' && e.mayChangeFiles) scheduleRefresh()
      break
    }
    case 'ask':
      ensureTurn()
      append(h('div', 'note wait', `${icon('alert')}<span>Waiting for your OK in the terminal: <code>${esc(String(e.command ?? '').slice(0, 200))}</code></span>`), turnEl!)
      setNow('<span>Waiting for your OK in the terminal</span>', 'ask')
      break
    case 'voice':
      ensureTurn()
      append(h('div', 'note voice', `${icon('voice')}<span>“${esc(String(e.line))}”</span>`), turnEl!)
      break
    case 'error':
      ensureTurn()
      append(h('div', 'note err', `${icon('alert')}<span>${esc(String(e.message))}</span>`), turnEl!)
      break
    case 'turn_end': {
      const changed = (e.files as unknown[] | undefined)?.length ?? 0
      const secs = Number(e.ms ?? 0) / 1000
      ensureTurn()
      append(h('div', 'done', `${e.stopped ? 'Stopped' : 'Done'} in ${secs >= 60 ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s` : `${secs.toFixed(1)}s`} · ${changed ? `${changed} file${changed === 1 ? '' : 's'} changed` : 'no files changed'}${e.cost ? ` · $${Number(e.cost).toFixed(4)}` : ''}`), turnEl!)
      setNow(`<span>${e.stopped ? 'Stopped' : `Done${changed ? ` · ${changed} file${changed === 1 ? '' : 's'} changed` : ''}`}. Ask Darce something else in your terminal.</span>`)
      turnEl = null; replyEl = null; nowPath = null; updateMapNow()
      scheduleRefresh()
      break
    }
  }
}
feed.addEventListener('click', e => { const s = (e.target as HTMLElement).closest('.step.link') as HTMLElement | null; if (s?.dataset.file) pick(s.dataset.file) })

// ── Loading and live updates ─────────────────────────────────────
let refreshT = 0
function scheduleRefresh() { clearTimeout(refreshT); refreshT = window.setTimeout(() => void loadGraph(true), 1200) }
async function loadGraph(fresh = false) {
  const g: Graph = await api(`/api/graph${fresh ? '?fresh=1' : ''}`)
  const first = !graph
  load(g)
  if (first) {
    const s = await api('/api/state').catch(() => null)
    for (const c of (s?.changed ?? []) as { path: string; added: number; removed: number }[]) { const f = byPath.get(c.path); if (f) { f.status = 'changed'; f.added = c.added; f.removed = c.removed; reveal(f.p) } }
  }
  renderTree()
  if (first || view === 'map') renderStage()
}
function connect() {
  const es = new EventSource(`/api/events?t=${TOKEN}`)
  es.onmessage = m => { try { onEvent(JSON.parse(m.data)) } catch { /* skip a bad event */ } }
  es.onerror = () => setNow('<span>Darce isn\'t running. Start it and run /brain again.</span>')
}

loadGraph().then(connect).catch(() => {
  setNow('<span>This link has expired. Run /brain in Darce for a fresh one.</span>')
  stage.innerHTML = '<div class="empty-center"><div><h3>This link has expired</h3>Run <code>/brain</code> in Darce to open a fresh one.</div></div>'
})
