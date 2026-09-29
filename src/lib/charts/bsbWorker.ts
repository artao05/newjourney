/// <reference lib="webworker" />
/** Decodes BSB/KAP raster charts off the main thread: an RNC is tens of millions of pixels. */
import { openRaster } from './bsbOpen'

declare const self: DedicatedWorkerGlobalScope

self.onmessage = (e: MessageEvent<{ id: number; buf: ArrayBuffer; palette: string }>) => {
  const { id, buf, palette } = e.data
  try {
    const r = openRaster(buf, palette)
    self.postMessage({ id, ok: true, raster: r }, [r.rgba.buffer])
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
