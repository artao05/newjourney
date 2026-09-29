/**
 * Expedition's windward/leeward course wizard, as geometry.
 *
 * Built around a start line that is already pinged, from the manual's settings:
 *
 * - **Windward**: nautical miles from the middle of the line, up the axis.
 * - **Leeward**: nautical miles from the line up the axis. This is the modern
 *   course, whose leeward gate sits just above the start. A negative distance puts
 *   the mark below the line. (The first version of this app had the sign the other
 *   way round.)
 * - **Leeward above**: the committee boat (starboard end), the middle of the line,
 *   or the pin.
 * - **Gate**: an optional gate at the leeward mark, the second buoy to its left
 *   looking upwind, at the given width.
 * - **Leave to**: the side every created mark is rounded on.
 * - **Laps**: how many times round; the course ends at the last leeward mark.
 */

import type { LatLon, Mark, RoundingSide } from '@/lib/types'
import { destination, midpoint } from '@/lib/geo'
import { wrap360 } from '@/lib/angles'

export interface WLOptions {
  line: { port: LatLon; starboard: LatLon }
  /** Course axis, degrees true: the direction from the leeward to the windward mark. */
  axisTrue: number
  windwardNm: number
  leewardNm: number
  leewardAbove: 'committee' | 'middle' | 'pin'
  /** Gate width in metres, or null for a single leeward mark. */
  gateWidthM: number | null
  leaveTo: RoundingSide
  laps: number
}

export type WLMark = Pick<Mark, 'name' | 'position' | 'roundTo'> & {
  gate?: { widthM: number; left: LatLon; right: LatLon }
}

/** A point `nm` up the axis from `from`, or down it when `nm` is negative. */
function along(from: LatLon, axis: number, nm: number): LatLon {
  return nm >= 0 ? destination(from, axis, nm) : destination(from, wrap360(axis + 180), -nm)
}

export function buildWLCourse(o: WLOptions): WLMark[] {
  const mid = midpoint(o.line.port, o.line.starboard)
  const base =
    o.leewardAbove === 'committee' ? o.line.starboard : o.leewardAbove === 'pin' ? o.line.port : mid
  const windward: WLMark = {
    name: 'Windward',
    position: along(mid, o.axisTrue, o.windwardNm),
    roundTo: o.leaveTo,
  }
  const leewardPos = along(base, o.axisTrue, o.leewardNm)
  let leeward: WLMark
  if (o.gateWidthM != null && o.gateWidthM > 0) {
    // The gate's second buoy goes to the left, looking upwind: the axis minus 90°.
    const left = destination(leewardPos, wrap360(o.axisTrue - 90), o.gateWidthM / 1852)
    leeward = {
      name: 'Leeward gate',
      // Sailed as its middle until gates are routed as gates (worklist 5.2).
      position: midpoint(leewardPos, left),
      roundTo: 'either',
      gate: { widthM: o.gateWidthM, left, right: leewardPos },
    }
  } else {
    leeward = { name: 'Leeward', position: leewardPos, roundTo: o.leaveTo }
  }
  const laps = Math.max(1, Math.min(10, Math.round(o.laps)))
  const out: WLMark[] = []
  for (let i = 0; i < laps; i++) {
    out.push({ ...windward, name: laps > 1 ? `Windward ${i + 1}` : 'Windward' })
    out.push({ ...leeward, name: laps > 1 ? `${leeward.name} ${i + 1}` : leeward.name })
  }
  return out
}
