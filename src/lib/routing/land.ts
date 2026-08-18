/**
 * The obstacle layer for the isochrone router.
 *
 * Implements docs/03-algorithms/routing-isochrone.md §6. The one rule that
 * matters: **test the segment, not the endpoint.** A router that only asks
 * "is the arrival point on land?" cheerfully hops boats over islands, because
 * a single 30 nm step can straddle one entirely. The doc calls this the most
 * common bug in hobby routers, so `crosses()` — not `isLand()` — is the
 * primitive the kernel uses.
 *
 * Two layers, in the order the doc prescribes:
 *   1. a rasterised bitmask walked with an Amanatides–Woo DDA. This resolves
 *      the overwhelming majority of segments in nanoseconds. The raster is
 *      dilated by one cell after filling, so it is a strict *superset* of the
 *      true land area and can therefore never produce a false negative — which
 *      is what makes it safe to use as an early accept.
 *   2. an exact polygon intersection, run only when the raster says "maybe".
 *
 * Nothing here was derived from any GPL routing source — see
 * docs/02-data-sources/licensing-matrix.md §5.
 */

import { wrap180 } from '../angles'
import { segmentsIntersect } from '../geo'
import type { BBox, LatLon, XY } from '../types'

export interface LandMask {
  isLand(lat: number, lon: number): boolean
  crosses(a: LatLon, b: LatLon): boolean
  readonly bbox: BBox
}

/**
 * GeoJSON polygon coordinates: `[ring][vertex][lon, lat]`. Ring 0 is the outer
 * boundary, any further rings are holes (lakes, inland seas).
 */
export type PolygonCoords = number[][][]

const WORLD_BBOX: BBox = { west: -180, south: -90, east: 180, north: 90 }

/** Open-ocean routing: nothing is ever land, and both tests are free. */
export const NULL_LAND_MASK: LandMask = {
  bbox: WORLD_BBOX,
  isLand: () => false,
  crosses: () => false,
}

// ------------------------------------------------------------ geojson intake

function isRingArray(v: unknown): v is PolygonCoords {
  if (!Array.isArray(v) || v.length === 0) return false
  const ring = v[0]
  if (!Array.isArray(ring) || ring.length === 0) return false
  const pos = ring[0]
  return Array.isArray(pos) && typeof pos[0] === 'number' && typeof pos[1] === 'number'
}

function visit(node: unknown, out: PolygonCoords[]): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) visit(child, out)
    return
  }
  const g = node as Record<string, unknown>
  switch (typeof g.type === 'string' ? g.type : '') {
    case 'FeatureCollection':
      visit(g.features, out)
      return
    case 'Feature':
      visit(g.geometry, out)
      return
    case 'GeometryCollection':
      visit(g.geometries, out)
      return
    case 'Polygon':
      if (isRingArray(g.coordinates)) out.push(g.coordinates)
      return
    case 'MultiPolygon':
      if (Array.isArray(g.coordinates)) {
        for (const poly of g.coordinates) if (isRingArray(poly)) out.push(poly)
      }
      return
    default:
      return
  }
}

/**
 * Pull every Polygon / MultiPolygon out of an arbitrary GeoJSON blob.
 * Deliberately defensive: land data arrives from the network and from user
 * imports, and a malformed feature must degrade to "no land here", never throw.
 */
export function extractPolygons(geojson: unknown): PolygonCoords[] {
  const out: PolygonCoords[] = []
  visit(geojson, out)
  return out
}

// --------------------------------------------------------- exact vector test

interface StoredPoly {
  /** Each ring flattened to `[lon, lat, lon, lat, …]` — one allocation per ring. */
  rings: Float64Array[]
  w: number
  s: number
  e: number
  n: number
}

/**
 * Exact polygon obstacle test. Used on its own for small coastal problems and
 * as the second stage behind `RasterLandMask`.
 *
 * Intersection is tested in a (lon, lat) plane rather than a metric one. That
 * is legitimate: segment crossing is a topological predicate, and an affine
 * scaling of one axis cannot change whether two segments cross. Longitudes are
 * expressed relative to the segment's first point through `wrap180`, so a
 * segment near the antimeridian still behaves.
 */
export class PolygonLandMask implements LandMask {
  readonly bbox: BBox
  private readonly polys: StoredPoly[]
  // Scratch, so the hot-ish edge loop allocates nothing.
  private readonly p1: XY = { x: 0, y: 0 }
  private readonly p2: XY = { x: 0, y: 0 }
  private readonly p3: XY = { x: 0, y: 0 }
  private readonly p4: XY = { x: 0, y: 0 }

