/**
 * Main-thread wrapper around the routing worker.
 *
 * The UI never touches `postMessage`: it awaits a promise and gets progress
 * through a callback. See docs/05-spec/technical-spec.md §5.
 */

import type { PolarTable, RouteRequest, RouteResult, WeatherCube } from '../types'
import type { LandRasterPayload, RouteWorkerRequest, RouteWorkerResponse } from './worker'

export interface RoutePayload {
  cube: WeatherCube
  polar: PolarTable
  /**
   * A prebuilt, validated land raster from a venue pack. Preferred over `land`:
   * finer, already checked against known-water coordinates, and free at route
   * time. See `src/data/landmask.ts`.
   */
  landRaster?: LandRasterPayload
  /** GeoJSON land, or anything `buildLandMask` can parse. Optional. */
  land?: unknown
  /** Land raster cell size in degrees. Coastal default is 0.01° (~0.6 nm). */
  landCellDeg?: number
}

interface Pending {
  id: number
  resolve: (r: RouteResult) => void
  onProgress?: (f: number) => void
}

function cancelledResult(reason: string): RouteResult {
  return {
    ok: false,
    error: reason,
    legs: [],
    etaMs: null,
    elapsedS: null,
    directTimeS: null,
    isochrones: [],
    reverseIsochrones: [],
    sensitivity: null,
    diagnostics: { nodesExplored: 0, timeStepS: 0, computeMs: 0, warnings: [] },
  }
}

export class RoutingClient {
  private worker: Worker | null = null
  private pending: Pending | null = null
  private nextId = 1

  /**
   * Route, resolving with the `RouteResult`. The promise never rejects — the
   * kernel reports failure in-band so the UI has exactly one path to render.
   */
  route(
    req: RouteRequest,
    payload: RoutePayload,
    onProgress?: (f: number) => void,
  ): Promise<RouteResult> {
    // Only one route at a time: a second request supersedes the first, which is
    // what a user dragging a waypoint actually means.
    if (this.pending) this.cancel()
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise<RouteResult>((resolve) => {
      this.pending = { id, resolve, onProgress }
      const msg: RouteWorkerRequest = {
        type: 'route',
        id,
        req,
        cube: payload.cube,
        polarTable: payload.polar,
        landRaster: payload.landRaster,
        landData: payload.land,
        landCellDeg: payload.landCellDeg,
      }
      // Keep the UI's cube intact. Transferring these buffers detaches the typed
      // arrays on the main thread, so a second route or the wind overlay sees an
      // empty forecast. The pilot cubes are small enough that cloning is the
      // right correctness trade-off; a future persisted cube cache can give the
      // worker its own transferable copy.
      worker.postMessage(msg)
    })
  }

  /** Abandon the running route. The pending promise resolves `ok: false`. */
  cancel(): void {
    const p = this.pending
    this.pending = null
    if (this.worker) {
      // Termination is the cancellation mechanism: the kernel's inner loop has
      // no yield point by design, so there is nothing to poll a flag from.
      this.worker.terminate()
      this.worker = null
    }
    if (p) p.resolve(cancelledResult('routing cancelled'))
  }

  dispose(): void {
    this.cancel()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as RouteWorkerResponse | undefined
      const p = this.pending
      if (!msg || !p || msg.id !== p.id) return
      if (msg.type === 'progress') {
        p.onProgress?.(msg.fraction)
        return
      }
      this.pending = null
      p.resolve(msg.result)
    }
    worker.onerror = (e: ErrorEvent) => {
      const p = this.pending
      this.pending = null
      if (p) p.resolve(cancelledResult(`routing worker crashed: ${e.message}`))
    }
    this.worker = worker
    return worker
  }
}
