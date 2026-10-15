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

// Read-only commands whose operands are files: these read outside the project when given a path there
const PATH_READERS = new Set(['ls', 'll', 'la', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'rg', 'ag', 'egrep', 'fgrep',
  'tree', 'file', 'stat', 'du', 'diff', 'cmp', 'uniq', 'cut', 'nl', 'column', 'jq', 'yq', 'bat', 'realpath', 'readlink'])
// The first operand is a pattern or filter, not a file (unless given with -e / -f)
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'jq', 'yq'])
// Options whose value is the next word, so it isn't mistaken for a file
const VALUE_OPTS = new Set(['-e', '-f', '--regexp', '--file', '-g', '--glob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C', '-m', '--max-count', '-n', '-c', '--lines', '--bytes', '-d', '--delimiter', '-L', '-I', '--arg', '--argjson', '--slurpfile', '--rawfile'])

function pathOperands(cmd: string, args: string[]): string[] {
  const out: string[] = []
  let patternGiven = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') { out.push(...args.slice(i + 1)); break }
    if (VALUE_OPTS.has(a)) {
      if (a === '-e' || a === '--regexp' || a === '-f' || a === '--file') {
        patternGiven = true
        // -f reads its pattern from a file: that file counts too
        if (a === '-f' || a === '--file') out.push(args[i + 1] ?? '')
      }
      i++
      continue
    }
    if (a.startsWith('-')) continue
    out.push(a)
  }
  return PATTERN_FIRST.has(cmd) && !patternGiven ? out.slice(1) : out
}

