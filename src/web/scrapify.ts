import { loadConfig } from '../config/config.js'

// Scrapify: stealth fetching through a real (patched) browser that gets past bot walls.
export type ScrapifyConfig = { url: string; token: string }

export function scrapifyConfig(): ScrapifyConfig | null {
  const cfg = loadConfig() as { scrapify?: { url?: string; token?: string } }
  const url = process.env.SCRAPIFY_URL || cfg.scrapify?.url
  const token = process.env.SCRAPIFY_TOKEN || cfg.scrapify?.token
  return url && token ? { url: url.replace(/\/$/, ''), token } : null
}

export type ScrapifyResult = { url: string; status: number; modeUsed: string; title: string; html: string; bodyText: string }

export async function scrapifyFetch(url: string, mode: 'auto' | 'stealthy' = 'auto', signal?: AbortSignal): Promise<ScrapifyResult> {
  const cfg = scrapifyConfig()
  if (!cfg) throw new Error('Stealth fetching is not set up. Add "scrapify": { "url": "…", "token": "…" } to ~/.darcerc, or set SCRAPIFY_URL and SCRAPIFY_TOKEN.')
  const res = await fetch(`${cfg.url}/fetch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, mode, timeoutMs: 45_000 }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
  })
  const data = (await res.json().catch(() => ({}))) as Partial<ScrapifyResult> & { error?: string }
  if (!res.ok) throw new Error(data.error || `Stealth fetch failed (${res.status})`)
  return data as ScrapifyResult
}
