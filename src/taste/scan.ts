import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { checkTaste, isUiFile, projectTaste, TASTE_RULES, type TasteFinding } from './check.js'

/** `/taste` without a path: the files changed since the last commit, plus new ones. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', 'coverage', 'vendor', '.turbo', '.vercel', '.cache', 'public'])
const MAX_FILES = 2000

export type TasteScan = { files: number; results: { path: string; findings: TasteFinding[] }[]; scope: string }

function changedFiles(cwd: string): string[] | null {
  try {
    const opts = { cwd, encoding: 'utf-8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] }
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], opts).trim()
    const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD'], opts).split('\n')
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], opts).split('\n')
    return [...new Set([...tracked, ...untracked].filter(Boolean))].map(f => resolve(root, f)).filter(f => existsSync(f))
  } catch {
    return null
  }
}

function walk(dir: string, out: string[]) {
  if (out.length >= MAX_FILES) return
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (st.isFile() && st.size < 400_000 && !/\.min\.|\.d\.ts$/.test(name)) out.push(p)
    if (out.length >= MAX_FILES) return
  }
}

const shown = (cwd: string, p: string) => { const r = relative(cwd, p); return !r ? '.' : r.startsWith('..') || isAbsolute(r) ? p : r }

export function scanTaste(cwd: string, target: string): TasteScan {
  let files: string[]
  let scope: string
  if (target) {
    const abs = resolve(cwd, target)
    if (!existsSync(abs)) throw new Error(`Nothing at ${target}`)
    files = []
    if (statSync(abs).isDirectory()) walk(abs, files)
    else files.push(abs)
    scope = shown(cwd, abs)
  } else {
    const changed = changedFiles(cwd)
    if (changed && changed.length) { files = changed; scope = 'your uncommitted changes' }
    else { files = []; walk(cwd, files); scope = 'this project' }
  }
  const opts = projectTaste(cwd)
  const results: TasteScan['results'] = []
  let count = 0
  for (const f of files) {
    let content: string
    try { content = readFileSync(f, 'utf-8') } catch { continue }
    if (!isUiFile(f, content)) continue
    count++
    const findings = checkTaste(f, content, undefined, opts)
    if (findings.length) results.push({ path: shown(cwd, f), findings })
  }
  results.sort((a, b) => b.findings.length - a.findings.length)
  return { files: count, results, scope }
}

export function formatScan(s: TasteScan, maxPerFile = 8): string {
  const total = s.results.reduce((n, r) => n + r.findings.length, 0)
  if (!s.files) return `Taste check: no UI files in ${s.scope}.`
  if (!total) return `Taste check: ${s.files} UI file${s.files === 1 ? '' : 's'} in ${s.scope}, nothing that looks generated.`
  const byRule = new Map<string, number>()
  for (const r of s.results) for (const f of r.findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1)
  const out = [`Taste check: ${total} finding${total === 1 ? '' : 's'} in ${s.results.length} of ${s.files} UI files (${s.scope})`, '']
  for (const r of s.results.slice(0, 25)) {
    out.push(r.path)
    for (const f of r.findings.slice(0, maxPerFile)) out.push(`  ${String(f.line).padStart(5)}  ${TASTE_RULES[f.rule]}: ${f.text}`)
    if (r.findings.length > maxPerFile) out.push(`         and ${r.findings.length - maxPerFile} more`)
  }
  if (s.results.length > 25) out.push(`and ${s.results.length - 25} more files`)
  out.push('', [...byRule].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${TASTE_RULES[k as keyof typeof TASTE_RULES].toLowerCase()}`).join(', '))
  out.push('/taste fix asks Darce to fix them. A darce-taste-ignore comment keeps one on purpose.')
  return out.join('\n')
}
