import { EMOJI, FAKE, FILLER, gradientVerdict, parseColor, saturated, type Hsl, type TasteRule } from './check.js'

/**
 * The taste check on the rendered page: computed styles and visible text, each with its box on
 * the page, so the studio can pin exactly what looks generated. The page script only collects
 * candidates; the verdicts use the same color logic as the source rules.
 */

export type Box = { x: number; y: number; w: number; h: number }
export type PageHit = { rule: TasteRule; box: Box; label: string; text: string; classes: string }

type Candidate = { kind: 'gradient' | 'clip' | 'stripe' | 'blob' | 'emoji' | 'filler' | 'fake'; box: Box; data: string; text: string; classes: string }
/** Every value of a kind the page renders, how often, and where a few of them are. */
type Tally = Record<string, { n: number; boxes: Box[] }>
export type SystemSample = { text: Tally; surface: Tally; border: Tally; size: Tally; family: Tally; radius: Tally }
type Collected = { cands: Candidate[]; sys: SystemSample }

/** Runs inside the page. Must stay self-contained: it's sent as source text. */
function collect(cfg: { filler: [string, string][]; fake: [string, string][]; emoji: [string, string]; max: number }): Collected {
  const out: Candidate[] = []
  const sys: SystemSample = { text: {}, surface: {}, border: {}, size: {}, family: {}, radius: {} }
  const tally = (t: Tally, key: string, box: Box) => { const e = t[key] ?? (t[key] = { n: 0, boxes: [] }); e.n++; if (e.boxes.length < 4 && box.w * box.h > 16) e.boxes.push(box) }
  const clear = (c: string) => c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c)
  const filler = cfg.filler.map(([s, f]) => new RegExp(s, f))
  const fake = cfg.fake.map(([s, f]) => new RegExp(s, f))
  const emoji = new RegExp(cfg.emoji[0], cfg.emoji[1] + 'g')
  const sx = window.scrollX, sy = window.scrollY
  const boxOf = (r: DOMRect) => ({ x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) })
  const visible = (el: Element, r: DOMRect) => {
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05
  }
  const cls = (el: Element) => (typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? '').slice(0, 300)
  const ownText = (el: Element) => Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim()

  const all = Array.from(document.body.querySelectorAll('*')).slice(0, cfg.max)
  for (const el of all) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'path'].includes(el.tagName)) continue
    const r = el.getBoundingClientRect()
    if (!visible(el, r)) continue
    const s = getComputedStyle(el)
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
    const base = { box: boxOf(r), text, classes: cls(el) }
    const bg = s.backgroundImage
    const clipText = s.backgroundClip === 'text' || (s as any).webkitBackgroundClip === 'text'
    if (bg.includes('gradient(') && clipText) out.push({ kind: 'clip', data: bg, ...base })
    else if (bg.includes('gradient(') && r.width * r.height > 900) out.push({ kind: 'gradient', data: bg, ...base })
    const lw = parseFloat(s.borderLeftWidth)
    if (lw >= 2 && s.borderLeftStyle !== 'none' && parseFloat(s.borderTopWidth) < lw && parseFloat(s.borderRightWidth) < lw && r.height > 16)
      out.push({ kind: 'stripe', data: s.borderLeftColor, ...base })
    const blur = s.filter.match(/blur\(([\d.]+)px\)/)
    if (blur && +blur[1]! >= 40) out.push({ kind: 'blob', data: `${s.backgroundColor} ${bg}`, ...base })
    // The page's working system: text colors and sizes where there is text, surfaces and edges where they show
    const own = ownText(el)
    if (own) {
      tally(sys.text, s.color, base.box)
      tally(sys.size, `${Math.round(parseFloat(s.fontSize) * 2) / 2}`, base.box)
      tally(sys.family, (s.fontFamily.split(',')[0] ?? '').replace(/["']/g, '').trim(), base.box)
    }
    if (!clear(s.backgroundColor)) tally(sys.surface, s.backgroundColor, base.box)
    const bw = ['Top', 'Right', 'Bottom', 'Left'].filter(side => parseFloat((s as any)[`border${side}Width`]) > 0 && (s as any)[`border${side}Style`] !== 'none')
    if (bw.length && !clear(s.borderTopColor)) tally(sys.border, bw.includes('Top') ? s.borderTopColor : s.borderLeftColor, base.box)
    const rad = parseFloat(s.borderTopLeftRadius)
    if (rad > 0 && rad < Math.min(r.width, r.height) / 2 && (!clear(s.backgroundColor) || bw.length || el.tagName === 'IMG')) tally(sys.radius, `${Math.round(rad)}`, base.box)
  }

  // Text: emoji and copy, boxed to the words themselves
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n: Node | null
  let count = 0
  while ((n = walker.nextNode()) && count++ < cfg.max * 2) {
    const t = n.textContent ?? ''
    if (!t.trim()) continue
    const parent = n.parentElement
    if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE'].includes(parent.tagName)) continue
    const pr = parent.getBoundingClientRect()
    if (!visible(parent, pr)) continue
    const box = (start: number, end: number) => { const range = document.createRange(); range.setStart(n!, start); range.setEnd(n!, end); return boxOf(range.getBoundingClientRect()) }
    const line = t.replace(/\s+/g, ' ').trim().slice(0, 160)
    for (const m of t.matchAll(emoji)) out.push({ kind: 'emoji', data: m[0], box: box(m.index!, m.index! + m[0].length), text: line, classes: cls(parent) })
    const words = filler.map(re => t.match(re)).filter(Boolean) as RegExpMatchArray[]
    if (words.length) out.push({ kind: 'filler', data: words.map(m => m[0]).join('|'), box: box(words[0]!.index!, words[0]!.index! + words[0]![0].length), text: line, classes: cls(parent) })
    const proof = fake.map(re => t.match(re)).filter(Boolean) as RegExpMatchArray[]
    if (proof.length) out.push({ kind: 'fake', data: proof.map(m => m[0]).join('|'), box: box(proof[0]!.index!, proof[0]!.index! + proof[0]![0].length), text: line, classes: cls(parent) })
  }
  return { cands: out, sys }
}

export function detectorScript(max = 6000): string {
  const cfg = {
    filler: FILLER.map(r => [r.source, r.flags]),
    fake: FAKE.map(r => [r.source, r.flags]),
    emoji: [EMOJI.source, EMOJI.flags],
    max,
  }
  // Bundlers may wrap named functions in a __name() helper that doesn't exist in the page
  return `(() => { var __name = (f) => f; return (${collect.toString()})(${JSON.stringify(cfg)}) })()`
}

const colorsIn = (css: string): Hsl[] =>
  [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch|oklab)\([^)]*\)/g)]
    .filter(m => !/rgba?\([^)]*,\s*0\)$|\/\s*0\)$/.test(m[0])) // fully transparent stops
    .map(m => parseColor(m[0]))
    .filter((c): c is Hsl => !!c)

