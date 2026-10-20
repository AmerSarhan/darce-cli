import { loadConfig, globalRcProblem } from '../config/config.js'
import { DEFAULT_API_BASE } from './accounts.js'
import { callApi, failure } from './http.js'

export type RedeemResult = { ok: boolean; message: string }

/**
 * Turn an early-beta code into Power access. Uses the account passed in (the REPL's active one, which
 * /login may have switched since launch), else the one in config. `message` is a sentence to show.
 */
export async function redeemCode(code: string, auth: { apiKey?: string; apiBase?: string } = {}): Promise<RedeemResult> {
  const fail = (message: string): RedeemResult => ({ ok: false, message })
  if (!code.trim()) return fail('Usage: darce redeem <CODE>')
  const config = auth.apiKey ? null : loadConfig()
  const apiKey = auth.apiKey || config?.apiKey
  const problem = !apiKey && globalRcProblem()
  if (problem) return fail(problem)
  if (!apiKey) return fail('Sign in first: run `darce signup` (or `darce login`), then redeem the code.')
  const base = (config ? config.apiBase : auth.apiBase) || DEFAULT_API_BASE
  try {
    const r = await callApi(`${base}/v1/redeem`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim() }),
    })
    return r.ok ? { ok: true, message: String(r.data.message || 'Done.') } : fail(failure(r, "Couldn't redeem that code"))
  } catch (err) {
    return fail((err as Error).message)
  }
}
