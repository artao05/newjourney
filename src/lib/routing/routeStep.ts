/**
 * Stepping through a computed route in time, and reading its isochrones at a
 * point: where the boat is at each routing step, what she has there, which
 * isochrone that is, and how a point on an isochrone stands against the best
 * of it (DNM %).
 */
import { distance } from '../geo'
import type { Isochrone, LatLon, RouteLeg } from '../types'

/** The routing steps: the isochrones' times, or the legs' where there are none. */
export function routeSteps(r: { legs: RouteLeg[]; isochrones: Isochrone[] }): number[] {
  const ts = (r.isochrones.length ? r.isochrones.map((i) => i.t) : r.legs.map((l) => l.t)).filter(Number.isFinite)
  return [...new Set(ts)].sort((a, b) => a - b)
}

/** Where the route has the boat at `t`, between its legs, and the leg she is on. */
export function routeAt(legs: RouteLeg[], t: number): { position: LatLon; leg: RouteLeg } | null {
  if (!legs.length) return null
  if (t <= legs[0].t) return { position: legs[0].position, leg: legs[0] }
  for (let i = 1; i < legs.length; i++) {
    const a = legs[i - 1]
    const b = legs[i]
    // At a leg's own time, she is on that leg, not the one before.
    if (t < b.t) {
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
      return { position: { lat: a.position.lat + (b.position.lat - a.position.lat) * f, lon: a.position.lon + (b.position.lon - a.position.lon) * f }, leg: a }
    }
  }
  const last = legs[legs.length - 1]
  return { position: last.position, leg: last }
}

/** The isochrone nearest in time to `t`. */
export function isochroneNear(isos: Isochrone[], t: number): Isochrone | null {
  let best: Isochrone | null = null
  for (const i of isos) if (!best || Math.abs(i.t - t) < Math.abs(best.t - t)) best = i
  return best
}

/** The isochrone passing nearest `p`, within `withinNm`. */
export function isochroneThrough(isos: Isochrone[], p: LatLon, withinNm = 0.25): { iso: Isochrone; nm: number } | null {
  let best: { iso: Isochrone; nm: number } | null = null
  for (const iso of isos) {
    for (const q of iso.points) {
      const nm = distance(p, q)
      if (nm <= withinNm && (!best || nm < best.nm)) best = { iso, nm }
    }
  }
  return best
}

/**
 * DNM %: a point's distance to the next mark as a percentage of the nearest
 * any point of that isochrone gets. 100 % is the best place on it to be.
 */
export function dnmPct(p: LatLon, iso: Isochrone, mark: LatLon): number | null {
  if (!iso.points.length) return null
  const best = Math.min(...iso.points.map((q) => distance(q, mark)))
  return best > 1e-9 ? (distance(p, mark) / best) * 100 : null
}
