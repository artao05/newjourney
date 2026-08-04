/**
 * Web Worker entry for the routing kernel.
 *
 * See docs/05-spec/technical-spec.md §5: the kernel "lives in a Web Worker,
 * pure function of its inputs — no I/O, no clock, no globals". This file is the
 * only place in `src/lib/routing/**` that knows about `postMessage`, the weather
 * cube wire format or the polar table, which is what keeps `isochrone.ts`
 * testable in plain Node.
 *
 * Protocol
 *   in   { type: 'route', id, req, cube, polarTable, landData? }
 *   out  { type: 'progress', id, fraction }
 *        { type: 'result',   id, result }
 *
 * Cancellation is by termination — `RoutingClient.cancel()` kills the worker and
 * builds a fresh one. A cooperative flag would need a yield point in the inner
 * loop, and the inner loop is where the whole performance budget lives.
 */

import { routeIsochrone, type RouteContext } from './isochrone'
import { RasterLandMask, buildLandMask, type LandMask } from './land'
import type {
  BBox,
  PolarLattice,
  PolarTable,
  RouteRequest,
  RouteResult,
  WeatherCube,
  WeatherField,
} from '../types'

/**
 * A land mask already rasterised offline, passed through as-is.
 *
 * Preferred over `landData` whenever a venue pack exists: it is finer than
 * anything worth rasterising per request (the Portland pack is ~111 m), it has
 * been validated against known-water coordinates, and it costs nothing at route
 * time. `Uint32Array` survives structured clone, so it crosses to the worker
 * without a copy of the geometry.
 */
export interface LandRasterPayload {
  bbox: BBox
  nx: number
  ny: number
  bits: Uint32Array
}

export interface RouteWorkerRequest {
  type: 'route'
  id: number
  req: RouteRequest
  cube: WeatherCube
  polarTable: PolarTable
  /** Prebuilt raster. Takes precedence over `landData`. */
  landRaster?: LandRasterPayload
  landData?: unknown
  /** Land raster cell size in degrees. Defaults to a coastal-scale 0.01°. */
  landCellDeg?: number
}

export type RouteWorkerResponse =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'result'; id: number; result: RouteResult }

/**
 * The polar and weather modules are pulled in *here and only here*, and lazily.
 *
 * Keeping them out of `isochrone.ts` is deliberate: the kernel then has no
 * dependency beyond `types`, `angles` and `geo`, which is what lets the whole
 * §10 validation suite run in plain Node against analytic fakes. Loading them
 * dynamically also keeps them out of the main-thread bundle — nothing but the
 * worker ever needs a polar interpolator.
 *
 * Both are guarded: a worker that cannot build its inputs reports an actionable
 * error rather than dying with an unhandled rejection.
 */
export async function rebuildLattice(table: PolarTable): Promise<PolarLattice> {
  try {
    const { buildLattice } = await import('../polar')
    return buildLattice(table)
  } catch (e) {
    throw new Error(
      `could not build the polar lattice from "${table?.name ?? 'unnamed polar'}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }
}

/** Rebuild a `WeatherField` from a transferred cube. */
export async function rebuildField(cube: WeatherCube): Promise<WeatherField> {
  try {
    const { CubeField } = await import('../weather')
    return new CubeField(cube)
  } catch (e) {
    throw new Error(
      `could not rebuild the forecast field: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

function rebuildLand(data: unknown, bbox: BBox, cellDeg: number): LandMask | null {
  if (data == null) return null
  try {
    return buildLandMask(data, bbox, cellDeg)
  } catch {
    return null
  }
}

/**
 * Adopt a prebuilt raster.
 *
 * Validates the bit array against the declared grid before trusting it. A short
 * array would read as open water past its end, and a router that believes land
 * is sea is worse than one with no land data at all — the second warns you, the
 * first does not.
 */
function adoptLandRaster(p: LandRasterPayload | undefined): LandMask | null {
  if (!p) return null
  const want = Math.ceil((p.nx * p.ny) / 32)
  const bits = p.bits instanceof Uint32Array ? p.bits : new Uint32Array(p.bits)
  if (p.nx <= 0 || p.ny <= 0 || bits.length < want) return null
  return new RasterLandMask(p.bbox, p.nx, p.ny, bits)
}

/** Bounding box that covers the course, padded — used to size the land raster. */
function courseBBox(req: RouteRequest, cube: WeatherCube): BBox {
  const lats = [req.start.lat, ...req.marks.map((m) => m.lat)]
  const lons = [req.start.lon, ...req.marks.map((m) => m.lon)]
  const pad = 0.5
  const bb: BBox = {
    west: Math.min(...lons) - pad,
    east: Math.max(...lons) + pad,
    south: Math.min(...lats) - pad,
    north: Math.max(...lats) + pad,
  }
  // Never rasterise land outside the forecast box — nothing there is routable.
  return {
    west: Math.max(bb.west, cube.bbox.west),
    east: Math.min(bb.east, cube.bbox.east),
    south: Math.max(bb.south, cube.bbox.south),
    north: Math.min(bb.north, cube.bbox.north),
  }
}

/**
 * Run one request. Exported so the protocol can be exercised in Node without a
 * real `Worker`, and so a server-side caller can reuse it verbatim.
 */
export async function handleRouteMessage(
  msg: RouteWorkerRequest,
  post: (m: RouteWorkerResponse) => void,
): Promise<void> {
  try {
    const [lattice, field] = await Promise.all([
      rebuildLattice(msg.polarTable),
      rebuildField(msg.cube),
    ])
    // A validated venue raster beats rasterising GeoJSON per request.
    const land =
      adoptLandRaster(msg.landRaster) ??
      rebuildLand(msg.landData, courseBBox(msg.req, msg.cube), msg.landCellDeg ?? 0.01)
    let lastPost = 0
    const ctx: RouteContext = {
      field,
      lattice,
      land,
      onProgress: (fraction) => {
        // Throttled: progress messages that outnumber the frames that can show
        // them just steal cycles from the search.
        const now = Date.now()
        if (now - lastPost < 100 && fraction < 1) return
        lastPost = now
        post({ type: 'progress', id: msg.id, fraction })
      },
    }
    post({ type: 'result', id: msg.id, result: routeIsochrone(msg.req, ctx) })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    post({
      type: 'result',
      id: msg.id,
      result: {
        ok: false,
        error: `worker could not start the route: ${message}`,
        legs: [],
        etaMs: null,
        elapsedS: null,
        directTimeS: null,
        isochrones: [],
        reverseIsochrones: [],
        sensitivity: null,
        diagnostics: { nodesExplored: 0, timeStepS: 0, computeMs: 0, warnings: [] },
      },
    })
  }
}

// Wire up only when we really are inside a worker. Importing this module from a
// test or from the main thread must be inert.
const scope = globalThis as unknown as {
  postMessage?: (m: unknown) => void
  onmessage?: unknown
  addEventListener?: (t: string, h: (e: MessageEvent) => void) => void
  importScripts?: unknown
  document?: unknown
}

if (
  typeof scope.postMessage === 'function' &&
  typeof scope.addEventListener === 'function' &&
  typeof scope.document === 'undefined'
) {
  scope.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as RouteWorkerRequest | undefined
    if (!data || data.type !== 'route') return
    void handleRouteMessage(data, (m) => scope.postMessage?.(m))
  })
}
