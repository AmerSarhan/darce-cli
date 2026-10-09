import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { addAccount } from './accounts.js'
import { browserLogin } from './browserLogin.js'
import { writePrivate } from '../utils/privateFile.js'

const API_BASE = process.env.DARCE_API_BASE || 'https://api.darce.dev'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD = 8
const MAX_ATTEMPTS = 3

type AuthResult = { ok: true; apiKey: string } | { ok: false; status: number; message: string }

// Minimal raw-mode line reader. Avoids node:readline, which leaves a keypress
// listener on stdin that fights with Ink once the REPL starts.
function readLine(prompt: string, secret = false): Promise<string> {
  return new Promise(resolve => {
    const stdin = process.stdin
    let value = ''
    process.stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const finish = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
      resolve(secret ? value : value.trim())
    }

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish()
        if (ch === '\u0003') { // Ctrl+C
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            if (!secret) process.stdout.write('\b \b')
          }
          continue
        }
        if (ch < ' ') continue // ignore other control characters
        value += ch
        if (!secret) process.stdout.write(ch)
      }
    }

    stdin.on('data', onData)
  })
}

function createPrompter() {
  return {
    ask: (q: string) => readLine(q),
    askSecret: (q: string) => readLine(q, true),
    close: () => {},
  }
}

async function callAuth(endpoint: 'login' | 'register', email: string, password: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${API_BASE}/v1/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json().catch(() => ({})) as { api_key?: string; message?: string; error?: string }
    if (res.ok && data.api_key) return { ok: true, apiKey: data.api_key }
    return { ok: false, status: res.status, message: data.message || data.error || `Request failed (${res.status})` }
  } catch {
    return { ok: false, status: 0, message: "Couldn't reach darce.dev — check your internet connection." }
  }
}

/** Start a no-account trial: a key with a few requests, claimable later with `darce signup`. */
async function startTrial(): Promise<{ apiKey: string; limit: number } | { error: string }> {
  try {
    const res = await fetch(`${API_BASE}/v1/auth/trial`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const data = await res.json().catch(() => ({})) as { api_key?: string; limit?: number; message?: string }
    if (res.ok && data.api_key) return { apiKey: data.api_key, limit: data.limit ?? 10 }
    return { error: data.message || `Couldn't start a trial (${res.status}).` }
  } catch {
    return { error: "Couldn't reach darce.dev — check your internet connection." }
  }
}

/** `darce signup`: turn the current trial into a free account (same key, same history), or create one. */
export async function signupFlow(currentKey?: string): Promise<string | null> {
  if (!process.stdin.isTTY) { console.log('\n  Run `darce signup` in a terminal.\n'); return null }
  const p = createPrompter()
  let tier = ''
  if (currentKey) {
    try {
      const res = await fetch(`${API_BASE}/v1/account`, { headers: { Authorization: `Bearer ${currentKey}` } })
      tier = ((await res.json().catch(() => ({}))) as { tier?: string }).tier ?? ''
    } catch {}
  }
  if (tier !== 'trial') {
    if (tier) console.log('\n  You already have an account on this machine. Creating another one:\n')
    const result = await signUp(p)
    const apiKey = typeof result === 'object' && result ? await signIn(p, result.signinEmail) : result
    if (apiKey) saveCredentials(apiKey, lastEmail)
    return apiKey
  }

  console.log('\n  Create your free account (a daily allowance, no card). Your trial and its history carry over.\n')
  const email = await askEmail(p.ask)
  if (!email) return null
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const password = await p.askSecret(`  Choose a password (${MIN_PASSWORD}+ characters): `)
    if (password.length < MIN_PASSWORD) { console.log(`  Too short — use at least ${MIN_PASSWORD} characters.\n`); continue }
    const confirm = await p.askSecret('  Confirm password: ')
    if (confirm !== password) { console.log("  Passwords don't match. Try again.\n"); continue }
    try {
      const res = await fetch(`${API_BASE}/v1/auth/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentKey}` },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json().catch(() => ({})) as { api_key?: string; message?: string }
      if (res.ok && data.api_key) {
        saveCredentials(data.api_key, email)
        console.log(`  Done: ${email} is on the Free plan. Carry on with \`darce --resume\`.\n`)
        return data.api_key
      }
      console.log(`  ${data.message || `Sign-up failed (${res.status}).`}\n`)
      if (res.status === 409) return null
    } catch {
      console.log("  Couldn't reach darce.dev — check your internet connection.\n")
      return null
    }
  }
  return null
}

export function saveCredentials(apiKey: string, email = '') {
  if (email) { addAccount(email, apiKey, API_BASE); return }
  const rcPath = join(homedir(), '.darcerc')
  let existing: Record<string, unknown> = {}
  try {
    if (existsSync(rcPath)) existing = JSON.parse(readFileSync(rcPath, 'utf-8'))
  } catch {}

  existing.apiKey = apiKey
  existing.apiBase = API_BASE

  writePrivate(rcPath, JSON.stringify(existing, null, 2) + '\n')
}

