import { structuredPatch } from 'diff'

export type DiffLine = { kind: 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number }
export type DiffHunk = { lines: DiffLine[] }
export type FileDiff = { kind: 'diff'; path: string; created: boolean; added: number; removed: number; hunks: DiffHunk[] }

/** Structured, display-ready diff between two versions of a file. */
export function fileDiff(path: string, before: string | null, after: string): FileDiff {
  const patch = structuredPatch(path, path, before ?? '', after, '', '', { context: 3 })
  let added = 0
  let removed = 0
  const hunks: DiffHunk[] = patch.hunks.map(h => {
    let oldNo = h.oldStart
    let newNo = h.newStart
    const lines: DiffLine[] = []
    for (const raw of h.lines) {
      if (raw.startsWith('\\')) continue // "\ No newline at end of file"
      const text = raw.slice(1)
      if (raw[0] === '+') { lines.push({ kind: 'add', text, newNo: newNo++ }); added++ }
      else if (raw[0] === '-') { lines.push({ kind: 'del', text, oldNo: oldNo++ }); removed++ }
      else lines.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ })
    }
    return { lines }
  })
  return { kind: 'diff', path, created: before === null, added, removed, hunks }
}
