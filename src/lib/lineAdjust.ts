/**
 * Adjusting a pinged start line without sailing back to it: Expedition's Start
 * panel options for each end.
 *
 * - **From the other end**: place an end at a range and bearing from the other,
 *   as when the committee boat gives the line length and bearing on the radio.
 * - **Nudge upwind**: slide an end up (positive) or down (negative) the wind, in
 *   metres, when you can see the pin sits a little further up than you pinged it.
 * - **Swap ends**: if they were pinged the wrong way round.
 */

import type { LatLon } from '@/lib/types'
import { destination } from '@/lib/geo'
import { wrap360 } from '@/lib/angles'

const M_PER_NM = 1852

export function endFromOther(other: LatLon, rangeM: number, bearingTrue: number): LatLon {
  return destination(other, wrap360(bearingTrue), rangeM / M_PER_NM)
}

/** Move `end` `metres` toward the wind (positive) or away from it (negative). */
export function nudgeUpwind(end: LatLon, twd: number, metres: number): LatLon {
  if (metres === 0) return end
  return metres > 0
    ? destination(end, wrap360(twd), metres / M_PER_NM)
    : destination(end, wrap360(twd + 180), -metres / M_PER_NM)
}
