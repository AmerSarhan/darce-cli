// Fast paths — no heavy imports
const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-v')) {
  console.log('0.1.0')
  process.exit(0)
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  darce - A blazing-fast AI coding agent by darce.dev

  Usage:
    darce                           Interactive REPL
    darce "fix the login bug"       Start with a prompt
    darce --model <id>              Override model
    darce --version                 Print version
    darce --help                    Show this help

  Config:
    ~/.darcerc                      Global config (JSON)
    ./.darcerc                      Project config (JSON)
    DARCE_API_KEY                   API key env var
    DARCE_MODEL                     Default model env var
    DARCE_DEBUG=1                   Enable debug logging

  Hotkeys:
    Ctrl+M                          Switch model
    Ctrl+C                          Cancel / Exit
`)
  process.exit(0)
}

// Parse --model flag
let modelOverride: string | undefined
const modelIndex = args.indexOf('--model')
if (modelIndex !== -1 && args[modelIndex + 1]) {
  modelOverride = args[modelIndex + 1]
  args.splice(modelIndex, 2)
}

// Remaining args are the initial prompt
const initialPrompt = args.join(' ').trim() || undefined

// Dynamic import — only load heavy deps when needed
async function main() {
  const { loadConfig } = await import('../config/config.js')
  const config = loadConfig()

  if (!config.apiKey) {
    console.error('Error: No API key found.')
    console.error('Set DARCE_API_KEY environment variable or add "apiKey" to ~/.darcerc')
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

  const initialState = {
    config,
    messages: [],
    streamingText: null,
    spinnerMode: 'idle' as const,
    currentModel: modelOverride || config.router.default,
    sessionId: randomUUID(),
    cwd: process.cwd(),
    readFiles: new Set<string>(),
    modelOverride: modelOverride || null,
  }

  const { saveCosts } = await import('../state/costTracker.js')
  const { getTotalCost, formatCostSummary } = await import('../state/costTracker.js')

  // Save costs on exit
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

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
