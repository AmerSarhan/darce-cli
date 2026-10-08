import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writePrivate } from '../utils/privateFile.js'

/**
 * Saved Darce accounts. The active one is mirrored into ~/.darcerc (apiKey/apiBase)
 * so everything else keeps reading config the way it always has.
 */
export type Account = { email: string; apiKey: string; apiBase: string; addedAt: string }
type Store = { active?: string; accounts: Record<string, Account> }

const STORE = () => join(homedir(), '.darce', 'accounts.json')
const RC = () => join(homedir(), '.darcerc')

function load(): Store {
  try {
    return JSON.parse(readFileSync(STORE(), 'utf-8'))
  } catch {
    return { accounts: {} }
  }
}

function save(store: Store) {
  writePrivate(STORE(), JSON.stringify(store, null, 2))
}

function writeRc(account: Account | null) {
  let rc: Record<string, unknown> = {}
  try { if (existsSync(RC())) rc = JSON.parse(readFileSync(RC(), 'utf-8')) } catch {}
  if (account) {
    rc.apiKey = account.apiKey
    rc.apiBase = account.apiBase
  } else {
    delete rc.apiKey
    delete rc.apiBase
  }
  writePrivate(RC(), JSON.stringify(rc, null, 2) + '\n')
}

export function listAccounts(): { active?: string; accounts: Account[] } {
  const s = load()
  return { active: s.active, accounts: Object.values(s.accounts) }
}

export function addAccount(email: string, apiKey: string, apiBase = 'https://api.darce.dev'): Account {
  const s = load()
  const account: Account = { email: email.toLowerCase(), apiKey, apiBase, addedAt: new Date().toISOString() }
  s.accounts[account.email] = account
  s.active = account.email
  save(s)
  writeRc(account)
  return account
}

export function switchAccount(emailOrPrefix: string): Account | null {
  const s = load()
  const want = emailOrPrefix.toLowerCase()
  const account = s.accounts[want] ?? Object.values(s.accounts).find(a => a.email.startsWith(want))
  if (!account) return null
  s.active = account.email
  save(s)
  writeRc(account)
  return account
}

/** Sign out of the active account (or a named one). Falls back to another saved account if any. */
export function removeAccount(email?: string): { removed?: string; nowActive?: Account } {
  const s = load()
  const target = (email ?? s.active)?.toLowerCase()
  if (!target || !s.accounts[target]) {
    writeRc(null)
    return {}
  }
  delete s.accounts[target]
  const next = Object.values(s.accounts)[0]
  s.active = next?.email
  save(s)
  writeRc(next ?? null)
  return { removed: target, nowActive: next }
}

export type AccountInfo = { email: string; tier: string; daily_requests: number; daily_limit: number | string }

export async function fetchAccount(apiKey: string, apiBase = 'https://api.darce.dev'): Promise<AccountInfo | null> {
  try {
    const res = await fetch(`${apiBase}/v1/account`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    return (await res.json()) as AccountInfo
  } catch {
    return null
  }
}
