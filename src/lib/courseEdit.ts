/** Where a new mark goes into a course: into the leg it lies nearest, on great circles. */
import { alongTrack, crossTrack, distance } from './geo'
import type { LatLon } from './types'

/** Nautical miles from `p` to the great-circle leg a→b (to an end, past either end). */
export function distanceToLeg(p: LatLon, a: LatLon, b: LatLon): number {
  const len = distance(a, b)
  if (len < 1e-9) return distance(p, a)
  const along = alongTrack(p, a, b)
  if (along <= 0) return distance(p, a)
  if (along >= len) return distance(p, b)
  return Math.abs(crossTrack(p, a, b))
}

/**
 * The index in `marks` at which a mark at `p` sits in the nearest leg: the
 * legs are from `start` (the boat or the planned start, if given) to the
 * first mark, then mark to mark. With no leg at all, the end.
 */
export function nearestLegInsert(marks: LatLon[], p: LatLon, start: LatLon | null = null): number {
  const pts = start ? [start, ...marks] : marks
  let best = marks.length
  let bestNm = Infinity
  for (let i = 1; i < pts.length; i++) {
    const d = distanceToLeg(p, pts[i - 1], pts[i])
    if (d < bestNm) {
      bestNm = d
      // Leg i-1 → i of `pts` ends at mark index i-1 (with a start) or i (without).
      best = start ? i - 1 : i
    }
  }
  return best
}