let lastEmail = ''

async function askEmail(ask: (q: string) => Promise<string>): Promise<string | null> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const email = await ask('  Email: ')
    if (EMAIL_RE.test(email)) { lastEmail = email; return email }
    console.log("  That doesn't look like an email address. Try again.\n")
  }
  return null
}

async function signUp(p: ReturnType<typeof createPrompter>): Promise<string | { signinEmail: string } | null> {
  const email = await askEmail(p.ask)
  if (!email) return null

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const password = await p.askSecret(`  Choose a password (${MIN_PASSWORD}+ characters): `)
    if (password.length < MIN_PASSWORD) {
      console.log(`  Too short — use at least ${MIN_PASSWORD} characters.\n`)
      continue
    }
    const confirm = await p.askSecret('  Confirm password: ')
    if (confirm !== password) {
      console.log("  Passwords don't match. Try again.\n")
      continue
    }

    console.log('\n  Creating your account...')
    const result = await callAuth('register', email, password)
    if (result.ok) {
      console.log('  Account created — you\'re on the Free plan.\n')
      return result.apiKey
    }
    if (result.status === 409 || /exist|already|taken|registered/i.test(result.message)) {
      console.log(`  ${email} already has an account. Let's sign you in instead.\n`)
      return { signinEmail: email }
    }
    console.log(`  ${result.message}\n`)
    if (result.status === 0) return null
  }
  return null
}

async function signIn(p: ReturnType<typeof createPrompter>, presetEmail?: string): Promise<string | null> {
  let email = presetEmail ?? await askEmail(p.ask)
  if (!email) return null

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i > 0) {
      const again = await p.ask(`  Email [${email}]: `)
      if (again) email = again
    }
    lastEmail = email
    const password = await p.askSecret('  Password: ')

    console.log('\n  Signing in...')
    const result = await callAuth('login', email, password)
    if (result.ok) {
      console.log('  Signed in!\n')
      return result.apiKey
    }
    if (result.status === 0) {
      console.log(`  ${result.message}\n`)
      return null
    }
    console.log(result.status === 401
      ? '  Wrong email or password. Try again, or reset it at https://cli.darce.dev/forgot\n'
      : `  ${result.message}\n`)
  }
  console.log('  Still stuck? Run `darce login` to try again.\n')
  return null
}

/**
 * Interactive sign-up / sign-in. Saves the API key to ~/.darcerc and returns it,
 * or returns null if the user gave up or stdin isn't a terminal.
 */
export async function onboard(mode: 'choose' | 'signin' = 'choose'): Promise<string | null> {
  if (!process.stdin.isTTY) {
    console.log('\n  Run `darce login` in a terminal to create a free account, or set DARCE_API_KEY.\n')
    return null
  }

  const p = createPrompter()
  try {
    let choice = mode === 'signin' ? '3' : ''
    if (!choice) {
      console.log('\n  Welcome to Darce — the coding agent you can undo.\n')
      console.log('    1) Try it now                       (free, no account)')
      console.log('    2) Sign in with your browser')
      console.log('    3) Create a free account here       (daily allowance, no card needed)')
      console.log('    4) Sign in here with email and password\n')
      choice = await p.ask('  Choose 1-4 [1]: ')
      console.log()
      // Menu numbers shifted when the trial was added; map back to the flows below
      choice = choice === '' || choice === '1' ? 'trial' : String(Number(choice) - 1)
    }

    let apiKey: string | null = null
    let email = ''
    if (choice === 'trial') {
      const t = await startTrial()
      if ('apiKey' in t) {
        saveCredentials(t.apiKey)
        console.log(`  You're in. The trial covers a few real tasks. When you want more, run \`darce signup\` for a free daily allowance and keep your history.\n`)
        return t.apiKey
      }
      console.log(`  ${t.error} Let's sign in with your browser instead.\n`)
      choice = '1'
    }
    if (choice === '1') {
      console.log('  Opening cli.darce.dev in your browser…')
      try {
        const r = await browserLogin({ onUrl: url => console.log(`  If it didn't open, visit:\n  ${url}\n\n  Waiting for you to sign in (Ctrl+C to cancel)…`) })
        apiKey = r.apiKey
        email = r.email
        console.log(`\n  Signed in as ${email}.\n`)
      } catch (err) {
        console.log(`\n  ${(err as Error).message} Falling back to signing in here.\n`)
        choice = '3'
      }
    }
    if (!apiKey && choice === '3') {
      const r = await signIn(p)
      apiKey = r
    } else if (!apiKey && choice === '2') {
      const result = await signUp(p)
      apiKey = typeof result === 'object' && result ? await signIn(p, result.signinEmail) : result
    }
    if (apiKey && !email) email = lastEmail

    if (apiKey) saveCredentials(apiKey, email)
    return apiKey
  } finally {
    p.close()
  }
}
