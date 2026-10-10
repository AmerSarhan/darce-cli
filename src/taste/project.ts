import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { TasteRule } from './check.js'

/**
 * Whole-project signs of UI code assembled one prompt at a time: the same long class list pasted
 * wherever a button or card was needed, colors typed out by hand in file after file, and
 * components that grew to hold a whole screen's worth of state. Thresholds were set against
 * real projects so a tidy codebase stays quiet.
 */

export type Spot = { file: string; line: number }
export type ProjectFinding = { rule: TasteRule; label: string; detail: string; spots: Spot[]; code?: string }

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', 'coverage', 'vendor', '.turbo', '.vercel', '.cache', 'public', 'storybook-static'])
const UI = /\.(tsx|jsx|vue|svelte|astro|html?)$/
const STYLE = /\.(css|scss|sass|less)$/
// Where tokens and primitives are defined: values written there are the system, not a copy of it
const DEFINES = /(^|\/)(theme|tokens?|colors?|palette|design-system|tailwind\.config|globals?|variables|vars)\b|\/components\/ui\/|\.(test|spec|stories)\.[jt]sx?$/i

function files(root: string, max = 3000): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number) => {
    if (depth > 10 || out.length >= max) return
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      if (SKIP.has(n) || n.startsWith('.')) continue
      const p = join(d, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p, depth + 1)
      else if ((UI.test(n) || STYLE.test(n)) && st.size < 500_000 && !/\.min\./.test(n)) out.push(p)
    }
  }
  walk(root, 0)
  return out
}

const lineOf = (text: string, index: number) => { let n = 1; for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++; return n }

export function analyzeProject(cwd: string): ProjectFinding[] {
  const found: ProjectFinding[] = []
  const styles = new Map<string, { raw: string; spots: Spot[] }>()
  const colors = new Map<string, Map<string, number>>() // hex → file → first line

  for (const abs of files(cwd)) {
    const file = relative(cwd, abs)
    let text: string
    try { text = readFileSync(abs, 'utf-8') } catch { continue }
    const defines = DEFINES.test(file)

    if (UI.test(file)) {
      // Long class lists, compared as sets so order doesn't hide a copy
      if (!defines) {
        for (const m of text.matchAll(/\bclass(?:Name)?=(?:"([^"]+)"|'([^']+)'|\{`([^`$]+)`\})/g)) {
          const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/\s+/g, ' ')
          const tokens = raw.split(' ')
          if (tokens.length < 8) continue
          const key = [...new Set(tokens)].sort().join(' ')
          const e = styles.get(key) ?? { raw, spots: [] }
          e.spots.push({ file, line: lineOf(text, m.index!) })
          styles.set(key, e)
        }
      }
      // Components that hold a whole screen: long, with lots of state and effects
      const lines = text.split('\n').length
      const state = (text.match(/\buseState\s*[(<]/g) ?? []).length + (text.match(/\b(ref|reactive)\s*\(/g) ?? []).length
      const effects = (text.match(/\buse(Layout)?Effect\s*\(/g) ?? []).length
      if (!defines && ((lines > 700 && state >= 12) || (lines > 500 && state >= 18) || lines > 1500)) {
        found.push({
          rule: 'big-component',
          label: `${file.split('/').pop()}: ${lines} lines, ${state} pieces of state${effects ? `, ${effects} effects` : ''}`,
          detail: 'One file is running a whole screen. Split it into components that each own their state, so a change in one place can\'t break another.',
          spots: [{ file, line: 1 }],
        })
      }
    }
    // Hand-typed colors, outside the files that define the palette
    if (!defines) {
      text.split('\n').forEach((l, i) => {
        if (/^\s*--[\w-]+\s*:/.test(l) || /^\s*(\/\/|\*|\/\*)/.test(l)) return
        for (const m of l.matchAll(/#([0-9a-fA-F]{6})\b(?![\w-])/g)) {
          const hex = '#' + m[1]!.toLowerCase()
          if (hex === '#ffffff' || hex === '#000000') continue
          const byFile = colors.get(hex) ?? new Map<string, number>()
          if (!byFile.has(file)) byFile.set(file, i + 1)
          colors.set(hex, byFile)
        }
      })
    }
  }

  // The same style pasted in many places
  const pasted = [...styles.values()].filter(e => e.spots.length >= 5 && new Set(e.spots.map(s => s.file)).size >= 2).sort((a, b) => b.spots.length - a.spots.length)
  for (const e of pasted.slice(0, 8)) {
    const nFiles = new Set(e.spots.map(s => s.file)).size
    const kind = /\b(px|py|p)-\d/.test(e.raw) && /\b(rounded|border)/.test(e.raw) && /\b(hover:|focus|cursor)/.test(e.raw) ? 'button or control' : /\b(rounded|border|shadow)/.test(e.raw) && /\bp-\d/.test(e.raw) ? 'card' : 'style'
    found.push({
      rule: 'pasted-styles',
      label: `The same ${e.raw.split(' ').length}-class ${kind} is pasted ${e.spots.length} times in ${nFiles} files`,
      detail: `Make it one component (or one class) so a change happens once. Today a tweak means finding all ${e.spots.length} copies.`,
      spots: e.spots,
      code: e.raw,
    })
  }

  // Colors typed out across many files
  const spread = [...colors.entries()].filter(([, f]) => f.size >= 4).sort((a, b) => b[1].size - a[1].size)
  if (spread.length >= 4) {
    const top = spread.slice(0, 6)
    found.push({
      rule: 'hardcoded-colors',
      label: `${spread.length} colors typed out by hand in 4 or more files each`,
      detail: `${top.map(([hex, f]) => `${hex} in ${f.size}`).join(', ')}. Define each once as a token and use the token, so the palette lives in one place.`,
      spots: top.flatMap(([, f]) => [...f.entries()].slice(0, 3).map(([file, line]) => ({ file, line }))),
      code: top.map(([hex]) => hex).join(' '),
    })
  }
  return found
}
