/**
 * The error log: what went wrong, kept on this device for 60 days, to read
 * back or send on. No telemetry: nothing leaves the device unless the user
 * exports it.
 */

export interface ErrorEntry {
  t: number
  /** Where: a screen's name, "window" for an uncaught error, "promise" for an unhandled rejection. */
  where: string
  message: string
  stack?: string
}

const KEY = 'newjourney.errors.v1'
const MAX = 200
const KEEP_MS = 60 * 24 * 3600_000

export function readErrors(now = Date.now()): ErrorEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    const all = raw ? (JSON.parse(raw) as ErrorEntry[]) : []
    return all.filter((e) => now - e.t <= KEEP_MS)
  } catch {
    return []
  }
}

export function recordError(where: string, error: unknown, now = Date.now()): void {
  const e: ErrorEntry = {
    t: now,
    where,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack.slice(0, 2000) } : {}),
  }
  try {
    localStorage.setItem(KEY, JSON.stringify([...readErrors(now), e].slice(-MAX)))
  } catch {
    /* storage full or off: the log is a convenience, not a duty */
  }
}

export function clearErrors(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}

/** The log as text, a line an entry, for export. */
export function errorsText(entries: ErrorEntry[]): string {
  return entries.map((e) => `${new Date(e.t).toISOString()} [${e.where}] ${e.message}${e.stack ? `\n  ${e.stack.split('\n').slice(1, 4).join('\n  ')}` : ''}`).join('\n') + (entries.length ? '\n' : '')
}

let installed = false

/** Catch what nothing else does: uncaught errors and unhandled rejections. */
export function installErrorLog(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (e) => recordError('window', e.error ?? e.message))
  window.addEventListener('unhandledrejection', (e) => recordError('promise', e.reason))
}
