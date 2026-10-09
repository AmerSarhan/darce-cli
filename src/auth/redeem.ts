import { loadConfig } from '../config/config.js'

/** Turn an early-beta code into Power access on this account. Returns a sentence to show. */
export async function redeemCode(code: string): Promise<string> {
  if (!code.trim()) return 'Usage: darce redeem <CODE>'
  const config = loadConfig()
  if (!config.apiKey) return 'Sign in first: run `darce signup` (or `darce login`), then redeem the code.'
  try {
    const res = await fetch(`${config.apiBase || 'https://api.darce.dev'}/v1/redeem`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim() }),
    })
    const data = await res.json().catch(() => ({})) as { message?: string; error?: string }
    return data.message || data.error || (res.ok ? 'Done.' : `Couldn't redeem that code (${res.status}).`)
  } catch {
    return "Couldn't reach darce.dev. Check your connection and try again."
  }
}
