/** A BSB/KAP chart made ready for the map: its picture, where its corners go, and what it is. */
import { bsbCorners, bsbGeoref, bsbToRgba, decodeBsb, type BsbGeoref } from './bsb'

export type Corners = [[number, number], [number, number], [number, number], [number, number]]

export interface OpenedRaster {
  name: string
  number: string
  scale: number
  width: number
  height: number
  /** The picture, shrunk to fit a map texture. */
  rgba: Uint8ClampedArray
  /** Top-left, top-right, bottom-right, bottom-left, as [lon, lat]. */
  corners: Corners
  /**
   * A grid over the chart: (cols + 1) × (rows + 1) vertices as [lon, lat], row by row from
   * the top-left, placed by the chart's own georeferencing. Drawn a tile at a time, the
   * picture follows the chart's projection instead of one four-corner warp, which is
   * tens of metres out across a whole Lambert chart. The tile edges, xs and ys, fall on
   * whole pixels of the picture, and the vertices are placed exactly there.
   */
  grid: { cols: number; rows: number; xs: number[]; ys: number[]; points: Array<[number, number]> }
  rmsPx: number
  warnings: string[]
}

/** Chart pixels a side for a tile, at most: a warp across that stays within a metre or two of the projection. */
const TILE_PX = 1024

function gridOver(chart: { width: number; height: number }, picture: { width: number; height: number }, geo: BsbGeoref): OpenedRaster['grid'] {
  const cols = Math.min(8, Math.max(1, Math.ceil(chart.width / TILE_PX)))
  const rows = Math.min(8, Math.max(1, Math.ceil(chart.height / TILE_PX)))
  const xs = Array.from({ length: cols + 1 }, (_, i) => Math.round((i / cols) * picture.width))
  const ys = Array.from({ length: rows + 1 }, (_, j) => Math.round((j / rows) * picture.height))
  const points: Array<[number, number]> = []
  for (const y of ys)
    for (const x of xs) {
      const p = geo.toLatLon((x * chart.width) / picture.width, (y * chart.height) / picture.height)
      points.push([p.lon, p.lat])
    }
  return { cols, rows, xs, ys, points }
}

/** The picture cut along the grid: each tile's pixels in the (shrunk) picture, and where its corners go. */
export function rasterTiles(r: Pick<OpenedRaster, 'grid'>): Array<{ x: number; y: number; w: number; h: number; corners: Corners }> {
  const { cols, rows, xs, ys, points } = r.grid
  const at = (i: number, j: number) => points[j * (cols + 1) + i]
  const out: Array<{ x: number; y: number; w: number; h: number; corners: Corners }> = []
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++)
      out.push({ x: xs[i], y: ys[j], w: xs[i + 1] - xs[i], h: ys[j + 1] - ys[j], corners: [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)] })
  return out
}

export function openRaster(buf: ArrayBuffer | Uint8Array, palette = 'RGB'): OpenedRaster {
  const c = decodeBsb(buf)
  const geo = bsbGeoref(c.header)
  const img = bsbToRgba(c, palette)
  const warnings = [...c.warnings]
  if (geo.rmsPx > 2) warnings.push(`the reference points fit to ${geo.rmsPx.toFixed(1)} pixels only`)
  return {
    name: c.header.name,
    number: c.header.number,
    scale: c.header.scale,
    width: img.width,
    height: img.height,
    rgba: img.data,
    corners: bsbCorners(c, geo),
    grid: gridOver(c, img, geo),
    rmsPx: geo.rmsPx,
    warnings,
  }
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: OpenedRaster) => void; reject: (e: Error) => void }>()

/** Open a raster chart in a worker, or on this thread where there are none. The buffer is handed over. */
export function openRasterChart(buf: ArrayBuffer, palette = 'RGB'): Promise<OpenedRaster> {
  if (typeof Worker === 'undefined') {
    try {
      return Promise.resolve(openRaster(buf, palette))
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
  }
  if (!worker) {
    worker = new Worker(new URL('./bsbWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; raster?: OpenedRaster; error?: string }>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.ok && e.data.raster) p.resolve(e.data.raster)
      else p.reject(new Error(e.data.error ?? 'the raster chart could not be read'))
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'the chart reader stopped'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, buf, palette }, [buf])
  })
}
