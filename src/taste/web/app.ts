/// <reference lib="dom" />

/* Darce taste studio. Your page as it renders, with pins on what reads as templated; the
   page's own style sheet (colors, type, radii); and how the code is put together.
   You choose Fix or Keep; Darce does the fixing and the page re-renders for a before/after.
   Motion: one orchestrated reveal per render (a scan down the page that drops each pin as it
   passes), and small spring answers to everything you do. Reduced motion turns it all off. */

type View = 'desktop' | 'mobile'
type Kind = 'page' | 'system' | 'code'
type Box = { x: number; y: number; w: number; h: number }
type Issue = {
  id: string; kind: Kind; rule: string; title: string; label: string; why: string; fix: string; detail?: string
  where?: { file: string; line: number; code: string }
  spots?: { file: string; line: number }[]
  pins: { view: View; box: Box }[]
  decision: 'fix' | 'keep'; kept?: boolean
}
type Sys = { colors: { hex: string; n: number; members: { hex: string; n: number }[] }[]; sizes: { value: number; n: number }[]; radii: { value: number; n: number }[]; fonts: { name: string; n: number }[] }
type StudioReport = {
  phase: 'starting' | 'capturing' | 'ready' | 'fixing' | 'checking' | 'error'
  message: string; version: number; target: string | null; cwd: string
  views: Partial<Record<View, { width: number; height: number }>>
  compare: boolean; fixed: string[]; previous: number | null; system: Sys | null; issues: Issue[]
}

const $ = (id: string) => document.getElementById(id)!
const TOKEN = new URLSearchParams(location.search).get('t') ?? ''
const q = (path: string) => `${path}${path.includes('?') ? '&' : '?'}t=${TOKEN}`
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const h = (tag: string, cls = '', html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e }
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
const SPRING = getComputedStyle(document.documentElement).getPropertyValue('--spring').trim() || 'cubic-bezier(.2,.8,.2,1)'
const EASE = 'cubic-bezier(.2,.8,.2,1)'
const anim = (el: Element, frames: Keyframe[], o: KeyframeAnimationOptions) => (calm ? null : el.animate(frames, o))

const ICON = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  system: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="5.5" r="2.5"/><circle cx="10.5" cy="5.5" r="2.5"/><circle cx="8" cy="10.5" r="2.5"/></svg>',
  code: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4L2 8l4 4M10 4l4 4-4 4"/></svg>',
  arrows: '<svg viewBox="0 0 16 16" fill="none" stroke="#1a0f04" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4L2 8l4 4M10 4l4 4-4 4"/></svg>',
}

let report: StudioReport | null = null
let version = -1
let view: View = 'desktop'
let tab: Kind = 'page'
let compare: 'split' | 'after' = 'split'
let selected: string | null = null
let split = 50
let fixStartedAt = 0
let introFor = -1 // the report version whose reveal has played
let shownCount = 0
let showAllCode = false
type Live = { ask: { command: string; reason: string } | null; activity: { at: number; kind: string; text: string }[]; saying: string }
let live: Live = { ask: null, activity: [], saying: '' }
let lastShown = ''
const choice = new Map<string, 'fix' | 'keep'>()

const decision = (i: Issue) => choice.get(i.id) ?? i.decision
const of = (k: Kind) => (report?.issues ?? []).filter(i => i.kind === k)
const pinned = () => (report?.issues ?? []).filter(i => i.pins.length && i.kind === 'page')
const number = (id: string) => pinned().findIndex(i => i.id === id) + 1
const busy = () => !report || report.phase !== 'ready'

// ------------------------------------------------------------------ data

async function poll() {
  try {
    const s = await fetch(q('/api/state')).then(r => r.json()) as { phase: StudioReport['phase']; version: number; elapsed: number } & Live
    if (s.phase === 'fixing' && !fixStartedAt) fixStartedAt = Date.now() - s.elapsed
    const liveChanged = JSON.stringify([s.ask, s.activity.length, s.saying]) !== JSON.stringify([live.ask, live.activity.length, live.saying])
    live = { ask: s.ask, activity: s.activity ?? [], saying: s.saying ?? '' }
    if (s.phase === 'fixing' && report?.phase === 'fixing') { if (liveChanged) renderLive(); tickTimer() }
    else if (s.version !== version) await load()
  } catch { /* Darce restarting; keep trying */ }
  setTimeout(poll, report?.phase === 'fixing' ? 400 : 800)
}

async function load() {
  const r = await fetch(q('/api/report')).then(res => res.json()) as StudioReport
  const fresh = !report || r.issues.map(i => i.id).join() !== report.issues.map(i => i.id).join()
  if (fresh) { choice.clear(); selected = null }
  if (r.phase !== 'fixing') fixStartedAt = 0
  const wasPhase = report?.phase
  report = r
  version = r.version
  if (!r.views[view]) view = r.views.desktop ? 'desktop' : 'mobile'
  // Land on a tab that has something, the first time there's a result
  // (after a fix, stay on the page: the before/after is the point)
  if (fresh && r.phase === 'ready' && r.previous == null && !of(tab).length) tab = of('page').length ? 'page' : of('system').length ? 'system' : of('code').length ? 'code' : 'page'
  void wasPhase
  render(false)
}

