/**
 * The route legs table: Expedition's route pane.
 *
 * For each leg: where from, where to, the true bearing and great-circle distance,
 * the angle off the wind, and the time to sail it from the polar, with tacks or
 * gybes allowed for when the leg is a beat or a run. This is the quick estimate a
 * navigator reads before the start, in constant wind. The optimal route, with the
 * forecast, is the Route tab's job.
 */

import type { Boat, LatLon, PolarLattice, WindEstimate } from '@/lib/types'
import { bearing, distance } from '@/lib/geo'
import { angsep } from '@/lib/angles'
import { markTime } from '@/lib/tactics'

export interface LegRow {
  from: string
  to: string
  bearing: number
  distanceNm: number
  /** Angle between the leg and the wind, 0 (dead upwind) to 180 (dead downwind). */
  offWindDeg: number | null
  /** Polar time for the leg, penalties included. Null without a wind or a polar. */
  timeS: number | null
  /** Time from the first leg's start to the end of this one. */
  elapsedS: number | null
}

export function courseLegs(o: {
  start: { name: string; position: LatLon } | null
  marks: Array<{ name: string; position: LatLon }>
  wind: Pick<WindEstimate, 'twd' | 'tws'> | null
  lattice: PolarLattice | null
  boat: Boat
}): LegRow[] {
  const points = o.start ? [o.start, ...o.marks] : o.marks
  const rows: LegRow[] = []
  let elapsed: number | null = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const brg = bearing(a.position, b.position)
    const nm = distance(a.position, b.position)
    const offWind = o.wind ? angsep(brg, o.wind.twd) : null
    let t: number | null = null
    if (o.wind && o.lattice && offWind != null && nm > 0) {
      try {
        t = markTime(nm, offWind, o.lattice.targetsAt(o.wind.tws), o.boat, o.lattice, o.wind.tws)
      } catch {
        t = null
      }
    }
    elapsed = elapsed != null && t != null ? elapsed + t : null
    rows.push({ from: a.name, to: b.name, bearing: brg, distanceNm: nm, offWindDeg: offWind, timeS: t, elapsedS: elapsed })
  }
  return rows
}
