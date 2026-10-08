import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Write a file only your user can read (0600), in a folder only your user can open (0700).
 * `mode` on writeFileSync only applies when a file is created, so permissions are set explicitly
 * every time: files made by older versions get fixed on their next write.
 */
export function writePrivate(path: string, data: string | Buffer): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, data, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
}

/** Tighten permissions on Darce's own files from earlier versions (key file, history, sessions). */
export function lockDownDarceFiles(): void {
  const home = homedir()
  for (const [p, mode] of [[join(home, '.darcerc'), 0o600], [join(home, '.darce'), 0o700], [join(home, '.darce', 'sessions'), 0o700]] as const) {
    try { if (existsSync(p)) chmodSync(p, mode) } catch {}
  }
}
