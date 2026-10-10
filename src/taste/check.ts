import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

/**
 * The taste check: fast, deterministic rules for the things that make a UI look generated.
 * It runs on every UI file Darce writes, and only reports lines that edit added, so it never
 * nags about code that was there before. Each rule is tuned to stay quiet on hand-designed
 * code; when a rule is wrong for a project, `darce-taste-ignore` on (or above) the line, or
 * `.darce/taste.json` with { "off": ["rule-id"] }, turns it off.
 */

export type TasteRule =
  | 'ai-gradient'
  | 'gradient-text'
  | 'emoji-icon'
  | 'stripe-border'
  | 'glow-blob'
  | 'filler-copy'
  | 'fake-proof'
  | 'accent-sprawl'
  | 'hover-lift'
  // Page system (from the rendered page)
  | 'stock-palette'
  | 'type-scale'
  | 'radius-sprawl'
  | 'font-sprawl'
  // Project code
  | 'pasted-styles'
  | 'big-component'
  | 'hardcoded-colors'

export type TasteFinding = { rule: TasteRule; line: number; text: string; fix: string }

export const TASTE_RULES: Record<TasteRule, string> = {
  'ai-gradient': 'Purple or rainbow gradients',
  'gradient-text': 'Gradient-filled headline text',
  'emoji-icon': 'Emoji standing in for icons',
  'stripe-border': 'Colored left-border stripes',
  'glow-blob': 'Blurred color blobs as decoration',
  'filler-copy': 'Filler words and hollow phrasing',
  'fake-proof': 'Placeholder names and unproven claims',
  'accent-sprawl': 'Too many accent colors in one file',
  'hover-lift': 'Every card scales or lifts on hover',
  'stock-palette': 'Stock framework colors',
  'type-scale': 'No type scale',
  'radius-sprawl': 'Corner radii all over the place',
  'font-sprawl': 'Too many typefaces',
  'pasted-styles': 'Styles pasted instead of reused',
  'big-component': 'Component doing too much',
  'hardcoded-colors': 'Colors hard-coded across files',
}

const MARKUP = new Set(['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.mdx'])
const STYLES = new Set(['.css', '.scss', '.sass', '.less', '.pcss'])

/** Files the check looks at. Plain .js/.ts count only when they render markup. */
export function isUiFile(path: string, content?: string): boolean {
  const ext = extname(path).toLowerCase()
  if (MARKUP.has(ext) || STYLES.has(ext)) return true
  if (['.js', '.mjs', '.ts'].includes(ext) && content) return /className=|class="|<\/?[a-z]+[\s>]/.test(content) && /className=|innerHTML|html`|jsx/.test(content)
  return false
}

// ---------------------------------------------------------------- color

const NEUTRAL = new Set(['slate', 'gray', 'grey', 'zinc', 'neutral', 'stone', 'black', 'white', 'transparent', 'current', 'inherit'])
const FAMILY_HUE: Record<string, number> = {
  red: 0, orange: 25, amber: 40, yellow: 50, lime: 85, green: 140, emerald: 155, teal: 175, cyan: 190, sky: 200,
  blue: 220, indigo: 240, violet: 260, purple: 275, fuchsia: 295, pink: 330, rose: 350,
}
const PURPLE = (h: number) => h >= 235 && h <= 305

export type Hsl = { h: number; s: number; l: number }

function rgbToHsl(r: number, g: number, b: number): Hsl {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s, l }
}

