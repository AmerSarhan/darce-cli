/** A write to the terminal failed because the terminal itself is gone, not because of a bug. */
export function isTerminalGone(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined
  return !!e && ['EIO', 'EPIPE', 'ENXIO'].includes(e.code ?? '') && (e.syscall === 'write' || /\bwrite\b/.test(e.message ?? ''))
}
