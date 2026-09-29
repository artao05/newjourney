/**
 * The grid algorithm: an older, simpler router than the isochrones, kept for
 * what it is good at, a second opinion and long ocean legs.
 *
 * Nodes sit in rows across the track from start to finish, along the great
 * circle or the rhumb line, with columns either side. The boat moves forward a
 * row at a time, up to three columns sideways, so a beat is a zigzag of
 * diagonal moves; each move is timed with the polar in the wind and current at
 * its start and the time it is sailed. Forward-only moves make it a dynamic
 * programme over rows, exact on its own grid. It charges nothing for a tack,
 * and it cannot go back on itself, which is where the isochrones do better.
 */

import { bearing, destination, distance } from '@/lib/geo'
import { angdiff, wrap360 } from '@/lib/angles'
import type { LatLon, PolarLattice, RouteLeg, RouteRequest, RouteResult, WeatherField } from '@/lib/types'
import type { LandMask } from './land'

export interface GridOptions {
  /** Rows from start to finish. */
  rows?: number
  /** Cross-track width either side of the track, as a fraction of its length. */
  widthFrac?: number
  /** Lay the rows along the great circle rather than the rhumb line. */
  greatCircle?: boolean
}

const MAX_SIDESTEP = 3

/** The point a fraction `f` of the way along the great circle from `a` to `b`. */
export function greatCirclePoint(a: LatLon, b: LatLon, f: number): LatLon {
  const r = Math.PI / 180
  const [la1, lo1, la2, lo2] = [a.lat * r, a.lon * r, b.lat * r, b.lon * r]
  const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2))
  if (d < 1e-12) return { ...a }
  const A = Math.sin((1 - f) * d) / Math.sin(d)
  const B = Math.sin(f * d) / Math.sin(d)
  const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2)
  const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2)
  const z = A * Math.sin(la1) + B * Math.sin(la2)
  return { lat: Math.atan2(z, Math.hypot(x, y)) / r, lon: Math.atan2(y, x) / r }
}

/**
 * The point a fraction `f` of the way along the rhumb line from `a` to `b`:
 * latitude even in distance, longitude even in Mercator latitude, which is
 * what a constant bearing means. (A great-circle step along the first bearing
 * is not a rhumb line: it drifts poleward.)
 */
export function rhumbPoint(a: LatLon, b: LatLon, f: number): LatLon {
  const r = Math.PI / 180
  const lat = a.lat + f * (b.lat - a.lat)
  let dLon = b.lon - a.lon
  if (dLon > 180) dLon -= 360
  if (dLon < -180) dLon += 360
  const psi = (la: number) => Math.log(Math.tan(Math.PI / 4 + (la * r) / 2))
  const dPsi = psi(b.lat) - psi(a.lat)
  const g = Math.abs(dPsi) < 1e-12 ? f : (psi(lat) - psi(a.lat)) / dPsi
  let lon = a.lon + g * dLon
  if (lon > 180) lon -= 360
  if (lon < -180) lon += 360
  return { lat, lon }
}

