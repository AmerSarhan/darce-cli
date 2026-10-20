import { join } from 'node:path'
import { homedir } from 'node:os'
import { addAccount, listAccounts, savedApiBase, DEFAULT_API_BASE } from './accounts.js'
import { browserLogin } from './browserLogin.js'
import { callApi, failure } from './http.js'
import { updateGlobalRc, readSettingsFile } from '../config/config.js'

// Read per call: DARCE_API_BASE can change between calls (tests), and it decides what gets saved
const apiBase = () => process.env.DARCE_API_BASE || DEFAULT_API_BASE
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
    const r = await callApi(`${apiBase()}/v1/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (r.ok && typeof r.data.api_key === 'string') return { ok: true, apiKey: r.data.api_key }
    return { ok: false, status: r.status, message: failure(r) }
  } catch (err) {
    return { ok: false, status: 0, message: (err as Error).message }
  }
}

/** Start a no-account trial: a key with a few requests, claimable later with `darce signup`. */
async function startTrial(): Promise<{ apiKey: string; limit: number } | { error: string; unreachable?: boolean }> {
  try {
    const r = await callApi(`${apiBase()}/v1/auth/trial`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    if (r.ok && typeof r.data.api_key === 'string') return { apiKey: r.data.api_key, limit: typeof r.data.limit === 'number' ? r.data.limit : 10 }
    return { error: failure(r, "Couldn't start a trial") }
  } catch (err) {
    return { error: (err as Error).message, unreachable: true }
  }
}

/** `darce signup`: turn the current trial into a free account (same key, same history), or create one. */
export async function signupFlow(currentKey?: string): Promise<string | null> {
  if (!process.stdin.isTTY) { console.log('\n  Run `darce signup` in a terminal.\n'); return null }
  const p = createPrompter()
  let tier = ''
  if (currentKey) {
    try {
      const r = await callApi(`${apiBase()}/v1/account`, { headers: { Authorization: `Bearer ${currentKey}` } })
      tier = typeof r.data.tier === 'string' ? r.data.tier : ''
    } catch (err) {
      console.log(`\n  ${(err as Error).message}\n`)
      return null
    }
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
    let r
    try {
      r = await callApi(`${apiBase()}/v1/auth/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentKey}` },
        body: JSON.stringify({ email, password }),
      })
    } catch (err) {
      console.log(`  ${(err as Error).message}\n`)
      return null
    }
    if (r.ok && typeof r.data.api_key === 'string') {
      saveCredentials(r.data.api_key, email)
      console.log(`  Done: ${email} is on the Free plan. Carry on with \`darce --resume\`.\n`)
      return r.data.api_key
    }
    console.log(`  ${failure(r, 'Sign-up failed')}\n`)
    if (r.status === 409) return null
  }
  return null
}

export function saveCredentials(apiKey: string, email = '') {
  if (email) { addAccount(email, apiKey, apiBase()); return }
  const base = savedApiBase(apiBase())
  updateGlobalRc(rc => {
    rc.apiKey = apiKey
    if (base) rc.apiBase = base
    else delete rc.apiBase
  })
}

export type LoginFlow = 'trial' | 'browser' | 'signup' | 'signin'

/**
 * The first-run / `darce login` menu. With a key already saved there's no trial: Enter would otherwise
 * swap a signed-in account for a trial key, leaving ~/.darcerc and accounts.json disagreeing.
 */
export function loginMenu(signedIn: boolean): { flow: LoginFlow; label: string }[] {
  const menu: { flow: LoginFlow; label: string }[] = [
    { flow: 'trial', label: 'Try it now                       (free, no account)' },
    { flow: 'browser', label: 'Sign in with your browser' },
    { flow: 'signup', label: 'Create a free account here       (daily allowance, no card needed)' },
    { flow: 'signin', label: 'Sign in here with email and password' },
  ]
  return signedIn ? menu.slice(1) : menu
}

/** The flow for what was typed at the menu (Enter picks the first), or null when it isn't an option. */
export function pickLoginFlow(input: string, signedIn: boolean): LoginFlow | null {
  const menu = loginMenu(signedIn)
  const n = input.trim() === '' ? 1 : Number(input.trim())
  return Number.isInteger(n) && n >= 1 && n <= menu.length ? menu[n - 1]!.flow : null
}

function hasSavedKey(): boolean {
  if (listAccounts().accounts.length) return true
  try { return !!readSettingsFile(join(homedir(), '.darcerc')).apiKey } catch { return false }
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
      ? '  Wrong email or password. Try again, or reset it at https://darce.dev/forgot\n'
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
    let choice: LoginFlow | null = mode === 'signin' ? 'signin' : null
    if (!choice) {
      const signedIn = hasSavedKey()
      const menu = loginMenu(signedIn)
      console.log(signedIn ? '\n  Sign in to Darce.\n' : '\n  Welcome to Darce — the coding agent you can undo.\n')
      menu.forEach((m, i) => console.log(`    ${i + 1}) ${m.label}`))
      console.log()
      for (let i = 0; i < MAX_ATTEMPTS && !choice; i++) {
        choice = pickLoginFlow(await p.ask(`  Choose 1-${menu.length} [1]: `), signedIn)
        if (!choice) console.log(`  Choose 1-${menu.length}.\n`)
      }
      if (!choice) return null
      console.log()
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
      // Unreachable means the browser sign-in would only sit waiting too
      if (t.unreachable) { console.log(`  ${t.error}\n`); return null }
      console.log(`  ${t.error} Let's sign in with your browser instead.\n`)
      choice = 'browser'
    }
    if (choice === 'browser') {
      console.log('  Opening darce.dev in your browser…')
      try {
        const r = await browserLogin({ onUrl: url => console.log(`  If it didn't open, visit:\n  ${url}\n\n  Waiting for you to sign in (Ctrl+C to cancel)…`) })
        apiKey = r.apiKey
        email = r.email
        console.log(`\n  Signed in as ${email}.\n`)
      } catch (err) {
        console.log(`\n  ${(err as Error).message} Falling back to signing in here.\n`)
        choice = 'signin'
      }
    }
    if (!apiKey && choice === 'signin') {
      const r = await signIn(p)
      apiKey = r
    } else if (!apiKey && choice === 'signup') {
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
