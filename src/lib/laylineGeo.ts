/**
 * Laylines as lines on a chart: from the active mark back along each tack's
 * course, the way Expedition draws them, with the oscillation bounds either side.
 *
 * A layline is the line you would sail on to reach the mark on one tack at the
 * target angle. So it runs from the mark back along that course, reversed. The
 * bounds are the same lines turned by the wind's oscillation, both ways, so a
 * boat inside them is not yet sure of laying the mark.
 */

import type { LatLon, PolarLattice } from '@/lib/types'
import { bearing, destination, distance } from '@/lib/geo'
import { angsep, wrap360 } from '@/lib/angles'

export interface LaylineLines {
  /** The course to the mark on each tack, degrees true. */
  portCourse: number
  starboardCourse: number
  upwind: boolean
  port: [LatLon, LatLon]
  starboard: [LatLon, LatLon]
  /** Each layline turned by ±bounds: four lines, empty when the bounds are 0. */
  bounds: Array<{ side: 'port' | 'starboard'; line: [LatLon, LatLon] }>
}

export function laylineLines(o: {
  mark: LatLon
  from: LatLon | null
  wind: { twd: number; tws: number }
  lattice: PolarLattice
  boundsDeg: number
}): LaylineLines {
  const upwind = o.from ? angsep(bearing(o.from, o.mark), o.wind.twd) < 90 : true
  const t = o.lattice.targetsAt(o.wind.tws)
  const twa = Math.abs(upwind ? t.upTwa : t.downTwa)
  // Starboard tack puts the wind on the starboard side: course = TWD − TWA.
  const starboardCourse = wrap360(o.wind.twd - twa)
  const portCourse = wrap360(o.wind.twd + twa)
  // Long enough to reach past the boat, and never a stub.
  const len = o.from ? Math.max(0.5, 1.3 * distance(o.from, o.mark)) : 1
  const back = (course: number): [LatLon, LatLon] => [o.mark, destination(o.mark, wrap360(course + 180), len)]
  const bounds: LaylineLines['bounds'] = []
  if (o.boundsDeg > 0) {
    for (const d of [-o.boundsDeg, o.boundsDeg]) {
      bounds.push({ side: 'port', line: back(portCourse + d) })
      bounds.push({ side: 'starboard', line: back(starboardCourse + d) })
    }
  }
  return {
    portCourse,
    starboardCourse,
    upwind,
    port: back(portCourse),
    starboard: back(starboardCourse),
    bounds,
  }
}
