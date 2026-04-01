import { z } from 'zod'
import type { ToolDef } from './Tool.js'
import type { OpenRouterTool } from '../providers/provider.js'

const tools = new Map<string, ToolDef>()

export function register(tool: ToolDef) {
  tools.set(tool.name, tool)
}

export function getTool(name: string): ToolDef | undefined {
  return tools.get(name)
}

export function allTools(): ToolDef[] {
  return [...tools.values()]
}

export function toAPITools(): OpenRouterTool[] {
  return allTools().map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.inputSchema) as Record<string, unknown>,
    },
  }))
}
