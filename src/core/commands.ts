import { getTotalCost, formatCostSummary, formatTokenCount } from '../state/costTracker.js'
import { MODEL_PROFILES } from '../config/models.js'

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
    description: 'Switch model or show current model',
    execute: (args, context) => {
      if (!args.trim()) {
        const available = MODEL_PROFILES.map(m => {
          const marker = m.id === context.currentModel ? ' (active)' : ''
          return `  ${m.id}${marker}`
        }).join('\n')
        return `Current model: ${context.currentModel}\n\nAvailable models:\n${available}`
      }
      const modelId = args.trim()
      const profile = MODEL_PROFILES.find(m => m.id === modelId || m.id.endsWith('/' + modelId))
      if (!profile) {
        return `Unknown model: ${modelId}. Type /model to see available models.`
      }
      context.setModel(profile.id)
      return `Switched to ${profile.id}`
    },
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