  constructor(polygons: PolygonCoords[], bbox?: BBox) {
    this.polys = []
    let west = 180
    let east = -180
    let south = 90
    let north = -90
    for (const poly of polygons) {
      const rings: Float64Array[] = []
      let w = 180
      let e = -180
      let s = 90
      let n = -90
      for (const ring of poly) {
        if (ring.length < 3) continue
        const flat = new Float64Array(ring.length * 2)
        for (let i = 0; i < ring.length; i++) {
          const lon = ring[i][0]
          const lat = ring[i][1]
          flat[i * 2] = lon
          flat[i * 2 + 1] = lat
          if (lon < w) w = lon
          if (lon > e) e = lon
          if (lat < s) s = lat
          if (lat > n) n = lat
        }
        rings.push(flat)
      }
      if (rings.length === 0) continue
      this.polys.push({ rings, w, s, e, n })
      if (w < west) west = w
      if (e > east) east = e
      if (s < south) south = s
      if (n > north) north = n
    }
    this.bbox =
      bbox ??
      (this.polys.length > 0
        ? { west, south, east, north }
        : { west: 0, south: 0, east: 0, north: 0 })
  }

  get polygonCount(): number {
    return this.polys.length
  }

  isLand(lat: number, lon: number): boolean {
    for (let k = 0; k < this.polys.length; k++) {
      const poly = this.polys[k]
      if (lat < poly.s || lat > poly.n) continue
      const rel = wrap180(lon - poly.w)
      if (rel < 0 || rel > poly.e - poly.w) continue
      // Even-odd across the outer ring *and* the holes at once: a point inside
      // a hole crosses one extra boundary and therefore reads as outside.
      let inside = false
      for (let r = 0; r < poly.rings.length; r++) {
        const ring = poly.rings[r]
        const n = ring.length
        for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
          const yi = ring[i + 1]
          const yj = ring[j + 1]
          if (yi > lat !== yj > lat) {
            const xi = ring[i]
            const xj = ring[j]
            if (lon < xi + ((lat - yi) / (yj - yi)) * (xj - xi)) inside = !inside
          }
        }
      }
      if (inside) return true
    }
    return false
  }

  crosses(a: LatLon, b: LatLon): boolean {
    if (this.isLand(a.lat, a.lon) || this.isLand(b.lat, b.lon)) return true
    const p1 = this.p1
    const p2 = this.p2
    const p3 = this.p3
    const p4 = this.p4
    p1.x = 0
    p1.y = a.lat
    p2.x = wrap180(b.lon - a.lon)
    p2.y = b.lat
    const loLat = a.lat < b.lat ? a.lat : b.lat
    const hiLat = a.lat < b.lat ? b.lat : a.lat
    const loX = p1.x < p2.x ? p1.x : p2.x
    const hiX = p1.x < p2.x ? p2.x : p1.x
    for (let k = 0; k < this.polys.length; k++) {
      const poly = this.polys[k]
      if (poly.n < loLat || poly.s > hiLat) continue
      const rw = wrap180(poly.w - a.lon)
      const re = rw + (poly.e - poly.w)
      if (re < loX || rw > hiX) continue
      for (let r = 0; r < poly.rings.length; r++) {
        const ring = poly.rings[r]
        const n = ring.length
        for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
          p3.x = wrap180(ring[j] - a.lon)
          p3.y = ring[j + 1]
          p4.x = wrap180(ring[i] - a.lon)
          p4.y = ring[i + 1]
          if (segmentsIntersect(p1, p2, p3, p4)) return true
        }
      }
    }
    return false
  }
}

// -------------------------------------------------------------- raster stage

/**
 * Bitmask land, walked with a DDA. Cheap enough to sit in the routing inner
 * loop, which is the whole point: the kernel performs one `crosses()` call per
 * candidate state, of which there are millions.
 */
export class RasterLandMask implements LandMask {
  readonly bbox: BBox
  readonly nx: number
  readonly ny: number
  readonly dLon: number
  readonly dLat: number
  /** One bit per cell, row-major, y outer. */
  private readonly bits: Uint32Array
  /** Exact second stage. Null means the raster is the final word. */
  private readonly exact: PolygonLandMask | null

