import { execSync } from 'node:child_process'
import { allTools } from '../tools/registry.js'

let cachedSystemPrompt: string | null = null

function getGitContext(cwd: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 5000 }).trim()
    const status = execSync('git status --short', { cwd, encoding: 'utf-8', timeout: 5000 }).trim()
    const log = execSync('git log --oneline -5', { cwd, encoding: 'utf-8', timeout: 5000 }).trim()
    return `Branch: ${branch}\nStatus:\n${status || '(clean)'}\nRecent commits:\n${log}`
  } catch {
    return null
  }
}

export function buildSystemPrompt(cwd: string): string {
  if (cachedSystemPrompt) return cachedSystemPrompt

  const parts = [
    'You are Darce, an interactive CLI coding agent. You help users with software engineering tasks by reading, writing, and editing code, running shell commands, and searching codebases.',
    '',
    'You have access to tools for interacting with the filesystem and running commands. Use them to accomplish tasks.',
    '',
    `Current directory: ${cwd}`,
    `Platform: ${process.platform}`,
    `Shell: ${process.env.SHELL || process.env.COMSPEC || 'bash'}`,
    `Date: ${new Date().toISOString().split('T')[0]}`,
  ]

  const git = getGitContext(cwd)
  if (git) {
    parts.push('', `Git:\n${git}`)
  }

  const tools = allTools()
  if (tools.length > 0) {
    parts.push('', 'Available tools:')
    for (const t of tools) {
      parts.push(`- ${t.name}: ${t.description}`)
    }
  }

  parts.push(
    '',
    'Guidelines:',
    '- Read files before editing them.',
    '- Use Glob/Grep to find files instead of guessing paths.',
    '- Be concise in your responses.',
    '- When editing, provide exact string matches for old_string.',
    '- Run tests after making changes to verify correctness.',
  )

  cachedSystemPrompt = parts.join('\n')
  return cachedSystemPrompt
}

export function resetContext() {
  cachedSystemPrompt = null
}
