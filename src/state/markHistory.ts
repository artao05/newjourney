/**
 * Undo and redo for the course's marks: every change to the marks (added,
 * moved, renamed, reordered, deleted, cleared) can be taken back and put
 * back again. Edits to the same field of the same mark close together (typing
 * a position, a name) count as one, so one undo takes back the edit, not a
 * keystroke.
 */
import { create } from 'zustand'
import { useStore } from './store'
import type { Mark } from '@/lib/types'

interface Snapshot {
  marks: Mark[]
  active: number
}

const MAX = 50
/** Edits to the same field of one mark within this long are one step. */
const COALESCE_MS = 1000

let past: Snapshot[] = []
let future: Snapshot[] = []
let applying = false
let lastAt = -Infinity
let lastKey: string | null = null

export const useMarkHistory = create<{ canUndo: boolean; canRedo: boolean }>(() => ({ canUndo: false, canRedo: false }))

const publish = () => useMarkHistory.setState({ canUndo: past.length > 0, canRedo: future.length > 0 })
const ids = (m: Mark[]) => m.map((x) => x.id).join(',')

/** Which field of which mark an edit changed, when it changed just one; null otherwise. */
function editKey(prev: Mark[], next: Mark[]): string | null {
  if (ids(prev) !== ids(next)) return null
  const changed = next.filter((m, i) => m !== prev[i])
  if (changed.length !== 1) return null
  const m = changed[0]
  const was = prev.find((x) => x.id === m.id)!
  const keys = (Object.keys({ ...was, ...m }) as Array<keyof Mark>).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(m[k]))
  return `${m.id}:${keys.sort().join(',')}`
}

let started = false

/** Start recording (once). Called at start-up; tests call it too. */
export function startMarkHistory(now: () => number = Date.now): void {
  if (started) return
  started = true
  useStore.subscribe((s, prev) => {
    if (applying || s.course.marks === prev.course.marks) return
    const t = now()
    const key = editKey(prev.course.marks, s.course.marks)
    // The same field of the same mark, straight after the last edit to it, joins that edit.
    if (!(key && key === lastKey && t - lastAt < COALESCE_MS && past.length)) {
      past.push({ marks: prev.course.marks, active: prev.activeMarkIndex })
      if (past.length > MAX) past.shift()
    }
    lastAt = t
    lastKey = key
    future = []
    publish()
  })
}

function apply(snap: Snapshot) {
  applying = true
  try {
    useStore.getState().restoreMarks(snap.marks, snap.active)
  } finally {
    applying = false
  }
  lastAt = -Infinity
}

const current = (): Snapshot => ({ marks: useStore.getState().course.marks, active: useStore.getState().activeMarkIndex })

export function undoMarks(): boolean {
  const snap = past.pop()
  if (!snap) return false
  future.push(current())
  apply(snap)
  publish()
  return true
}

export function redoMarks(): boolean {
  const snap = future.pop()
  if (!snap) return false
  past.push(current())
  apply(snap)
  publish()
  return true
}

/** For tests: forget the history. */
export function resetMarkHistory(): void {
  past = []
  future = []
  lastAt = -Infinity
  lastKey = null
  publish()
}
