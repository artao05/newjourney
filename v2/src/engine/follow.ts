/**
 * The planned route, cut up so the simulated boat can sail it: one piece per
 * leg of the course, and the geometry the helm needs (the nearest stretch of
 * the route, a point a little further along it).
 *
 * Distances here are flat, about the first point of a stretch. Fine at
 * racecourse scale.
 */
import type { LatLon, RouteResult } from '@/lib/types'
import { distance } from '@/lib/geo'

export interface RoutePoint extends LatLon {
  /**
   * The stretch from this point to the next is one the router sailed as a
   * zigzag stand-in (a beat or run made good at VMG), drawn as a straight line
   * the boat can't point along. The helm tacks or gybes either side of it.
   */
  beat: boolean
}

export interface FollowRoute {
  /** Where the route leaves from: the spot on the start line, for a whole-course route. */
  start: LatLon
  /** Course leg index (into the course sequence) → the route for that leg. */
  legs: Map<number, RoutePoint[]>
}

/**
 * Where the route makes its closest approach to each mark, in order: an index
 * into `route.legs`, or -1 when it never comes within a quarter mile.
 */
export function markIndices(route: RouteResult, marks: LatLon[]): number[] {
  let from = 0
  return marks.map((m) => {
    let best = -1
    let bestD = Infinity
    for (let i = from; i < route.legs.length; i++) {
      const d = distance(route.legs[i]!.position, m)
      if (d < bestD) {
        bestD = d
        best = i
      }
      // Once well past a close approach, this mark is done.
      if (bestD < 0.05 && d > bestD + 0.3) break
    }
    if (best < 0 || bestD > 0.25) return -1
    from = best + 1
    return best
  })
}

/**
 * The route split by leg, for a route through `marks` that starts on course
 * leg `firstLeg` (0 for a whole-course route; the leg the boat is on for a
 * route from here). Stops at the first mark the route misses.
 */
export function followPieces(route: RouteResult, marks: LatLon[], firstLeg: number): FollowRoute | null {
  if (!route.ok || route.legs.length < 2) return null
  const idx = markIndices(route, marks)
  const legs = new Map<number, RoutePoint[]>()
  let from = 0
  for (let i = 0; i < idx.length; i++) {
    const to = idx[i]!
    if (to < 0) break
    const pts = route.legs.slice(from, to + 1).map((l) => ({ lat: l.position.lat, lon: l.position.lon, beat: l.isBeating }))
    if (pts.length >= 2) legs.set(firstLeg + i, pts)
    from = to
  }
  const p0 = route.legs[0]!.position
  return legs.size ? { start: { lat: p0.lat, lon: p0.lon }, legs } : null
}

const NM_PER_DEG = 60

function xy(p: LatLon, ref: LatLon): [number, number] {
  const k = Math.cos((ref.lat * Math.PI) / 180)
  return [(p.lon - ref.lon) * NM_PER_DEG * k, (p.lat - ref.lat) * NM_PER_DEG]
}

/** Distance from `p` to the stretch a→b, and how far along it (0 to 1) the nearest point is. */
export function toSegment(p: LatLon, a: LatLon, b: LatLon): { d: number; f: number } {
  const [bx, by] = xy(b, a)
  const [px, py] = xy(p, a)
  const len2 = bx * bx + by * by
  const f = len2 > 1e-12 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0
  return { d: Math.hypot(px - f * bx, py - f * by), f }
}

/**
 * The stretch of the route the boat is on: the nearest one at or after
 * `from`, so progress only goes forward (a beat and the run back down can
 * overlap, and a boat must not jump between them).
 */
export function nearestStretch(pts: RoutePoint[], from: number, p: LatLon): { seg: number; d: number; f: number } {
  let best = { seg: Math.min(from, pts.length - 2), d: Infinity, f: 0 }
  for (let k = Math.max(0, from); k < pts.length - 1; k++) {
    const s = toSegment(p, pts[k]!, pts[k + 1]!)
    // Ties go forward: at a corner, the stretch after it.
    if (s.d <= best.d + 1e-6) best = { seg: k, d: s.d, f: s.f }
    else if (best.d < 0.05 && s.d > best.d + 0.3) break
  }
  // Past the end of a stretch is on the next one, even when the boat
  // overshot the corner and the next one heads off at a right angle.
  while (best.f >= 0.999 && best.seg < pts.length - 2) {
    const s = toSegment(p, pts[best.seg + 1]!, pts[best.seg + 2]!)
    best = { seg: best.seg + 1, d: s.d, f: s.f }
  }
  return best
}

/** How much further the zigzag goes from stretch `seg`: the straight-line stand-ins in a row. */
export function zigzagLeft(pts: RoutePoint[], seg: number): number {
  let nm = 0
  for (let k = seg; k < pts.length - 1 && pts[k]!.beat; k++) nm += distance(pts[k]!, pts[k + 1]!)
  return nm
}

/** The point `nm` further along the route from where the boat is abeam of stretch `seg`. */
export function aheadOnRoute(pts: RoutePoint[], seg: number, f: number, nm: number): LatLon {
  const lerp = (a: LatLon, b: LatLon, t: number): LatLon => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t })
  let left = nm
  let at = lerp(pts[seg]!, pts[seg + 1]!, f)
  for (let k = seg; k < pts.length - 1; k++) {
    const end = pts[k + 1]!
    const d = distance(at, end)
    if (d >= left) return lerp(at, end, left / d)
    left -= d
    at = end
  }
  return at
}
