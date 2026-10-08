import { parse } from 'shell-quote'
import { resolve, relative, isAbsolute, dirname } from 'node:path'
import { realpathSync, existsSync } from 'node:fs'

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
  'tree', 'which', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'date', 'whoami', 'uname', 'printenv', 'id',
  'diff', 'cmp', 'uniq', 'cut', 'tr', 'jq', 'yq', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'column',
  'true', 'false', 'test', '[', 'sleep', 'ps', 'top', 'uptime', 'history', 'man', 'tldr', 'cal', 'bat',
])

// Commands that run another command: score the wrapped command instead
const WRAPPERS = new Set(['env', 'xargs', 'timeout', 'nice', 'nohup', 'command', 'builtin', 'exec', 'time', 'stdbuf', 'caffeinate', 'unbuffer'])
// Interpreters: running a project file is "changes the project", but inline code is opaque
const INTERPRETERS = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'python', 'python3', 'ruby', 'php', 'perl', 'deno', 'bun', 'lua', 'Rscript', 'osascript'])
const INLINE_FLAGS = new Set(['-e', '-c', '-p', '-r', '-E', '--eval', '--print', '-pe', '-ne', '-le'])
// Download-and-run package runners
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx', 'pipx'])

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag', 'shortlog', 'reflog', 'grep'])
const GIT_WRITE_LOCAL = new Set(['add', 'commit', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'cherry-pick', 'revert', 'mv', 'rm', 'init', 'worktree', 'stash'])
const GIT_NETWORK = new Set(['push', 'pull', 'fetch', 'clone', 'submodule'])