const contains = (outer: Box, inner: Box) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1

/** Candidates → findings. Nested matches of the same thing keep only the outermost. */
export function judge(cands: Candidate[]): PageHit[] {
  const hits: PageHit[] = []
  for (const c of cands) {
    const hit = (rule: TasteRule, label: string) => hits.push({ rule, box: c.box, label, text: c.text, classes: c.classes })
    switch (c.kind) {
      case 'gradient': { const v = gradientVerdict(colorsIn(c.data)); if (v) hit('ai-gradient', v); break }
      case 'clip': { if (colorsIn(c.data).some(saturated)) hit('gradient-text', 'gradient fill on text'); break }
      case 'stripe': { const col = parseColor(c.data); if (col && saturated(col)) hit('stripe-border', 'colored left stripe'); break }
      case 'blob': { if (colorsIn(c.data).some(saturated)) hit('glow-blob', 'blurred color blob'); break }
      case 'emoji': hit('emoji-icon', `emoji ${c.data}`); break
      case 'filler': hit('filler-copy', c.data.split('|').map(w => `"${w}"`).join(', ')); break
      case 'fake': hit('fake-proof', c.data.split('|').map(w => `"${w}"`).join(', ')); break
    }
  }
  // A gradient section often wraps another gradient element with the same background; keep the outer one
  return hits.filter((h, i) => !hits.some((o, j) => j !== i && o.rule === h.rule && o.rule !== 'emoji-icon' && o.rule !== 'filler-copy' && o.rule !== 'fake-proof' && contains(o.box, h.box) && (o.box.w * o.box.h > h.box.w * h.box.h || j < i)))
}

export type { Candidate, Collected }
