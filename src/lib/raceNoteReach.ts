/**
 * How far, along the course over the ground, to the nearest race-note line or
 * area boundary: where the boat will cross one if she holds her COG. For the
 * "Race note GPS reach distance to" and "time to" channels.
 */
import type { LatLon } from './types'

const NM = 1852

/** Local flat metres east and north of `o`: near enough over the few miles that matter. */
function enu(o: LatLon, p: LatLon): [number, number] {
  const k = Math.cos((o.lat * Math.PI) / 180)
  return [(p.lon - o.lon) * 60 * NM * k, (p.lat - o.lat) * 60 * NM]
}

/** Metres along the ray (origin, direction d) to segment a–b, or null when it misses. */
function rayToSegment(d: [number, number], a: [number, number], b: [number, number]): number | null {
  const e: [number, number] = [b[0] - a[0], b[1] - a[1]]
  const den = d[0] * e[1] - d[1] * e[0]
  if (Math.abs(den) < 1e-12) return null
  // Solve t·d = a + u·e.
  const t = (a[0] * e[1] - a[1] * e[0]) / den
  const u = (a[0] * d[1] - a[1] * d[0]) / den
  return t > 0 && u >= 0 && u <= 1 ? t : null
}

/**
 * Nautical miles along `cogDeg` from `from` to the nearest crossing of any
 * race-note line or area boundary within `maxNm`, or null when none is met.
 */
export function reachRaceNote(from: LatLon, cogDeg: number, notes: ReadonlyArray<{ kind: string; points: LatLon[] }>, maxNm = 50): number | null {
  if (!Number.isFinite(cogDeg)) return null
  const r = (cogDeg * Math.PI) / 180
  const d: [number, number] = [Math.sin(r), Math.cos(r)]
  let best = Infinity
  for (const n of notes) {
    if (n.kind === 'point' || n.points.length < 2) continue
    const pts = n.points.map((p) => enu(from, p))
    // An area's boundary closes; a line's does not.
    const segs = n.kind === 'area' ? pts.length : pts.length - 1
    for (let i = 0; i < segs; i++) {
      const t = rayToSegment(d, pts[i], pts[(i + 1) % pts.length])
      if (t != null && t < best) best = t
    }
  }
  return best / NM <= maxNm ? best / NM : null
}