// Commands that run another command: score the wrapped command instead
export const WRAPPERS = new Set(['env', 'xargs', 'timeout', 'nice', 'nohup', 'command', 'builtin', 'exec', 'time', 'stdbuf', 'caffeinate', 'unbuffer'])
// Interpreters: running a project file is "changes the project", but inline code is opaque
const INTERPRETERS = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'python', 'python3', 'ruby', 'php', 'perl', 'deno', 'bun', 'lua', 'Rscript', 'osascript'])
const INLINE_FLAGS = new Set(['-e', '-c', '-p', '-r', '-E', '--eval', '--print', '-pe', '-ne', '-le'])
// Effects that leave this machine can't be rolled back by /undo, so they always ask first
const OUTSIDE_EFFECT = /deploy|release|publish|migrat|seed|(^|[:._/-])db([:._/-]|$)|prod|push|drop|truncate|reset|rollback|upload|ship|terraform|infra/i
const DB_CLIENTS = new Set(['psql', 'pg_dump', 'pg_restore', 'mysql', 'mariadb', 'mongosh', 'mongo', 'redis-cli', 'cqlsh', 'clickhouse-client', 'prisma', 'drizzle-kit', 'knex', 'sequelize', 'supabase', 'pscale', 'neonctl', 'turso', 'atlas', 'flyway', 'liquibase', 'dbmate', 'goose'])
const DESTRUCTIVE_SQL = /\b(drop|truncate)\b|\bdelete\s+from\b|\balter\s+table\b.*\bdrop\b/i
const NO_UNDO = " (/undo can't reverse that)"
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
export function unwrap(cmd: string, args: string[]): string[] {
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
  // cd only moves the rest of a chain; inside the project that's harmless
  if (cmd === 'cd' || cmd === 'pushd' || cmd === 'popd') {
    const target = args.find(a => !a.startsWith('-'))
    if (cmd === 'popd' || !target || target === '-') return risk
    return outside(target, cwd) ? max(risk, { level: 2, reason: `works outside the project (${target})` }) : risk
  }
  if (DESTRUCTIVE.has(cmd)) return { level: 3, reason: `${cmd} can change your system` }
  if (RUNNERS.has(cmd)) {
    // npx/bunx/pnpx run the project's own copy when it's installed; only a download is risky
    const bin = args.find(a => !a.startsWith('-'))
    const local = bin && (cmd === 'npx' || cmd === 'bunx' || cmd === 'pnpx') && !args.some(a => a === '--yes' || a === '-y' || a.startsWith('--package') || a === '-p')
      && existsSync(resolve(cwd, 'node_modules', '.bin', bin))
    if (local && (DB_CLIENTS.has(bin!) || args.some(a => !a.startsWith('-') && OUTSIDE_EFFECT.test(a)))) {
      return max(risk, { level: 2, reason: `${bin} may change things outside this machine${NO_UNDO}` })
    }
    return max(risk, local ? { level: 1, reason: `runs ${bin} from this project` } : { level: 2, reason: `${cmd} downloads and runs a package` })
  }
  if (INTERPRETERS.has(cmd)) {
    if (args.some(a => INLINE_FLAGS.has(a)) || (cmd === 'deno' && sub === 'eval') || (cmd === 'bun' && (sub === 'x' || sub === 'add' || sub === 'install'))) {
      return max(risk, { level: 2, reason: `${cmd} runs inline code or downloads packages` })
    }
    if (!args.length || args[0] === '-') return max(risk, { level: 2, reason: `${cmd} reads code from input` })
    // e.g. scripts/seed.js, deploy.py, `manage.py migrate`, `artisan migrate`
    const named = args.slice(0, 3).find(a => !a.startsWith('-') && OUTSIDE_EFFECT.test(a))
    if (named) return max(risk, { level: 2, reason: `runs ${args.slice(0, 2).join(' ')}, which may change things outside this machine${NO_UNDO}` })
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
    // Global options come before the subcommand: -C <dir>, --git-dir <dir>, --no-pager, -P…
    let k = 0
    let gitDir: string | undefined
    while (k < args.length && args[k]!.startsWith('-')) {
      const a = args[k]!
      if (a === '-C' || a === '--git-dir' || a === '--work-tree') { if (a === '-C' || a === '--work-tree') gitDir = args[k + 1]; k += 2 }
      else if (a === '--namespace' || a === '-c') k += 2
      else { if (a.startsWith('--work-tree=')) gitDir = a.slice(12); k++ }
    }
    const gsub = args[k] ?? ''
    if (gitDir && outside(gitDir, cwd)) return max(risk, { level: 2, reason: `runs git in another folder (${gitDir})` })
    // Options before the subcommand can set config that runs programs (core.pager, core.sshCommand…)
    if (args.some(a => a === '-c' || a.startsWith('--config-env') || a.startsWith('--exec-path'))) return max(risk, { level: 2, reason: 'git with config overrides can run programs' })
    if (gsub === 'config') {
      // `git config user.name` (one key, no value) and `git config get|list` only read
      const ops: string[] = []
      const cfg = args.slice(k + 1)
      for (let i = 0; i < cfg.length; i++) {
        if (['-f', '--file', '--blob', '--type', '--default', '--comment'].includes(cfg[i]!)) { i++; continue }
        if (!cfg[i]!.startsWith('-')) ops.push(cfg[i]!)
      }
      const writes = cfg.some(a => /^--(unset|unset-all|add|replace-all|rename-section|remove-section|edit)$|^-e$/.test(a))
      const readOnly = args.some(a => a === '--get' || a === '--get-all' || a === '--get-regexp' || a === '--list' || a === '-l' || a === '--show-origin' && args.includes('--list'))
        || ops[0] === 'get' || ops[0] === 'list'
        || (!writes && ops.length === 1 && !['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(ops[0]!))
      return readOnly ? risk : max(risk, { level: 2, reason: 'changes git configuration, which can make git run programs' })
    }
    if (args.some(a => a.startsWith('-O') || a.startsWith('--open-files-in-pager') || a.startsWith('--ext-diff'))) return max(risk, { level: 2, reason: 'git option that runs another program' })
    const out = args.find(a => a.startsWith('--output='))
    if (out) risk = max(risk, outside(out.slice(9), cwd) ? { level: 2, reason: 'writes outside the project' } : { level: 1, reason: 'writes a file' })
    if (gsub === 'stash' && (args.includes('list') || args.includes('show'))) return risk
    const gargs = args.slice(k + 1)
    const has = (short: string, ...long: string[]) => gargs.some(a => long.some(l => a === l || a.startsWith(l + '=')) || (/^-[a-zA-Z]+$/.test(a) && [...short].some(c => a.includes(c))))
    const positional = gargs.filter(a => !a.startsWith('-'))
    if (GIT_NETWORK.has(gsub)) {
      // Level 3 so an "always allow git push" rule never covers these
      if (gsub === 'push' && (has('f', '--force', '--force-with-lease') || gargs.some(a => a.startsWith('+')))) return { level: 3, reason: 'force-pushes and can overwrite remote history' }
      if (gsub === 'push' && (has('d', '--delete', '--mirror', '--prune') || positional.some(a => a.startsWith(':')))) return { level: 3, reason: 'deletes or overwrites branches on the remote' }
      return max(risk, { level: 2, reason: `git ${gsub} talks to a remote` })
    }
    if (gsub === 'reset' && args.includes('--hard')) return { level: 3, reason: 'discards uncommitted work (git reset --hard)' }
    if (gsub === 'clean' && args.some(a => /^-[a-zA-Z]*f/.test(a))) return { level: 3, reason: 'deletes untracked files (git clean -f)' }
    if (gsub === 'stash' && (args.includes('drop') || args.includes('clear'))) return max(risk, { level: 2, reason: 'drops stashed work' })
    // Snapshots restore files, not refs: anything that deletes, moves or rewrites them asks
    if (gsub === 'branch') {
      if (has('dDfMC', '--delete', '--force')) return max(risk, { level: 2, reason: `deletes or force-moves a branch${NO_UNDO}` })
      const listing = has('lar', '--list', '--all', '--remotes', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--show-current')
      if (has('mcu', '--move', '--copy', '--set-upstream-to', '--unset-upstream', '--edit-description') || (positional.length && !listing)) return max(risk, { level: 1, reason: 'git branch changes the repository' })
      return risk
    }
    if (gsub === 'tag') {
      if (has('df', '--delete', '--force')) return max(risk, { level: 2, reason: `deletes or moves a tag${NO_UNDO}` })
      if (positional.length && !has('ln', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at')) return max(risk, { level: 1, reason: 'git tag creates a tag' })
      return risk
    }
    if (gsub === 'remote') {
      const op = positional[0] ?? ''
      if (['remove', 'rm', 'set-url', 'prune', 'update'].includes(op)) return max(risk, { level: 2, reason: `git remote ${op} changes where git pushes or deletes remote refs${NO_UNDO}` })
      if (op && !['show', 'get-url'].includes(op)) return max(risk, { level: 1, reason: `git remote ${op} changes the repository` })
      return risk
    }
    if (gsub === 'reflog' && ['expire', 'delete'].includes(positional[0] ?? '')) return max(risk, { level: 2, reason: `deletes reflog entries used to recover lost commits${NO_UNDO}` })
    if (gsub === 'commit' && has('', '--amend')) return max(risk, { level: 2, reason: `rewrites the last commit${NO_UNDO}` })
    if (gsub === 'rebase' && !has('', '--abort', '--quit')) return max(risk, { level: 2, reason: `rewrites commit history${NO_UNDO}` })
    if (gsub === 'checkout' && (gargs.includes('--') || gargs.includes('.') || has('f', '--force'))) return max(risk, { level: 2, reason: 'discards uncommitted changes to files' })
    if (gsub === 'reset') return max(risk, { level: 2, reason: `git reset moves the branch or unstages changes${NO_UNDO}` })
    if (GIT_READ.has(gsub)) return risk
    if (GIT_WRITE_LOCAL.has(gsub)) return max(risk, { level: 1, reason: `git ${gsub} changes the repository` })
    return max(risk, { level: 2, reason: `git ${gsub}` })
  }

  if (DB_CLIENTS.has(cmd)) {
    if (DESTRUCTIVE_SQL.test(args.join(' '))) return { level: 3, reason: `${cmd} runs destructive SQL against a database${NO_UNDO}` }
    return max(risk, { level: 2, reason: `${cmd} talks to a database${NO_UNDO}` })
  }
  // Project scripts whose names say they reach outside: deploys, migrations, seeds, releases
  const script = (PKG_MANAGERS.has(cmd) && (sub === 'run' || sub === 'run-script') ? args.filter(a => !a.startsWith('-'))[1]
    : ['make', 'just', 'rake', 'task', 'mage'].includes(cmd) ? args.find(a => !a.startsWith('-') && !a.includes('='))
    : (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') && sub && !PKG_INSTALL.has(sub) && !['test', 't', 'run', 'exec', 'x', 'start', 'build'].includes(sub) ? sub
    : undefined)
  if (script && OUTSIDE_EFFECT.test(script)) return max(risk, { level: 2, reason: `runs the "${script}" script, which may change things outside this machine${NO_UNDO}` })

  if (PKG_MANAGERS.has(cmd)) {
    if (PKG_INSTALL.has(sub)) return max(risk, { level: 2, reason: `${cmd} ${sub} downloads or publishes packages` })
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
  const writes = (target: string): Risk => outside(target, cwd) ? { level: 2, reason: `writes outside the project (${target})` } : { level: 1, reason: `writes ${target}` }
  if (cmd === 'sort' || cmd === 'tree') {
    const o = args.findIndex(a => a === '-o' || a.startsWith('--output'))
    if (o === -1) return risk
    return max(risk, writes(args[o]!.startsWith('--output=') ? args[o]!.slice(9) : args[o + 1] ?? ''))
  }
  if (cmd === 'yq' && args.some(a => a === '--inplace' || /^-[a-zA-Z]+$/.test(a) && a.includes('i'))) {
    const files = args.filter(a => !a.startsWith('-')).slice(1)
    return files.reduce<Risk>((r, f) => max(r, writes(f)), max(risk, { level: 1, reason: 'edits files in place' }))
  }
  if (cmd === 'uniq') {
    // uniq [input [output]]: the second operand is overwritten
    const operands: string[] = []
    for (let j = 0; j < args.length; j++) {
      const a = args[j]!
      if (a === '-f' || a === '-s' || a === '-w') j++
      else if (a === '-' || !a.startsWith('-')) operands.push(a)
    }
    return operands[1] && operands[1] !== '-' ? max(risk, writes(operands[1])) : risk
  }
  if ((cmd === 'rg' || cmd === 'ag') && args.some(a => a.startsWith('--pre'))) return max(risk, { level: 2, reason: 'rg --pre runs a program on every file' })
  if (cmd === 'fd' || cmd === 'fdfind') {
    if (args.some(a => a === '-x' || a === '-X' || a.startsWith('--exec'))) return max(risk, { level: 2, reason: 'fd can run commands' })
    return risk
  }
  if (READ_ONLY.has(cmd)) {
    // Same rule as the Read tool: reading a file outside the project (~/.ssh, ~/.aws, another repo) asks first
    const p = PATH_READERS.has(cmd) ? pathOperands(cmd, args).find(a => (a.includes('/') || a.startsWith('~')) && outside(a, cwd)) : undefined
    return p ? max(risk, { level: 2, reason: `reads outside the project (${p})` }) : risk
  }
  if (NETWORK.has(cmd)) return max(risk, { level: 2, reason: `${cmd} reaches outside your machine or project${NO_UNDO}` })
  if (BUILD_TOOLS.has(cmd)) {
    const outsideTarget = (cmd === 'cp' || cmd === 'mv' || cmd === 'ln') && args.filter(a => !a.startsWith('-')).some(a => outside(a, cwd))
    return max(risk, outsideTarget ? { level: 2, reason: `${cmd} touches files outside the project` } : { level: 1, reason: `runs ${cmd}` })
  }
  return max(risk, { level: 2, reason: `${cmd} is not a command Darce recognises` })
}

// Commands that only print what a substitution produced: its output can't become a path, a target or a program
const OUTPUT_ONLY = new Set(['echo', 'printf', 'test', '[', 'true', 'false', 'expr'])
const SUB = '__darce_sub__'

/**
 * Pull out `$(…)` and backtick substitutions (not inside single quotes), replacing each with a placeholder.
 * Returns null when the command can't be split cleanly (unbalanced or nested quoting we don't model).
 */
function extractSubstitutions(command: string): { outer: string; inner: string[] } | null {
  const inner: string[] = []
  let outer = ''
  let i = 0
  let quote: '"' | "'" | null = null
  while (i < command.length) {
    const ch = command[i]!
    if (quote === "'") { outer += ch; if (ch === "'") quote = null; i++; continue }
    if (ch === '\\') { outer += command.slice(i, i + 2); i += 2; continue }
    if (ch === "'" && !quote) { quote = "'"; outer += ch; i++; continue }
    if (ch === '"') { quote = quote === '"' ? null : '"'; outer += ch; i++; continue }
    if (ch === '$' && command[i + 1] === '(' && command[i + 2] !== '(') {
      let depth = 1, j = i + 2
      while (j < command.length && depth > 0) { if (command[j] === '(') depth++; else if (command[j] === ')') depth--; j++ }
      if (depth !== 0) return null
      inner.push(command.slice(i + 2, j - 1)); outer += SUB; i = j; continue
    }
    if (ch === '`') {
      const j = command.indexOf('`', i + 1)
      if (j === -1) return null
      inner.push(command.slice(i + 1, j)); outer += SUB; i = j + 1; continue
    }
    outer += ch; i++
  }
  return quote === "'" ? null : { outer, inner }
}

function scoreParsed(command: string, cwd: string): { risk: Risk; commands: ReturnType<typeof splitCommands> } | null {
  let tokens: Token[]
  try {
    tokens = parse(command, (name: string) => `$${name}`) as Token[]
  } catch {
    return null
  }
  const commands = splitCommands(tokens)
  return { risk: commands.reduce<Risk>((r, c) => max(r, classifySimple(c.words, c.redirects, c.pipedFrom, cwd)), { level: 0, reason: 'read-only' }), commands }
}

export function bashRisk(command: string, cwd: string, depth = 0): Risk {
  if (/\$\(|`/.test(command)) {
    const subs = depth < 3 ? extractSubstitutions(command) : null
    const outer = subs && scoreParsed(subs.outer, cwd)
    if (subs && outer) {
      const inner = subs.inner.reduce<Risk>((r, c) => max(r, bashRisk(c, cwd, depth + 1)), { level: 0, reason: 'read-only' })
      // Read-only commands whose output is only printed (echo "files: $(git ls-files | wc -l)") are as safe as the parts.
      // Anywhere else the output could become a path, a target or a program, so it still needs a look.
      const printedOnly = outer.commands.every(c => !c.words.some(w => w.includes(SUB)) || OUTPUT_ONLY.has(c.words[0] ?? ''))
        && !outer.commands.some(c => (c.words[0] ?? '').includes(SUB))
      if (printedOnly && inner.level === 0) return max(outer.risk, inner)
      return max(max(outer.risk, inner), { level: 2, reason: 'uses command substitution' })
    }
    const base = scoreParsed(command, cwd)
    if (!base) return { level: 2, reason: 'could not parse the command' }
    return max(base.risk, { level: 2, reason: 'uses command substitution' })
  }
  const scored = scoreParsed(command, cwd)
  return scored ? scored.risk : { level: 2, reason: 'could not parse the command' }
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
