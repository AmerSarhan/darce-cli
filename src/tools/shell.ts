import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export type ShellKind = 'posix' | 'powershell' | 'cmd'
export type Shell = { file: string; kind: ShellKind; name: string }

/** What the picker may look at; injected in tests so Windows choices can be checked anywhere. */
export type ShellProbe = {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** An executable file at this path */
  exists: (path: string) => boolean
}

const defaultProbe = (): ShellProbe => ({
  platform: process.platform,
  env: process.env,
  exists: (p) => {
    try {
      if (!statSync(p).isFile()) return false
      if (process.platform !== 'win32') accessSync(p, constants.X_OK)
      return true
    } catch { return false }
  },
})

// System32\bash.exe and the WindowsApps alias are WSL: a Linux filesystem, where Windows paths don't exist
const WSL_BASH = /\\(system32|sysnative|windowsapps)\\/i

/** Every match for an executable on PATH, in order, like `where`. */
function onPath(name: string, probe: ShellProbe): string[] {
  const path = probe.env.PATH ?? probe.env.Path ?? ''
  return path.split(';').filter(Boolean).map(dir => win32.join(dir.replace(/^"|"$/g, ''), name)).filter(probe.exists)
}

export function pickShell(probe: ShellProbe = defaultProbe()): Shell {
  const { env, exists } = probe
  if (probe.platform !== 'win32') {
    const file = env.SHELL && exists(env.SHELL) ? env.SHELL : exists('/bin/bash') ? '/bin/bash' : '/bin/sh'
    return { file, kind: 'posix', name: posix.basename(file) }
  }

  // Git Bash first: the model writes POSIX shell far more reliably than PowerShell or cmd
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const bashes = [
    env.SHELL && /bash(\.exe)?$/i.test(env.SHELL) ? env.SHELL : undefined,
    win32.join(programFiles, 'Git', 'bin', 'bash.exe'),
    win32.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
    ...onPath('bash.exe', probe),
  ]
  const bash = bashes.find((p): p is string => !!p && !WSL_BASH.test(p) && exists(p))
  if (bash) return { file: bash, kind: 'posix', name: 'bash' }

  const systemRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  const pwsh = onPath('pwsh.exe', probe)[0]
    ?? [win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ...onPath('powershell.exe', probe)].find(exists)
  if (pwsh) return { file: pwsh, kind: 'powershell', name: 'PowerShell' }

  return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', kind: 'cmd', name: 'cmd.exe' }
}

let cached: Shell | undefined
/** The shell Bash commands run in, picked once per process. */
export function systemShell(): Shell {
  return cached ??= pickShell()
}

/** How to spawn `command` in `shell`. */
export function shellInvocation(command: string, shell: Shell = systemShell()): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (shell.kind === 'powershell') return { file: shell.file, args: ['-NoProfile', '-NonInteractive', '-Command', command] }
  // cmd parses its own command line: quote it whole and stop Node escaping inner quotes, as Node's shell: true does
  if (shell.kind === 'cmd') return { file: shell.file, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true }
  return { file: shell.file, args: ['-c', command] }
}

/** The system prompt line, so the model writes commands for the shell they will run in. */
export function shellPromptLine(shell: Shell = systemShell()): string {
  if (shell.kind === 'powershell') return 'Shell: PowerShell (use PowerShell syntax)'
  if (shell.kind === 'cmd') return 'Shell: cmd.exe (use cmd syntax)'
  return `Shell: ${shell.name}`
}
