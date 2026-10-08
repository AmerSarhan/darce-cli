import { parse } from 'shell-quote'
import { resolve, relative, isAbsolute } from 'node:path'

/**
 * Risk levels for tool calls:
 *   0  read-only            (ls, git status, Read, Grep)
 *   1  changes the project  (edits inside the repo, running tests/builds)
 *   2  reaches outside      (network, installs, writes outside the repo, unknown commands)
 *   3  destructive          (rm -rf, force-push, sudo, piping downloads into a shell)
 */
export type RiskLevel = 0 | 1 | 2 | 3
export type Risk = { level: RiskLevel; reason: string }

const READ_ONLY = new Set([
  'ls', 'll', 'la', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'pwd', 'echo', 'printf', 'grep', 'rg', 'ag', 'egrep', 'fgrep',
  'tree', 'which', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'date', 'whoami', 'uname', 'env', 'printenv', 'id',
  'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'column',
  'true', 'false', 'test', '[', 'sleep', 'ps', 'top', 'uptime', 'history', 'man', 'tldr', 'cal', 'bat', 'fd', 'awk',
])

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag', 'shortlog', 'reflog', 'grep', 'config', 'stash'])
const GIT_WRITE_LOCAL = new Set(['add', 'commit', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'cherry-pick', 'revert', 'mv', 'rm', 'init', 'worktree'])
const GIT_NETWORK = new Set(['push', 'pull', 'fetch', 'clone', 'submodule'])

