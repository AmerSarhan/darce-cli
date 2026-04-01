// Fast paths — no heavy imports
const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-v')) {
  console.log('0.2.2')
  process.exit(0)
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  darce - A blazing-fast AI coding agent by darce.dev

  Usage:
    darce                           Interactive REPL
    darce "fix the login bug"       Start with a prompt
    darce --model <id>              Override model
    darce login                     Sign in / create account
    darce logout                    Remove saved credentials
    darce --resume, -r              Resume last session
    darce --version                 Print version
    darce --help                    Show this help

  Hotkeys:
    Ctrl+M                          Switch model
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
  const { createInterface } = await import('node:readline')
  const { writeFileSync, existsSync, readFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r))

  console.log('\n  Welcome to Darce\n')

  const email = await ask('  Email: ')
  const password = await ask('  Password: ')
  rl.close()

  console.log('\n  Connecting...')

  // Try login first, then register
  let data: any
  let res = await fetch('https://api.darce.dev/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  if (res.ok) {
    data = await res.json()
    console.log('  Signed in!')
  } else {
    // Try register
    res = await fetch('https://api.darce.dev/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (res.ok) {
      data = await res.json()
      console.log('  Account created!')
    } else {
      const err = await res.json()
      throw new Error(`  ${err.message || err.error || 'Auth failed'}`)
    }
  }

  // Save to ~/.darcerc
  const rcPath = join(homedir(), '.darcerc')
  let existing: Record<string, unknown> = {}
  try {
    if (existsSync(rcPath)) {
      existing = JSON.parse(readFileSync(rcPath, 'utf-8'))
    }
  } catch {}

  existing.apiKey = data.api_key
  existing.apiBase = 'https://api.darce.dev'

  const dir = join(homedir(), '.darce')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(rcPath, JSON.stringify(existing, null, 2) + '\n')

  console.log(`\n  API key saved to ~/.darcerc`)
  console.log(`  You're ready — just run: darce\n`)
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

// === Main REPL ===
async function main(modelOverride?: string, initialPrompt?: string, resumeSession?: boolean) {
  const { loadConfig } = await import('../config/config.js')
  const config = loadConfig()

  if (!config.apiKey) {
    console.log('\n  No API key found. Run `darce login` to get started.\n')
    process.exit(1)
  }

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
