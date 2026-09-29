/**
 * Chart cells the user has installed, and how they are drawn. The cells' files
 * are kept in IndexedDB (lib/charts/library.ts) and drawn again on start;
 * the display settings live here for the session.
 */
import { create } from 'zustand'
import type { EncCell } from '@/lib/charts/s57'
import type { DisplayCategory } from '@/lib/charts/s52'
import { cellStore, groupCellFiles, mergeCell, type StoredCell } from '@/lib/charts/library'
import { openEncCell } from '@/lib/charts/s57Client'
import { openRasterChart, type OpenedRaster } from '@/lib/charts/bsbOpen'

export interface EncDisplay {
  category: DisplayCategory
  shallowM: number
  deepM: number
  twoShades: boolean
  night: boolean
}

/** A raster chart (BSB/KAP) on the Route chart: its picture as an image URL and where its corners go. */
export interface RasterChart {
  id: string
  name: string
  number: string
  scale: number
  url: string
  corners: OpenedRaster['corners']
  opacity: number
  on: boolean
  warnings: string[]
}

interface ChartsState {
  cells: EncCell[]
  /** Raster charts opened this session (not kept yet). */
  rasters: RasterChart[]
  addRaster(r: RasterChart): void
  updateRaster(id: string, patch: Partial<Pick<RasterChart, 'on' | 'opacity'>>): void
  removeRaster(id: string): void
  safetyDepthM: number
  /** S-52 starts on Standard; soundings matter inshore, so this starts on All. */
  display: EncDisplay
  add(c: EncCell): void
  /** Take a cell off the chart, by its name with or without extension. */
  remove(name: string): void
  clear(): void
  setSafetyDepth(m: number): void
  /** Route through water at least the safety depth, and clear of dangers, where there are cells. */
  routeBySafety: boolean
  setRouteBySafety(on: boolean): void
  setDisplay(p: Partial<EncDisplay>): void
}

export const DEFAULT_ENC_DISPLAY: EncDisplay = { category: 'all', shallowM: 2, deepM: 10, twoShades: false, night: false }

/** A cell's name without its extension, upper case: the key it is installed under. */
export const cellKey = (name: string) => name.replace(/\.\d{3}$/, '').toUpperCase()

export const useCharts = create<ChartsState>()((set) => ({
  cells: [],
  rasters: [],
  addRaster: (r) => set((s) => ({ rasters: [...s.rasters, r] })),
  updateRaster: (id, patch) => set((s) => ({ rasters: s.rasters.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  removeRaster: (id) =>
    set((s) => {
      const gone = s.rasters.find((r) => r.id === id)
      if (gone) URL.revokeObjectURL(gone.url)
      return { rasters: s.rasters.filter((r) => r.id !== id) }
    }),
  safetyDepthM: 3,
  display: DEFAULT_ENC_DISPLAY,
  // A cell opened again (same name) replaces the one held.
  add: (c) => set((s) => ({ cells: [...s.cells.filter((x) => cellKey(x.name) !== cellKey(c.name)), c] })),
  remove: (name) => set((s) => ({ cells: s.cells.filter((x) => cellKey(x.name) !== cellKey(name)) })),
  clear: () => set({ cells: [] }),
  setSafetyDepth: (m) => set({ safetyDepthM: m }),
  routeBySafety: true,
  setRouteBySafety: (on) => set({ routeBySafety: on }),
  setDisplay: (p) => set((s) => ({ display: { ...s.display, ...p } })),
}))

/** A stored cell drawn: base and updates copied, since the worker takes the buffers it is given. */
function draw(c: StoredCell): Promise<EncCell> {
  return openEncCell(
    c.base.slice().buffer,
    c.updates.map((u) => u.bytes.slice().buffer),
  )
}

export interface InstallResult {
  installed: string[]
  errors: string[]
  skipped: string[]
}

/**
 * Install chart files: base cells, update files, a folder of them, or zipped
 * exchange sets. Each cell is kept and drawn again with all its updates.
 */
export async function installChartFiles(files: Array<{ name: string; bytes: Uint8Array }>, now = Date.now()): Promise<InstallResult> {
  const out: InstallResult = { installed: [], errors: [], skipped: [] }
  let grouped: ReturnType<typeof groupCellFiles>
  try {
    grouped = groupCellFiles(files)
  } catch (e) {
    return { ...out, errors: [e instanceof Error ? e.message : String(e)] }
  }
  out.skipped = grouped.skipped
  const store = cellStore()
  const installed = new Map((await store.list()).map((c) => [c.name, c]))
  for (const incoming of grouped.cells) {
    const merged = mergeCell(installed.get(incoming.name), incoming, now)
    if ('error' in merged) {
      out.errors.push(merged.error)
      continue
    }
    try {
      const cell = await draw(merged)
      await store.put(merged)
      useCharts.getState().add(cell)
      out.installed.push(merged.name)
    } catch (e) {
      out.errors.push(`${incoming.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

export async function uninstallCell(name: string): Promise<void> {
  await cellStore().remove(cellKey(name))
  useCharts.getState().remove(name)
}

export async function uninstallAllCells(): Promise<void> {
  await cellStore().clear()
  useCharts.getState().clear()
}

let restoring: Promise<void> | null = null

/** Draw the installed cells again, once a session. */
export function restoreCharts(): Promise<void> {
  restoring ??= (async () => {
    let stored: StoredCell[] = []
    try {
      stored = await cellStore().list()
    } catch {
      return
    }
    for (const c of stored.sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        useCharts.getState().add(await draw(c))
      } catch {
        /* one damaged cell does not keep the rest off the chart */
      }
    }
  })()
  return restoring
}

/** For tests: forget that the cells were restored. */
export function resetChartRestore() {
  restoring = null
}

let rasterSeq = 0

/** Open a BSB/KAP raster chart and put it on the Route chart, under the ENC cells. */
export async function openRasterFile(name: string, bytes: Uint8Array, palette = 'RGB'): Promise<RasterChart> {
  const r = await openRasterChart(bytes.slice().buffer, palette)
  const canvas = document.createElement('canvas')
  canvas.width = r.width
  canvas.height = r.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('this browser cannot draw the chart picture')
  ctx.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.width, r.height), 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('this browser cannot draw the chart picture')
  const chart: RasterChart = {
    id: `rnc-${Date.now().toString(36)}-${rasterSeq++}`,
    name: r.name || name,
    number: r.number,
    scale: r.scale,
    url: URL.createObjectURL(blob),
    corners: r.corners,
    opacity: 1,
    on: true,
    warnings: r.warnings,
  }
  useCharts.getState().addRaster(chart)
  return chart
}
