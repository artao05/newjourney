/** Decodes an S-57 cell in a worker, or on this thread where there are no workers. */
import { decodeS57, type EncCell } from './s57'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (c: EncCell) => void; reject: (e: Error) => void }>()

export function openEncCell(buf: ArrayBuffer): Promise<EncCell> {
  if (typeof Worker === 'undefined') {
    try {
      return Promise.resolve(decodeS57(buf))
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
  }
  if (!worker) {
    worker = new Worker(new URL('./s57Worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; cell?: EncCell; error?: string }>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.ok && e.data.cell) p.resolve(e.data.cell)
      else p.reject(new Error(e.data.error ?? 'the chart cell could not be read'))
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
    worker!.postMessage({ id, buf }, [buf])
  })
}
