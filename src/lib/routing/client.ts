/**
 * Main-thread wrapper around the routing worker.
 *
 * The UI never touches `postMessage`: it awaits a promise and gets progress
 * through a callback. See docs/05-spec/technical-spec.md §5.
 */

import type { DepartureSweep } from './departure'
import type { Millis, PolarTable, RouteRequest, RouteResult, WeatherCube } from '../types'
import type {
  LandRasterPayload,
  RouteWorkerRequest,
  SweepWorkerRequest,
  WorkerResponse,
} from './worker'

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

/**
 * The one outstanding request.
 *
 * Discriminated rather than a single `resolve` widened to both result types: the
 * worker is shared, a sweep response must never resolve a route promise with the
 * wrong shape, and the compiler is the only thing that can guarantee that.
 */
type Pending =
  | { kind: 'route'; id: number; resolve: (r: RouteResult) => void; onProgress?: (f: number) => void }
  | { kind: 'sweep'; id: number; resolve: (s: DepartureSweep) => void; onProgress?: (f: number) => void }

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
    diagnostics: { nodesExplored: 0, timeStepS: 0, computeMs: 0, landAvoided: false, warnings: [] },
  }
}

function cancelledSweep(reason: string): DepartureSweep {
  return {
    options: [],
    best: null,
    spreadS: null,
    stepFloorS: null,
    attempted: 0,
    succeeded: 0,
    warnings: [reason],
  }
}

/** Departures to solve in one sweep. See `SweepOptions.maxSolves`. */
export interface SweepWindow {
  from: Millis
  /** Inclusive. */
  to: Millis
  stepMs: number
  maxSolves?: number
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
      this.pending = { kind: 'route', id, resolve, onProgress }
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

  /**
   * Sweep a window of departure times, resolving with the ranked set.
   *
   * `req.startTime` is ignored; the sweep supplies one per solve. Like `route`,
   * the promise never rejects — a sweep that could not run comes back with no
   * `best` and a warning saying why, which is the same shape as a sweep where
   * every departure legitimately failed.
   *
   * Progress is `done / total` departures, not isochrone steps.
   */
  sweep(
    req: RouteRequest,
    payload: RoutePayload,
    window: SweepWindow,
    onProgress?: (f: number) => void,
  ): Promise<DepartureSweep> {
    if (this.pending) this.cancel()
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise<DepartureSweep>((resolve) => {
      this.pending = { kind: 'sweep', id, resolve, onProgress }
      const msg: SweepWorkerRequest = {
        type: 'sweep',
        id,
        req,
        cube: payload.cube,
        polarTable: payload.polar,
        landRaster: payload.landRaster,
        landData: payload.land,
        landCellDeg: payload.landCellDeg,
        from: window.from,
        to: window.to,
        stepMs: window.stepMs,
        maxSolves: window.maxSolves,
      }
      // Cloned, not transferred, for the reason `route` documents above.
      worker.postMessage(msg)
    })
  }

  /** Abandon the running route or sweep. The pending promise resolves in-band. */
  cancel(): void {
    const p = this.pending
    this.pending = null
    if (this.worker) {
      // Termination is the cancellation mechanism: the kernel's inner loop has
      // no yield point by design, so there is nothing to poll a flag from.
      this.worker.terminate()
      this.worker = null
    }
    if (!p) return
    if (p.kind === 'sweep') p.resolve(cancelledSweep('departure sweep cancelled'))
    else p.resolve(cancelledResult('routing cancelled'))
  }

  dispose(): void {
    this.cancel()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as WorkerResponse | undefined
      const p = this.pending
      if (!msg || !p || msg.id !== p.id) return
      if (msg.type === 'progress') {
        p.onProgress?.(msg.fraction)
        return
      }
      // A response of the wrong kind for the outstanding request is dropped
      // rather than resolved. Ids already make this unreachable; it is here so
      // that a future second request kind cannot resolve a promise with a shape
      // its caller does not expect.
      if (msg.type === 'result' && p.kind === 'route') {
        this.pending = null
        p.resolve(msg.result)
      } else if (msg.type === 'sweepResult' && p.kind === 'sweep') {
        this.pending = null
        p.resolve(msg.sweep)
      }
    }
    worker.onerror = (e: ErrorEvent) => {
      const p = this.pending
      this.pending = null
      /*
       * Drop the worker, not just the request.
       *
       * An uncaught error reaching here means the module never loaded or the
       * thread is gone - `handleRouteMessage` catches everything else and reports
       * failure in-band. Keeping the reference meant the next `route()` saw no
       * pending request, skipped `cancel()`, reused the dead worker, and posted
       * into the void: that promise never settled, so the UI sat on "Routing" with
       * no route and no error until someone pressed ROUTE a second time. A hang
       * with no feedback is the worst of the failure modes available here.
       *
       * Guarded on identity because a newer worker may already have replaced this
       * one, and tearing that one down would move the hang rather than fix it.
       */
      if (this.worker === worker) {
        worker.terminate()
        this.worker = null
      }
      if (!p) return
      const why = `routing worker crashed: ${e.message}`
      if (p.kind === 'sweep') p.resolve(cancelledSweep(why))
      else p.resolve(cancelledResult(why))
    }
    this.worker = worker
    return worker
  }
}
