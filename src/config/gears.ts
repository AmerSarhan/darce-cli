import { getModelProfile } from './models.js'

// Cheapest → smartest. Shift+↑ / Shift+↓ moves along this list, even mid-task.
export const DEFAULT_GEARS = [
  'qwen/qwen3-coder-next',
  'anthropic/claude-haiku-5.5',
  'qwen/qwen3-coder',
  'deepseek/deepseek-v4-pro',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-opus-5.5',
]

export function gearIndex(gears: string[], model: string): number {
  return gears.indexOf(model)
}

/** The next model up (+1) or down (−1). Off-list models start from the nearest end. */
export function shiftGear(gears: string[], model: string, dir: 1 | -1): string {
  const i = gears.indexOf(model)
  if (i === -1) return dir === 1 ? gears[gears.length - 1]! : gears[0]!
  return gears[Math.max(0, Math.min(gears.length - 1, i + dir))]!
}

/** "$2/$10 per M · 6.7× qwen3-coder" — price context for a gear change. */
export function priceNote(to: string, from: string): string {
  const a = getModelProfile(to)
  const b = getModelProfile(from)
  if (!a) return ''
  const perM = (n: number) => `$${(n * 1000).toFixed(n * 1000 < 1 ? 2 : 1)}`
  const price = `${perM(a.costPer1kInput)}/${perM(a.costPer1kOutput)} per M`
  if (!b || !b.costPer1kOutput || !a.costPer1kOutput) return price
  const ratio = a.costPer1kOutput / b.costPer1kOutput
  const rel = ratio >= 1.05 ? `${ratio.toFixed(ratio >= 10 ? 0 : 1)}× the cost` : ratio <= 0.95 ? `${(1 / ratio).toFixed(1 / ratio >= 10 ? 0 : 1)}× cheaper` : 'same price'
  return `${price} · ${rel}`
}
