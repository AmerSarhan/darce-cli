import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { addAccount } from './accounts.js'
import { browserLogin } from './browserLogin.js'

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

export function saveCredentials(apiKey: string, email = '') {
  if (email) { addAccount(email, apiKey, API_BASE); return }
  const rcPath = join(homedir(), '.darcerc')
  let existing: Record<string, unknown> = {}
  try {
    if (existsSync(rcPath)) existing = JSON.parse(readFileSync(rcPath, 'utf-8'))
  } catch {}

  existing.apiKey = apiKey
  existing.apiBase = API_BASE

  mkdirSync(join(homedir(), '.darce'), { recursive: true })
  writeFileSync(rcPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 })
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
      console.log('  Account created — you\'re on the free Starter plan.\n')
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
      ? '  Wrong email or password. Try again.\n'
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
      console.log('\n  Welcome to Darce — an AI coding agent for your terminal.\n')
      console.log('    1) Sign in with your browser        (recommended)')
      console.log('    2) Create a free account here       (25 requests/month, no card needed)')
      console.log('    3) Sign in here with email and password\n')
      choice = await p.ask('  Choose 1, 2 or 3 [1]: ')
      console.log()
    }

    let apiKey: string | null = null
    let email = ''
    if (choice === '' || choice === '1') {
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