const PKG_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'poetry', 'uv', 'cargo', 'go', 'gem', 'bundle', 'composer', 'mvn', 'gradle', 'dotnet', 'deno'])
const PKG_INSTALL = new Set(['install', 'i', 'add', 'update', 'upgrade', 'up', 'remove', 'rm', 'uninstall', 'un', 'get', 'publish', 'link', 'ci', 'sync', 'dlx', 'exec', 'x'])
const BUILD_TOOLS = new Set(['tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'pytest', 'ruff', 'black', 'mypy', 'make', 'cmake', 'java', 'javac', 'rustc', 'gcc', 'clang', 'swift', 'mkdir', 'touch', 'cp', 'mv', 'ln', 'next', 'vite', 'webpack', 'turbo', 'nx', 'biome'])
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

/** Real path of `p`, resolving symlinks through its nearest existing ancestor. */
function realish(p: string): string {
  let cur = p
  const rest: string[] = []
  while (!existsSync(cur)) {
    const up = dirname(cur)
    if (up === cur) return p
    rest.unshift(cur.slice(up.length + 1))
    cur = up
  }
  try { return resolve(realpathSync(cur), ...rest) } catch { return p }
}

export function outside(path: string, cwd: string): boolean {
  if (path === '/dev/null' || path.startsWith('/dev/std') || path.startsWith('&')) return false
  // Unexpanded variables, command substitution or another user's home: can't know where it lands
  if (/[$`]/.test(path) || /^~[^/]/.test(path)) return true
  const abs = isAbsolute(path) ? path : resolve(cwd, path.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
  const lexical = relative(cwd, abs)
  if (lexical.startsWith('..') || isAbsolute(lexical)) return true
  // A symlink inside the project can point anywhere
  const real = relative(realish(cwd), realish(abs))
  return real.startsWith('..') || isAbsolute(real)
}

/** Strip leading options of a wrapper command (and the duration for timeout) to find the wrapped command. */
function unwrap(cmd: string, args: string[]): string[] {
  let j = 0
  const takesValue = new Set(['-n', '-u', '-s', '-k', '-I', '-L', '-P', '-d', '-E', '-i', '-o', '-e', '--signal', '--kill-after', '--adjustment', '-C', '-S'])
  while (j < args.length) {
    const a = args[j]!
    if (cmd === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { j++; continue }
    if (a === '--') { j++; break }
    if (a.startsWith('-')) { j += takesValue.has(a) ? 2 : 1; continue }
    break
  }
  if (cmd === 'timeout' && j < args.length) j++ // the duration
  return args.slice(j)
}

/** A sed script that writes files (w/W) or runs commands (e). */
function sedWrites(args: string[]): boolean {
  const scripts: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '-e' || a === '--expression') { if (args[k + 1]) scripts.push(args[k + 1]!); k++ }
    else if (a === '-f' || a === '--file') return true
    else if (!a.startsWith('-') && scripts.length === 0) scripts.push(a)
  }
  return scripts.some(sc => /(^|[;\n{}])\s*[0-9,$]*\s*(\/[^/]*\/)?\s*[wWe](\s|$)/.test(sc) || /s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gpiImM0-9]*[we]/.test(sc))
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

  if (WRAPPERS.has(cmd)) {
    const inner = unwrap(cmd, args)
    if (!inner.length) return risk
    // xargs feeds its input to the command as arguments, so its targets are unknown
    const wrapped = classifySimple(inner, [], pipedFrom, cwd)
    return max(risk, cmd === 'xargs' ? max(wrapped, { level: 1, reason: `runs ${inner[0]} on piped input` }) : wrapped)
  }
  if (DESTRUCTIVE.has(cmd)) return { level: 3, reason: `${cmd} can change your system` }
  if (RUNNERS.has(cmd)) {
    // npx/bunx/pnpx run the project's own copy when it's installed; only a download is risky
    const bin = args.find(a => !a.startsWith('-'))
    const local = bin && (cmd === 'npx' || cmd === 'bunx' || cmd === 'pnpx') && !args.some(a => a === '--yes' || a === '-y' || a.startsWith('--package') || a === '-p')
      && existsSync(resolve(cwd, 'node_modules', '.bin', bin))
    return max(risk, local ? { level: 1, reason: `runs ${bin} from this project` } : { level: 2, reason: `${cmd} downloads and runs a package` })
  }
  if (INTERPRETERS.has(cmd)) {
    if (args.some(a => INLINE_FLAGS.has(a)) || (cmd === 'deno' && sub === 'eval') || (cmd === 'bun' && (sub === 'x' || sub === 'add' || sub === 'install'))) {
      return max(risk, { level: 2, reason: `${cmd} runs inline code or downloads packages` })
    }
    if (!args.length || args[0] === '-') return max(risk, { level: 2, reason: `${cmd} reads code from input` })
    return max(risk, { level: 1, reason: `runs ${cmd} ${sub}`.trim() })
  }
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
    // Options before the subcommand can set config that runs programs (core.pager, core.sshCommand…)
    if (args.some(a => a === '-c' || a.startsWith('--config-env') || a.startsWith('--exec-path'))) return max(risk, { level: 2, reason: 'git with config overrides can run programs' })
    if (sub === 'config') {
      const readOnly = args.some(a => a === '--get' || a === '--get-all' || a === '--get-regexp' || a === '--list' || a === '-l' || a === '--show-origin' && args.includes('--list'))
      return readOnly ? risk : max(risk, { level: 2, reason: 'changes git configuration, which can make git run programs' })
    }
    if (args.some(a => a.startsWith('-O') || a.startsWith('--open-files-in-pager') || a.startsWith('--ext-diff'))) return max(risk, { level: 2, reason: 'git option that runs another program' })
    const out = args.find(a => a.startsWith('--output='))
    if (out) risk = max(risk, outside(out.slice(9), cwd) ? { level: 2, reason: 'writes outside the project' } : { level: 1, reason: 'writes a file' })
    if (sub === 'stash' && (args.includes('list') || args.includes('show'))) return risk
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
  if (cmd === 'sed') {
    if (sedWrites(args)) return max(risk, { level: 2, reason: 'sed script writes files or runs commands' })
    if (!args.some(a => a === '-i' || a.startsWith('-i') || a === '--in-place')) return risk
    return max(risk, { level: 1, reason: 'edits files in place' })
  }
  if (cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk' || cmd === 'nawk') {
    const prog = args.filter(a => !a.startsWith('-')).join(' ')
    if (args.includes('-f') || /system\s*\(|\|\s*getline|getline|>|\|/.test(prog)) return max(risk, { level: 2, reason: 'awk program runs commands or writes files' })
    return risk
  }
  if (cmd === 'sort') {
    const o = args.findIndex(a => a === '-o' || a.startsWith('--output'))
    if (o === -1) return risk
    const target = args[o]!.startsWith('--output=') ? args[o]!.slice(9) : args[o + 1] ?? ''
    return max(risk, outside(target, cwd) ? { level: 2, reason: 'writes outside the project' } : { level: 1, reason: 'writes a file' })
  }
  if ((cmd === 'rg' || cmd === 'ag') && args.some(a => a.startsWith('--pre'))) return max(risk, { level: 2, reason: 'rg --pre runs a program on every file' })
  if (cmd === 'fd' || cmd === 'fdfind') {
    if (args.some(a => a === '-x' || a === '-X' || a.startsWith('--exec'))) return max(risk, { level: 2, reason: 'fd can run commands' })
    return risk
  }
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
    case 'Grep': {
      const p = String(input.file_path ?? input.path ?? '')
      return p && outside(p, cwd)
        ? { level: 2, reason: `reads outside the project (${p})` }
        : { level: 0, reason: 'read-only' }
    }
    case 'Skill':
    case 'Plan':
      return { level: 0, reason: 'read-only' }
    case 'Agent':
      // The thread's own steps are scored and approved one by one
      return { level: 0, reason: 'starts a thread' }
    case 'Remember':
      // Notes about the user follow you into every project, so they're confirmed
      return input.scope === 'user'
        ? { level: 2, reason: 'saves a note used in all your projects' }
        : { level: 1, reason: 'saves a note for this project' }
    case 'WebFetch':
    case 'WebSearch':
    case 'StealthFetch':
      return { level: 1, reason: 'reads from the web (untrusted content)' }
    case 'Edit':
    case 'Write':
    case 'Image': {
      const p = String(input.file_path ?? '')
      const refsOutside = name === 'Image' && Array.isArray(input.reference_images) && input.reference_images.some(r => outside(String(r), cwd))
      if (outside(p, cwd)) return { level: 3, reason: `writes outside the project (${p})` }
      if (refsOutside) return { level: 2, reason: 'sends an image from outside the project' }
      return { level: 1, reason: name === 'Write' ? 'creates or overwrites a file' : name === 'Image' ? 'generates an image (counts as 3 requests)' : 'edits a file' }
    }
    case 'Bash':
      return bashRisk(String(input.command ?? ''), cwd)
    default:
      return { level: 2, reason: 'unknown tool' }
  }
}

/** True when the command is one simple command: no pipes, chains, substitutions or redirects. */
export function isSimpleCommand(command: string): boolean {
  if (/\$\(|`|[\n\r]/.test(command)) return false
  try {
    const tokens = parse(command, (name: string) => `$${name}`) as Token[]
    return tokens.every(t => typeof t === 'string')
  } catch { return false }
}

/** Key used for "always allow" rules: the command and its subcommand, e.g. "npm install". */
export function trustKey(command: string): string {
  const words = command.trim().split(/\s+/).filter(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  const [cmd = '', sub = '', third = ''] = words
  if (!sub || sub.startsWith('-') || sub.includes('/')) return cmd
  // "npm run build" — trust the specific script, not every script
  return (sub === 'run' || sub === 'exec') && third && !third.startsWith('-') ? `${cmd} ${sub} ${third}` : `${cmd} ${sub}`
}
