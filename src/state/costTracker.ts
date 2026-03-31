import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { getModelProfile } from '../config/models.js'

type ModelUsage = {
  inputTokens: number
  outputTokens: number
  costUSD: number
  requests: number
}

type CostState = {
  models: Map<string, ModelUsage>
  sessionStart: number
}

let state: CostState = { models: new Map(), sessionStart: Date.now() }

export function addUsage(model: string, usage: { prompt_tokens: number; completion_tokens: number }) {
  const profile = getModelProfile(model)
  const inputCost = (usage.prompt_tokens / 1000) * (profile?.costPer1kInput ?? 0.003)
  const outputCost = (usage.completion_tokens / 1000) * (profile?.costPer1kOutput ?? 0.015)
  const cost = inputCost + outputCost

  const existing = state.models.get(model) ?? { inputTokens: 0, outputTokens: 0, costUSD: 0, requests: 0 }
  state.models.set(model, {
    inputTokens: existing.inputTokens + usage.prompt_tokens,
    outputTokens: existing.outputTokens + usage.completion_tokens,
    costUSD: existing.costUSD + cost,
    requests: existing.requests + 1,
  })
}

export function getTotalCost(): number {
  let total = 0
  for (const usage of state.models.values()) total += usage.costUSD
  return total
}

export function getTotalTokens(): number {
  let total = 0
  for (const usage of state.models.values()) total += usage.inputTokens + usage.outputTokens
  return total
}

export function formatCostSummary(): string {
  const total = getTotalCost()
  const elapsed = Math.floor((Date.now() - state.sessionStart) / 1000)
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const time = mins > 0 ? `${mins}m${secs}s` : `${secs}s`
  return `$${total.toFixed(4)} | ${time}`
}

export function formatTokenCount(): string {
  const total = getTotalTokens()
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k`
  return `${total}`
}

const COST_FILE = join(homedir(), '.darce', 'session-cost.json')

export function saveCosts(sessionId: string) {
  const dir = dirname(COST_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const data = {
    sessionId,
    models: Object.fromEntries(state.models),
    sessionStart: state.sessionStart,
  }
  writeFileSync(COST_FILE, JSON.stringify(data))
}

export function restoreCosts(sessionId: string): boolean {
  try {
    if (!existsSync(COST_FILE)) return false
    const data = JSON.parse(readFileSync(COST_FILE, 'utf-8'))
    if (data.sessionId !== sessionId) return false
    state = {
      models: new Map(Object.entries(data.models)),
      sessionStart: data.sessionStart,
    }
    return true
  } catch {
    return false
  }
}

export function resetCosts() {
  state = { models: new Map(), sessionStart: Date.now() }
}
