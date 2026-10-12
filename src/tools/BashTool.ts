import { z } from 'zod'
import { spawn } from 'node:child_process'
import type { ToolDef } from './Tool.js'
import type { ToolResult, ToolContext } from '../types.js'
import { safeEnv } from '../utils/env.js'

const inputSchema = z.object({
  command: z.string().describe('Shell command to execute'),
  description: z.string().optional().describe('Short description of what this command does'),
  timeout: z.number().optional().describe('Timeout in milliseconds (default 120000)'),
})

type Input = z.infer<typeof inputSchema>
type Output = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  timeoutMs?: number
  aborted?: boolean
  overflowed?: boolean // killed for producing too much output
  background?: boolean // something it started still holds the output pipe
}

const MAX_OUTPUT = 10_000_000
const KILL_GRACE_MS = 2000
// Long enough to collect output still in the pipe after exit, short enough not to wait on `cmd &`
const DRAIN_MS = 200
const isWindows = process.platform === 'win32'

/** Keeps the first and last `keep` chars of a stream without holding all of it. */
class Capture {
  head = ''
  tail = ''
  total = 0
  constructor(private keep: number) {}
  push(s: string) {
    this.total += s.length
    const room = this.keep - this.head.length
    if (room > 0) { this.head += s.slice(0, room); s = s.slice(room) }
    if (!s) return
    this.tail += s
    if (this.tail.length > this.keep * 2) this.tail = this.tail.slice(-this.keep)
  }
  text(): string {
    const tail = this.tail.slice(-this.keep)
    const omitted = this.total - this.head.length - tail.length
    return omitted > 0 ? `${this.head}\n\n... (${omitted} characters truncated) ...\n\n${tail}` : this.head + tail
  }
}

// Commands run in their own process group; make sure none outlive Darce
const running = new Set<number>()
process.once('exit', () => { for (const pid of running) try { process.kill(-pid, 'SIGKILL') } catch {} })

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
      // Credentials in the user's environment are withheld unless allowed via passEnv
      const { env } = safeEnv(process.env, context.passEnv)
      // Own process group, so a timeout or abort reaches everything the command started
      const proc = spawn(shell, ['-c', input.command], {
        cwd: context.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWindows,
      })
      const pid = proc.pid
      if (pid && !isWindows) running.add(pid)

      const stdout = new Capture(15000)
      const stderr = new Capture(5000)
      let timedOut = false
      let aborted = false
      let overflowed = false
      let exitCode: number | null = null
      let done = false
      let drain: NodeJS.Timeout | undefined
      let forceKill: NodeJS.Timeout | undefined

      const kill = (signal: NodeJS.Signals) => {
        try {
          if (pid && !isWindows) process.kill(-pid, signal)
          else proc.kill(signal)
        } catch {}
      }
      const stop = () => {
        kill('SIGTERM')
        forceKill ??= setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS)
        forceKill.unref()
      }
      const timer = setTimeout(() => { timedOut = true; stop() }, timeout)
      const onAbort = () => { aborted = true; stop() }

      const finish = (background: boolean, error?: string) => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearTimeout(drain)
        context.abortSignal?.removeEventListener('abort', onAbort)
        // A background job (`cmd &`) may keep the pipe open: keep draining it (closing it would kill the job
        // with SIGPIPE on its next write), drop the output, and don't let it keep Darce running
        for (const s of [proc.stdout, proc.stderr]) {
          s.removeAllListeners('data')
          s.resume()
          ;(s as unknown as { unref?: () => void }).unref?.()
        }
        if (pid) running.delete(pid)
        const err = stderr.text()
        resolve({
          data: {
            stdout: stdout.text(),
            stderr: error ? (err ? `${err}\n${error}` : error) : err,
            exitCode,
            timedOut,
            timeoutMs: timeout,
            aborted: aborted || undefined,
            overflowed: overflowed || undefined,
            background: (background && !timedOut && !aborted && !overflowed) || undefined,
          },
        })
      }

      const onData = (cap: Capture) => (s: string) => {
        cap.push(s)
        if (!overflowed && stdout.total + stderr.total > MAX_OUTPUT) { overflowed = true; stop() }
      }
      // Decode as UTF-8 across chunk boundaries so multibyte characters aren't split
      proc.stdout.setEncoding('utf8').on('data', onData(stdout))
      proc.stderr.setEncoding('utf8').on('data', onData(stderr))

      proc.on('error', (err) => finish(false, err.message))
      proc.on('exit', (code) => {
        exitCode = code
        drain = setTimeout(() => finish(true), DRAIN_MS)
      })
      proc.on('close', () => finish(false))

      if (context.abortSignal) {
        if (context.abortSignal.aborted) onAbort()
        else context.abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    })
  },

  formatResult(output: Output): string {
    const parts: string[] = []
    if (output.timedOut) parts.push(`Command timed out${output.timeoutMs ? ` after ${output.timeoutMs / 1000}s` : ''} and was stopped.`)
    if (output.aborted) parts.push('Command was interrupted.')
    if (output.overflowed) parts.push(`Command was stopped after producing over ${MAX_OUTPUT / 1_000_000}MB of output; only the start and end are shown. Redirect to a file or filter the output.`)
    if (output.stdout) parts.push(output.stdout)
    if (output.stderr) parts.push(`STDERR:\n${output.stderr}`)
    if (output.exitCode !== null && output.exitCode !== 0) {
      parts.push(`Exit code: ${output.exitCode}`)
    }
    if (output.background) parts.push('(The command exited, but a process it started is still running in the background and holding its output. Its later output is not captured; redirect it to a file to read it.)')
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
