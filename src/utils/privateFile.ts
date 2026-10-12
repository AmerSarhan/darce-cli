import { writeFileSync, mkdirSync, chmodSync, existsSync, renameSync, unlinkSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Write a file only your user can read (0600), in a folder only your user can open (0700).
 * `mode` on writeFileSync only applies when a file is created, so permissions are set explicitly
 * every time: files made by older versions get fixed on their next write.
 */
export function writePrivate(target: string, data: string | Buffer): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  // Follow a symlinked dotfile so the rename replaces the real file, not the link
  let path = target
  try { path = realpathSync(target) } catch {}
  // Write aside then rename: a crash mid-write leaves the old file whole instead of truncated
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, data, { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

/** Tighten permissions on Darce's own files from earlier versions (key file, history, sessions). */
export function lockDownDarceFiles(): void {
  const home = homedir()
  for (const [p, mode] of [[join(home, '.darcerc'), 0o600], [join(home, '.darce'), 0o700], [join(home, '.darce', 'sessions'), 0o700]] as const) {
    try { if (existsSync(p)) chmodSync(p, mode) } catch {}
  }
}
