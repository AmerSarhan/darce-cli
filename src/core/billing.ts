import { exec } from 'node:child_process'

export type CheckoutResult = { url: string } | { error: string; alreadyPaid?: boolean }

/** Ask the Darce API for a Stripe checkout link. */
export async function createCheckout(apiKey: string, apiBase = 'https://api.darce.dev', plan?: 'builder' | 'power'): Promise<CheckoutResult> {
  try {
    const res = await fetch(`${apiBase}/v1/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: plan ? JSON.stringify({ plan }) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string; message?: string }
    if (res.ok && data.url) return { url: data.url }
    const error = data.error || data.message || `Checkout failed (${res.status})`
    return { error, alreadyPaid: /already/i.test(error) }
  } catch (err) {
    return { error: `Could not reach darce.dev: ${(err as Error).message}` }
  }
}

export function openInBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
  exec(cmd, () => {})
}
