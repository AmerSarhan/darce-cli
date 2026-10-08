import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { parse } from 'shell-quote'
import { bashRisk, unwrap, WRAPPERS, type Risk } from './risk.js'
import { trace } from '../utils/logger.js'

/**
 * A second look at commands the rules would run automatically (level 1) when they execute code
 * whose effects the command line doesn't show: `npm run sync`, `node scripts/x.js`, `make release`.
 *
 * 1. Deterministic: resolve the package.json script and score its real command with the rules.
 * 2. Semantic: ask api.darce.dev/v1/risk (TypeSafe Jev) whether running it changes anything outside
 *    this computer, given the script line and the start of the file it runs.
 *
 * It can only raise the level. Any failure or timeout keeps the rules' answer.
 */
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const CODE_RUNNERS = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'python', 'python3', 'ruby', 'php', 'deno', 'bun', 'bash', 'sh', 'zsh', 'make', 'just', 'rake', 'task', 'perl'])
const THRESHOLD = 0.3
const cache = new Map<string, Risk | null>()

function inside(path: string, cwd: string): boolean {
  const rel = relative(cwd, resolve(cwd, path))
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function readHead(path: string, cwd: string, max = 4000): string | undefined {
  try {
    const abs = resolve(cwd, path)
    if (!inside(abs, cwd) || !existsSync(abs) || !statSync(abs).isFile()) return undefined
    return readFileSync(abs, 'utf-8').slice(0, max)
  } catch {
    return undefined
  }
}

/** Each simple command in a line (`cd x && npm run sync; echo $?` → three), VAR=value prefixes dropped. */
function commands(command: string): string[][] {
  try {
    const out: string[][] = [[]]
    for (const t of parse(command, (n: string) => `$${n}`)) {
      if (typeof t === 'string') out[out.length - 1]!.push(t)
      else if ('op' in t && !['>', '>>', '<', '>&', '&>', '<<'].includes((t as { op: string }).op)) out.push([])
    }
    return out.map(words => {
      let i = 0
      while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++
      let w = words.slice(i)
      // Look through wrappers: `timeout 60 npm run sync`, `env X=1 node x.js`, `nice make deploy`
      while (w.length && WRAPPERS.has(w[0]!.split('/').pop()!)) w = unwrap(w[0]!.split('/').pop()!, w.slice(1))
      return w
    }).filter(w => w.length > 0)
  } catch {
    return []
  }
}

const firstCommand = (command: string): string[] | null => commands(command)[0] ?? null

/** The part of a line that runs code, e.g. `npm run sync` in `cd app && npm run sync; echo $?`. */
function codePart(command: string): string[] | undefined {
  return commands(command).find(w => { const c = w[0]!.split('/').pop()!; return RUNNERS.has(c) || CODE_RUNNERS.has(c) || w[0]!.startsWith('./') })
}

/** The package.json script a runner command executes, if any. */
function packageScript(words: string[], cwd: string): { name: string; text: string } | undefined {
  const [cmd, sub, name] = words
  if (!cmd || !RUNNERS.has(cmd)) return undefined
  const scriptName = sub === 'run' || sub === 'run-script' ? name : sub
  if (!scriptName || scriptName.startsWith('-')) return undefined
  try {
    const scripts = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8')).scripts ?? {}
    const text = scripts[scriptName]
    return typeof text === 'string' ? { name: scriptName, text } : undefined
  } catch {
    return undefined
  }
}

/** The project file a command runs (`node scripts/x.js`, `./deploy.sh`, `bash x.sh`). */
function scriptFile(words: string[]): string | undefined {
  const [cmd, ...args] = words
  if (!cmd) return undefined
  if (cmd.startsWith('./') || cmd.startsWith('scripts/')) return cmd
  if (!CODE_RUNNERS.has(cmd.split('/').pop()!)) return undefined
  return args.find(a => !a.startsWith('-') && /\.(m?[jt]s|cjs|py|rb|php|sh|pl)$/.test(a))
}

export function wantsSecondOpinion(command: string): boolean {
  return !!codePart(command)
}

export async function secondOpinion(command: string, cwd: string, apiKey: string, apiBase = 'https://api.darce.dev'): Promise<Risk | null> {
  const key = `${cwd}\0${command}`
  if (cache.has(key)) return cache.get(key)!
  // Models usually prefix `cd <dir> &&`; judge the part that actually runs code
  const words = codePart(command)
  if (!words) return null

  // 1. The script's real command, scored by the rules
  const pkg = packageScript(words, cwd)
  if (pkg) {
    const inner = bashRisk(pkg.text, cwd)
    if (inner.level >= 2) {
      const r: Risk = { level: inner.level, reason: `"${pkg.name}" runs \`${pkg.text.slice(0, 60)}\`: ${inner.reason}` }
      cache.set(key, r)
      return r
    }
  }

  // 2. Jev, with the script line and the start of the file that will run
  const innerWords = pkg ? firstCommand(pkg.text) : null
  const file = scriptFile(words) ?? (innerWords ? scriptFile(innerWords) : undefined)
  const source = file ? readHead(file, cwd) : undefined
  const started = Date.now()
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/v1/risk`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, script: pkg?.text, source }),
      signal: AbortSignal.timeout(2000),
    })
    const data = (await res.json().catch(() => ({}))) as { outside?: number }
    trace('risk_check', { ms: Date.now() - started, status: res.status, outside: data.outside })
    if (!res.ok || typeof data.outside !== 'number') return null
    const r: Risk | null = data.outside >= THRESHOLD
      ? { level: 2, reason: `looks like it changes something outside this machine (${Math.round(data.outside * 100)}% sure) (/undo can't reverse that)` }
      : null
    cache.set(key, r)
    return r
  } catch {
    trace('risk_check', { ms: Date.now() - started, error: 'unreachable' })
    return null
  }
}
