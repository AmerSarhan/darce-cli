import './test-home.js'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

type Test = (name: string, fn: () => boolean | Promise<boolean>) => Promise<void>

// Each test gets its own HOME; every path these modules use is resolved per call
async function inHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'darce-0180-'))
  mkdirSync(join(home, '.darce'), { recursive: true })
  const real = process.env.HOME
  process.env.HOME = home
  try { return await fn(home) } finally { process.env.HOME = real }
}

const isPrivate = (p: string) => (statSync(p).mode & 0o777) === 0o600

export async function testState0180(test: Test) {
  const { remember, forget, forgetProblem, memoryPath } = await import('./src/core/memory.js')
  const { loadHistory, saveHistory } = await import('./src/state/history.js')
  const { trustedKeys, addTrust } = await import('./src/state/trust.js')
  const { loadConfig } = await import('./src/config/config.js')
  const { loadModels, recordModelUse } = await import('./src/config/models.js')
  const { saveCosts, resetCosts } = await import('./src/state/costTracker.js')
  const { saveCredentials, loginMenu, pickLoginFlow } = await import('./src/auth/onboarding.js')
  const { savedApiBase } = await import('./src/auth/accounts.js')
  const { redeemCode } = await import('./src/auth/redeem.js')

  await test('Memory: remember keeps the user\'s own lines and only skips exact duplicates', () => inHome(() => {
    const cwd = '/tmp/proj-0180'
    remember('user', cwd, "Don't use pnpm")
    const path = memoryPath('user', cwd)
    writeFileSync(path, readFileSync(path, 'utf-8') + 'My own note, not a bullet\n')
    const a = remember('user', cwd, 'use pnpm')
    const b = remember('user', cwd, 'Use pnpm!')
    const text = readFileSync(path, 'utf-8')
    return a.added && !b.added && text.includes('My own note, not a bullet') && text.includes("- Don't use pnpm")
      && text.includes('- use pnpm (') && isPrivate(path)
  }))

  await test('Memory: forget refuses matches under 3 letters instead of removing many notes', () => inHome(() => {
    const cwd = '/tmp/proj-0180'
    for (const n of ['Prefers tabs', 'Deploys on Fridays', 'Uses Vercel']) remember('user', cwd, n)
    const before = readFileSync(memoryPath('user', cwd), 'utf-8')
    const e = forget('user', cwd, 'e'), bang = forget('user', cwd, '!!'), year = forget('user', cwd, String(new Date().getFullYear()))
    const same = readFileSync(memoryPath('user', cwd), 'utf-8') === before
    const tabs = forget('user', cwd, 'tabs')
    return e === 0 && bang === 0 && year === 0 && same && tabs === 1 && /at least 3/.test(forgetProblem('e') ?? '') && forgetProblem('tabs') === null
  }))

  await test('History: a second window\'s save keeps the first window\'s prompts; huge pastes aren\'t stored', () => inHome(() => {
    const a = loadHistory(), b = loadHistory()
    saveHistory(['from A', ...a])
    saveHistory(['from B', ...b])
    saveHistory(['x'.repeat(50_000), 'from B', ...b])
    const h = loadHistory()
    saveHistory(Array.from({ length: 300 }, (_, i) => `p${i}`))
    return h[0] === 'from B' && h.includes('from A') && !h.some(s => s.length > 20_000) && loadHistory().length === 200
  }))

  await test('Trust: bad trust.json shapes don\'t throw or turn strings into characters; a broken file is kept and backed up', () => inHome(home => {
    const path = join(home, '.darce', 'trust.json')
    writeFileSync(path, 'null')
    const nullOk = trustedKeys('/r').size === 0
    writeFileSync(path, JSON.stringify({ '/r': 'npm install', '/s': ['git push', 7] }))
    const strOk = trustedKeys('/r').size === 0 && [...trustedKeys('/s')].join() === 'git push'
    const broken = '{ "/r": ["npm test"], }'
    writeFileSync(path, broken)
    const problem = addTrust('/r', 'npm install')
    const kept = readFileSync(path, 'utf-8') === broken
    const backups = readdirSync(join(home, '.darce')).filter(f => f.startsWith('trust.json.bad-') && readFileSync(join(home, '.darce', f), 'utf-8') === broken)
    writeFileSync(path, JSON.stringify({ '/s': ['git push'] }))
    const saved = addTrust('/r', 'npm install') === null && trustedKeys('/r').has('npm install') && trustedKeys('/s').has('git push')
    return nullOk && strOk && !!problem && /isn't valid JSON/.test(problem) && kept && backups.length === 1 && saved && isPrivate(path)
  }))

  await test('Config: "router": null and wrong-typed values in ~/.darcerc fall back to defaults', () => inHome(home => {
    writeFileSync(join(home, '.darcerc'), JSON.stringify({ router: null, maxTurns: '9', theme: null, critic: null }))
    const c = loadConfig()
    writeFileSync(join(home, '.darcerc'), JSON.stringify({ router: { default: 7, rules: 'x' } }))
    const d = loadConfig()
    writeFileSync(join(home, '.darcerc'), JSON.stringify({ router: { default: 'a/b' }, maxTurns: 9 }))
    const e = loadConfig()
    const envModel = process.env.DARCE_MODEL
    return typeof c.router.default === 'string' && Array.isArray(c.router.rules) && c.maxTurns === 50 && c.theme === 'dark'
      && c.critic === undefined && typeof d.router.default === 'string' && Array.isArray(d.router.rules)
      && (envModel ? true : e.router.default === 'a/b') && e.maxTurns === 9
  }))

  await test('Models: a cache without models still refreshes instead of throwing; caches and cost files are private', () => inHome(async home => {
    writeFileSync(join(home, '.darce', 'models.json'), JSON.stringify({ fetchedAt: Date.now() }))
    const realFetch = globalThis.fetch
    let fetched = 0
    globalThis.fetch = (async () => { fetched++; throw new Error('offline') }) as typeof fetch
    let list: unknown
    try { list = await loadModels() } finally { globalThis.fetch = realFetch }
    recordModelUse('a/b')
    resetCosts()
    saveCosts('s1')
    const d = join(home, '.darce')
    return Array.isArray(list) && (list as unknown[]).length > 0 && fetched > 0
      && isPrivate(join(d, 'recent-models.json')) && isPrivate(join(d, 'session-cost.json'))
  }))

  await test('Login: DARCE_API_BASE and the default endpoint aren\'t saved to ~/.darcerc or accounts.json', () => inHome(home => {
    const real = process.env.DARCE_API_BASE
    process.env.DARCE_API_BASE = 'http://127.0.0.1:9'
    try {
      saveCredentials('trial-key')
      const rc1 = JSON.parse(readFileSync(join(home, '.darcerc'), 'utf-8'))
      saveCredentials('acct-key', 'a@b.co')
      const rc2 = JSON.parse(readFileSync(join(home, '.darcerc'), 'utf-8'))
      const store = JSON.parse(readFileSync(join(home, '.darce', 'accounts.json'), 'utf-8'))
      delete process.env.DARCE_API_BASE
      saveCredentials('k3')
      const rc3 = JSON.parse(readFileSync(join(home, '.darcerc'), 'utf-8'))
      return rc1.apiKey === 'trial-key' && !('apiBase' in rc1) && rc2.apiKey === 'acct-key' && !('apiBase' in rc2)
        && !('apiBase' in store.accounts['a@b.co']) && !('apiBase' in rc3)
        && savedApiBase('https://self.host') === 'https://self.host' && savedApiBase('https://api.darce.dev') === undefined
    } finally {
      if (real === undefined) delete process.env.DARCE_API_BASE
      else process.env.DARCE_API_BASE = real
    }
  }))

  await test('Login menu: no trial (or trial default) when signed in; out-of-range choices are rejected', () => {
    const signedIn = loginMenu(true).map(m => m.flow)
    return !signedIn.includes('trial') && loginMenu(false).length === 4
      && pickLoginFlow('', false) === 'trial' && pickLoginFlow('', true) === 'browser'
      && pickLoginFlow('3', true) === 'signin' && pickLoginFlow('4', false) === 'signin'
      && pickLoginFlow('5', false) === null && pickLoginFlow('4', true) === null
      && pickLoginFlow('0', false) === null && pickLoginFlow('1.5', false) === null && pickLoginFlow('x', false) === null
  })

  await test('Redeem: reports ok/failure and bills the key it\'s given, not the one in config', async () => {
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(String(req.headers.authorization))
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const good = JSON.parse(body).code === 'GOOD'
        res.writeHead(good ? 200 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: good ? 'Power unlocked.' : 'That code is used up.' }))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const ok = await redeemCode('GOOD', { apiKey: 'active-key', apiBase: base })
      const bad = await redeemCode('USED', { apiKey: 'active-key', apiBase: base })
      const empty = await redeemCode('  ')
      const signedOut = await inHome(() => redeemCode('GOOD'))
      return ok.ok && ok.message === 'Power unlocked.' && !bad.ok && bad.message === 'That code is used up.'
        && !empty.ok && /Usage/.test(empty.message) && (process.env.DARCE_API_KEY ? true : !signedOut.ok && /Sign in first/.test(signedOut.message))
        && seen.length === 2 && seen.every(h => h === 'Bearer active-key')
    } finally {
      server.close()
    }
  })

}
