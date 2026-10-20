// Fast paths — no heavy imports
// Namespace import: a named import of enableCompileCache fails to link on Node 22.0, which lacks it
import * as nodeModule from 'node:module'
import { VERSION } from '../version.js'
import { parseArgs } from './args.js'

// Cache compiled code on disk (Node 22.1+): later launches skip recompiling Ink, React and Darce
try { nodeModule.enableCompileCache?.() } catch { /* older Node or read-only cache dir: just slower */ }

const args = process.argv.slice(2)
const parsed = ['login', 'logout', 'signup', 'redeem', 'upgrade'].includes(args[0] ?? '') ? null : parseArgs(args)
if (parsed && 'error' in parsed) {
  console.error(parsed.error)
  process.exit(2)
}

if (parsed?.version) {
  console.log(VERSION)
  process.exit(0)
}

if (parsed?.help) {
  console.log(`
  darce - the coding agent you can undo, by darce.dev

  Usage:
    darce                           Interactive REPL
    darce "fix the login bug"       Start with a prompt
    darce --model <id>              Override model
    darce signup                    Create a free account (keeps your trial and its history)
    darce login                     Sign in with your browser (or create an account)
    darce upgrade                   Upgrade to Builder or Power
    darce redeem <code>             Redeem a promo code
    darce logout                    Remove saved credentials
    darce --resume, -r              Resume the last session here (/resume picks any past one)
    darce -p "explain src/app.ts"   Print the answer and exit (also --print; for scripts and CI)
    git diff | darce -p "review"    Piped input is added to the prompt
    darce --mode plan               auto (default), ask, plan (read-only) or full
    darce --version                 Print version
    darce --help                    Show this help

  In a session:
    /model, Ctrl+P                  Pick or search 250+ coding models
    /undo, /diff                    Undo Darce's last change, review all changes
    /rewind, Esc Esc                Scrub through every change and rewind
    /derby <task>                   Race models on a task, apply the best result
    /critic on                      Second-opinion review of every edit
    Shift+Up / Shift+Down           Shift to a smarter / cheaper model
    Shift+Tab                       Cycle approval mode
    /help                           All commands
    Shift+Enter, Ctrl+J, \\ Enter    New line
    Esc, Ctrl+C                     Stop Darce (Ctrl+C twice to exit)
`)
  process.exit(0)
}

// Auth commands — handle before loading heavy deps
if (args[0] === 'login') {
  authFlow().then(() => process.exit(0)).catch(err => {
    console.error(err.message)
    process.exit(1)
  })
} else if (args[0] === 'logout') {
  logoutFlow().catch(err => { console.error(err.message); process.exit(1) })
} else if (args[0] === 'signup') {
  ;(async () => {
    const { loadConfig } = await import('../config/config.js')
    await exitIfRcBroken()
    const { signupFlow } = await import('../auth/onboarding.js')
    const key = await signupFlow(loadConfig().apiKey || undefined)
    process.exit(key ? 0 : 1)
  })().catch(err => { console.error(err.message); process.exit(1) })
} else if (args[0] === 'redeem') {
  const { redeemCode } = await import('../auth/redeem.js')
  const r = await redeemCode(args[1] ?? '')
  ;(r.ok ? console.log : console.error)(`\n  ${r.message}\n`)
  process.exit(r.ok ? 0 : 1)
} else if (args[0] === 'upgrade') {
  upgradeFlow().then(ok => process.exit(ok ? 0 : 1)).catch(err => { console.error(err.message); process.exit(1) })
} else if (parsed && !('error' in parsed)) {
  if (parsed.mode) process.env.DARCE_MODE = parsed.mode
  // Piped in or out with a prompt (`git diff | darce "review this"`) is a script, not a session
  const run = parsed.print || ((!process.stdout.isTTY || !process.stdin.isTTY) && parsed.prompt)
    ? printMain(parsed.model, parsed.prompt)
    : main(parsed.model, parsed.prompt, parsed.resume)
  run.catch(err => {
    console.error('Fatal error:', err.message)
    process.exit(1)
  })
}