const PKG_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'poetry', 'uv', 'cargo', 'go', 'gem', 'bundle', 'composer', 'mvn', 'gradle', 'dotnet', 'deno'])
const PKG_INSTALL = new Set(['install', 'i', 'add', 'update', 'upgrade', 'up', 'remove', 'rm', 'uninstall', 'un', 'get', 'publish', 'link', 'ci', 'sync', 'dlx', 'exec', 'x'])
const BUILD_TOOLS = new Set(['tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'pytest', 'ruff', 'black', 'mypy', 'make', 'cmake', 'node', 'tsx', 'ts-node', 'python', 'python3', 'ruby', 'php', 'java', 'javac', 'rustc', 'gcc', 'clang', 'swift', 'mkdir', 'touch', 'cp', 'mv', 'ln', 'sed', 'npx', 'next', 'vite', 'webpack', 'turbo', 'nx', 'biome'])
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'rsync', 'ftp', 'sftp', 'nc', 'netcat', 'telnet', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'docker', 'podman', 'kubectl', 'helm', 'terraform', 'gh', 'aws', 'gcloud', 'az', 'vercel', 'railway', 'fly', 'heroku', 'open', 'xdg-open'])
const DESTRUCTIVE = new Set(['sudo', 'su', 'doas', 'dd', 'mkfs', 'fdisk', 'diskutil', 'shutdown', 'reboot', 'halt', 'killall', 'pkill', 'launchctl', 'systemctl', 'crontab', 'chown', 'eval'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'])

const max = (a: Risk, b: Risk): Risk => (b.level > a.level ? b : a)

type Token = string | { op: string } | { comment: string } | { pattern: string } | Record<string, unknown>

/** Split a parsed command line into simple commands plus the operators that join them. */
function splitCommands(tokens: Token[]): { words: string[]; redirects: string[]; pipedFrom: boolean }[] {
  const out: { words: string[]; redirects: string[]; pipedFrom: boolean }[] = []
  let cur = { words: [] as string[], redirects: [] as string[], pipedFrom: false }
  let redirectNext = false
  for (const tok of tokens) {
    if (typeof tok === 'string') {
      if (redirectNext) { cur.redirects.push(tok); redirectNext = false } else cur.words.push(tok)
      continue
    }
    if ('pattern' in tok && typeof tok.pattern === 'string') { cur.words.push(tok.pattern); continue }
    if ('op' in tok && typeof tok.op === 'string') {
      const op = tok.op
      if (op === '>' || op === '>>' || op === '>&' || op === '>|' || op === '&>') { redirectNext = op !== '>&'; continue }
      if (op === '<' || op === '<<' || op === '<(' || op === '(' || op === ')') continue
      // command separators
      out.push(cur)
      cur = { words: [], redirects: [], pipedFrom: op === '|' || op === '|&' }
    }
  }
  out.push(cur)
  return out.filter(c => c.words.length > 0 || c.redirects.length > 0)
}

function outside(path: string, cwd: string): boolean {
  if (path === '/dev/null' || path.startsWith('/dev/std') || path.startsWith('&')) return false
  const abs = isAbsolute(path) ? path : resolve(cwd, path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
  const rel = relative(cwd, abs)
  return rel.startsWith('..') || isAbsolute(rel)
}

function classifySimple(words: string[], redirects: string[], pipedFrom: boolean, cwd: string): Risk {
  // Skip leading VAR=value assignments
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++
  const cmd = (words[i] ?? '').split('/').pop()!
  const args = words.slice(i + 1)
  const sub = args.find(a => !a.startsWith('-')) ?? ''

  let risk: Risk = { level: 0, reason: 'read-only' }
  for (const target of redirects) {
    risk = max(risk, outside(target, cwd)
      ? { level: 2, reason: `writes outside the project (${target})` }
      : { level: 1, reason: `writes ${target}` })
  }
  if (!cmd) return risk

  if (DESTRUCTIVE.has(cmd)) return { level: 3, reason: `${cmd} can change your system` }
  if (SHELLS.has(cmd) && pipedFrom) return { level: 3, reason: 'pipes downloaded or generated content into a shell' }
  if (SHELLS.has(cmd) && args.includes('-c')) return max(risk, { level: 2, reason: 'runs a nested shell command' })

  if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'shred' || cmd === 'unlink') {
    const recursive = args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')
    const force = args.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force')
    const targets = args.filter(a => !a.startsWith('-'))
    if (targets.some(t => outside(t, cwd) || t === '*' || t === '.' || t === '/' || t === '~')) return { level: 3, reason: 'deletes files outside the project or everything in a folder' }
    if (recursive && force) return { level: 3, reason: 'force-deletes folders recursively' }
    return max(risk, { level: 2, reason: 'deletes files' })
  }

  if (cmd === 'git') {
    if (GIT_NETWORK.has(sub)) {
      if (sub === 'push' && args.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a.startsWith('+'))) return { level: 3, reason: 'force-pushes and can overwrite remote history' }
      return max(risk, { level: 2, reason: `git ${sub} talks to a remote` })
    }
    if (sub === 'reset' && args.includes('--hard')) return { level: 3, reason: 'discards uncommitted work (git reset --hard)' }
    if (sub === 'clean' && args.some(a => /^-[a-zA-Z]*f/.test(a))) return { level: 3, reason: 'deletes untracked files (git clean -f)' }
    if (sub === 'branch' && args.some(a => a === '-D')) return max(risk, { level: 2, reason: 'force-deletes a branch' })
    if (sub === 'stash' && (args.includes('drop') || args.includes('clear'))) return max(risk, { level: 2, reason: 'drops stashed work' })
    if (GIT_READ.has(sub)) return risk
    if (GIT_WRITE_LOCAL.has(sub)) return max(risk, { level: 1, reason: `git ${sub} changes the repository` })
    return max(risk, { level: 2, reason: `git ${sub}` })
  }

  if (PKG_MANAGERS.has(cmd)) {
    if (PKG_INSTALL.has(sub)) return max(risk, { level: 2, reason: `${cmd} ${sub} downloads or publishes packages` })
    if (cmd === 'npm' && sub === 'run' && /^(deploy|publish|release)/.test(args[1] ?? '')) return max(risk, { level: 2, reason: `runs the ${args[1]} script` })
    return max(risk, { level: 1, reason: `${cmd} ${sub || ''}`.trim() })
  }

  if (cmd === 'find') {
    if (args.some(a => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok')) return max(risk, { level: 2, reason: 'find can delete or run commands' })
    return risk
  }
  if (cmd === 'chmod') return max(risk, args.some(a => a === '-R') ? { level: 2, reason: 'changes permissions recursively' } : { level: 1, reason: 'changes file permissions' })
  if (cmd === 'kill') return max(risk, { level: 2, reason: 'stops a process' })
  if (cmd === 'sed' && !args.some(a => a === '-i' || a.startsWith('-i'))) return risk
  if (READ_ONLY.has(cmd)) return risk
  if (NETWORK.has(cmd)) return max(risk, { level: 2, reason: `${cmd} reaches outside your machine or project` })
  if (BUILD_TOOLS.has(cmd)) {
    const outsideTarget = (cmd === 'cp' || cmd === 'mv' || cmd === 'ln') && args.filter(a => !a.startsWith('-')).some(a => outside(a, cwd))
    return max(risk, outsideTarget ? { level: 2, reason: `${cmd} touches files outside the project` } : { level: 1, reason: `runs ${cmd}` })
  }
  return max(risk, { level: 2, reason: `${cmd} is not a command Darce recognises` })
}

export function bashRisk(command: string, cwd: string): Risk {
  let tokens: Token[]
  try {
    tokens = parse(command, (name: string) => `$${name}`) as Token[]
  } catch {
    return { level: 2, reason: 'could not parse the command' }
  }
  if (/\$\(|`/.test(command)) {
    // Command substitution: score the outer command but never below "needs a look"
    const base = splitCommands(tokens).reduce<Risk>((r, c) => max(r, classifySimple(c.words, c.redirects, c.pipedFrom, cwd)), { level: 0, reason: 'read-only' })
    return max(base, { level: 2, reason: 'uses command substitution' })
  }
  return splitCommands(tokens).reduce<Risk>(
    (r, c) => max(r, classifySimple(c.words, c.redirects, c.pipedFrom, cwd)),
    { level: 0, reason: 'read-only' },
  )
}

export function toolRisk(name: string, input: Record<string, unknown>, cwd: string): Risk {
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return { level: 0, reason: 'read-only' }
    case 'WebFetch':
      return { level: 1, reason: 'fetches a web page (untrusted content)' }
    case 'Edit':
    case 'Write': {
      const p = String(input.file_path ?? '')
      return outside(p, cwd)
        ? { level: 3, reason: `writes outside the project (${p})` }
        : { level: 1, reason: name === 'Write' ? 'creates or overwrites a file' : 'edits a file' }
    }
    case 'Bash':
      return bashRisk(String(input.command ?? ''), cwd)
    default:
      return { level: 2, reason: 'unknown tool' }
  }
}

/** Key used for "always allow" rules: the command and its subcommand, e.g. "npm install". */
export function trustKey(command: string): string {
  const words = command.trim().split(/\s+/).filter(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  const [cmd = '', sub = '', third = ''] = words
  if (!sub || sub.startsWith('-') || sub.includes('/')) return cmd
  // "npm run build" — trust the specific script, not every script
  return (sub === 'run' || sub === 'exec') && third && !third.startsWith('-') ? `${cmd} ${sub} ${third}` : `${cmd} ${sub}`
}
