import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { brain } from './bus.js'
import { buildGraph, projectPath, type BrainGraph } from './graph.js'
import type { FileDiff } from '../utils/diff.js'

/**
 * The brain view's local server: a page, a live event stream and a few read-only lookups.
 * Listens on 127.0.0.1 only, every request needs the random token in the link Darce prints, and
 * the Host header must be this server (so a website can't reach it through DNS rebinding).
 */
export type BrainSource = {
  cwd: string
  model: () => string
  gitRoot: () => string | null
  timeline: () => { n: number; label: string; at: number }[]
  stepDiff: (i: number) => FileDiff[] | null
  sessionDiff: () => FileDiff[] | null
}

const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.npmrc|\.netrc|\.darcerc)$/i

let running: { server: Server; url: string } | null = null

function assetsDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [join(here, 'brain'), resolve(here, '../../dist/brain'), resolve(here, '../dist/brain')]
  return candidates.find(d => existsSync(join(d, 'index.html'))) ?? candidates[0]!
}

export function brainUrl(): string | null {
  return running?.url ?? null
}

export async function startBrain(src: BrainSource): Promise<string> {
  if (running) return running.url
  const token = randomBytes(16).toString('hex')
  const dir = assetsDir()
  let graph: Promise<BrainGraph> | null = null
  const getGraph = (fresh = false) => (graph && !fresh ? graph : (graph = buildGraph(src.cwd)))

  const rel = (d: FileDiff): FileDiff => ({ ...d, path: projectPath(src.cwd, d.path, src.gitRoot()) || d.path })

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const port = (server.address() as { port: number }).port
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'text/plain', 'Forbidden')
    // The page and its script are static; everything with project data needs the token
    if (url.pathname.startsWith('/api/') && url.searchParams.get('t') !== token) return send(res, 403, 'text/plain', 'This link has expired. Run /brain in Darce for a new one.')

    try {
      switch (url.pathname) {
        case '/':
          return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(dir, 'index.html')))
        case '/app.js':
          return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(join(dir, 'app.js')))
        case '/api/graph':
          return json(res, await getGraph(url.searchParams.get('fresh') === '1'))
        case '/api/state':
          return json(res, {
            model: src.model(),
            cwd: src.cwd,
            timeline: src.timeline(),
            changed: (src.sessionDiff() ?? []).map(rel).map(d => ({ path: d.path, added: d.added, removed: d.removed, created: d.created })),
          })
        case '/api/step': {
          const i = Number(url.searchParams.get('i'))
          return json(res, (src.stepDiff(i) ?? []).map(rel))
        }
        case '/api/file': {
          const p = url.searchParams.get('path') ?? ''
          const abs = resolve(src.cwd, p)
          if (!abs.startsWith(resolve(src.cwd) + sep)) return send(res, 400, 'text/plain', 'Outside the project')
          if (SECRET_FILE.test(p)) return json(res, { path: p, hidden: true })
          const diff = (src.sessionDiff() ?? []).map(rel).find(d => d.path === p) ?? null
          let content: string | null = null
          try { if (statSync(abs).size <= 400 * 1024) content = readFileSync(abs, 'utf8') } catch { /* deleted or unreadable */ }
          return json(res, { path: p, content, diff })
        }
        case '/api/events': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
          res.write(`retry: 1500\n\n`)
          for (const e of brain.backlog()) res.write(`data: ${JSON.stringify(e)}\n\n`)
          const off = brain.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`))
          const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
          req.on('close', () => { off(); clearInterval(ping) })
          return
        }
        default:
          return send(res, 404, 'text/plain', 'Not found')
      }
    } catch (err) {
      return send(res, 500, 'text/plain', (err as Error).message)
    }
  })

  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    // A fixed, recognisable port when it's free; any free port otherwise
    server.listen(7337, '127.0.0.1', () => ok())
  }).catch(() => new Promise<void>(ok => server.listen(0, '127.0.0.1', () => ok())))
  server.unref()

  const port = (server.address() as { port: number }).port
  running = { server, url: `http://127.0.0.1:${port}/?t=${token}` }
  brain.active = true
  brain.emit('hello', { model: src.model(), cwd: src.cwd })
  void getGraph() // start building now so the page opens to a ready map
  return running.url
}

export function stopBrain(): void {
  running?.server.close()
  running = null
  brain.active = false
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
  res.end(body)
}

function json(res: ServerResponse, data: unknown) {
  send(res, 200, 'application/json', JSON.stringify(data))
}
