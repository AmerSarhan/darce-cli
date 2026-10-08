import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ModelProfile } from '../types.js'

// Offline fallback — the live catalog is fetched from OpenRouter by loadModels()

export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'qwen/qwen3-coder',
    strengths: ['coding', 'fast'],
    contextWindow: 262144,
    costPer1kInput: 0.0003,
    costPer1kOutput: 0.001,
  },
  {
    id: 'qwen/qwen3-coder-next',
    strengths: ['coding', 'fast', 'cheap'],
    contextWindow: 262144,
    costPer1kInput: 0.00012,
    costPer1kOutput: 0.0008,
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    strengths: ['coding', 'reasoning'],
    contextWindow: 1000000,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.01,
  },
  {
    id: 'anthropic/claude-opus-5.5',
    strengths: ['coding', 'reasoning', 'agentic'],
    contextWindow: 1000000,
    costPer1kInput: 0.004,
    costPer1kOutput: 0.02,
  },
  {
    id: 'openai/gpt-5.6-sol',
    strengths: ['coding', 'reasoning'],
    contextWindow: 1050000,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.01,
  },
  {
    id: 'x-ai/grok-4.7',
    strengths: ['coding', 'reasoning', 'fast'],
    contextWindow: 500000,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.006,
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    strengths: ['coding', 'reasoning', 'vision'],
    contextWindow: 1048576,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.012,
  },
  {
    id: 'google/gemini-3.8-flash',
    strengths: ['coding', 'fast', 'vision'],
    contextWindow: 1048576,
    costPer1kInput: 0.00075,
    costPer1kOutput: 0.00375,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    strengths: ['coding', 'reasoning'],
    contextWindow: 1048576,
    costPer1kInput: 0.00096,
    costPer1kOutput: 0.0019,
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    strengths: ['coding', 'fast', 'cheap'],
    contextWindow: 1048576,
    costPer1kInput: 0.0003,
    costPer1kOutput: 0.0012,
  },
  {
    id: 'moonshotai/kimi-k3',
    strengths: ['coding', 'agentic'],
    contextWindow: 1048576,
    costPer1kInput: 0.0006,
    costPer1kOutput: 0.0123,
  },
  {
    id: 'z-ai/glm-5.3',
    strengths: ['coding', 'cheap'],
    contextWindow: 1048576,
    costPer1kInput: 0.00005,
    costPer1kOutput: 0.0034,
  },
]

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_PATH = join(homedir(), '.darce', 'models.json')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

let catalog: ModelProfile[] = MODEL_PROFILES

type OpenRouterModel = {
  id: string
  name?: string
  created?: number
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  supported_parameters?: string[]
}

// Keep only chat models that can call tools — Darce is useless without them
export function toModelProfiles(models: OpenRouterModel[]): ModelProfile[] {
  return models
    .filter(m => m.supported_parameters?.includes('tools'))
    .filter(m => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text'))
    .filter(m => !m.id.endsWith(':batch'))
    .map(m => {
      const strengths: string[] = []
      if (m.architecture?.input_modalities?.includes('image')) strengths.push('vision')
      if (m.supported_parameters?.includes('reasoning')) strengths.push('reasoning')
      if (m.id.endsWith(':free')) strengths.push('free')
      return {
        id: m.id,
        name: m.name,
        created: m.created,
        strengths,
        contextWindow: m.context_length ?? 0,
        costPer1kInput: Math.max(0, Number(m.pricing?.prompt ?? 0) * 1000),
        costPer1kOutput: Math.max(0, Number(m.pricing?.completion ?? 0) * 1000),
      }
    })
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
}

function readCache(): { fetchedAt: number; models: ModelProfile[] } | null {
  try {
    if (!existsSync(CACHE_PATH)) return null
    return JSON.parse(readFileSync(CACHE_PATH, 'utf-8'))
  } catch {
    return null
  }
}

// Fetch the live OpenRouter catalog (cached for 24h). Never throws — falls back to cache, then MODEL_PROFILES.
export async function loadModels(opts: { force?: boolean } = {}): Promise<ModelProfile[]> {
  const cached = readCache()
  if (cached?.models.length && !opts.force && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    catalog = cached.models
    return catalog
  }

  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { data: OpenRouterModel[] }
    const models = toModelProfiles(data.data)
    if (models.length > 0) {
      catalog = models
      try {
        mkdirSync(join(homedir(), '.darce'), { recursive: true })
        writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), models }))
      } catch {}
      return catalog
    }
  } catch {}

  if (cached?.models.length) catalog = cached.models
  return catalog
}

export function getModels(): ModelProfile[] {
  return catalog
}

export function getModelProfile(modelId: string): ModelProfile | undefined {
  return catalog.find(m => m.id === modelId) ?? MODEL_PROFILES.find(m => m.id === modelId)
}
