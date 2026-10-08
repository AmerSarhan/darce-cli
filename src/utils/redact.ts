// Strip well-known secret formats from text before it is sent to a model.
// Conservative by design: only high-confidence patterns, so code is never mangled.

const PATTERNS: Array<[string, RegExp]> = [
  ['private_key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g],
  ['openai_key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g],
  ['openrouter_key', /\bsk-or-v1-[a-f0-9]{48,}\b/g],
  ['stripe_key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['darce_key', /\bdarce-[A-Za-z0-9_-]{24,}\b/g],
]

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0
  let out = text
  for (const [name, re] of PATTERNS) {
    out = out.replace(re, () => {
      count++
      return `⟨redacted:${name}⟩`
    })
  }
  return { text: out, count }
}
