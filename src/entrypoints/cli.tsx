// Fast paths — no heavy imports
import { VERSION } from '../version.js'

const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION)
  process.exit(0)
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  darce - A blazing-fast AI coding agent by darce.dev

  Usage:
    darce                           Interactive REPL
    darce "fix the login bug"       Start with a prompt
    darce --model <id>              Override model
    darce signup                    Create a free account (keeps your trial and its history)
    darce login                     Sign in with your browser (or create an account)
    darce upgrade                   Upgrade to Builder or Power
    darce logout                    Remove saved credentials
    darce --resume, -r              Resume the last session here (/resume picks any past one)
    darce -p "explain src/app.ts"   Print the answer and exit (for scripts and CI)
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
    const { signupFlow } = await import('../auth/onboarding.js')
    const key = await signupFlow(loadConfig().apiKey || undefined)
    process.exit(key ? 0 : 1)
  })().catch(err => { console.error(err.message); process.exit(1) })
} else if (args[0] === 'upgrade') {
  upgradeFlow().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1) })
} else {
  // Parse --model flag
  let modelOverride: string | undefined
  const modelIndex = args.indexOf('--model')
  if (modelIndex !== -1 && args[modelIndex + 1]) {
    modelOverride = args[modelIndex + 1]
    args.splice(modelIndex, 2)
  }

  const modeIndex = args.indexOf('--mode')
  if (modeIndex !== -1 && args[modeIndex + 1]) {
    process.env.DARCE_MODE = args[modeIndex + 1]
    args.splice(modeIndex, 2)
  }

  const printMode = args.includes('--print') || args.includes('-p')
  for (const flag of ['--print', '-p']) {
    const i = args.indexOf(flag)
    if (i !== -1) args.splice(i, 1)
  }

  const resumeSession = args.includes('--resume') || args.includes('-r')
  if (resumeSession) {
    const idx = args.indexOf('--resume')
    if (idx !== -1) args.splice(idx, 1)
    const idx2 = args.indexOf('-r')
    if (idx2 !== -1) args.splice(idx2, 1)
  }

  const initialPrompt = args.join(' ').trim() || undefined
  const run = printMode || (!process.stdout.isTTY && initialPrompt)
    ? printMain(modelOverride, initialPrompt)
    : main(modelOverride, initialPrompt, resumeSession)
  run.catch(err => {
    console.error('Fatal error:', err.message)
    process.exit(1)
  })
}

// === Auth Flow ===
async function authFlow() {
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

async function upgradeFlow() {
  const { readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const rcPath = join(homedir(), '.darcerc')
  if (!existsSync(rcPath)) {
    console.log('\n  Not logged in. Run `darce login` first.\n')
    return
  }

  let config: Record<string, unknown>
  try {
    config = JSON.parse(readFileSync(rcPath, 'utf-8'))
  } catch {
    console.log('\n  Invalid config. Run `darce login` again.\n')
    return
  }

  const apiKey = config.apiKey as string
  const apiBase = (config.apiBase as string) || 'https://api.darce.dev'

  console.log('\n  Creating checkout session...')

  const res = await fetch(`${apiBase}/v1/checkout`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  })

  const data = await res.json() as { url?: string; error?: string }

  if (!res.ok) {
    if (data.error === 'Already on Pro') {
      console.log('  You\'re already on Pro!\n')
    } else {
      console.log(`  Error: ${data.error || 'Failed to create checkout'}\n`)
    }
    return
  }

  console.log(`\n  Open this link to upgrade:\n`)
  console.log(`  ${data.url}\n`)

  // Try to open browser automatically (no shell, https only)
  const { openInBrowser } = await import('../core/billing.js')
  if (data.url) openInBrowser(data.url)
}

// === Main REPL ===
async function main(modelOverride?: string, initialPrompt?: string, resumeSession?: boolean) {
  const { lockDownDarceFiles } = await import('../utils/privateFile.js')
  lockDownDarceFiles()
  const { loadConfig } = await import('../config/config.js')
  const config = loadConfig()

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
  if (!prompt) {
    console.error('Usage: darce -p "your task"')
    process.exit(2)
  }
  const { loadConfig } = await import('../config/config.js')
  const config = loadConfig()
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
  process.exit(failed || result.value.reason === 'error' ? 1 : result.value.reason === 'aborted' ? 130 : 0)
}
