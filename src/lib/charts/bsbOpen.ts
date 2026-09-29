/** A BSB/KAP chart made ready for the map: its picture, where its corners go, and what it is. */
import { bsbCorners, bsbGeoref, bsbToRgba, decodeBsb } from './bsb'

export interface OpenedRaster {
  name: string
  number: string
  scale: number
  width: number
  height: number
  /** The picture, shrunk to fit a map texture. */
  rgba: Uint8ClampedArray
  /** Top-left, top-right, bottom-right, bottom-left, as [lon, lat]. */
  corners: [[number, number], [number, number], [number, number], [number, number]]
  rmsPx: number
  warnings: string[]
}

export function openRaster(buf: ArrayBuffer | Uint8Array, palette = 'RGB'): OpenedRaster {
  const c = decodeBsb(buf)
  const geo = bsbGeoref(c.header)
  const img = bsbToRgba(c, palette)
  const warnings = [...c.warnings]
  if (geo.rmsPx > 2) warnings.push(`the reference points fit to ${geo.rmsPx.toFixed(1)} pixels only`)
  return { name: c.header.name, number: c.header.number, scale: c.header.scale, width: img.width, height: img.height, rgba: img.data, corners: bsbCorners(c, geo), rmsPx: geo.rmsPx, warnings }
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