// ------------------------------------------------------------------ header

function placeThumb(seg: HTMLElement, attr: string, value: string) {
  let thumb = seg.querySelector<HTMLElement>('.thumb')
  if (!thumb) { thumb = h('span', 'thumb'); seg.prepend(thumb) }
  const btn = seg.querySelector<HTMLElement>(`button[${attr}="${value}"]`)
  for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn))
  const t = thumb
  requestAnimationFrame(() => { if (btn) { t.style.left = `${btn.offsetLeft}px`; t.style.width = `${btn.offsetWidth}px` } })
}

function renderHeader() {
  const r = report
  $('target').textContent = r?.target ?? (r?.phase === 'ready' ? 'code only' : '')
  const views = $('views')
  views.hidden = !r || Object.keys(r.views).length < 2 || tab !== 'page'
  if (!views.hidden) placeThumb(views, 'data-v', view)
  const cmp = $('compare')
  cmp.hidden = !r?.compare || r.phase !== 'ready' || tab !== 'page'
  if (!cmp.hidden) placeThumb(cmp, 'data-c', compare)
  ;($('recheck') as HTMLButtonElement).disabled = !r || ['starting', 'capturing', 'checking', 'fixing'].includes(r.phase)
}

// ------------------------------------------------------------------ tabs

function renderTabs() {
  const tabs = $('tabs')
  const r = report
  if (!r || r.phase === 'error' || ((r.phase === 'starting' || r.phase === 'capturing' || r.phase === 'checking') && r.previous == null)) { tabs.style.display = 'none'; tabs.innerHTML = ''; return }
  tabs.style.display = ''
  const items: [Kind, string][] = [['page', 'On the page'], ['system', 'System'], ['code', 'Code']]
  let ink = tabs.querySelector<HTMLElement>('.ink')
  if (!tabs.querySelector('button')) {
    for (const [k, label] of items) {
      const b = h('button', '', `${label}<span class="n"></span>`)
      b.setAttribute('role', 'tab'); b.dataset.k = k
      b.addEventListener('click', () => { if (tab !== k) { tab = k; selected = null; render(true) } })
      tabs.append(b)
    }
    ink = h('span', 'ink'); tabs.append(ink)
  }
  for (const b of tabs.querySelectorAll<HTMLElement>('button')) {
    const k = b.dataset.k as Kind
    b.setAttribute('aria-selected', String(tab === k))
    b.querySelector('.n')!.textContent = String(of(k).filter(i => !i.kept).length)
  }
  const sel = ink!
  requestAnimationFrame(() => { const b = tabs.querySelector<HTMLElement>(`[data-k="${tab}"]`); if (b) { sel.style.left = `${b.offsetLeft + 8}px`; sel.style.width = `${b.offsetWidth - 16}px` } })
}

// ------------------------------------------------------------------ stage

const STEPS: [string, string][] = [['Looking for your page', 'Finding your page'], ['Opening', 'Opening it in Chrome'], ['Rendering at desktop width', 'Rendering at desktop width'], ['Rendering at phone width', 'Rendering at phone width'], ['Matching', 'Reading the code behind it']]

function loadingStage(stage: HTMLElement) {
  const r = report
  const at = Math.max(0, STEPS.findIndex(([k]) => (r?.message ?? '').startsWith(k)))
  const frame = h('div', 'frame', '<div class="bar"><span></span><span></span><span></span></div>')
  const ghosts: Partial<CSSStyleDeclaration>[] = [
    { top: '70px', height: '22px', width: '28%' },
    { top: '110px', height: '48px', width: '62%' },
    { top: '178px', height: '12px', width: '44%' },
    { top: '226px', height: '130px', width: 'calc(50% - 50px)' },
    { top: '226px', height: '130px', width: 'calc(50% - 50px)', left: 'auto', right: '40px' },
    { top: '376px', height: '110px', width: 'calc(100% - 80px)' },
  ]
  for (const g of ghosts) { const el = h('div', 'ghost'); Object.assign(el.style, { right: 'auto' }, g); frame.append(el) }
  frame.append(h('div', 'sweep'))
  stage.append(frame)
  const steps = h('div', 'steps')
  STEPS.forEach(([, label], i) => steps.append(h('div', `step ${i < at ? 'done' : i === at ? 'on' : ''}`, `<span class="d">${ICON.check}</span>${label}`)))
  stage.append(steps)
}

function renderStage(reveal: boolean) {
  const stage = $('stage')
  const r = report
  stage.innerHTML = ''
  const loading = !r || r.phase === 'starting' || r.phase === 'capturing' || r.phase === 'checking'
  if (loading) return loadingStage(stage)
  if (r!.phase === 'error') { stage.append(h('div', 'empty', `<div><h2>Couldn't check the page</h2><p>${esc(r!.message)}</p></div>`)); return }
  if (tab === 'system') return systemStage(stage, reveal)
  if (tab === 'code') return codeStage(stage, reveal)
  pageStage(stage, reveal)
}