/** A CSS color literal → hue/saturation/lightness, or null for anything it can't read. */
export function parseColor(raw: string): Hsl | null {
  const c = raw.trim().toLowerCase()
  let m = c.match(/^#([0-9a-f]{3,8})$/)
  if (m) {
    let hex = m[1]!
    if (hex.length === 3 || hex.length === 4) hex = hex.slice(0, 3).split('').map(x => x + x).join('')
    if (hex.length !== 6 && hex.length !== 8) return null
    return rgbToHsl(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16))
  }
  m = c.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/)
  if (m) return rgbToHsl(+m[1]!, +m[2]!, +m[3]!)
  m = c.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/)
  if (m) return { h: +m[1]! % 360, s: +m[2]! / 100, l: +m[3]! / 100 }
  m = c.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/)
  if (m) {
    // oklch hue runs about 25-40° ahead of HSL in the blue-purple range; map the purples onto HSL's
    const chroma = +m[3]!, h = +m[4]!
    const l = m[2] ? +m[1]! / 100 : +m[1]!
    const hsl = h >= 270 && h <= 335 ? 235 + (h - 270) : h >= 250 && h < 270 ? 220 : h
    return { h: hsl, s: Math.min(1, chroma / 0.2), l }
  }
  const named: Record<string, string> = { purple: '#800080', violet: '#ee82ee', indigo: '#4b0082', magenta: '#ff00ff', fuchsia: '#ff00ff', blue: '#0000ff', pink: '#ffc0cb', cyan: '#00ffff', red: '#ff0000', orange: '#ffa500' }
  if (named[c]) return parseColor(named[c]!)
  return null
}

export const saturated = (c: Hsl) => c.s >= 0.35 && c.l >= 0.12 && c.l <= 0.92
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }

/** Judge a set of gradient stops: purple-family, or saturated stops far apart on the wheel. */
export function gradientVerdict(stops: Hsl[]): string | null {
  const strong = stops.filter(saturated)
  if (strong.some(c => PURPLE(c.h))) return 'purple gradient'
  for (let i = 0; i < strong.length; i++)
    for (let j = i + 1; j < strong.length; j++)
      if (hueGap(strong[i]!.h, strong[j]!.h) > 60) return 'multi-color gradient'
  return null
}

const familyColor = (family: string, shade: string): Hsl | null => {
  if (NEUTRAL.has(family) || !(family in FAMILY_HUE)) return null
  const n = +shade
  return { h: FAMILY_HUE[family]!, s: n >= 100 ? 0.8 : 0.5, l: n >= 950 ? 0.1 : n <= 50 ? 0.97 : 0.5 }
}

// ---------------------------------------------------------------- text helpers

/** Each string literal (or attribute value), with the line it starts on. Class lists live in these. */
function strings(content: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = []
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) out.push({ text: m[1] ?? m[2] ?? m[3] ?? '', line: lineAt(content, m.index) })
  return out
}

let lineStarts: number[] = []
let lineSource = ''
function lineAt(content: string, index: number): number {
  if (content !== lineSource) {
    lineSource = content
    lineStarts = [0]
    for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1)
  }
  let lo = 0, hi = lineStarts.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= index) lo = mid; else hi = mid - 1 }
  return lo + 1
}