// === Auth Flow ===
/** Stop with a readable message when ~/.darcerc is unreadable, instead of treating the user as signed out. */
async function exitIfRcBroken(hasKey = false) {
  const { globalRcProblem } = await import('../config/config.js')
  const problem = globalRcProblem()
  if (!problem) return
  if (hasKey) { process.stderr.write(`  Warning: ${problem} Your settings in it are ignored for now.\n`); return }
  console.error(`\n  ${problem}\n`)
  process.exit(1)
}

/** Interactive sessions: never die silently with the terminal left in raw mode, and keep going past stray promise rejections. */
async function installSafetyNet() {
  const { trace, TRACE_PATH } = await import('../utils/logger.js')
  const { redactSecrets } = await import('../utils/redact.js')
  const describe = (e: unknown) => redactSecrets(e instanceof Error ? `${e.stack ?? e.message}` : String(e)).text.slice(0, 2000)
  process.on('unhandledRejection', reason => trace('unhandled_rejection', { error: describe(reason) }))
  process.on('uncaughtException', err => {
    trace('uncaught_exception', { error: describe(err) })
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false) } catch { /* stdin already gone */ }
    // Show the cursor, end bracketed paste, pop the kitty keyboard mode Ink pushed
    try { process.stdout.write('\x1b[?25h\x1b[?2004l\x1b[<u\n') } catch { /* stdout closed */ }
    process.stderr.write(`\n  Darce stopped on an unexpected error: ${redactSecrets(err?.message ?? String(err)).text}\n  Details are in ${TRACE_PATH}\n\n`)
    process.exit(1)
  })
}

async function authFlow() {
  await exitIfRcBroken()
  const { onboard } = await import('../auth/onboarding.js')
  const apiKey = await onboard()
  if (!apiKey) process.exit(1)
  console.log('  Saved to ~/.darcerc. Start coding with: darce\n')
}

async function logoutFlow() {
  const { removeAccount } = await import('../auth/accounts.js')
  const r = removeAccount()
  console.log(r.nowActive
    ? `\n  Signed out${r.removed ? ` of ${r.removed}` : ''}. Now using ${r.nowActive.email}.\n`
    : '\n  Signed out. Run `darce login` to sign in again. Your other settings in ~/.darcerc were kept.\n')
  process.exit(0)
}

async function upgradeFlow(): Promise<boolean> {
  const { loadConfig } = await import('../config/config.js')
  const config = loadConfig()
  await exitIfRcBroken(!!config.apiKey)
  if (!config.apiKey) {
    console.error('\n  Not logged in. Run `darce login` first.\n')
    return false
  }

  console.log('\n  Creating checkout session...')

  const { callApi, failure } = await import('../auth/http.js')
  let r
  try {
    r = await callApi(`${config.apiBase || 'https://api.darce.dev'}/v1/checkout`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
    })
  } catch (err) {
    console.error(`  ${(err as Error).message}\n`)
    return false
  }

  if (!r.ok) {
    if (r.data.error === 'Already on Pro') {
      console.log('  You\'re already on Pro.\n')
      return true
    }
    console.error(`  Error: ${failure(r, 'Failed to create checkout')}\n`)
    return false
  }

  const url = typeof r.data.url === 'string' ? r.data.url : ''
  console.log(`\n  Open this link to upgrade:\n`)
  console.log(`  ${url}\n`)

  // Try to open browser automatically (no shell, https only)
  const { openInBrowser } = await import('../core/billing.js')
  if (url) openInBrowser(url)
  return !!url
}