function pageStage(stage: HTMLElement, reveal: boolean) {
  const r = report!
  const shot = r.views[view]
  if (!shot) {
    stage.append(h('div', 'empty', `<div><h2>No page to show</h2><p>Start your app (for example <code>npm run dev</code>) and press Check again. To check one page, run <code>/taste localhost:3000/pricing</code> in Darce.</p></div>`))
    return
  }
  const avail = stage.clientWidth - 64
  const width = view === 'mobile' ? Math.min(390, avail) : Math.min(shot.width, Math.max(320, avail))
  const scale = width / shot.width
  const canvas = h('div', `canvas ${view === 'mobile' ? 'phone' : ''}`)
  canvas.style.width = `${width}px`
  const after = h('img') as HTMLImageElement
  after.src = q(`/api/shot?view=${view}&v=${r.version}`)
  after.alt = `Your page at ${view === 'mobile' ? 'phone' : 'desktop'} width`
  canvas.append(after)
  stage.append(canvas)

  if (r.compare && r.phase === 'ready' && compare === 'split') {
    canvas.style.setProperty('--split', `${split}%`)
    const wrap = h('div', 'before')
    const img = h('img') as HTMLImageElement
    img.src = q(`/api/shot?view=${view}&when=before&v=${r.version}`)
    img.alt = 'Before the fix'
    wrap.append(img)
    const handle = h('div', 'handle', `<i>${ICON.arrows}</i>`)
    handle.setAttribute('role', 'slider'); handle.setAttribute('aria-label', 'Compare before and after'); handle.tabIndex = 0
    const set = (v: number) => { split = Math.max(0, Math.min(100, v)); canvas.style.setProperty('--split', `${split}%`); handle.setAttribute('aria-valuenow', String(Math.round(split))) }
    canvas.addEventListener('pointerdown', e => {
      const b = canvas.getBoundingClientRect()
      set(((e.clientX - b.left) / b.width) * 100)
      canvas.setPointerCapture(e.pointerId)
      const mv = (ev: PointerEvent) => set(((ev.clientX - b.left) / b.width) * 100)
      canvas.addEventListener('pointermove', mv)
      canvas.addEventListener('pointerup', () => canvas.removeEventListener('pointermove', mv), { once: true })
    })
    handle.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') set(split + (e.key === 'ArrowLeft' ? -5 : 5)) })
    canvas.append(wrap, h('div', 'tag l', 'Before'), h('div', 'tag r', 'After'), handle)
    // The payoff: sweep across once so the change is seen without touching anything
    if (reveal && !calm) {
      set(6)
      const go = () => {
        anim(canvas, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 600, easing: EASE })
        const t0 = performance.now() + 500
        const run = (t: number) => {
          const k = Math.max(0, Math.min(1, (t - t0) / 2000))
          const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
          set(k < 0.6 ? 6 + ease(k / 0.6) * 88 : 94 - ease((k - 0.6) / 0.4) * 44)
          if (k < 1) requestAnimationFrame(run)
        }
        requestAnimationFrame(run)
      }
      after.decode().then(go, go)
    }
    return
  }

  // Pins and outlines; overlapping pins step aside
  const placed: { x: number; y: number }[] = []
  const spot = (x: number, y: number) => {
    let px = Math.max(14, Math.min(width - 14, x)), py = Math.max(14, y)
    for (let g = 0; g < 12 && placed.some(p => Math.abs(p.x - px) < 26 && Math.abs(p.y - py) < 26); g++) px = Math.min(width - 14, px + 28)
    placed.push({ x: px, y: py })
    return { px, py }
  }
  const pins: { el: HTMLElement; y: number }[] = []
  for (const i of pinned()) {
    for (const p of i.pins.filter(p => p.view === view)) {
      const o = h('div', 'outline')
      o.dataset.id = i.id
      const w = p.box.w * scale + 8, ht = p.box.h * scale + 8
      Object.assign(o.style, { left: `${p.box.x * scale - 4}px`, top: `${p.box.y * scale - 4}px`, width: `${w}px`, height: `${ht}px` })
      o.innerHTML = `<svg><rect x="1" y="1" width="${Math.max(2, w - 2)}" height="${Math.max(2, ht - 2)}" rx="6" pathLength="100" stroke-dasharray="100" style="--len:100"/></svg>`
      canvas.append(o)
      const fixing = r.phase === 'fixing' && r.fixed.includes(i.id)
      const pin = h('button', `pin ${decision(i) === 'keep' ? 'keep' : ''} ${fixing ? 'work' : ''} ${r.phase === 'fixing' && !fixing ? 'dim' : ''}`, String(number(i.id)))
      pin.dataset.id = i.id
      pin.setAttribute('aria-label', `${number(i.id)}: ${i.title}`)
      const { px, py } = spot(p.box.x * scale, p.box.y * scale)
      Object.assign(pin.style, { left: `${px}px`, top: `${py}px` })
      pin.addEventListener('click', e => { e.stopPropagation(); select(i.id, 'pin') })
      pin.addEventListener('mouseenter', () => hover(i.id, true))
      pin.addEventListener('mouseleave', () => hover(i.id, false))
      canvas.append(pin)
      pins.push({ el: pin, y: py })
    }
  }
  applySelection()
  if (reveal) introReveal(canvas, after, pins)
}