const COMMENT = /^\s*(\/\/|\/\*|\*|\{\s*\/\*|<!--|#\s)/

/** Lines of visible text: markup lines that aren't comments, imports or class-only. */
function proseLines(lines: string[]): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = []
  let inBlock = false
  lines.forEach((raw, i) => {
    const t = raw.trim()
    if (inBlock) { if (t.includes('*/') || t.includes('-->')) inBlock = false; return }
    if (/^(\/\*|\{\s*\/\*|<!--)/.test(t) && !/(\*\/|-->)/.test(t)) { inBlock = true; return }
    if (COMMENT.test(raw) || /^\s*(import|export \* from|@import)\b/.test(raw)) return
    // Drop class attributes and URLs so tokens like "seamless-scroll" or slugs don't count as copy
    // Developer-only lines (logs, errors) aren't interface
    if (/\b(console|logger|log)\.(log|info|warn|error|debug|trace)\s*\(|\bthrow new \w*Error\(/.test(raw)) return
    // Drop class lists, placeholders (input hints may show sample names), file paths and URLs
    const text = raw
      .replace(/\b(class|className|placeholder|src|href|srcSet|data-[\w-]+)=("[^"]*"|'[^']*'|\{[^}]*\})/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\w./-]+\.(svg|png|jpe?g|webp|gif|avif|mp4|webm|ico)\b/gi, '')
    // On a line of code, only sentence-like strings and JSX text are copy; identifiers and selectors aren't
    const code = /[;=(){}]|=>|\?\./.test(text.replace(/>[^<]*</g, '><'))
    if (!code) { out.push({ text, line: i + 1 }); return }
    const parts = [
      ...[...text.matchAll(/"([^"]*)"|'([^']*)'|`([^`$]*)`/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '').filter(t => /\s/.test(t.trim()) || EMOJI.test(t)),
      ...[...text.matchAll(/>([^<>{}]+)</g)].map(m => m[1]!),
    ]
    if (parts.length) out.push({ text: parts.join(' '), line: i + 1 })
  })
  return out
}

// ---------------------------------------------------------------- rules

// Words and phrasings that could describe any product. Word list and patterns follow
// github.com/petergyang/no-ai-slop, trimmed to what shows up in interface copy.
export const FILLER = [
  /\bseamless(ly)?\b/i,
  // The verb only: "negotiation leverage" is plain English, "leverage AI to" is filler
  /\bleverag(es|ing)\b|\bleverage (?:the|your|our|their|its|a|an|ai|data|existing|modern|powerful|cutting|advanced|this|these|every)\b/i, /\bsupercharg(e|es|ed|ing)\b/i, /\brevolutioni[sz](e|es|ing)\b/i,
  /\bunleash(es|ing)?\b/i, /\bunlock (the|your) (full )?(power|potential)\b/i, /\belevate your\b/i, /\bgame[- ]chang(er|ing)\b/i,
  /\bcutting[- ]edge\b/i, /\bnext[- ]gen(eration)?\b/i, /\bempower(s|ing)?\b/i, /\beffortless(ly)?\b/i,
  /\bbest[- ]in[- ]class\b/i, /\bharness(es|ing)? the power\b/i, /\bin today's (fast[- ]paced|digital|ever[- ]changing)\b/i, /\btake (it|your \w+) to the next level\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i, /\bblazing(ly)?[- ]fast\b/i, /\b(transform|reimagine) (the way|how) you\b/i,
  /\bdelve\b/i, /\bfoster(s|ing)?\b/i, /\butiliz(e|es|ing)\b/i, /\bfacilitat(e|es|ing)\b/i, /\bstreamlin(e|es|ed|ing)\b/i,
  /\bparadigm shift\b/i, /\bthis changes everything\b/i, /\btapestry\b/i, /\bbeacon\b/i, /\bmultifaceted\b/i,
  /\bmeticulous(ly)?\b/i, /\bparamount\b/i, /\btransformative\b/i, /\bembark\b/i, /\bever[- ]evolving\b/i,
  // Patterns: binary contrasts, throat-clearing, puffery, weasel attribution, set-piece openers
  /\b(?:isn't|is not|aren't|not) just (?:a |an |another )?[\w -]{2,40}?[.,;:]? (?:it's|it is|they're|but)\b/i,
  /\bmore than just (?:a |an )?\w+/i,
  /^\s*(?:here's the thing|let me be clear|the truth is|the reality is|the uncomfortable truth)\b/i,
  /\b(?:stands as a testament|plays? a (?:vital|pivotal|crucial|key) role|marks a pivotal|underscores (?:the|its) (?:importance|significance))\b/i,
  /\b(?:experts agree|studies show|industry leaders|widely regarded as)\b/i,
  /\b(?:let's dive in|in the age of|in the world of|at its core|look no further)\b/i,
]
export const FAKE = [
  /\blorem ipsum\b/i, /\b(john|jane) (doe|smith)\b/i, /\bAcme(?: (?:Corp|Inc|Co)\.?)?(?![\w/-])/, /★★★★★|⭐{3,}/,
  /\btrusted by (over )?\d[\d,.]*\s*k?\+?/i, /\b\d[\d,.]*\s*k?\+\s+(happy |satisfied )?(users|customers|developers|teams|companies|businesses)\b/i,
  /\b(join|loved by) (over )?\d[\d,.]*\s*k?\+?\s+(users|customers|developers|teams|companies)\b/i, /\b99\.9+% uptime\b/i,
]

// Emoji that render as pictures by default, or text symbols forced into emoji with U+FE0F
export const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u

type Ctx = { lines: string[]; content: string; ext: string; findings: TasteFinding[] }

function add(ctx: Ctx, rule: TasteRule, line: number, text: string, fix: string) {
  if (!ctx.findings.some(f => f.rule === rule && f.line === line)) ctx.findings.push({ rule, line, text, fix })
}

function gradients(ctx: Ctx) {
  // Tailwind stops within one class list
  for (const s of strings(ctx.content)) {
    if (!/(^|[\s:])(from|via|to)-/.test(s.text)) continue
    const stops: Hsl[] = []
    for (const m of s.text.matchAll(/(?:^|[\s:])(?:from|via|to)-([a-z]+)-(\d{2,3})\b/g)) { const c = familyColor(m[1]!, m[2]!); if (c) stops.push(c) }
    for (const m of s.text.matchAll(/(?:^|[\s:])(?:from|via|to)-\[([^\]]+)\]/g)) { const c = parseColor(m[1]!); if (c) stops.push(c) }
    const hasGradient = /\bbg-(gradient-to|linear|radial|conic)-/.test(s.text) || stops.length >= 2
    const v = hasGradient ? gradientVerdict(stops) : null
    if (v) add(ctx, 'ai-gradient', s.line, `${v} (${[...s.text.matchAll(/(?:^|[\s:])((?:from|via|to)-(?:[a-z]+-\d{2,3}|\[[^\]]+\]))/g)].map(m => m[1]).join(' ')})`, 'Use a solid surface in the project\'s own colors. If a gradient earns its place, keep it within one hue.')
  }
  // CSS gradients, including inline styles
  for (const m of ctx.content.matchAll(/(?:linear|radial|conic)-gradient\(/g)) {
    let depth = 1, i = m.index! + m[0].length
    while (i < ctx.content.length && depth > 0) { if (ctx.content[i] === '(') depth++; else if (ctx.content[i] === ')') depth--; i++ }
    const body = ctx.content.slice(m.index! + m[0].length, i - 1)
    const stops = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch)\([^)]*\)|\b(?:purple|violet|indigo|magenta|fuchsia|blue|pink|cyan|red|orange)\b/g)].map(x => parseColor(x[0])).filter((c): c is Hsl => !!c)
    const v = gradientVerdict(stops)
    if (v) add(ctx, 'ai-gradient', lineAt(ctx.content, m.index!), `${v} (${body.replace(/\s+/g, ' ').slice(0, 70)})`, 'Use a solid surface in the project\'s own colors. If a gradient earns its place, keep it within one hue.')
  }
}

function gradientText(ctx: Ctx) {
  for (const s of strings(ctx.content))
    // Only colored fills: an ink-to-ink fade (from-foreground to-foreground/70) is a quiet, deliberate choice
    if (/\bbg-clip-text\b/.test(s.text) && /\btext-transparent\b/.test(s.text) && (/(?:^|[\s:])(?:from|via|to)-\[#|(?:^|[\s:])(?:from|via|to)-([a-z]+)-\d{2,3}/.test(s.text) ? [...s.text.matchAll(/(?:^|[\s:])(?:from|via|to)-([a-z]+)-(\d{2,3})/g)].some(m => familyColor(m[1]!, m[2]!)) || /(?:from|via|to)-\[#/.test(s.text) : false))
      add(ctx, 'gradient-text', s.line, 'gradient fill on text', 'Set headlines in solid ink. Let size, weight and spacing carry them.')
  ctx.lines.forEach((l, i) => {
    if (/background-clip:\s*text/.test(l) && /(-webkit-)?text-fill-color:\s*transparent|color:\s*transparent/.test(ctx.lines.slice(i, i + 4).join('\n') + ctx.lines.slice(Math.max(0, i - 3), i).join('\n')))
      add(ctx, 'gradient-text', i + 1, 'gradient fill on text', 'Set headlines in solid ink. Let size, weight and spacing carry them.')
  })
}

function emoji(ctx: Ctx) {
  if (!MARKUP.has(ctx.ext) && !['.js', '.mjs', '.ts'].includes(ctx.ext)) return
  for (const p of proseLines(ctx.lines)) {
    const m = p.text.match(EMOJI)
    if (m) add(ctx, 'emoji-icon', p.line, `emoji ${m[0]} in the interface`, 'Use an icon from the project\'s icon set, or no icon. Emoji read as placeholder decoration.')
  }
}

function stripes(ctx: Ctx) {
  for (const s of strings(ctx.content)) {
    const border = s.text.match(/(?:^|\s)border-l-(2|4|8|\[\d+px\])\b/)
    const color = s.text.match(/(?:^|[\s:])border-(?:l-)?([a-z]+)-(\d{2,3})\b/)
    if (border && color && familyColor(color[1]!, color[2]!)) add(ctx, 'stripe-border', s.line, `colored left stripe (${border[0].trim()} ${color[0].trim()})`, 'Mark state with a fill, weight or position change instead of a colored side stripe.')
  }
  ctx.lines.forEach((l, i) => {
    const m = l.match(/border-left:\s*(\d+)px\s+solid\s+([^;]+)/)
    const c = m && +m[1]! >= 2 ? parseColor(m[2]!.trim()) : null
    if (c && saturated(c)) add(ctx, 'stripe-border', i + 1, `colored left stripe (${m![0].trim()})`, 'Mark state with a fill, weight or position change instead of a colored side stripe.')
  })
}

function blobs(ctx: Ctx) {
  for (const s of strings(ctx.content)) {
    const blur = /(^|\s)blur-(2xl|3xl|\[(\d{2,})px\])/.exec(s.text)
    if (!blur || (blur[3] && +blur[3] < 40)) continue
    const round = /(^|\s)rounded-full\b/.test(s.text)
    const colored = [...s.text.matchAll(/(?:^|\s)(?:bg|from|via|to)-([a-z]+)-(\d{2,3})/g)].some(m => familyColor(m[1]!, m[2]!))
    if (round && colored) add(ctx, 'glow-blob', s.line, 'blurred color blob behind content', 'Remove it. Depth should come from layout and real content, not glows.')
  }
  ctx.lines.forEach((l, i) => {
    const m = l.match(/filter:\s*blur\((\d+)px\)/)
    if (m && +m[1]! >= 40) {
      const near = ctx.lines.slice(Math.max(0, i - 6), i + 7).join('\n')
      const colored = [...near.matchAll(/#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch)\([^)]*\)/g)].some(x => { const c = parseColor(x[0]); return c && saturated(c) })
      if (colored && /border-radius:\s*(50%|9999px|999px)/.test(near)) add(ctx, 'glow-blob', i + 1, 'blurred color blob behind content', 'Remove it. Depth should come from layout and real content, not glows.')
    }
  })
}

function copy(ctx: Ctx) {
  if (STYLES.has(ctx.ext)) return
  for (const p of proseLines(ctx.lines)) {
    const filler = FILLER.map(re => p.text.match(re)?.[0]).filter(Boolean)
    if (filler.length) add(ctx, 'filler-copy', p.line, filler.map(w => `"${w}"`).join(', '), 'Say the concrete thing the product does instead.')
    const fake = FAKE.map(re => p.text.match(re)?.[0]).filter(Boolean)
    if (fake.length) add(ctx, 'fake-proof', p.line, fake.map(w => `"${w}"`).join(', '), 'Use real names and real numbers, or leave it out. Never ship invented proof.')
  }
}

function nearestFamily(h: number): string {
  // Coarse buckets: shades a designer would call one color stay one family
  const buckets: [string, number][] = [['red', 0], ['orange', 28], ['yellow', 50], ['green', 120], ['teal', 172], ['blue', 210], ['purple', 270], ['pink', 325]]
  let best = 'red', gap = 999
  for (const [n, hue] of buckets) { const g = hueGap(h, hue); if (g < gap) { gap = g; best = n } }
  return best
}
const TW_BUCKET: Record<string, string> = { red: 'red', rose: 'red', orange: 'orange', amber: 'orange', yellow: 'yellow', lime: 'green', green: 'green', emerald: 'green', teal: 'teal', cyan: 'teal', sky: 'blue', blue: 'blue', indigo: 'blue', violet: 'purple', purple: 'purple', fuchsia: 'pink', pink: 'pink' }

const UTIL = /(?:^|[\s:"'`])(?:bg|text|border|ring|from|via|to|fill|stroke|outline|decoration|shadow|accent|caret|divide)-([a-z]+)-(\d{2,3})\b/g

function accents(ctx: Ctx) {
  const first = new Map<string, number>()
  for (const s of strings(ctx.content))
    for (const m of s.text.matchAll(UTIL)) { const fam = TW_BUCKET[m[1]!]; if (fam && familyColor(m[1]!, m[2]!) && !first.has(fam)) first.set(fam, s.line) }
  // Literal colors (arbitrary values, inline styles, CSS) count by the family their hue falls in
  ctx.lines.forEach((l, i) => {
    if (/^\s*--[\w-]+\s*:/.test(l) || COMMENT.test(l)) return // token definitions are the fix, not the problem
    for (const m of l.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])|(?:rgba?|hsla?|oklch)\([^)]*\)/g)) {
      const c = parseColor(m[0])
      if (!c || c.s < 0.45 || c.l < 0.2 || c.l > 0.85) continue
      const fam = nearestFamily(c.h)
      if (!first.has(fam)) first.set(fam, i + 1)
    }
  })
  // Red, green and yellow/orange are usually status colors; allow them plus a brand hue and one more
  if (first.size >= 6) {
    const list = [...first.keys()]
    for (const [, line] of first) add(ctx, 'accent-sprawl', line, `${first.size} different accent hues in one file (${list.join(', ')})`, 'Keep one brand accent plus status colors. Map the rest onto the brand color or neutrals.')
  }
}

function hoverLift(ctx: Ctx) {
  const fix = 'Keep hover feedback quiet (a border or background change), and only where clicking does something.'
  const hits = strings(ctx.content).filter(s => /(^|\s)(group-)?hover:(scale-1(0[3-9]|10|25)|-translate-y-(1|1\.5|2|3|4))\b/.test(s.text))
  if (hits.length >= 3) for (const h of hits) add(ctx, 'hover-lift', h.line, `hover lift/scale (${hits.length} in this file)`, fix)
  // In CSS one rule lifts every card it matches, so one is enough
  for (const m of ctx.content.matchAll(/([^{}\n]*\b(card|tile|feature|panel|plan|pricing|item|box)[\w-]*[^{}\n]*:hover[^{}\n]*)\{([^}]*)\}/gi)) {
    const body = m[3]!
    const lift = body.match(/translateY\(\s*-(\d+(?:\.\d+)?)px/) , scale = body.match(/scale\(\s*(1\.\d+)/)
    if ((lift && +lift[1]! >= 3) || (scale && +scale[1]! >= 1.03)) add(ctx, 'hover-lift', lineAt(ctx.content, m.index! + m[0].indexOf(':hover')), `${m[1]!.trim().slice(0, 40)} lifts on hover`, fix)
  }
}

/** Testimonials Darce writes itself are invented by definition. Only judged on added lines. */
function testimonials(ctx: Ctx, only: Set<number>) {
  ctx.lines.forEach((l, i) => {
    if (!only.has(i + 1)) return
    if (/<blockquote\b|class(Name)?=["'{][^"'}]*\b(testimonial|quote|review)s?\b|<(Testimonial|Review|Quote)(Card|s)?\b|\btestimonials?\s*[:=]\s*\[/i.test(l))
      add(ctx, 'fake-proof', i + 1, 'testimonial written by the agent', 'Only use real quotes the user gives you, with permission. Otherwise leave the section out or ask for them.')
  })
}

// ---------------------------------------------------------------- entry points

export type TasteOptions = { off?: Set<string> }

/** Read `.darce/taste.json` from the project, if there is one. */
export function projectTaste(cwd: string): TasteOptions {
  const p = join(cwd, '.darce', 'taste.json')
  if (!existsSync(p)) return {}
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8')) as { off?: unknown }
    return { off: new Set(Array.isArray(j.off) ? j.off.map(String) : []) }
  } catch {
    return {}
  }
}

/** All findings for a file. With `only`, keep findings on those line numbers (the lines an edit added). */
export function checkTaste(path: string, content: string, only?: Set<number>, opts: TasteOptions = {}): TasteFinding[] {
  if (!isUiFile(path, content) || /darce-taste-ignore-file/.test(content) || content.length > 400_000) return []
  if (/(\.|\/)(test|spec|stories|story)\.[jt]sx?$|\/__(tests|mocks)__\//.test(path)) return []
  if (opts.off?.has('all')) return []
  const ctx: Ctx = { lines: content.split('\n'), content, ext: extname(path).toLowerCase(), findings: [] }
  gradients(ctx); gradientText(ctx); emoji(ctx); stripes(ctx); blobs(ctx); copy(ctx); accents(ctx); hoverLift(ctx)
  if (only) testimonials(ctx, only)
  const ignored = (line: number) => /darce-taste-ignore/.test(ctx.lines[line - 1] ?? '') || /darce-taste-ignore/.test(ctx.lines[line - 2] ?? '')
  let out = ctx.findings.filter(f => !opts.off?.has(f.rule) && !ignored(f.line))
  // Sprawl is about the whole file: one finding, on its first line (or the first added one)
  for (const rule of ['accent-sprawl'] as TasteRule[]) {
    const all = out.filter(f => f.rule === rule)
    const keep = (only ? all.find(f => only.has(f.line)) : undefined) ?? all[0]
    out = out.filter(f => f.rule !== rule || f === keep)
  }
  if (only) {
    // File-wide rules (sprawl, repeated labels) report once, on the first added line that feeds them
    const wide = new Set<TasteRule>(['accent-sprawl', 'hover-lift'])
    let testimonial = false
    const kept: TasteFinding[] = []
    for (const f of out) {
      if (!only.has(f.line)) continue
      if (wide.has(f.rule) && kept.some(k => k.rule === f.rule)) continue
      if (f.text === 'testimonial written by the agent') { if (testimonial) continue; testimonial = true }
      kept.push(f)
    }
    out = kept
  }
  return out.sort((a, b) => a.line - b.line)
}

/** Line numbers an edit added, from the diff Darce already builds for the terminal. */
export function addedLines(diff: { hunks: { lines: { kind: string; newNo?: number }[] }[] }): Set<number> {
  const s = new Set<number>()
  for (const h of diff.hunks) for (const l of h.lines) if (l.kind === 'add' && l.newNo) s.add(l.newNo)
  return s
}

/** The note the model reads in the tool result, so it fixes these before calling the work done. */
export function tasteNote(path: string, findings: TasteFinding[]): string {
  if (!findings.length) return ''
  const rows = findings.slice(0, 12).map(f => `- line ${f.line}: ${TASTE_RULES[f.rule]}: ${f.text}. ${f.fix}`)
  const more = findings.length > 12 ? `\n- and ${findings.length - 12} more` : ''
  return `\n\nTaste check on ${path} found ${findings.length} thing${findings.length === 1 ? '' : 's'} that make the UI look generated:\n${rows.join('\n')}${more}\nFix these now unless the user asked for them. If one is intended, add a darce-taste-ignore comment on that line.`
}

let enabled = true
export const tasteEnabled = () => enabled
export const setTasteEnabled = (on: boolean) => { enabled = on }

/** Run the check on what an Edit or Write just added. Returns the note for the model ('' when clean). */
export function tasteForEdit(absPath: string, shownPath: string, content: string, diff: { hunks: { lines: { kind: string; newNo?: number }[] }[]; taste?: TasteFinding[] }, cwd: string): string {
  if (!enabled) return ''
  try {
    const findings = checkTaste(absPath, content, addedLines(diff), projectTaste(cwd))
    if (!findings.length) return ''
    diff.taste = findings
    return tasteNote(shownPath, findings)
  } catch {
    return '' // a broken rule must never break an edit
  }
}
