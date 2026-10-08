// Terminal side-channels: window title, tab progress, desktop notifications and
// clickable links. Each is feature-detected from the environment and degrades to nothing.

const env = process.env
const tty = !!process.stdout.isTTY && env.TERM !== 'dumb' && !env.CI
const inTmux = !!env.TMUX
const program = (env.TERM_PROGRAM ?? '').toLowerCase()
const isKitty = env.TERM === 'xterm-kitty' || !!env.KITTY_WINDOW_ID
const isGhostty = program === 'ghostty' || !!env.GHOSTTY_RESOURCES_DIR
const isITerm = program === 'iterm.app'
const isWezTerm = program === 'wezterm' || !!env.WEZTERM_PANE
const isWindowsTerminal = !!env.WT_SESSION
const isVSCode = program === 'vscode'

function versionAtLeast(v: string | undefined, min: number[]): boolean {
  if (!v) return false
  const parts = v.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i]!
  }
  return true
}

export const caps = {
  title: tty,
  // OSC 9;4 tab/taskbar progress — older iTerm2 would show it as a notification instead
  progress: tty && !inTmux && (isWindowsTerminal || isGhostty || isKitty || (isITerm && versionAtLeast(env.TERM_PROGRAM_VERSION, [3, 6, 6]))),
  notify: tty && !inTmux && (isKitty || isGhostty || isITerm || isWezTerm),
  links: tty && !env.DARCE_NO_LINKS && (isKitty || isGhostty || isITerm || isWezTerm || isWindowsTerminal || isVSCode || program === 'alacritty' || inTmux === false),
}

function write(seq: string) {
  if (tty) process.stdout.write(seq)
}

export function setTitle(text: string) {
  if (caps.title) write(`\x1b]2;${text.replace(/[\x00-\x1f]/g, '')}\x07`)
}

export function setProgress(state: 'busy' | 'error' | 'off') {
  if (!caps.progress) return
  write(state === 'busy' ? '\x1b]9;4;3;0\x07' : state === 'error' ? '\x1b]9;4;2;100\x07' : '\x1b]9;4;0;0\x07')
}

export function notify(title: string, body: string) {
  if (env.DARCE_NO_NOTIFY) return
  if (!caps.notify) {
    write('\x07') // bell: most terminals badge the tab or bounce the dock when unfocused
    return
  }
  const clean = (s: string) => s.replace(/[\x00-\x1f;]/g, ' ').slice(0, 200)
  if (isKitty) write(`\x1b]99;i=darce:d=0;${clean(title)}\x1b\\\x1b]99;i=darce:d=1:p=body;${clean(body)}\x1b\\`)
  else if (isGhostty || isWezTerm) write(`\x1b]777;notify;${clean(title)};${clean(body)}\x07`)
  else write(`\x1b]9;${clean(title)}: ${clean(body)}\x07`)
}

/** Clickable link to a local file; falls back to plain text. */
export function link(text: string, absPath: string): string {
  if (!caps.links) return text
  const url = isVSCode ? `vscode://file${absPath}` : `file://${absPath}`
  return `\x1b]8;;${encodeURI(url)}\x07${text}\x1b]8;;\x07`
}

/** Clickable web link (https://…); falls back to plain text. */
export function webLink(text: string, url: string): string {
  if (!caps.links) return text
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}
