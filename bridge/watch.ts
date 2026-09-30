/**
 * Watched folders: a file that lands in one (a GRIB from a satellite
 * download, a tracker's position report, a raster chart) is sent on to the
 * app, which opens it as if it had been picked. A browser cannot watch a
 * folder; the bridge can.
 *
 * A file is sent once it has stopped changing for a moment, so one still being
 * written is not sent half done, and again only if it changes. Files already
 * there when the bridge starts are left alone.
 */
import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'

export type WatchKind = 'auto' | 'grib' | 'chart' | 'tracking'

export interface WatchConfig {
  dir: string
  /** What its files are; auto goes by each file's name. */
  kind?: WatchKind
  id?: string
  /** Also send the files already there (the newest 20) to each app as it connects: a chart folder, a GRIB folder. */
  scan?: boolean
}

export interface WatchedFile {
  watch: string
  name: string
  kind: WatchKind
  size: number
  mtime: number
  data: Buffer
}

export interface WatchStatus {
  id: string
  dir: string
  kind: WatchKind
  state: 'watching' | 'error' | 'stopped'
  detail: string | null
  files: number
}

/** Files larger than this are not sent. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

export function startWatch(
  c: WatchConfig,
  onFile: (f: WatchedFile) => void,
  opts: { settleMs?: number } = {},
): { status: WatchStatus; stop(): void; existing(): WatchedFile[] } {
  const status: WatchStatus = { id: c.id ?? `watch:${basename(c.dir)}`, dir: c.dir, kind: c.kind ?? 'auto', state: 'watching', detail: null, files: 0 }
  const settle = opts.settleMs ?? 700
  // What each file was when last seen or sent, so an unchanged one is not sent again.
  const known = new Map<string, string>()
  const stamp = (path: string) => {
    try {
      const s = statSync(path)
      return s.isFile() ? { key: `${s.size}:${s.mtimeMs}`, size: s.size, mtime: s.mtimeMs } : null
    } catch {
      return null
    }
  }
  try {
    for (const name of readdirSync(c.dir)) {
      const st = stamp(join(c.dir, name))
      if (st) known.set(name, st.key)
    }
  } catch (e) {
    status.state = 'error'
    status.detail = e instanceof Error ? e.message : String(e)
    return { status, stop: () => undefined, existing: () => [] }
  }
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const check = (name: string) => {
    timers.delete(name)
    const path = join(c.dir, name)
    const st = stamp(path)
    if (!st || known.get(name) === st.key) return
    known.set(name, st.key)
    if (st.size > MAX_FILE_BYTES) {
      status.detail = `${name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB: not sent`
      return
    }
    let data: Buffer
    try {
      data = readFileSync(path)
    } catch {
      return
    }
    status.files++
    onFile({ watch: status.id, name, kind: status.kind, size: st.size, mtime: st.mtime, data })
  }
  let w: FSWatcher | null = null
  try {
    w = watch(c.dir, (_event, filename) => {
      if (!filename) return
      const name = String(filename)
      const t = timers.get(name)
      if (t) clearTimeout(t)
      // Wait until it has stopped changing.
      timers.set(name, setTimeout(() => check(name), settle))
    })
    w.on('error', (e) => {
      status.state = 'error'
      status.detail = e.message
    })
  } catch (e) {
    status.state = 'error'
    status.detail = e instanceof Error ? e.message : String(e)
  }
  return {
    status,
    stop: () => {
      for (const t of timers.values()) clearTimeout(t)
      w?.close()
      status.state = 'stopped'
    },
    // The files there now, newest first, twenty at most, for a scanned folder.
    existing: () => {
      const out: WatchedFile[] = []
      let names: string[] = []
      try {
        names = readdirSync(c.dir)
      } catch {
        return out
      }
      const files = names
        .map((name) => ({ name, st: stamp(join(c.dir, name)) }))
        .filter((f): f is { name: string; st: NonNullable<ReturnType<typeof stamp>> } => f.st != null && f.st.size <= MAX_FILE_BYTES)
        .sort((a, b) => b.st.mtime - a.st.mtime)
        .slice(0, 20)
      for (const f of files) {
        try {
          out.push({ watch: status.id, name: f.name, kind: status.kind, size: f.st.size, mtime: f.st.mtime, data: readFileSync(join(c.dir, f.name)) })
        } catch {
          /* gone since */
        }
      }
      return out
    },
  }
}
