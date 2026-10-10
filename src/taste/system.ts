import type { Box, SystemSample } from './detect.js'
import type { TasteRule } from './check.js'
import { TAILWIND_V3, TAILWIND_V4 } from './palette.js'

/**
 * The page's working design system, read back from what it renders: which colors, text sizes,
 * corner radii and typefaces are actually in use. Hand-designed pages draw from a small set;
 * pages assembled one prompt at a time pick a new value each time (#1a1a1a here, #1b1b1b there).
 * Colors are compared in OKLab, so "near-identical" means near-identical to the eye.
 */

type Lab = { L: number; a: number; b: number; alpha: number }
export type Swatch = { hex: string; n: number }
export type ColorGroup = { hex: string; n: number; members: Swatch[] }
export type Step = { value: number; n: number; boxes: Box[] }
export type SystemFinding = { rule: TasteRule; label: string; detail: string; boxes: Box[]; data: unknown }
export type SystemReport = {
  colors: ColorGroup[]
  sizes: Step[]
  radii: Step[]
  fonts: { name: string; n: number }[]
  findings: SystemFinding[]
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function rgbToOklab(r: number, g: number, b: number, alpha = 1): Lab {
  const [R, G, B] = [r, g, b].map(v => srgbToLinear(v / 255)) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s, alpha }
}

function oklabToRgb({ L, a, b }: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  return rgb.map(v => Math.round(Math.max(0, Math.min(1, linearToSrgb(v))) * 255)) as [number, number, number]
}

/** A computed CSS color (rgb, rgba, oklch, oklab, color(srgb …)) → OKLab, or null. */
export function toLab(css: string): Lab | null {
  const c = css.trim().toLowerCase()
  const nums = (s: string) => s.split(/[\s,/]+/).filter(Boolean).map(x => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x)))
  let m = c.match(/^rgba?\(([^)]*)\)$/)
  if (m) { const [r, g, b, a = 1] = nums(m[1]!); return rgbToOklab(r!, g!, b!, a) }
  m = c.match(/^oklch\(([^)]*)\)$/)
  if (m) { const [L, C, H, a = 1] = nums(m[1]!); const h = ((H ?? 0) * Math.PI) / 180; return { L: L! > 1 ? L! / 100 : L!, a: C! * Math.cos(h), b: C! * Math.sin(h), alpha: a } }
  m = c.match(/^oklab\(([^)]*)\)$/)
  if (m) { const [L, a, b, al = 1] = nums(m[1]!); return { L: L! > 1 ? L! / 100 : L!, a: a!, b: b!, alpha: al } }
  m = c.match(/^color\(srgb ([^)]*)\)$/)
  if (m) { const [r, g, b, a = 1] = nums(m[1]!); return rgbToOklab(r! * 255, g! * 255, b! * 255, a) }
  m = c.match(/^#([0-9a-f]{6})$/)
  if (m) return rgbToOklab(parseInt(m[1]!.slice(0, 2), 16), parseInt(m[1]!.slice(2, 4), 16), parseInt(m[1]!.slice(4, 6), 16))
  return null
}

const hexOf = (lab: Lab) => '#' + oklabToRgb(lab).map(v => v.toString(16).padStart(2, '0')).join('')
const dist = (x: Lab, y: Lab) => Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b)

// Two colors closer than this read as the same color; a hair above "identical" (0.004) they're a near-duplicate
const SAME = 0.004
const NEAR = 0.03

/** Group the page's colors: identical ones merge, near-identical ones join a group. */
export function groupColors(tallies: Record<string, { n: number }>[]): ColorGroup[] {
  const seen = new Map<string, { lab: Lab; n: number }>()
  for (const t of tallies) for (const [css, { n }] of Object.entries(t)) {
    const lab = toLab(css)
    if (!lab || lab.alpha < 0.15) continue
    // Translucent colors are judged as the opaque color they're mixed from
    const key = hexOf(lab)
    const e = seen.get(key)
    if (e) e.n += n; else seen.set(key, { lab, n })
  }
  const all = [...seen.entries()].map(([hex, v]) => ({ hex, ...v })).sort((a, b) => b.n - a.n)
  const groups: { head: Lab; hex: string; n: number; members: (Swatch & { lab: Lab })[] }[] = []
  for (const c of all) {
    const g = groups.find(g => dist(g.head, c.lab) < NEAR)
    if (g) {
      const same = g.members.find(m => dist(m.lab, c.lab) < SAME)
      if (same) same.n += c.n; else g.members.push({ hex: c.hex, n: c.n, lab: c.lab })
      g.n += c.n
    } else groups.push({ head: c.lab, hex: c.hex, n: c.n, members: [{ hex: c.hex, n: c.n, lab: c.lab }] })
  }
  return groups.map(g => ({ hex: g.hex, n: g.n, members: g.members.map(({ hex, n }) => ({ hex, n })) }))
}

const steps = (t: Record<string, { n: number; boxes: Box[] }>): Step[] =>
  Object.entries(t).map(([k, v]) => ({ value: parseFloat(k), n: v.n, boxes: v.boxes })).filter(s => s.value > 0).sort((a, b) => a.value - b.value)

