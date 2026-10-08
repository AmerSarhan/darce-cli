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
    darce login                     Create a free account or sign in
    darce upgrade                   Upgrade to Builder or Power
    darce logout                    Remove saved credentials
    darce --resume, -r              Resume last session
    darce --version                 Print version
    darce --help                    Show this help

  In a session:
    /model                          Pick or search 300+ models
    /help                           All commands
    Ctrl+C                          Cancel / Exit
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

  const resumeSession = args.includes('--resume') || args.includes('-r')
  if (resumeSession) {
    const idx = args.indexOf('--resume')
    if (idx !== -1) args.splice(idx, 1)
    const idx2 = args.indexOf('-r')
    if (idx2 !== -1) args.splice(idx2, 1)
  }

  const initialPrompt = args.join(' ').trim() || undefined
  main(modelOverride, initialPrompt, resumeSession).catch(err => {
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
  const { existsSync, unlinkSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const rcPath = join(homedir(), '.darcerc')
  if (existsSync(rcPath)) {
    unlinkSync(rcPath)
    console.log('\n  Logged out. ~/.darcerc removed.\n')
  } else {
    console.log('\n  Not logged in.\n')
  }
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

  // Try to open browser automatically
  const { exec } = await import('node:child_process')
  const openCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  exec(`${openCmd} "${data.url}"`)
}

// === Main REPL ===
async function main(modelOverride?: string, initialPrompt?: string, resumeSession?: boolean) {
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
  const { saveSession, loadLatestSession } = await import('../state/sessions.js')

  let restoredMessages: any[] = []
  let sessionId: string = randomUUID()

  if (resumeSession) {
    const restored = loadLatestSession(process.cwd())
    if (restored) {
      restoredMessages = restored.messages
      sessionId = restored.sessionId
      console.log(`  Resuming session ${sessionId.slice(0, 8)}... (${restoredMessages.length} messages)\n`)
    } else {
      console.log('  No previous session found for this directory.\n')
    }
  }

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

  const { waitUntilExit } = render(
    React.createElement(App, { initialState, children: React.createElement(REPL, { provider, initialPrompt }) })
  )

  await waitUntilExit()
}