// === Main REPL ===
async function main(modelOverride?: string, initialPrompt?: string, resumeSession?: boolean) {
  await installSafetyNet()
  const { lockDownDarceFiles } = await import('../utils/privateFile.js')
  lockDownDarceFiles()
  const { loadConfig } = await import('../config/config.js')
  const config = loadConfig()
  await exitIfRcBroken(!!config.apiKey)

  // First run — set up an account right here, then drop straight into the REPL
  if (!config.apiKey) {
    const { onboard } = await import('../auth/onboarding.js')
    const apiKey = await onboard()
    if (!apiKey) process.exit(1)
    config.apiKey = apiKey
    config.apiBase = process.env.DARCE_API_BASE || 'https://api.darce.dev'
  }

  // Refresh the model catalog in the background — the picker uses whatever is loaded
  const { loadModels } = await import('../config/models.js')
  loadModels().catch(() => {})

  const { registerAllTools } = await import('../tools/index.js')
  registerAllTools()

  const { OpenRouterProvider } = await import('../providers/openrouter.js')
  const provider = new OpenRouterProvider(config.apiKey, config.apiBase || undefined)

  const { render } = await import('ink')
  const React = await import('react')
  const { App } = await import('../ui/App.js')
  const { REPL } = await import('../ui/REPL.js')
  const { randomUUID } = await import('node:crypto')
  const { loadLatestSession } = await import('../state/sessions.js')

  let restoredMessages: any[] = []
  let sessionId: string = randomUUID()

  if (resumeSession) {
    const restored = loadLatestSession(process.cwd())
    if (restored) {
      restoredMessages = restored.messages
      sessionId = restored.sessionId
    } else {
      console.log('  No previous session found for this directory. Starting a new one.\n')
    }
  }

  provider.setSession(sessionId) // one conversation stays on one provider, so its prompt cache is reused

  const { setTheme } = await import('../ui/theme.js')
  setTheme(config.theme)

  const initialState = {
    config,
    messages: restoredMessages,
    streamingText: null,
    spinnerMode: 'idle' as const,
    currentModel: modelOverride || config.router.default,
    sessionId,
    cwd: process.cwd(),
    readFiles: new Set<string>(),
    modelOverride: modelOverride || null,
    mode: (['auto', 'ask', 'plan', 'full'].includes(config.mode ?? '') ? config.mode : 'auto') as 'auto' | 'ask' | 'plan' | 'full',
  }

  const { saveCosts } = await import('../state/costTracker.js')
  const { getTotalCost, formatCostSummary } = await import('../state/costTracker.js')

  process.on('exit', () => {
    const cost = getTotalCost()
    if (cost > 0) {
      process.stdout.write(`\n${formatCostSummary()}\n`)
    }
    saveCosts(initialState.sessionId)
  })

  if (!process.stdin.isTTY) {
    console.error('  darce needs an interactive terminal. For scripts and CI, use: darce -p "your task"')
    process.exit(1)
  }

  const { waitUntilExit } = render(
    React.createElement(App, {
      initialState,
      children: React.createElement(REPL, { provider, initialPrompt, restored: restoredMessages }),
    }),
    {
      // Ctrl+C stops the current task; REPL exits on a second press
      exitOnCtrlC: false,
      // Redraw only changed lines — no flicker on long sessions
      incrementalRendering: true,
      // Shift+Enter, Ctrl+M etc. on terminals that support the kitty keyboard protocol
      kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
    },
  )

  await waitUntilExit()
  // Don't wait on background requests (model list, predictions) — quit right away
  process.exit(0)
}

