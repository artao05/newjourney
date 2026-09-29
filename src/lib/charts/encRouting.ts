/**
 * ENC cells for the router and for checking a route, against the safety depth.
 *
 * Unsafe water, for a boat that needs the safety depth: land, depth areas
 * whose shallow end (DRVAL1) is less than it, and dangers (rocks, wrecks,
 * obstructions) whose depth (VALSOU) is less than it or not given, each
 * kept `dangerBufferM` clear of. The router is given these as more land, in
 * the same grid as the venue's land pack; the route check samples a route
 * against them and says where it goes wrong, as an ECDIS route check does.
 */
import { distance } from '../geo'
import { dilate, fillPolygons, type PolygonCoords } from '../routing/land'
import type { BBox, LatLon } from '../types'
import type { EncCell, EncFeature } from './s57'

const DANGERS = new Set(['UWTROC', 'WRECKS', 'OBSTRN'])

/** A danger point whose depth, if charted, is less than the safety depth. */
function isDangerous(f: EncFeature, safetyDepthM: number): boolean {
  const v = f.attrs.VALSOU
  if (v == null || v === '') return true
  const d = Number(v)
  return !Number.isFinite(d) || d < safetyDepthM
}

function isShallowArea(f: EncFeature, safetyDepthM: number): boolean {
  if (f.cls === 'LNDARE') return true
  if (f.cls !== 'DEPARE' && f.cls !== 'DRGARE') return false
  const d = Number(f.attrs.DRVAL1 ?? 0)
  return !Number.isFinite(d) || d < safetyDepthM
}

/** A square `halfM` each side of a point, as a polygon. */
function box(lon: number, lat: number, halfM: number): PolygonCoords {
  const dLat = halfM / 111_120
  const dLon = halfM / (111_120 * Math.cos((lat * Math.PI) / 180))
  return [[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]]
}

/** Every polygon a boat needing `safetyDepthM` must keep out of. */
export function unsafePolygons(cells: EncCell[], safetyDepthM: number, dangerBufferM = 50): PolygonCoords[] {
  const out: PolygonCoords[] = []
  for (const c of cells) {
    for (const f of c.features) {
      const g = f.geometry
      if (!g) continue
      if (g.type === 'Polygon' && (isShallowArea(f, safetyDepthM) || (DANGERS.has(f.cls) && isDangerous(f, safetyDepthM)))) out.push(g.coordinates)
      else if (g.type === 'Point' && DANGERS.has(f.cls) && isDangerous(f, safetyDepthM)) out.push(box(g.coordinates[0], g.coordinates[1], dangerBufferM))
    }
  }
  return out
}

export interface RasterPayload {
  bbox: BBox
  nx: number
  ny: number
  bits: Uint32Array
}

/**
 * The router's land raster with the ENC's unsafe water added. Given the
 * venue's land pack, in its grid (a copy: the pack is not changed); without
 * one, a grid over the cells at about 50 m.
 */
export function withEncHazards(base: RasterPayload | undefined, cells: EncCell[], safetyDepthM: number, dangerBufferM = 50): RasterPayload | undefined {
  const polys = unsafePolygons(cells, safetyDepthM, dangerBufferM)
  if (!polys.length) return base
  let grid: RasterPayload
  if (base) grid = { ...base, bits: base.bits.slice() }
  else {
    const bs = cells.map((c) => c.bounds).filter((b): b is BBox => !!b)
    if (!bs.length) return base
    const bbox = { west: Math.min(...bs.map((b) => b.west)), south: Math.min(...bs.map((b) => b.south)), east: Math.max(...bs.map((b) => b.east)), north: Math.max(...bs.map((b) => b.north)) }
    const cell = 0.0005
    const nx = Math.max(1, Math.min(4096, Math.round((bbox.east - bbox.west) / cell)))
    const ny = Math.max(1, Math.min(4096, Math.round((bbox.north - bbox.south) / cell)))
    grid = { bbox, nx, ny, bits: new Uint32Array(Math.ceil((nx * ny) / 32)) }
  }
  // Filled by cell centres, then grown a cell, so no unsafe water is left out.
  const own = new Uint32Array(grid.bits.length)
  fillPolygons(own, grid.bbox, grid.nx, grid.ny, polys)
  const grown = dilate(own, grid.nx, grid.ny)
  for (let i = 0; i < grid.bits.length; i++) grid.bits[i] |= grown[i]
  return grid
}

