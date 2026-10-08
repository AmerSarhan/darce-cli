// Build the environment for commands Darce runs. Variables that look like
// credentials are withheld unless the user explicitly allows them (passEnv).

// Matched per underscore-separated segment, so GIT_AUTHOR_NAME, PWD or KEYTIMEOUT are untouched
const SECRET_SEGMENT = /^(API)?KEYS?$|TOKENS?$|SECRETS?$|^PASSWORD|^PASSWD$|^PASS$|^CREDENTIALS?$|^PRIVATE$|^COOKIES?$|^DSN$/i
const SECRET_NAMES = new Set(['DATABASE_URL', 'REDIS_URL', 'MONGODB_URI', 'MONGO_URL', 'CONNECTION_STRING'])

// Needed for normal tooling even though the name matches
const ALWAYS_PASS = new Set(['SSH_AUTH_SOCK', 'GPG_AGENT_INFO'])

export function looksSecret(name: string): boolean {
  if (ALWAYS_PASS.has(name)) return false
  if (SECRET_NAMES.has(name.toUpperCase())) return true
  return name.split('_').some(seg => SECRET_SEGMENT.test(seg))
}

export function safeEnv(source: NodeJS.ProcessEnv, passEnv: string[] = []): { env: NodeJS.ProcessEnv; withheld: string[] } {
  const allow = new Set(passEnv)
  const env: NodeJS.ProcessEnv = {}
  const withheld: string[] = []
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('DARCE_')) { withheld.push(name); continue }
    if (looksSecret(name) && !allow.has(name)) {
      withheld.push(name)
      continue
    }
    env[name] = value
  }
  return { env, withheld }
}