/** The one big moment: the page settles in, a scan line runs down it, pins drop as it passes. */
function introReveal(canvas: HTMLElement, img: HTMLImageElement, pins: { el: HTMLElement; y: number }[]) {
  if (calm) return
  for (const p of pins) p.el.style.opacity = '0'
  canvas.style.opacity = '0'
  const go = () => {
    canvas.style.opacity = ''
    anim(canvas, [{ opacity: 0, transform: 'translateY(14px) scale(.985)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 700, easing: EASE })
    const visible = Math.min(canvas.offsetHeight, $('stage').clientHeight + 200)
    const D = Math.max(900, Math.min(1700, visible * 1.4))
    const line = h('div', 'scanline')
    canvas.append(line)
    anim(line, [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${visible + 120}px)`, opacity: 1, offset: 0.9 }, { transform: `translateY(${visible + 120}px)`, opacity: 0 }], { duration: D + 250, delay: 350, easing: 'cubic-bezier(.45,.05,.35,1)', fill: 'forwards' })?.finished.then(() => line.remove(), () => line.remove())
    for (const p of pins) {
      const at = 350 + Math.min(1, p.y / visible) * D * 0.92
      p.el.style.opacity = ''
      anim(p.el, [{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 650, delay: at, easing: SPRING, fill: 'backwards' })
      const o = canvas.querySelector<HTMLElement>(`.outline[data-id="${p.el.dataset.id}"]`)
      if (o) anim(o, [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }], { duration: 900, delay: Math.max(0, at - 80), easing: 'ease-out' })
    }
  }
  img.decode().then(go, go)
}

function systemStage(stage: HTMLElement, reveal: boolean) {
  const sys = report!.system
  if (!sys) { stage.append(h('div', 'empty', '<div><h2>No page to read the system from</h2><p>The system view reads colors, type and shapes from the rendered page. Start your app and press Check again.</p></div>')); return }
  const flags = new Map(of('system').map(i => [i.rule, i]))
  const sheet = h('div', 'sheet')
  const card = (title: string, n: string, sub: string, rule: string) => {
    const f = flags.get(rule)
    const c = h('div', `card ${f && decision(f) === 'fix' ? 'flag' : ''}`, `<h3>${title}<span class="n">${n}</span></h3><p>${sub}</p>`)
    if (f) c.querySelector('p')!.insertAdjacentHTML('afterend', `<div class="flagline">${esc(f.title)}: ${esc(f.label)}</div>`)
    sheet.append(c)
    return c
  }
  // Palette: each tile is one color; stripes inside a tile are near-identical versions of it
  const stock = new Set(((flags.get('stock-palette')?.label ?? '').match(/[a-z]+-\d+/g) ?? []))
  void stock
  const pal = card('Palette', `${sys.colors.length} colors`, 'Every color the page renders, most used first. Stripes inside a tile are near-identical versions of one color.', 'stock-palette')
  const sw = h('div', 'swatches')
  for (const g of sys.colors.slice(0, 40)) {
    sw.append(h('div', 'sw', `<div class="chip">${g.members.map(m => `<i style="background:${m.hex}"></i>`).join('')}</div><div class="meta"><b>${g.hex}</b>${g.members.length > 1 ? `${g.members.length} versions` : `used ${g.n}×`}</div>`))
  }
  pal.append(sw)
  // Type ladder, at real size
  const sizes = sys.sizes
  const maxN = Math.max(1, ...sizes.map(s => s.n))
  const crowd = new Set<number>()
  sizes.forEach((s, i) => { const nx = sizes[i + 1]; if (nx && nx.value - s.value <= (s.value < 20 ? 0.75 : s.value * 0.05)) { crowd.add(s.value); crowd.add(nx.value) } })
  const type = card('Type scale', `${sizes.length} sizes`, 'Each text size on the page, at its real size. Highlighted rows sit too close to tell apart.', 'type-scale')
  const ladder = h('div', 'ladder')
  for (const s of [...sizes].reverse()) ladder.append(h('div', `rung ${crowd.has(s.value) ? 'crowd' : ''}`, `<span class="px">${s.value}px</span><span class="sample" style="font-size:${Math.min(s.value, 64)}px">The quick brown fox</span><span class="bar"><i style="width:${Math.max(4, (s.n / maxN) * 100)}%"></i></span>`))
  type.append(ladder)
  const rc = card('Corner radii', `${sys.radii.length}`, 'Every corner radius on surfaces and edges.', 'radius-sprawl')
  const radii = h('div', 'radii')
  for (const r of sys.radii) radii.append(h('div', 'rad', `<i style="border-radius:${Math.min(r.value, 28)}px"></i>${r.value}px`))
  rc.append(radii)
  const fc = card('Typefaces', `${sys.fonts.length}`, 'The families text is set in.', 'font-sprawl')
  const fonts = h('div', 'fonts')
  for (const f of sys.fonts) fonts.append(h('div', 'font', `<span>${esc(f.name)}</span><span>${f.n} elements</span>`))
  fc.append(fonts)
  stage.append(sheet)

  if (reveal && !calm) {
    sheet.querySelectorAll('.card').forEach((c, i) => anim(c, [{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }], { duration: 700, delay: i * 90, easing: SPRING, fill: 'backwards' }))
    sheet.querySelectorAll('.sw').forEach((c, i) => anim(c, [{ opacity: 0, transform: 'scale(.82)' }, { opacity: 1, transform: 'none' }], { duration: 650, delay: 140 + i * 24, easing: SPRING, fill: 'backwards' }))
    sheet.querySelectorAll('.rung').forEach((c, i) => anim(c, [{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 550, delay: 260 + i * 40, easing: SPRING, fill: 'backwards' }))
    sheet.querySelectorAll('.rung .bar i').forEach((c, i) => anim(c, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 800, delay: 320 + i * 40, easing: EASE, fill: 'backwards' }))
    sheet.querySelectorAll('.rad i').forEach((c, i) => anim(c, [{ borderRadius: '0px', transform: 'scale(.7)' }, {}], { duration: 900, delay: 420 + i * 60, easing: SPRING, fill: 'backwards' }))
  }
}

function codeStage(stage: HTMLElement, reveal: boolean) {
  const list = of('code')
  if (!list.length) { stage.append(h('div', 'empty', '<div><h2>Nothing to flag in how it\'s built</h2><p>No pasted styles, hand-typed palettes or oversized components.</p></div>')); return }
  const pick = list.find(i => i.id === selected)
  const shown = pick ? [pick] : [...list.filter(i => i.spots).slice(0, 6), ...list.filter(i => !i.spots).slice(0, 3)]
  const wrap = h('div', 'codeview')
  for (const i of shown) {
    const c = h('div', 'card', `<h3>${esc(i.title)}</h3><p>${esc(i.label)}</p>`)
    if (i.rule === 'pasted-styles' && i.where?.code) c.append(h('div', 'tokens', i.where.code.split(' ').map(t => `<span>${esc(t)}</span>`).join('')))
    else if (i.rule === 'hardcoded-colors' && i.where?.code) c.append(h('div', 'tokens', i.where.code.split(' ').map(t => `<span><i style="display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px;vertical-align:-1px;background:${esc(t)}"></i>${esc(t)}</span>`).join('')))
    else if (i.where?.code) c.append(h('pre', '', esc(i.where.code)))
    if (i.detail) c.append(h('p', '', esc(i.detail)))
    const spots = i.spots ?? (i.where ? [i.where] : [])
    if (spots.length) {
      const s = h('div', 'spots')
      for (const p of spots.slice(0, pick ? 40 : 5)) s.append(h('div', '', `<b>${esc(p.file)}</b>:${p.line}`))
      if (!pick && spots.length > 5) s.append(h('div', '', `and ${spots.length - 5} more`))
      c.append(s)
    }
    c.style.cursor = 'pointer'
    c.addEventListener('click', () => select(i.id, 'stage'))
    wrap.append(c)
  }
  stage.append(wrap)
  if (reveal && !calm) wrap.querySelectorAll('.card').forEach((c, i) => anim(c, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 600, delay: i * 70, easing: SPRING, fill: 'backwards' }))
  if (reveal && !calm) wrap.querySelectorAll('.tokens span').forEach((c, i) => anim(c, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 400, delay: 200 + i * 18, easing: EASE, fill: 'backwards' }))
}

// ------------------------------------------------------------------ selection

function hover(id: string, on: boolean) {
  for (const o of document.querySelectorAll<HTMLElement>(`.outline[data-id="${id}"]`)) o.classList.toggle('on', on)
}

function applySelection() {
  for (const el of document.querySelectorAll<HTMLElement>('.issue')) { el.classList.toggle('sel', el.dataset.id === selected); el.setAttribute('aria-expanded', String(el.dataset.id === selected)) }
  for (const el of document.querySelectorAll<HTMLElement>('.pin')) el.classList.toggle('sel', el.dataset.id === selected)
  for (const el of document.querySelectorAll<HTMLElement>('.outline')) el.classList.toggle('sel', el.dataset.id === selected)
}

function select(id: string | null, from: 'row' | 'pin' | 'stage' = 'row') {
  selected = selected === id && from === 'row' ? null : id
  const issue = report?.issues.find(i => i.id === selected)
  if (tab === 'code') { renderStage(true); applySelection(); return }
  if (issue?.kind === 'page' && issue.pins.length && !issue.pins.some(p => p.view === view)) { view = issue.pins[0]!.view; renderHeader(); renderStage(false) }
  applySelection()
  if (!issue) return
  if (from !== 'row') document.querySelector(`.issue[data-id="${issue.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' })
  const pin = issue.pins.find(p => p.view === view)
  const stage = $('stage')
  const canvas = stage.querySelector<HTMLElement>('.canvas')
  if (pin && canvas && from === 'row') {
    const scale = canvas.clientWidth / report!.views[view]!.width
    stage.scrollTo({ top: Math.max(0, pin.box.y * scale + canvas.offsetTop - stage.clientHeight / 3) })
  }
}

// ------------------------------------------------------------------ panel

function countUp(el: HTMLElement, to: number, from: number) {
  shownCount = to
  if (calm || from === to) { el.textContent = String(to); return }
  el.textContent = String(from)
  const t0 = performance.now() + 300, D = 1200
  const run = (t: number) => { const k = Math.max(0, Math.min(1, (t - t0) / D)); const e = 1 - Math.pow(1 - k, 3); el.textContent = String(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(run) }
  requestAnimationFrame(run)
}

function renderVerdict(reveal: boolean) {
  const el = $('verdict')
  const r = report
  if (!r || ['starting', 'capturing', 'checking'].includes(r.phase)) {
    el.innerHTML = r?.previous != null ? '<h1>Checking the result</h1><p>Re-rendering the page to compare.</p>' : '<h1>Looking at your page</h1><p>Rendering it the way a visitor sees it, then reading the code behind it.</p>'
    return
  }
  if (r.phase === 'error') { el.innerHTML = '<h1>Something went wrong</h1>'; return }
  const open = r.issues.filter(i => !i.kept)
  if (r.phase === 'fixing') { el.innerHTML = `<h1>Darce is on it</h1><p>Working through ${plural(r.fixed.length, 'fix', 'fixes')}. If it needs your OK, it asks right here. The page re-renders when it's done.</p>`; return }
  if (r.previous != null) {
    const now = open.filter(i => i.kind === 'page').length
    el.innerHTML = `<h1>${now === 0 ? 'Nothing on the page reads as templated now' : `<span class="count">${now}</span> ${now === 1 ? 'thing' : 'things'} left on the page`}</h1><p>Drag across the page to compare.</p>
      <div class="delta"><span class="chip2">Before <span class="num-tab">${r.previous}</span></span><span class="arrow">→</span><span class="chip2 ${now < r.previous ? 'good' : ''}">${now < r.previous ? ICON.check : ''}Now <span class="num-tab" id="now-n">${now}</span></span></div>`
    if (reveal) {
      countUp($('now-n'), now, r.previous)
      const c = el.querySelector<HTMLElement>('.count'); if (c) countUp(c, now, r.previous)
      const good = el.querySelector('.chip2.good'); if (good) anim(good, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 700, delay: 1400, easing: SPRING, fill: 'backwards' })
    }
    return
  }
  const total = open.length
  if (!total) { el.innerHTML = `<h1>Nothing here reads as templated</h1><p>${Object.keys(r.views).length ? 'Checked the page at desktop and phone width, its style system, and the code.' : 'Checked the code. Start your app to check the page too.'}</p>`; return }
  el.innerHTML = `<h1><span class="count">${reveal ? 0 : total}</span> ${total === 1 ? 'thing reads' : 'things read'} as templated</h1><p>Choose what Darce fixes. Anything you keep stays as it is and won't come up again.</p>`
  const c = el.querySelector<HTMLElement>('.count')!
  if (reveal) countUp(c, total, 0); else shownCount = total
}

function issueRow(i: Issue): HTMLElement {
  const d = decision(i)
  const r = report!
  const row = h('div', `issue ${d === 'keep' ? 'keep' : ''} ${selected === i.id ? 'sel' : ''} ${r.phase === 'fixing' && r.fixed.includes(i.id) ? 'done' : ''}`)
  row.dataset.id = i.id
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  const loc = i.kind === 'system' ? 'the page as a whole' : i.spots && i.spots.length > 1 ? `${i.spots[0]!.file} and ${plural(i.spots.length - 1, 'other place')}` : i.where ? `${i.where.file}:${i.where.line}` : 'on the page'
  const badge = i.kind === 'page' && i.pins.length ? `<span class="num">${number(i.id)}</span>` : `<span class="num icon">${i.kind === 'system' ? ICON.system : ICON.code}</span>`
  row.innerHTML = `${badge}
    <div style="min-width:0"><div class="t">${esc(i.title)}</div><div class="l">${esc(i.label)}</div><div class="loc">${esc(loc)}</div></div>
    <div class="choice ${d === 'keep' ? 'keep' : ''}" role="group" aria-label="Fix or keep"><button class="fix" aria-pressed="${d === 'fix'}">Fix</button><button class="keep" aria-pressed="${d === 'keep'}">Keep</button></div>
    <div class="more"><div><p class="why">${esc(i.why)}</p>${i.detail ? `<p class="how">${esc(i.detail)}</p>` : ''}<p class="how">${esc(i.fix)}</p>${i.where?.code && i.kind === 'page' ? `<pre>${esc(i.where.code)}</pre>` : ''}</div></div>`
  for (const b of row.querySelectorAll<HTMLButtonElement>('.choice button')) {
    b.disabled = busy()
    b.addEventListener('click', e => {
      e.stopPropagation()
      const next = b.classList.contains('fix') ? 'fix' : 'keep'
      choice.set(i.id, next)
      row.querySelector('.choice')!.classList.toggle('keep', next === 'keep')
      row.classList.toggle('keep', next === 'keep')
      for (const x of row.querySelectorAll('.choice button')) x.setAttribute('aria-pressed', String(x.classList.contains(next)))
      for (const p of document.querySelectorAll<HTMLElement>(`.pin[data-id="${i.id}"]`)) { p.classList.toggle('keep', next === 'keep'); anim(p, [{ transform: 'scale(1.4)' }, { transform: 'scale(1)' }], { duration: 550, easing: SPRING }) }
      if (i.kind === 'system' && tab === 'system') renderStage(false)
      renderFoot()
    })
  }
  row.addEventListener('click', () => select(i.id))
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i.id) } })
  row.addEventListener('mouseenter', () => hover(i.id, true))
  row.addEventListener('mouseleave', () => hover(i.id, false))
  return row
}

function renderList(reveal: boolean) {
  const list = $('list')
  const keepScroll = list.scrollTop
  list.innerHTML = ''
  const r = report
  if (!r || ['starting', 'capturing', 'checking'].includes(r.phase)) { for (let k = 0; k < 4; k++) list.append(h('div', 'skel')); return }
  if (r.phase === 'error') { list.append(h('div', 'err', esc(r.message))); return }
  if (r.phase === 'fixing') { lastShown = ''; list.append(h('div', 'feed', '<div class="saying" id="saying"></div><div class="events" id="events"></div>')); renderLive(); return }
  const items = of(tab)
  const rows: HTMLElement[] = []
  const add = (i: Issue) => { const e = issueRow(i); rows.push(e); list.append(e) }
  if (tab === 'code') {
    const structural = items.filter(i => i.spots)
    const lines = items.filter(i => !i.spots)
    if (structural.length) { list.append(h('div', 'group-h', `How it's built <span class="n">${structural.length}</span>`)); structural.forEach(add) }
    if (lines.length) {
      const hdr = h('div', 'group-h', `${Object.keys(r.views).length ? 'In code that isn\'t on this page' : 'In the code'} <span class="n">${lines.length}</span>`)
      const all = lines.every(i => decision(i) === 'fix')
      const btn = h('button', '', all ? 'Keep all' : 'Fix all') as HTMLButtonElement
      btn.disabled = busy()
      btn.addEventListener('click', () => { for (const i of lines) choice.set(i.id, all ? 'keep' : 'fix'); renderList(false); renderFoot() })
      hdr.append(btn)
      list.append(hdr)
      ;(showAllCode ? lines : lines.slice(0, 40)).forEach(add)
      if (!showAllCode && lines.length > 40) { const more = h('button', 'group-h', `Show ${lines.length - 40} more`); more.style.cssText = 'width:100%;color:var(--accent-ink)'; more.addEventListener('click', () => { showAllCode = true; renderList(false) }); list.append(more) }
    }
    if (items.length) list.append(h('p', 'note', 'Code changes start on Keep: they touch more files, so choose them on purpose.'))
  } else items.forEach(add)
  if (!items.length) list.append(h('p', 'note', tab === 'page' ? 'Nothing on the rendered page.' : tab === 'system' ? 'The page\'s colors, type and shapes hold together.' : 'Nothing to flag in how it\'s built.'))
  list.scrollTop = reveal ? 0 : keepScroll
  if (reveal && !calm) rows.slice(0, 14).forEach((e, k) => anim(e, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay: 200 + k * 45, easing: SPRING, fill: 'backwards' }))
}

const KIND_ICON: Record<string, string> = {
  read: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
  run: '<path d="M3 4.5l3.5 3.5L3 11.5M8.5 12h4.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  done: '<path d="M3.5 8.5l3 3 6-7"/>',
  error: '<path d="M8 4.5v4M8 11.5h.01"/><circle cx="8" cy="8" r="6"/>',
}

/** While Darce works: what it's doing, what it last said, and anything it needs you to approve. */
function renderLive() {
  const events = document.getElementById('events')
  if (events) {
    // The server sends the latest few events; add the ones after the last one shown
    const keyOf = (a: Live['activity'][number]) => `${a.at}|${a.text}`
    const from = lastShown ? live.activity.findIndex(a => keyOf(a) === lastShown) + 1 : 0
    for (const a of live.activity.slice(from)) {
      events.querySelector('.ev.placeholder')?.remove()
      const row = h('div', `ev ${a.kind}`, `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${KIND_ICON[a.kind] ?? KIND_ICON.read}</svg><span>${esc(a.text)}</span>`)
      events.append(row)
      anim(row, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: SPRING })
      lastShown = keyOf(a)
    }
    events.querySelectorAll('.ev.now').forEach(e => e.classList.remove('now'))
    events.lastElementChild?.classList.add('now')
    const list = $('list'); list.scrollTop = list.scrollHeight
    if (!events.childElementCount) events.append(h('div', 'ev placeholder', '<span>Starting</span>'))
  }
  const saying = document.getElementById('saying')
  if (saying && saying.textContent !== live.saying) { saying.textContent = live.saying; saying.style.display = live.saying ? '' : 'none'; if (live.saying) anim(saying, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 }) }
  const ask = document.getElementById('ask')
  if (!ask) return
  const key = live.ask ? live.ask.command : ''
  if (ask.dataset.key === key) return
  ask.dataset.key = key
  ask.innerHTML = ''
  document.title = live.ask ? 'Approve: Darce · taste' : 'Darce · taste'
  if (!live.ask) return
  const card = h('div', 'askcard', `<div class="q">Darce wants to run this</div><code>${esc(live.ask.command)}</code><div class="r">${esc(live.ask.reason)}</div><div class="btns"><button class="deny">Deny</button><button class="allow">Allow</button></div>`)
  const answer = async (allow: boolean) => {
    card.querySelectorAll('button').forEach(b => (b.disabled = true))
    await fetch(q('/api/decide'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow }) })
    const out = anim(card, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], { duration: 220, easing: EASE, fill: 'forwards' })
    if (out) await out.finished
    ask.innerHTML = ''; ask.dataset.key = ''; live.ask = null; document.title = 'Darce · taste'
  }
  card.querySelector('.allow')!.addEventListener('click', () => answer(true))
  card.querySelector('.deny')!.addEventListener('click', () => answer(false))
  ask.append(card)
  anim(card, [{ opacity: 0, transform: 'translateY(12px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 600, easing: SPRING })
  ;(card.querySelector('.allow') as HTMLButtonElement).focus({ preventScroll: true })
}

function tickTimer() {
  const t = document.querySelector('.working .time')
  if (t && fixStartedAt) { const s = Math.floor((Date.now() - fixStartedAt) / 1000); t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
}

function renderFoot() {
  const foot = $('foot')
  const r = report
  if (!r || r.phase === 'error') { foot.innerHTML = ''; return }
  if (r.phase === 'fixing' || ((r.phase === 'capturing' || r.phase === 'checking') && r.previous != null)) {
    foot.innerHTML = `<div id="ask"></div><div class="working"><div class="bar"></div><span class="time"></span></div><p>${r.phase === 'fixing' ? `Fixing ${plural(r.fixed.length, 'thing')}. Everything Darce does shows up here.` : 'Re-rendering to compare.'}</p>`
    tickTimer()
    if (r.phase === 'fixing') renderLive()
    return
  }
  if (r.phase !== 'ready') { foot.innerHTML = ''; return }
  const n = r.issues.filter(i => decision(i) === 'fix').length
  const label = n ? `Fix ${plural(n, 'thing')} with Darce` : 'Choose something to fix'
  const prev = foot.querySelector<HTMLButtonElement>('.primary')
  if (prev && prev.disabled === !n) {
    if (prev.textContent !== label) { prev.textContent = label; anim(prev, [{ transform: 'scale(.97)' }, { transform: 'scale(1)' }], { duration: 450, easing: SPRING }) }
    return
  }
  foot.innerHTML = ''
  const b = h('button', `primary ${n ? 'shine' : ''}`, label) as HTMLButtonElement
  b.disabled = !n
  b.addEventListener('click', fix)
  foot.append(b, h('p', '', n ? 'Darce makes the changes in your terminal, then this window shows before and after.' : r.issues.length ? 'Everything is set to Keep.' : 'Make a change and press Check again.'))
}

async function fix() {
  if (!report) return
  const fixIds = report.issues.filter(i => decision(i) === 'fix').map(i => i.id)
  const keepIds = report.issues.filter(i => decision(i) === 'keep').map(i => i.id)
  const b = document.querySelector<HTMLButtonElement>('.primary')
  if (b) { b.disabled = true; b.textContent = 'Sending to Darce' }
  const res = await fetch(q('/api/fix'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fix: fixIds, keep: keepIds }) })
  if (!res.ok) {
    const msg = await res.text()
    $('foot').append(h('p', '', esc(msg)))
    if (b) { b.disabled = false; b.textContent = `Fix ${plural(fixIds.length, 'thing')} with Darce` }
    return
  }
  fixStartedAt = Date.now()
  compare = 'split'; split = 50; tab = 'page'
  await load()
}

function render(reveal: boolean) {
  const r = report
  // The big reveal plays once per new result
  const fresh = !!r && r.phase === 'ready' && r.version !== introFor
  if (fresh) introFor = r!.version
  renderHeader()
  renderTabs()
  renderStage(reveal || fresh)
  renderVerdict(fresh)
  renderList(reveal || fresh)
  renderFoot()
}

// ------------------------------------------------------------------ wiring

for (const b of $('views').querySelectorAll<HTMLButtonElement>('button')) b.addEventListener('click', () => { if (view !== b.dataset.v) { view = b.dataset.v as View; renderHeader(); renderStage(true) } })
for (const b of $('compare').querySelectorAll<HTMLButtonElement>('button')) b.addEventListener('click', () => { compare = b.dataset.c as 'split' | 'after'; renderHeader(); renderStage(false) })
$('recheck').addEventListener('click', async () => {
  ;($('recheck') as HTMLButtonElement).disabled = true
  await fetch(q('/api/recheck'), { method: 'POST' })
  await load()
})
document.addEventListener('keydown', e => { if (e.key === 'Escape' && selected) select(null) })
let resizeTimer = 0
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => { renderHeader(); renderTabs(); renderStage(false) }, 120) })

void load().then(poll, poll)
