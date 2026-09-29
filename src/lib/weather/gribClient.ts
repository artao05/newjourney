/**
 * Opens a GRIB file in a worker, or on this thread where there are no workers
 * (tests, very old browsers).
 */
import { openGribSync, type GribOpened } from './grib2'
import type { BBox } from '../types'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (o: GribOpened) => void; reject: (e: Error) => void }>()

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./gribWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; out?: GribOpened; error?: string }>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    if (e.data.ok && e.data.out) p.resolve(e.data.out)
    else p.reject(new Error(e.data.error ?? 'the GRIB file could not be read'))
  }
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'the GRIB reader stopped'))
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

export function openGrib(buf: ArrayBuffer, opts: { bbox?: BBox; model?: string } = {}): Promise<GribOpened> {
  if (typeof Worker === 'undefined') return Promise.resolve(openGribSync(buf, opts))
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ensureWorker().postMessage({ id, buf, ...opts }, [buf])
  })
}