/** Values within `gap` of each other: 13px, 13.5px and 14px are one size written three ways. */
function crowded(list: Step[], gap: (v: number) => number): Step[][] {
  const runs: Step[][] = []
  let cur: Step[] = []
  for (const s of list) {
    if (cur.length && s.value - cur[cur.length - 1]!.value <= gap(s.value)) cur.push(s)
    else { if (cur.length > 1) runs.push(cur); cur = [s] }
  }
  if (cur.length > 1) runs.push(cur)
  return runs
}

const px = (v: number) => `${v}px`
const MONO = /mono|courier|consolas|menlo|monaco|sf mono|code/i
const ICON_FONT = /icon|awesome|material symbols|glyph/i

function stockColors(tallies: Record<string, { n: number; boxes: Box[] }>[]) {
  const stock = [...Object.entries(TAILWIND_V4), ...Object.entries(TAILWIND_V3)].map(([name, css]) => ({ name, lab: toLab(css)! })).filter(s => s.lab)
  const names = new Set<string>()
  const boxes: Box[] = []
  let accent = 0, matched = 0
  for (const t of tallies) for (const [css, v] of Object.entries(t)) {
    const lab = toLab(css)
    if (!lab || lab.alpha < 0.15 || Math.hypot(lab.a, lab.b) < 0.04) continue
    accent += v.n
    const hit = stock.find(s => dist(s.lab, lab) < 0.006)
    if (hit) { matched += v.n; names.add(hit.name); if (boxes.length < 6) boxes.push(...v.boxes.slice(0, 1)) }
  }
  return { names: [...names], share: accent >= 3 ? matched / accent : 0, boxes }
}

export function analyzeSystem(sys: SystemSample): SystemReport {
  const colors = groupColors([sys.text, sys.surface, sys.border])
  const sizes = steps(sys.size)
  const radii = steps(sys.radius)
  const fonts = Object.entries(sys.family).map(([name, v]) => ({ name, n: v.n })).filter(f => f.name && !ICON_FONT.test(f.name)).sort((a, b) => b.n - a.n)
  const findings: SystemFinding[] = []
  const boxesFor = (t: Record<string, { boxes: Box[] }>, keys: string[]) => keys.flatMap(k => t[k]?.boxes ?? []).slice(0, 6)

  // Stock palette: accents that are the framework's defaults, unchanged. Designed pages pick their own;
  // near-identical grays and many colors turned out to be normal on well-designed sites, so they're shown, not judged.
  const stock = stockColors([sys.text, sys.surface, sys.border])
  // Red, green and amber stock shades are usually status colors (errors, price up/down) and are fine
  const brandish = stock.names.filter(n => !/^(red|green|emerald|amber|yellow)-/.test(n))
  if (stock.names.length >= 2 && brandish.length >= 1 && stock.share >= 0.5) {
    findings.push({
      rule: 'stock-palette',
      label: `${stock.names.slice(0, 4).join(', ')}${stock.names.length > 4 ? ` and ${stock.names.length - 4} more` : ''}`,
      detail: `${Math.round(stock.share * 100)}% of the color on this page is Tailwind's default palette used as-is. No brand color was chosen.`,
      boxes: stock.boxes,
      data: stock.names,
    })
  }
  // Type scale: many sizes, or sizes crowded together
  const sizeRuns = crowded(sizes, v => (v < 20 ? 0.75 : v * 0.05))
  // Well-designed sites measured 7 to 17 sizes; past 20 there's no scale left
  if (sizes.length >= 20) {
    const worst = sizeRuns.sort((a, b) => b.length - a.length)[0]
    findings.push({
      rule: 'type-scale',
      label: `${sizes.length} text sizes${sizeRuns.length ? `, ${sizeRuns.length} crowded together` : ''}`,
      detail: worst ? `${worst.slice(0, 6).map(s => px(s.value)).join(', ')}${worst.length > 6 ? '…' : ''} are too close to read as different sizes.` : 'Pick a scale of 6 to 10 sizes and map the rest onto it.',
      boxes: worst ? worst.flatMap(s => s.boxes).slice(0, 6) : [],
      data: sizes,
    })
  }
  // Radii: well-designed sites measured 1 to 9
  if (radii.length > 11) {
    findings.push({
      rule: 'radius-sprawl',
      label: `${radii.length} different corner radii`,
      detail: `${radii.map(r => px(r.value)).join(', ')}. A few radii, chosen by size, read as one system.`,
      boxes: radii.flatMap(r => r.boxes.slice(0, 1)).slice(0, 6),
      data: radii,
    })
  }
  // Typefaces: one or two plus a monospace
  const text = fonts.filter(f => !MONO.test(f.name))
  if (text.length > 3) {
    findings.push({
      rule: 'font-sprawl',
      label: `${text.length} typefaces`,
      detail: `${text.map(f => f.name).join(', ')}. One family (or two with clearly different jobs) carries a page.`,
      boxes: text.slice(2).flatMap(f => sys.family[f.name]?.boxes.slice(0, 2) ?? []).slice(0, 6),
      data: fonts,
    })
  }
  return { colors, sizes, radii, fonts, findings }
}
