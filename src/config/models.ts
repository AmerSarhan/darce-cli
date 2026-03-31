import type { ModelProfile } from '../types.js'

export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'qwen/qwen3-coder',
    strengths: ['coding', 'fast', 'reasoning'],
    contextWindow: 256000,
    costPer1kInput: 0.00016,
    costPer1kOutput: 0.0007,
  },
  {
    id: 'x-ai/grok-4.1-fast',
    strengths: ['coding', 'fast', 'reasoning'],
    contextWindow: 131072,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
  },
  {
    id: 'anthropic/claude-sonnet-4',
    strengths: ['coding', 'reasoning', 'fast'],
    contextWindow: 200000,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
  },
  {
    id: 'deepseek/deepseek-chat',
    strengths: ['coding', 'fast'],
    contextWindow: 128000,
    costPer1kInput: 0.00014,
    costPer1kOutput: 0.00028,
  },
  {
    id: 'deepseek/deepseek-r1',
    strengths: ['coding', 'reasoning'],
    contextWindow: 128000,
    costPer1kInput: 0.00055,
    costPer1kOutput: 0.0022,
  },
  {
    id: 'google/gemini-2.5-pro',
    strengths: ['coding', 'reasoning', 'vision'],
    contextWindow: 1000000,
    costPer1kInput: 0.00125,
    costPer1kOutput: 0.01,
  },
  {
    id: 'meta-llama/llama-4-maverick',
    strengths: ['coding', 'fast'],
    contextWindow: 1000000,
    costPer1kInput: 0.0005,
    costPer1kOutput: 0.0005,
  },
]

export function getModelProfile(modelId: string): ModelProfile | undefined {
  return MODEL_PROFILES.find(m => m.id === modelId)
}
