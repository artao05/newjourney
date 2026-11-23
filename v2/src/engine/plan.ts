/**
 * Course planning: a leg-by-leg plan from the forecast and the polar (instant,
 * readable for beginners), and the full isochrone route from the engine's
 * router (src/lib/routing), which runs in a worker.
 */
import { angdiff, courseFor, twaFrom } from '@/lib/angles'
import { bearing, destination, distance } from '@/lib/geo'
import { RoutingClient, defaultConstraints, defaultScalings } from '@/lib/routing'
import type { LatLon, RouteResult } from '@/lib/types'
import type { BoatModel } from './boats'
import { forecastWind, type Forecast } from './forecast'
import type { LegKind } from './types'

export interface LegPlan {
  from: LatLon
  to: LatLon
  toName: string
  kind: LegKind
  distanceNm: number
  bearing: number
  twd: number
  tws: number
  /** Signed TWA if sailed straight, degrees. */
  directTwa: number
  /** Angle to sail: target upwind/downwind angle on beats and runs, the direct angle on reaches. */
  sailTwa: number
  bsp: number
  /** Effective speed along the leg (VMG on beats and runs), knots. */
  vmc: number
  timeS: number
  /** Which tack to start on and why, for beats and runs. */
  firstTack: 'starboard' | 'port' | null
  favoured: string
  /** Headings on each tack, for beats and runs. */
  headings: { starboard: number; port: number } | null
}

/**
 * Plan each leg with the wind expected when the boat gets there. On beats and
 * runs, prefer the side with more pressure in the forecast, then the tack that
 * points closer to the mark.
 */
export function planLegs(o: { forecast: Forecast; boat: BoatModel; start: LatLon; marks: Array<{ name: string; lat: number; lon: number }>; t0: number }): LegPlan[] {
  const out: LegPlan[] = []
  let t = o.t0
  let from = o.start
  for (const m of o.marks) {
    const to = { lat: m.lat, lon: m.lon }
    const mid = { lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 }
    const w = forecastWind(o.forecast, mid, t) ?? { twd: 0, tws: 0 }
    const d = distance(from, to)
    const brg = bearing(from, to)
    const directTwa = twaFrom(brg, w.twd)
    const tg = o.boat.lattice.targetsAt(w.tws)
    let kind: LegKind = 'reach'
    if (Math.abs(directTwa) < tg.upTwa + 4) kind = 'beat'
    else if (Math.abs(directTwa) > tg.downTwa - 6) kind = 'run'
    let sailTwa = Math.abs(directTwa)
    let bsp = o.boat.lattice.speed(w.tws, directTwa)
    let vmc = bsp
    let firstTack: LegPlan['firstTack'] = null
    let favoured = 'Sail straight at the mark'
    let headings: LegPlan['headings'] = null
    if (kind !== 'reach') {
      const a = kind === 'beat' ? tg.upTwa : tg.downTwa
      sailTwa = a
      bsp = kind === 'beat' ? tg.upBsp : tg.downBsp
      const vmg = kind === 'beat' ? tg.upVmg : tg.downVmg
      // VMG along the leg, corrected for the leg not being dead up or down wind.
      const off = Math.abs(angdiff(brg, kind === 'beat' ? w.twd : (w.twd + 180) % 360))
      vmc = Math.abs(vmg) / Math.max(0.3, Math.cos((off * Math.PI) / 180))
      headings = { starboard: courseFor(w.twd, kind === 'beat' ? a : a), port: courseFor(w.twd, -a) }
      // Pressure to either side of the rhumb line, a third of the leg out.
      const side = (deg: number) => {
        const p = destination(mid, (brg + deg + 360) % 360, Math.max(0.15, d / 3))
        return forecastWind(o.forecast, p, t)?.tws ?? w.tws
      }
      const left = side(-90)
      const right = side(90)
      const diff = right - left
      // Starboard tack upwind heads left of the wind; port heads right.
      const pointsCloser: 'starboard' | 'port' = Math.abs(angdiff(headings.starboard, brg)) < Math.abs(angdiff(headings.port, brg)) ? 'starboard' : 'port'
      if (Math.abs(diff) > 0.6) {
        const goRight = diff > 0
        firstTack = kind === 'beat' ? (goRight ? 'port' : 'starboard') : goRight ? 'starboard' : 'port'
        favoured = `${goRight ? 'Right' : 'Left'} side: ${Math.abs(diff).toFixed(1)} kn more wind forecast`
      } else {
        firstTack = pointsCloser
        favoured = `Even pressure: start on the tack that points closer (${pointsCloser})`
      }
    }
    const timeS = vmc > 0.2 ? (d / vmc) * 3600 : Infinity
    out.push({ from, to, toName: m.name, kind, distanceNm: d, bearing: brg, twd: w.twd, tws: w.tws, directTwa, sailTwa, bsp, vmc, timeS, firstTack, favoured, headings })
    t += Number.isFinite(timeS) ? timeS * 1000 : 0
    from = to
  }
  return out
}

let client: RoutingClient | null = null

/** The optimal route through the marks, from the isochrone router in a worker. */
export function routeCourse(o: { forecast: Forecast; boat: BoatModel; start: LatLon; marks: LatLon[]; t0: number; onProgress?: (f: number) => void }): Promise<RouteResult> {
  client ??= new RoutingClient()
  return client.route(
    {
      start: o.start,
      startTime: o.t0,
      marks: o.marks,
      constraints: defaultConstraints(),
      scalings: defaultScalings(),
      resolution: 'balanced',
      computeSensitivity: false,
    },
    { cube: o.forecast.cube, polar: o.boat.polar },
    o.onProgress,
  )
}
