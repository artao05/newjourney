/// <reference lib="webworker" />
/** Decodes S-57 cells off the main thread: a harbour cell is tens of thousands of records. */
import { decodeS57 } from './s57'

declare const self: DedicatedWorkerGlobalScope

self.onmessage = (e: MessageEvent<{ id: number; buf: ArrayBuffer }>) => {
  const { id, buf } = e.data
  try {
    self.postMessage({ id, ok: true, cell: decodeS57(buf) })
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