  constructor(
    bbox: BBox,
    nx: number,
    ny: number,
    bits: Uint32Array,
    exact: PolygonLandMask | null = null,
  ) {
    this.bbox = bbox
    this.nx = nx
    this.ny = ny
    this.bits = bits
    this.exact = exact
    this.dLon = (bbox.east - bbox.west) / nx
    this.dLat = (bbox.north - bbox.south) / ny
  }

  /** True if cell (ix, iy) is flagged. Out of range reads as open water. */
  cellIsLand(ix: number, iy: number): boolean {
    if (ix < 0 || iy < 0 || ix >= this.nx || iy >= this.ny) return false
    const k = iy * this.nx + ix
    return (this.bits[k >>> 5] & (1 << (k & 31))) !== 0
  }

  isLand(lat: number, lon: number): boolean {
    const ix = Math.floor(wrap180(lon - this.bbox.west) / this.dLon)
    const iy = Math.floor((lat - this.bbox.south) / this.dLat)
    if (!this.cellIsLand(ix, iy)) return false
    return this.exact ? this.exact.isLand(lat, lon) : true
  }

  crosses(a: LatLon, b: LatLon): boolean {
    if (!this.rasterCrosses(a, b)) return false
    return this.exact ? this.exact.crosses(a, b) : true
  }

  /** Amanatides–Woo voxel traversal in cell space. Conservative by design. */
  private rasterCrosses(a: LatLon, b: LatLon): boolean {
    const fx0 = wrap180(a.lon - this.bbox.west) / this.dLon
    const fy0 = (a.lat - this.bbox.south) / this.dLat
    const fx1 = fx0 + wrap180(b.lon - a.lon) / this.dLon
    const fy1 = fy0 + (b.lat - a.lat) / this.dLat

    // Cheap whole-segment reject: entirely outside the mask box.
    if (fx0 < 0 && fx1 < 0) return false
    if (fy0 < 0 && fy1 < 0) return false
    if (fx0 > this.nx && fx1 > this.nx) return false
    if (fy0 > this.ny && fy1 > this.ny) return false

    const dx = fx1 - fx0
    const dy = fy1 - fy0

    /*
     * Clip the segment to the raster box before walking it — a ray/AABB slab
     * test, in cell space.
     *
     * The walk used to start at the segment's own first point and run under a
     * fixed budget of `nx + ny + 8` steps, returning "maybe land" when it ran
     * out. A segment beginning outside the box spent that budget getting there,
     * so a long enough approach reported land in water it never touched: on the
     * shipped 750x570 Portland raster the threshold was about 1.3°, roughly 80 nm,
     * which is inside the reach of a single offshore leg. It also contradicted the
     * promise made in `src/data/landmask.ts` and on the Route screen, that outside
     * the box the mask reports open water and avoidance does nothing.
     *
     * Clipping first makes the budget structurally unable to decide anything: both
     * ends of the walk are inside the box, so it visits at most `nx + ny` cells no
     * matter how long the original segment was. Note that a segment already
     * starting inside the box clips to `t0 = 0` and therefore walks *exactly* as
     * it did before — the change cannot alter any answer that was previously
     * reachable from inside the venue.
     */
    let t0 = 0
    let t1 = 1
    // Slab test, one axis at a time and deliberately allocation-free: this runs
    // once per candidate state in the routing inner loop, millions of times per
    // solve, so a pair of four-element arrays here would be pure GC churn.
    for (let axis = 0; axis < 2; axis++) {
      const d = axis === 0 ? dx : dy
      const f0 = axis === 0 ? fx0 : fy0
      const hi = axis === 0 ? this.nx : this.ny
      if (d === 0) {
        // No motion on this axis: the segment is inside its slab or it never is.
        if (f0 < 0 || f0 > hi) return false
        continue
      }
      const ta = -f0 / d
      const tb = (hi - f0) / d
      const enter = ta < tb ? ta : tb
      const exit = ta < tb ? tb : ta
      if (enter > t0) t0 = enter
      if (exit < t1) t1 = exit
      if (t0 > t1) return false
    }

    const sx = fx0 + dx * t0
    const sy = fy0 + dy * t0
    let ix = Math.floor(sx)
    let iy = Math.floor(sy)
    const ex = Math.floor(fx0 + dx * t1)
    const ey = Math.floor(fy0 + dy * t1)
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity
    let tmx = dx > 0 ? (ix + 1 - sx) / dx : dx < 0 ? (ix - sx) / dx : Infinity
    let tmy = dy > 0 ? (iy + 1 - sy) / dy : dy < 0 ? (iy - sy) / dy : Infinity

    // Exactly the cells the clipped segment passes through, plus slack for a
    // graze along a boundary. Bounded by the grid, never by the segment's length.
    const steps = Math.abs(ex - ix) + Math.abs(ey - iy) + 2
    for (let guard = 0; guard <= steps; guard++) {
      if (this.cellIsLand(ix, iy)) return true
      if (ix === ex && iy === ey) return false
      if (tmx < tmy) {
        tmx += tdx
        ix += stepX
      } else {
        tmy += tdy
        iy += stepY
      }
    }
    // Unreachable: the clip guarantees the walk terminates at (ex, ey) within
    // `steps`. Kept, and conservative, because the alternative if it ever were
    // reachable is a route over land.
    return true
  }
}

