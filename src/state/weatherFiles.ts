/**
 * Weather files the user has opened: GRIB from a picker or dropped on the chart.
 *
 * Kept apart from the main store, and not persisted: a cube is megabytes of
 * floats, and localStorage is neither the place nor the size for it. Keeping
 * them across reloads (IndexedDB) is part of the loaded-data list, P2-137.
 */
import { create } from 'zustand'
import { openGrib } from '@/lib/weather/gribClient'
import type { GribEntry, GribSkipped } from '@/lib/weather/grib2'
import type { BBox, WeatherCube } from '@/lib/types'

export interface WeatherFile {
  id: string
  name: string
  bytes: number
  loadedAt: number
  /** Only ticked files are used, as in Expedition's GRIB list. */
  enabled: boolean
  cube: WeatherCube | null
  catalogue: GribEntry[]
  skipped: GribSkipped[]
  warnings: string[]
  /** Set when the file could not be read at all. */
  error?: string
}

interface WeatherFilesState {
  /** Newest first. */
  files: WeatherFile[]
  add(files: WeatherFile[]): void
  setEnabled(id: string, on: boolean): void
  remove(id: string): void
  clear(): void
}

export const useWeatherFiles = create<WeatherFilesState>()((set) => ({
  files: [],
  add: (files) => set((s) => ({ files: [...files, ...s.files] })),
  setEnabled: (id, on) => set((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, enabled: on } : f)) })),
  remove: (id) => set((s) => ({ files: s.files.filter((f) => f.id !== id) })),
  clear: () => set({ files: [] }),
}))

let seq = 0

/** The file names a GRIB can come in, for the picker and for sorting out a drop. */
export const GRIB_ACCEPT = '.grb,.grb2,.grib,.grib2,.grb1,.grib1,.bin'

export function looksLikeGrib(name: string): boolean {
  // NOMADS names its files gfs.t06z.pgrb2.0p25.f003; Saildocs sends .grb or .bin.
  return /grb|grib/i.test(name) || /\.bin$/i.test(name) || !/\.[a-z0-9]{1,5}$/i.test(name)
}

/** Read each file (several at once) and add what it holds to the list. */
export async function openWeatherFiles(list: Iterable<File>, opts: { bbox?: BBox } = {}): Promise<WeatherFile[]> {
  const out: WeatherFile[] = []
  for (const file of list) {
    const base = { id: `wx-${Date.now().toString(36)}-${seq++}`, name: file.name, bytes: file.size, loadedAt: Date.now() }
    try {
      const got = await openGrib(await file.arrayBuffer(), { bbox: opts.bbox, model: file.name })
      const empty = !got.cube && got.catalogue.length === 0
      out.push({
        ...base,
        enabled: got.cube != null,
        ...got,
        error: empty ? (got.skipped[0]?.reason ?? 'no GRIB messages in this file') : undefined,
      })
    } catch (e) {
      out.push({ ...base, enabled: false, cube: null, catalogue: [], skipped: [], warnings: [], error: e instanceof Error ? e.message : String(e) })
    }
  }
  useWeatherFiles.getState().add(out)
  return out
}

/** The cube the chart shows: the newest ticked file that has one. */
export function activeFileCube(files: WeatherFile[]): { cube: WeatherCube; name: string } | null {
  const f = files.find((x) => x.enabled && x.cube)
  return f && f.cube ? { cube: f.cube, name: f.name } : null
}

/** A level as a person would say it. */
export function levelLabel(type: number, value: number): string {
  if (type === 1) return 'surface'
  if (type === 101) return 'mean sea level'
  if (type === 103) return `${value} m above ground`
  if (type === 100) return `${value / 100} hPa`
  if (type === 160) return `${value} m below sea level`
  return `level ${type}/${value}`
}

export interface CatalogueRow {
  name: string
  level: string
  steps: number
  from: number
  to: number
  grid: string
}

/** One row per parameter and level: how many times, from when to when, on what grid. */
export function summariseCatalogue(entries: GribEntry[]): CatalogueRow[] {
  const rows = new Map<string, CatalogueRow & { times: Set<number> }>()
  for (const e of entries) {
    const level = levelLabel(e.levelType, e.levelValue)
    const key = `${e.name}|${level}`
    const r = rows.get(key) ?? { name: e.name, level, steps: 0, from: e.validTime, to: e.validTime, grid: `${e.ni}×${e.nj}`, times: new Set<number>() }
    r.times.add(e.validTime)
    r.from = Math.min(r.from, e.validTime)
    r.to = Math.max(r.to, e.validTime)
    rows.set(key, r)
  }
  return [...rows.values()].map(({ times, ...r }) => ({ ...r, steps: times.size }))
}
