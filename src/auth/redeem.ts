import { loadConfig, globalRcProblem } from '../config/config.js'
import { callApi, failure } from './http.js'

/** Turn an early-beta code into Power access on this account. Returns a sentence to show. */
export async function redeemCode(code: string): Promise<string> {
  if (!code.trim()) return 'Usage: darce redeem <CODE>'
  const config = loadConfig()
  const problem = !config.apiKey && globalRcProblem()
  if (problem) return problem
  if (!config.apiKey) return 'Sign in first: run `darce signup` (or `darce login`), then redeem the code.'
  try {
    const r = await callApi(`${config.apiBase || 'https://api.darce.dev'}/v1/redeem`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim() }),
    })
    return r.ok ? String(r.data.message || 'Done.') : failure(r, "Couldn't redeem that code")
  } catch (err) {
    return (err as Error).message
  }
}
