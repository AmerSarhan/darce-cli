// Semantic color tokens. Components never hardcode colors — they ask for a role.

export type Theme = {
  accent: string // Darce ember: prompt marker, cursor, focus
  text: string
  muted: string
  faint: string
  success: string
  warning: string
  danger: string
  tool: string // tool names
  toolWrite: string // marker for tools that change the project
  diffAdd: string
  diffDel: string
}

const dark: Theme = {
  accent: '#E8913A',
  text: '#E6EAF0',
  muted: '#8A96A8',
  faint: '#5E6B7D',
  success: '#7CC48A',
  warning: '#E5C07B',
  danger: '#EF6F6C',
  tool: '#9CC3E6',
  toolWrite: '#E8913A',
  diffAdd: '#7CC48A',
  diffDel: '#EF6F6C',
}

const light: Theme = {
  accent: '#B45309',
  text: '#101828',
  muted: '#475467',
  faint: '#98A2B3',
  success: '#027A48',
  warning: '#B54708',
  danger: '#B42318',
  tool: '#1D4ED8',
  toolWrite: '#B45309',
  diffAdd: '#027A48',
  diffDel: '#B42318',
}

/**
 * Pick a palette. Explicit config wins; otherwise use COLORFGBG ("fg;bg"),
 * which many terminals set — a background index of 7 or 15 means light.
 */
export function resolveTheme(pref: 'dark' | 'light' | 'auto' = 'auto'): Theme {
  if (pref === 'dark') return dark
  if (pref === 'light') return light
  const bg = process.env.COLORFGBG?.split(';').pop()
  return bg === '7' || bg === '15' ? light : dark
}

let current: Theme = resolveTheme()

export function setTheme(pref: 'dark' | 'light' | 'auto') {
  current = resolveTheme(pref)
}

export function theme(): Theme {
  return current
}