// === Print mode: plain output for scripts, pipes and CI ===
async function printMain(modelOverride?: string, prompt?: string) {
  // `darce -p … | head -1` closes the pipe early: that's the reader being done, not a crash
  process.stdout.on('error', (e: NodeJS.ErrnoException) => process.exit(e.code === 'EPIPE' ? 0 : 1))
  const { readPipedStdin, STDIN_LIMIT } = await import('../utils/stdin.js')
  const piped = await readPipedStdin(process.stdin, 0, 1500, prompt ? 3000 : undefined)
  if (piped) {
    const note = piped.truncated ? `\n(Input cut at ${STDIN_LIMIT.toLocaleString('en-US')} bytes.)` : ''
    prompt = prompt ? `${prompt}\n\n<stdin>\n${piped.text}\n</stdin>${note}` : piped.text + note
  }
  if (!prompt) {
    console.error('Usage: darce -p "your task", or pipe it in: cat task.md | darce -p')
    process.exit(2)
  }
  const { loadConfig } = await import('../config/config.js')
  const config = loadConfig()
  await exitIfRcBroken(!!config.apiKey)
  if (!config.apiKey) {
    console.error('No Darce account on this machine. Run `darce login` in a terminal, or set DARCE_API_KEY.')
    process.exit(1)
  }
  const { registerAllTools } = await import('../tools/index.js')
  registerAllTools()
  const { OpenRouterProvider } = await import('../providers/openrouter.js')
  const { query } = await import('../core/query.js')
  const { buildSystemPrompt } = await import('../core/context.js')
  const { toolSummary } = await import('../ui/transcript.js')

  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())
  const { toolRisk } = await import('../core/risk.js')
  const mode = config.mode ?? 'auto'
  // No one can answer a prompt here: safe steps run, anything that would ask is declined
  const { secondOpinion, wantsSecondOpinion } = await import('../core/riskcheck.js')
  const authorize = async (call: { name: string; input: Record<string, unknown> }) => {
    let risk = toolRisk(call.name, call.input, process.cwd())
    // Same second look as the interactive app for scripts the rules would run unasked
    const cmdText = String(call.input.command ?? '')
    if (call.name === 'Bash' && risk.level === 1 && mode === 'auto' && config.riskCheck !== false && wantsSecondOpinion(cmdText)) {
      const second = await secondOpinion(cmdText, process.cwd(), config.apiKey, config.apiBase || undefined)
      if (second && second.level > risk.level) risk = second
    }
    if (mode === 'full' || risk.level === 0) return { allow: true as const }
    if (mode === 'plan') return { allow: false as const, reason: 'plan mode is on (read-only).' }
    if (mode === 'auto' && risk.level <= 1) return { allow: true as const }
    process.stderr.write(`[${call.name}] declined (${risk.reason}). Use --mode full to allow.\n`)
    return { allow: false as const, reason: `this needs approval (${risk.reason}) and Darce is running non-interactively.` }
  }

  const gen = query({
    messages: [{ role: 'user', content: prompt }],
    model: modelOverride || config.router.default,
    provider: new OpenRouterProvider(config.apiKey, config.apiBase || undefined),
    cwd: process.cwd(),
    systemPrompt: buildSystemPrompt(process.cwd()),
    maxTurns: config.maxTurns,
    readFiles: new Set(),
    abortSignal: controller.signal,
    passEnv: config.passEnv,
    authorize,
  })

  let failed = false
  let atLineStart = true
  let result = await gen.next()
  while (!result.done) {
    const e = result.value
    if (e.type === 'text_delta') {
      process.stdout.write(e.text)
      atLineStart = e.text.endsWith('\n')
    } else if (e.type === 'tool_executing') {
      if (!atLineStart) { process.stdout.write('\n'); atLineStart = true }
      process.stderr.write(`[${e.name}] ${toolSummary(e.name, e.input)}\n`)
    } else if (e.type === 'tool_result_ready' && e.isError) {
      process.stderr.write(`[${e.name}] failed: ${e.result.split('\n')[0]}\n`)
    } else if (e.type === 'error') {
      process.stderr.write(`Error: ${e.error}\n`)
      failed = true
    }
    result = await gen.next()
  }
  if (!atLineStart) process.stdout.write('\n')
  const reason = result.value.reason
  // A script must not mistake unfinished work for success
  if (reason === 'max_turns') process.stderr.write(`Stopped after ${config.maxTurns} steps without finishing. Raise maxTurns in ~/.darcerc, or split the task.\n`)
  process.exit(failed || reason === 'error' || reason === 'max_turns' ? 1 : reason === 'aborted' ? 130 : 0)
}
