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
// Live "most popular" order from OpenRouter (model ids), refreshed with the catalog
let popularity: string[] = []
const POPULAR_URL = 'https://openrouter.ai/api/frontend/v1/models/find?active=true&fmt=cards&order=most-popular'

/** Fetch OpenRouter's most-popular ranking. It's a large response, so only the order is kept. */
async function fetchPopularity(): Promise<string[]> {
  try {
    const res = await fetch(POPULAR_URL, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: { models?: Array<{ slug?: string }> } | Array<{ slug?: string }> }
    const list = Array.isArray(body.data) ? body.data : body.data?.models ?? []
    return list.map(m => m.slug).filter((s): s is string => typeof s === 'string')
  } catch {
    return []
  }
}

type OpenRouterModel = {
  id: string
  name?: string
  created?: number
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  supported_parameters?: string[]
}

/**
 * Can this model drive a coding agent? Tool calling alone isn't enough: these are left out of the
 * picker (a model named with --model or /model still works).
 */
const NOT_FOR_CODING = [
  /audio|voxtral|whisper|tts|omni/i,               // speech and omni (audio/video) models
  /image|banana/i,                                 // image generators
  /guard|safeguard|moderation/i,                   // safety classifiers
  /euryale|sao10k|thedrummer|gryphe|anthracite|mancer|undi95|lumimaid|magnum|roleplay|rp-/i, // roleplay/creative finetunes
  /(^|[-/])vl([-/:]|$)|\dv(-|$)|vision/i,          // vision-specialised variants (qwen3-vl, glm-4.6v, glm-5v-turbo)
  /^openrouter\/|router/i,                         // routers pick an unknown model per request
  /:online$|deep-research|relace-search|saba/i,   // web/research wrappers and regional-language models
  /nano|micro/i,                                   // too small for multi-step tool use
  /gpt-[\w.]*chat|chatgpt/i,                      // chat-tuned variants of agentic models
  /-(sante|fin|med|legal)(\W|$)/i,                 // domain finetunes (health, finance…)
]
const RELEASED_AFTER = Date.UTC(2025, 0, 1) / 1000 // older generations are superseded for agent work
const MIN_CONTEXT = 64_000

export function isCodingModel(m: { id: string; created?: number; contextWindow?: number }): boolean {
  if (NOT_FOR_CODING.some(re => re.test(m.id))) return false
  if (m.created && m.created < RELEASED_AFTER) return false
  if (m.contextWindow && m.contextWindow < MIN_CONTEXT) return false
  // Dense models of 14B parameters or fewer (e.g. -8b, -14b) aren't reliable agents; MoE ids like 30b-a3b are judged by total size
  const size = /[-_](\d+(?:\.\d+)?)b(?:[-_:]|$)/i.exec(m.id.split('/')[1] ?? m.id)
  if (size && Number(size[1]) <= 14) return false
  return true
}

// Keep only chat models that can call tools and can drive a coding agent
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
    .filter(isCodingModel)
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
}

function readCache(): { fetchedAt: number; models: ModelProfile[]; popular?: string[] } | null {
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
    // Caches from older versions may still hold models that aren't fit for coding
    catalog = cached.models.filter(isCodingModel)
    const usable = new Set(catalog.map(m => m.id))
    popularity = (cached.popular ?? []).filter(id => usable.has(id))
    popularity = cached.popular ?? []
    return catalog
  }

  try {
    const [res, popular] = await Promise.all([fetch(MODELS_URL, { signal: AbortSignal.timeout(8000) }), fetchPopularity()])
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { data: OpenRouterModel[] }
    const models = toModelProfiles(data.data)
    if (models.length > 0) {
      catalog = models
      // Keep only popular models Darce can actually use (tool calling)
      const usable = new Set(models.map(m => m.id))
      popularity = popular.filter(id => usable.has(id))
      try {
        mkdirSync(join(homedir(), '.darce'), { recursive: true })
        writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), models, popular: popularity }))
      } catch {}
      return catalog
    }
  } catch {}

  if (cached?.models.length) {
    catalog = cached.models.filter(isCodingModel)
    popularity = cached.popular ?? []
  }
  return catalog
}

/** Most popular first: OpenRouter's live ranking when available, otherwise the curated list. */
export function popularModels(limit = 15): string[] {
  return (popularity.length ? popularity : POPULAR_MODELS).slice(0, limit)
}

export function getModels(): ModelProfile[] {
  return catalog
}

export function getModelProfile(modelId: string): ModelProfile | undefined {
  return catalog.find(m => m.id === modelId) ?? MODEL_PROFILES.find(m => m.id === modelId)
}


// Popular coding models, in the order most people reach for them. OpenRouter has no public
// popularity API, so this is curated; anything missing from the live catalog is skipped.
export const POPULAR_MODELS = [
  'anthropic/claude-sonnet-5.5',
  'openai/gpt-5.6-sol',
  'google/gemini-3.1-pro-preview',
  'qwen/qwen3-coder',
  'anthropic/claude-opus-5.5',
  'deepseek/deepseek-v4-pro',
  'moonshotai/kimi-k3',
  'x-ai/grok-4.7',
  'google/gemini-3.8-flash',
  'z-ai/glm-5.3',
  'qwen/qwen3-coder-next',
  'deepseek/deepseek-v4.1-flash',
]

const RECENT_PATH = join(homedir(), '.darce', 'recent-models.json')

export function recentModels(): string[] {
  try {
    const data = JSON.parse(readFileSync(RECENT_PATH, 'utf-8'))
    return Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function recordModelUse(id: string) {
  try {
    const list = [id, ...recentModels().filter(m => m !== id)].slice(0, 6)
    mkdirSync(join(homedir(), '.darce'), { recursive: true })
    writeFileSync(RECENT_PATH, JSON.stringify(list))
  } catch {}
}

/** "Claude Sonnet 5.5" from "Anthropic: Claude Sonnet 5.5" (or a tidied id). */
export function displayName(m: ModelProfile): string {
  if (m.name) return m.name.replace(/^[^:]+:\s*/, '')
  return m.id.split('/').pop()!.replace(/[-_]/g, ' ')
}

export function vendorOf(id: string): string {
  const v = id.replace(/^~/, '').split('/')[0] ?? ''
  const names: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', 'x-ai': 'xAI', deepseek: 'DeepSeek', qwen: 'Qwen', moonshotai: 'Moonshot', 'z-ai': 'Z.ai', 'meta-llama': 'Meta', meta: 'Meta', mistralai: 'Mistral', minimax: 'MiniMax', xiaomi: 'Xiaomi', tencent: 'Tencent', nvidia: 'NVIDIA', amazon: 'Amazon', microsoft: 'Microsoft', cohere: 'Cohere', perplexity: 'Perplexity', inception: 'Inception', baidu: 'Baidu', bytedance: 'ByteDance' }
  return names[v] ?? v
}

/** Price level by output cost per million tokens. */
export function priceLevel(m: ModelProfile): string {
  const perM = m.costPer1kOutput * 1000
  if (perM === 0) return 'free'
  return perM < 1.5 ? '$' : perM < 6 ? '$$' : perM < 16 ? '$$$' : '$$$$'
}
