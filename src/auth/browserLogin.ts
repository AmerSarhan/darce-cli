import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { openInBrowser } from '../core/billing.js'

const LOGIN_PAGE = process.env.DARCE_LOGIN_URL || 'https://darce.dev/cli-login'

const DONE_PAGE = (ok: boolean, email?: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? 'Signed in' : 'Sign-in failed'} · Darce</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F5F7;color:#101828;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:420px;padding:32px;background:#fff;border:1px solid #E4E7EC;border-radius:12px}h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#475467}code{font-family:ui-monospace,Menlo,monospace;color:#101828}</style></head>
<body><main><h1>${ok ? "You're signed in" : 'Sign-in failed'}</h1><p>${ok ? `Darce is now using <code>${(email ?? '').replace(/[<>&"]/g, '')}</code>. You can close this tab and go back to your terminal.` : 'Go back to your terminal and try <code>/login</code> again.'}</p></main></body></html>`

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

export type BrowserLoginResult = { email: string; apiKey: string }

/**
 * Sign in through the browser: Darce listens on 127.0.0.1 only, opens darce.dev,
 * and the page posts the key straight back to this machine. A one-time state value
 * ties the response to this request.
 */
export async function browserLogin(opts: { signal?: AbortSignal; onUrl?: (url: string) => void } = {}): Promise<BrowserLoginResult> {
  const state = randomBytes(16).toString('hex')

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/callback')) {
        res.writeHead(404).end()
        return
      }
      try {
        const params = new URLSearchParams(await readBody(req))
        if (params.get('state') !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(DONE_PAGE(false))
          return
        }
        const apiKey = params.get('api_key') ?? ''
        const email = params.get('email') ?? ''
        if (!apiKey) throw new Error('No key received')
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(DONE_PAGE(true, email))
        finish()
        resolve({ email, apiKey })
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(DONE_PAGE(false))
      }
    })

    const timeout = setTimeout(() => { finish(); reject(new Error('Sign-in timed out after 5 minutes.')) }, 5 * 60_000)
    const finish = () => { clearTimeout(timeout); server.close() }
    opts.signal?.addEventListener('abort', () => { finish(); reject(new Error('Sign-in cancelled.')) })

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      const url = `${LOGIN_PAGE}?port=${port}&state=${state}`
      opts.onUrl?.(url)
      openInBrowser(url)
    })
    server.on('error', err => { finish(); reject(err) })
  })
}
