import { getTotalCost, formatCostSummary, formatTokenCount } from '../state/costTracker.js'
import { getModels } from '../config/models.js'

export type CommandContext = {
  setModel: (model: string) => void
  currentModel: string
  clearMessages: () => void
  cwd: string
}

export type SlashCommand = {
  name: string
  aliases?: string[]
  description: string
  execute: (args: string, context: CommandContext) => string | null
}

const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'List all available commands',
    execute: () => {
      const lines = COMMANDS.map(c => {
        const aliases = c.aliases?.length ? ` (/${c.aliases.join(', /')})` : ''
        return `  /${c.name}${aliases} — ${c.description}`
      })
      return 'Available commands:\n' + lines.join('\n')
    },
  },
  {
    name: 'model',
    aliases: ['m'],
    description: 'Open the model picker, or /model <search> to switch',
    execute: (args, context) => {
      const models = getModels()
      const query = args.trim().toLowerCase()
      if (!query) return '__MODEL_PICKER__'
      const exact = models.find(m => m.id.toLowerCase() === query || m.id.toLowerCase().endsWith('/' + query))
      if (exact) {
        context.setModel(exact.id)
        return `Switched to ${exact.id}`
      }
      const matches = models.filter(m => m.id.toLowerCase().includes(query) || m.name?.toLowerCase().includes(query))
      if (matches.length === 1) {
        context.setModel(matches[0]!.id)
        return `Switched to ${matches[0]!.id}`
      }
      if (matches.length > 1) {
        return `Multiple matches for "${query}":\n` + matches.slice(0, 15).map(m => `  ${m.id}`).join('\n')
      }
      // Not in the catalog (offline, or brand new) — let OpenRouter decide
      if (query.includes('/')) {
        context.setModel(args.trim())
        return `Switched to ${args.trim()} (not in catalog)`
      }
      return `Unknown model: ${args.trim()}. Type /model to see available models.`
    },
  },
  {
    name: 'undo',
    aliases: ['u'],
    description: 'Undo the last change Darce made (files and shell effects)',
    execute: () => '__UNDO__',
  },
  {
    name: 'diff',
    description: 'Show every file Darce changed this session',
    execute: () => '__DIFF__',
  },
  {
    name: 'mode',
    description: 'Approval mode: auto, ask, plan (read-only) or full (Shift+Tab cycles)',
    execute: (args) => `__MODE__:${args.trim().toLowerCase()}`,
  },
  {
    name: 'clear',
    aliases: ['c'],
    description: 'Clear conversation history',
    execute: (_args, context) => {
      context.clearMessages()
      return null // REPL handles clearing display
    },
  },
  {
    name: 'cost',
    description: 'Show session cost breakdown',
    execute: () => {
      return `Session: ${formatCostSummary()} | Tokens: ${formatTokenCount()}`
    },
  },
  {
    name: 'compact',
    description: 'Compact conversation (keep last 4 messages)',
    execute: (_args, context) => {
      context.clearMessages()
      return 'Conversation compacted. Kept last 4 messages.'
    },
  },
  {
    name: 'quit',
    aliases: ['q'],
    description: 'Exit Darce',
    execute: () => {
      return '__QUIT__'
    },
  },
]

export function isSlashCommand(input: string): boolean {
  return input.startsWith('/')
}

export function executeCommand(input: string, context: CommandContext): string | null {
  const parts = input.slice(1).split(/\s+/)
  const name = parts[0]?.toLowerCase()
  const args = parts.slice(1).join(' ')

  const cmd = COMMANDS.find(c => c.name === name || c.aliases?.includes(name!))
  if (!cmd) return `Unknown command: /${name}. Type /help for available commands.`
  return cmd.execute(args, context)
}
