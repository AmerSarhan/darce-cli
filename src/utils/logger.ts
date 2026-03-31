const DEBUG = process.env.DARCE_DEBUG === '1'

export function debug(...args: unknown[]) {
  if (DEBUG) {
    process.stderr.write(`[darce] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`)
  }
}