// ------------------------------------------------------------ route check

export interface RouteHazard {
  kind: 'land' | 'shallow' | 'danger'
  /** Where the route first meets it. */
  at: LatLon
  /** The leg (0 from the start) it is on. */
  leg: number
  what: string
}

function inRing(ring: number[][], lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inPolygon(rings: number[][][], lon: number, lat: number): boolean {
  if (!rings.length || !inRing(rings[0], lon, lat)) return false
  for (let k = 1; k < rings.length; k++) if (inRing(rings[k], lon, lat)) return false
  return true
}

const CLASS_NAME: Record<string, string> = { UWTROC: 'Rock', WRECKS: 'Wreck', OBSTRN: 'Obstruction', LNDARE: 'Land', DEPARE: 'Depth area', DRGARE: 'Dredged area' }

/**
 * Where a route (its points in order) meets land, water shallower than the
 * safety depth, or comes within `clearanceM` of a danger. Each hazard is
 * named once, where the route first meets it. Sampled every `stepM` along
 * the route.
 */
export function checkRoute(points: LatLon[], cells: EncCell[], safetyDepthM: number, clearanceM = 50, stepM = 20): RouteHazard[] {
  type Area = { f: EncFeature; rings: number[][][]; bb: BBox }
  const areas: Area[] = []
  const dangers: Array<{ f: EncFeature; p: LatLon }> = []
  for (const c of cells) {
    for (const f of c.features) {
      const g = f.geometry
      if (!g) continue
      if (g.type === 'Polygon' && (isShallowArea(f, safetyDepthM) || (DANGERS.has(f.cls) && isDangerous(f, safetyDepthM)))) {
        const xs = g.coordinates[0].map((p) => p[0])
        const ys = g.coordinates[0].map((p) => p[1])
        areas.push({ f, rings: g.coordinates, bb: { west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) } })
      } else if (g.type === 'Point' && DANGERS.has(f.cls) && isDangerous(f, safetyDepthM)) {
        dangers.push({ f, p: { lat: g.coordinates[1], lon: g.coordinates[0] } })
      }
    }
  }
  const found = new Map<EncFeature, RouteHazard>()
  const clearNm = clearanceM / 1852
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const n = Math.max(1, Math.ceil((distance(a, b) * 1852) / stepM))
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const p = { lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n }
      for (const ar of areas) {
        if (found.has(ar.f) || p.lon < ar.bb.west || p.lon > ar.bb.east || p.lat < ar.bb.south || p.lat > ar.bb.north) continue
        if (!inPolygon(ar.rings, p.lon, p.lat)) continue
        const f = ar.f
        const kind = f.cls === 'LNDARE' ? 'land' : DANGERS.has(f.cls) ? 'danger' : 'shallow'
        const what =
          kind === 'shallow'
            ? `${CLASS_NAME[f.cls]} ${f.attrs.DRVAL1 ?? '?'}–${f.attrs.DRVAL2 ?? '?'} m, under the ${safetyDepthM} m safety depth`
            : `${CLASS_NAME[f.cls] ?? f.cls}${f.attrs.OBJNAM ? ` (${f.attrs.OBJNAM})` : ''}`
        found.set(f, { kind, at: p, leg: i - 1, what })
      }
      for (const d of dangers) {
        if (found.has(d.f) || distance(p, d.p) > clearNm) continue
        const depth = d.f.attrs.VALSOU ? `, ${d.f.attrs.VALSOU} m` : ''
        found.set(d.f, { kind: 'danger', at: p, leg: i - 1, what: `${CLASS_NAME[d.f.cls]}${depth} within ${clearanceM} m` })
      }
    }
  }
  return [...found.values()].sort((x, y) => x.leg - y.leg)
}
