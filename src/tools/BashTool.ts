import { z } from 'zod'
import { spawn } from 'node:child_process'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'

const inputSchema = z.object({
  command: z.string().describe('Shell command to execute'),
  description: z.string().optional().describe('Short description of what this command does'),
  timeout: z.number().optional().describe('Timeout in milliseconds (default 120000)'),
})

type Input = z.infer<typeof inputSchema>
type Output = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }

export const BashTool: ToolDef<typeof inputSchema, Output> = {
  name: 'Bash',
  description: 'Execute a shell command and return stdout/stderr. Use for running tests, installing packages, git operations, and other system commands.',
  inputSchema,
  isReadOnly: false,
  isConcurrencySafe: false,

  async call(input: Input, context: ToolContext): Promise<ToolResult<Output>> {
    const timeout = input.timeout ?? 120000
    const shell = process.env.SHELL || process.env.COMSPEC || 'bash'

    return new Promise((resolve) => {
      const proc = spawn(shell, ['-c', input.command], {
        cwd: context.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

      proc.on('error', (err) => {
        if ((err as any).code === 'ETIMEDOUT' || (err as any).killed) {
          timedOut = true
        }
        resolve({ data: { stdout, stderr: stderr || err.message, exitCode: null, timedOut } })
      })

      proc.on('close', (code) => {
        // Truncate very long output
        if (stdout.length > 30000) {
          stdout = stdout.slice(0, 15000) + '\n\n... (truncated) ...\n\n' + stdout.slice(-15000)
        }
        if (stderr.length > 10000) {
          stderr = stderr.slice(0, 5000) + '\n\n... (truncated) ...\n\n' + stderr.slice(-5000)
        }
        resolve({ data: { stdout, stderr, exitCode: code, timedOut } })
      })

      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', () => { proc.kill('SIGTERM') })
      }
    })
  },

  formatResult(output: Output): string {
    const parts: string[] = []
    if (output.timedOut) parts.push('Command timed out.')
    if (output.stdout) parts.push(output.stdout)
    if (output.stderr) parts.push(`STDERR:\n${output.stderr}`)
    if (output.exitCode !== null && output.exitCode !== 0) {
      parts.push(`Exit code: ${output.exitCode}`)
    }
    return parts.join('\n') || '(no output)'
  },

  activityDescription(input) {
    if (input.description) return input.description
    if (input.command) {
      const short = input.command.length > 60 ? input.command.slice(0, 57) + '...' : input.command
      return `Running: ${short}`
    }
    return 'Running command'
  },
}