function failed(error: string): RouteResult {
  return {
    ok: false,
    error,
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

/** One leg on the grid, start to finish, leaving at `t0`. */
function gridLeg(
  from: LatLon,
  to: LatLon,
  t0: number,
  field: WeatherField,
  lattice: PolarLattice,
  land: LandMask | null,
  polarF: number,
  o: Required<GridOptions>,
): { legs: RouteLeg[]; evaluated: number } | null {
  const L = distance(from, to)
  const N = Math.max(4, o.rows)
  const ds = L / N
  const dc = ds * 0.5
  const M = Math.max(2, Math.ceil((L * o.widthFrac) / dc))
  const W = 2 * M + 1
  const along = (i: number): LatLon => (o.greatCircle ? greatCirclePoint(from, to, i / N) : rhumbPoint(from, to, i / N))
  const trackBrg = (i: number): number => {
    const a = along(Math.min(i, N - 1))
    const b = along(Math.min(i + 1, N))
    return bearing(a, b)
  }
  // Node positions, row by row; the first and last rows collapse to start and finish.
  const pos: LatLon[][] = []
  for (let i = 0; i <= N; i++) {
    const c = along(i)
    const tb = trackBrg(i)
    const row: LatLon[] = []
    for (let j = -M; j <= M; j++) row.push(i === 0 ? from : i === N ? to : destination(c, wrap360(tb + 90), j * dc))
    pos.push(row)
  }
  const arr: Float64Array[] = pos.map(() => new Float64Array(W).fill(Infinity))
  const back: Int16Array[] = pos.map(() => new Int16Array(W).fill(-1))
  const info: Array<Array<{ twd: number; tws: number; twa: number; bsp: number; hdg: number } | null>> = pos.map(() => new Array(W).fill(null))
  const centre = M
  arr[0][centre] = t0
  let evaluated = 0
  for (let i = 0; i < N; i++) {
    const jsFrom = i === 0 ? [centre] : Array.from({ length: W }, (_, k) => k)
    for (const j of jsFrom) {
      const t = arr[i][j]
      if (!Number.isFinite(t)) continue
      const p = pos[i][j]
      const targets = i + 1 === N ? [centre] : Array.from({ length: 2 * MAX_SIDESTEP + 1 }, (_, k) => j + k - MAX_SIDESTEP).filter((k) => k >= 0 && k < W)
      let wind: { u: number; v: number } | null = null
      let cur: { u: number; v: number } | null = null
      try {
        wind = field.wind(p.lat, p.lon, t)
        cur = field.current(p.lat, p.lon, t)
      } catch {
        wind = null
      }
      if (!wind) continue
      const tws = Math.hypot(wind.u, wind.v)
      const twd = wrap360((Math.atan2(-wind.u, -wind.v) * 180) / Math.PI)
      for (const k of targets) {
        evaluated++
        const q = pos[i + 1][k]
        const d = distance(p, q)
        if (d < 1e-9) continue
        const hdg = bearing(p, q)
        const twa = angdiff(twd, hdg)
        const bsp = lattice.speed(tws, Math.abs(twa)) * polarF
        const along = cur ? cur.u * Math.sin((hdg * Math.PI) / 180) + cur.v * Math.cos((hdg * Math.PI) / 180) : 0
        const sog = bsp + along
        if (!(sog > 0.05)) continue
        if (land && land.crosses(p, q)) continue
        const tq = t + (d / sog) * 3_600_000
        if (tq < arr[i + 1][k]) {
          arr[i + 1][k] = tq
          back[i + 1][k] = j
          info[i + 1][k] = { twd, tws, twa, bsp, hdg }
        }
      }
    }
  }
  if (!Number.isFinite(arr[N][centre])) return null
  // Walk back from the finish.
  const path: Array<[number, number]> = []
  for (let i = N, j = centre; i >= 0; i--) {
    path.push([i, j])
    j = back[i][j]
    if (i > 0 && j < 0) return null
  }
  path.reverse()
  const legs: RouteLeg[] = path.map(([i, j], n) => {
    const next = path[n + 1]
    const inf = next ? info[next[0]][next[1]] : info[i][j]
    const twa = inf?.twa ?? 0
    return {
      t: arr[i][j],
      position: pos[i][j],
      twd: inf?.twd ?? 0,
      tws: inf?.tws ?? 0,
      twa,
      bsp: inf?.bsp ?? 0,
      heading: inf?.hdg ?? 0,
      isBeating: false,
      tack: twa < 0 ? 'port' : 'starboard',
      currentSet: null,
      currentDrift: null,
      distanceNm: next ? distance(pos[i][j], pos[next[0]][next[1]]) : 0,
    }
  })
  return { legs, evaluated }
}

/** The course on the grid, leg by leg. */
export function routeGrid(
  req: RouteRequest,
  ctx: { field: WeatherField; lattice: PolarLattice; land?: LandMask | null },
  opts: GridOptions = {},
): RouteResult {
  const started = Date.now()
  const o: Required<GridOptions> = { rows: opts.rows ?? 60, widthFrac: opts.widthFrac ?? 0.5, greatCircle: opts.greatCircle ?? false }
  const polarF = req.scalings.polarPct / 100
  const legs: RouteLeg[] = []
  let from = req.start
  let t = req.startTime
  let evaluated = 0
  for (const [li, to] of req.marks.entries()) {
    const leg = gridLeg(from, to, t, ctx.field, ctx.lattice, ctx.land ?? null, polarF, o)
    if (!leg) {
      return failed(
        `leg ${li + 1} of ${req.marks.length}: the grid found no way through. It only moves forward along the track, so among islands it can be boxed in; the isochrones can go round.`,
      )
    }
    evaluated += leg.evaluated
    legs.push(...(legs.length ? leg.legs.slice(1) : leg.legs))
    t = leg.legs[leg.legs.length - 1].t
    from = to
  }
  const elapsedS = (t - req.startTime) / 1000
  return {
    ok: true,
    legs,
    etaMs: t,
    elapsedS,
    directTimeS: null,
    isochrones: [],
    reverseIsochrones: [],
    sensitivity: null,
    diagnostics: {
      nodesExplored: evaluated,
      timeStepS: 0,
      computeMs: Date.now() - started,
      landAvoided: ctx.land != null,
      warnings: ['Grid route: no tack or gybe costs, and moves only forward along the track.'],
    },
  }
}
