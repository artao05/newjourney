/// <reference lib="webworker" />
/**
 * Decodes GRIB off the main thread: a global 0.25° field is a million points,
 * and a file holds dozens of them.
 */
import { openGribSync } from './grib2'
import type { BBox } from '../types'

declare const self: DedicatedWorkerGlobalScope

self.onmessage = (e: MessageEvent<{ id: number; buf: ArrayBuffer; bbox?: BBox; model?: string }>) => {
  const { id, buf, bbox, model } = e.data
  try {
    const out = openGribSync(buf, { bbox, model })
    const transfer = out.cube ? Object.values(out.cube.data).map((a) => a.buffer as ArrayBuffer) : []
    self.postMessage({ id, ok: true, out }, transfer)
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
