/** Calls to the Darce API from sign-in, sign-up, redeem and upgrade: bounded in time, never a raw parse error. */
export type ApiReply = { ok: boolean; status: number; data: { message?: string; error?: string; [k: string]: unknown } }

export class Unreachable extends Error {}

const TIMEOUT_MS = 15_000

function reason(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } }
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return `no answer in ${TIMEOUT_MS / 1000} s`
  return e.cause?.code ?? e.cause?.message ?? e.message
}

/** Throws Unreachable ("Couldn't reach darce.dev: …") when there's no response; otherwise the status and JSON body ({} if it isn't JSON). */
export async function callApi(url: string, init: RequestInit = {}): Promise<ApiReply> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const text = await res.text()
    let data: ApiReply['data'] = {}
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') data = parsed
    } catch { /* an HTML error page from a proxy */ }
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    throw new Unreachable(`Couldn't reach darce.dev: ${reason(err)}. Check your connection and try again.`)
  }
}

/** The server's own message, or a plain one for a status with no readable body. */
export function failure(r: ApiReply, what = 'Request failed'): string {
  if (r.data.message || r.data.error) return String(r.data.message || r.data.error)
  return r.status >= 500 ? `darce.dev is having trouble (${r.status}). Try again in a minute.` : `${what} (${r.status}).`
}
