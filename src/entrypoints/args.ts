export type CliArgs = {
  help: boolean
  version: boolean
  print: boolean
  resume: boolean
  model?: string
  mode?: string
  prompt?: string
}

const MODES = ['auto', 'ask', 'plan', 'full']

/**
 * Flags go before the prompt or after it (`darce "fix it" --model x`). Words inside the prompt that look like
 * flags (`darce -p what does ls -h do`) stay in the prompt: short flags only count before the first prompt word,
 * and `--` ends flag parsing. Returns an error message for anything unclear instead of guessing.
 */
export function parseArgs(argv: string[]): CliArgs | { error: string } {
  const out: CliArgs = { help: false, version: false, print: false, resume: false }
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') { words.push(...argv.slice(i + 1)); break }
    const started = words.length > 0
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    if (flag === '--model' || flag === '--mode') {
      const value = inline ?? argv[i + 1]
      if (inline === undefined) i++
      if (!value || value.startsWith('-')) return { error: `${flag} needs a value, like ${flag === '--model' ? '--model anthropic/claude-sonnet-5.5' : '--mode plan'}.` }
      if (flag === '--mode' && !MODES.includes(value)) return { error: `Unknown mode "${value}". Use auto, ask, plan or full.` }
      if (flag === '--model') out.model = value
      else out.mode = value
      continue
    }
    if (flag === '--print' || (!started && a === '-p')) { out.print = true; continue }
    if (flag === '--resume' || (!started && a === '-r')) { out.resume = true; continue }
    if (flag === '--help' || (!started && a === '-h')) { out.help = true; continue }
    if (flag === '--version' || (!started && a === '-v')) { out.version = true; continue }
    if (!started && a.startsWith('-') && a.length > 1) return { error: `Unknown option ${a}. Run darce --help for the options, or put the prompt in quotes.` }
    words.push(a)
  }
  const prompt = words.join(' ').trim()
  if (prompt) out.prompt = prompt
  if (out.print && out.resume) return { error: '--resume works in the interactive app only, not with -p.' }
  return out
}