// ----------------------------------------------------------------- rasterise

function setBit(bits: Uint32Array, k: number): void {
  bits[k >>> 5] |= 1 << (k & 31)
}

function getBit(bits: Uint32Array, k: number): boolean {
  return (bits[k >>> 5] & (1 << (k & 31))) !== 0
}

/**
 * Grow the mask by one cell in all eight directions.
 *
 * Why: the scanline fill flags a cell when its *centre* is inside a polygon, so
 * a thin spit of land can slip between two cell centres. Dilating makes the
 * raster a strict superset of the real coastline, which is what licenses the
 * "no land cell touched ⇒ segment is clear" early accept. Accuracy is not lost,
 * because the exact polygon test is the arbiter for anything the raster flags.
 */
function dilate(bits: Uint32Array, nx: number, ny: number): Uint32Array {
  const out = bits.slice()
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (!getBit(bits, iy * nx + ix)) continue
      for (let dy = -1; dy <= 1; dy++) {
        const jy = iy + dy
        if (jy < 0 || jy >= ny) continue
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx
          if (jx < 0 || jx >= nx) continue
          setBit(out, jy * nx + jx)
        }
      }
    }
  }
  return out
}

/**
 * Rasterise GeoJSON land into a bitmask at `cellDeg` resolution, keeping the
 * source polygons for the exact second stage.
 *
 * Even-odd fill is applied *per polygon* rather than globally, so two separate
 * islands that overlap in the bbox union correctly instead of cancelling, while
 * holes inside a single polygon still punch through.
 */
export function buildLandMask(
  geojson: unknown,
  bbox: BBox,
  cellDeg: number,
): RasterLandMask {
  const polys = extractPolygons(geojson)
  const spanLon = Math.max(1e-9, bbox.east - bbox.west)
  const spanLat = Math.max(1e-9, bbox.north - bbox.south)
  const cell = Math.max(1e-6, cellDeg)
  const nx = Math.max(1, Math.min(8192, Math.round(spanLon / cell)))
  const ny = Math.max(1, Math.min(8192, Math.round(spanLat / cell)))
  const dLon = spanLon / nx
  const dLat = spanLat / ny
  const bits = new Uint32Array(((nx * ny + 31) >>> 5) || 1)

  const xs: number[] = []
  for (let j = 0; j < ny; j++) {
    const latC = bbox.south + (j + 0.5) * dLat
    for (let p = 0; p < polys.length; p++) {
      xs.length = 0
      const poly = polys[p]
      for (let r = 0; r < poly.length; r++) {
        const ring = poly[r]
        const n = ring.length
        if (n < 3) continue
        for (let i = 0; i < n; i++) {
          const a = ring[i]
          const b = ring[(i + 1) % n]
          const y1 = a[1]
          const y2 = b[1]
          if (y1 > latC !== y2 > latC) {
            xs.push(a[0] + ((latC - y1) / (y2 - y1)) * (b[0] - a[0]))
          }
        }
      }
      if (xs.length < 2) continue
      xs.sort((m, n) => m - n)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let i0 = Math.ceil((xs[k] - bbox.west) / dLon - 0.5)
        let i1 = Math.floor((xs[k + 1] - bbox.west) / dLon - 0.5)
        if (i1 < 0 || i0 >= nx) continue
        if (i0 < 0) i0 = 0
        if (i1 >= nx) i1 = nx - 1
        const row = j * nx
        for (let ix = i0; ix <= i1; ix++) setBit(bits, row + ix)
      }
    }
  }

  return new RasterLandMask(
    bbox,
    nx,
    ny,
    dilate(bits, nx, ny),
    polys.length > 0 ? new PolygonLandMask(polys, bbox) : null,
  )
}
