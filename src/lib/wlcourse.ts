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
  /** A separate finish mark this far up the axis from the line's middle, nm; absent to finish at the line. */
  finishNm?: number | null
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
  return withFinish(out, mid, o)
}

/** The course with its finish mark, when it has one apart from the line. */
function withFinish(marks: WLMark[], mid: LatLon, o: { axisTrue: number; finishNm?: number | null }): WLMark[] {
  if (o.finishNm == null || !Number.isFinite(o.finishNm)) return marks
  return [...marks, { name: 'Finish', position: along(mid, o.axisTrue, o.finishNm), roundTo: 'either' }]
}

export interface TriangleOptions {
  line: { port: LatLon; starboard: LatLon }
  axisTrue: number
  /** The windward mark up the axis from the line's middle, and the leeward mark, nm. */
  windwardNm: number
  leewardNm: number
  /**
   * The angle at the windward mark between the run and the first reach: 60° for the
   * Olympic equilateral triangle, 45° for a triangle square at the wing mark.
   */
  wingDeg: number
  leaveTo: RoundingSide
  /** Triangle: 1-2-3 each lap. Olympic: 1-2-3-1-3, a triangle then a sausage. */
  order: 'triangle' | 'olympic'
  laps: number
  finishNm?: number | null
}

/**
 * A triangle round the line: windward, wing and leeward marks. Rounded to
 * port, the wing mark is to the left looking upwind, where a boat bearing
 * away round the windward mark to port is headed; to starboard, the right.
 */
export function buildTriangleCourse(o: TriangleOptions): WLMark[] {
  const mid = midpoint(o.line.port, o.line.starboard)
  const w = along(mid, o.axisTrue, o.windwardNm)
  const l = along(mid, o.axisTrue, o.leewardNm)
  const side = o.leaveTo === 'starboard' ? 90 : -90
  // The wing: off the middle of the windward-leeward line by half of it times tan(angle).
  const half = (o.windwardNm - o.leewardNm) / 2
  const wing = destination(along(mid, o.axisTrue, (o.windwardNm + o.leewardNm) / 2), wrap360(o.axisTrue + side), Math.abs(half) * Math.tan((o.wingDeg * Math.PI) / 180))
  const one: WLMark = { name: 'Windward', position: w, roundTo: o.leaveTo }
  const two: WLMark = { name: 'Wing', position: wing, roundTo: o.leaveTo }
  const three: WLMark = { name: 'Leeward', position: l, roundTo: o.leaveTo }
  const laps = Math.max(1, Math.min(10, Math.round(o.laps)))
  const lap = o.order === 'olympic' ? [one, two, three, one, three] : [one, two, three]
  const out: WLMark[] = []
  for (let i = 0; i < laps; i++) for (const m of lap) out.push({ ...m, name: laps > 1 ? `${m.name} ${i + 1}` : m.name })
  return withFinish(out, mid, o)
}

export interface TrapezoidOptions {
  line: { port: LatLon; starboard: LatLon }
  axisTrue: number
  windwardNm: number
  leewardNm: number
  /** The reach leg from the windward mark, as a share of the beat. */
  reachShare: number
  /** The reach's angle below square to the axis, degrees (60° reaches a little down). */
  reachDeg: number
  leaveTo: RoundingSide
  laps: number
  finishNm?: number | null
}

/**
 * A trapezoid: up to the windward mark, a reach to the offset mark, a run
 * down the offset side to its leeward mark, and a reach back to the leeward
 * mark below the windward one, then up again. The offset side is left looking
 * upwind for port roundings, right for starboard.
 */
export function buildTrapezoidCourse(o: TrapezoidOptions): WLMark[] {
  const mid = midpoint(o.line.port, o.line.starboard)
  const w = along(mid, o.axisTrue, o.windwardNm)
  const l = along(mid, o.axisTrue, o.leewardNm)
  const beat = o.windwardNm - o.leewardNm
  const side = o.leaveTo === 'starboard' ? 1 : -1
  // The reach heads off to the side and a little down: the axis turned by 180° − the reach angle.
  const reachBearing = wrap360(o.axisTrue + side * (180 - o.reachDeg))
  const offTop = destination(w, reachBearing, Math.abs(beat) * o.reachShare)
  const offBottom = along(offTop, o.axisTrue, -Math.abs(beat))
  const marks: WLMark[] = [
    { name: 'Windward', position: w, roundTo: o.leaveTo },
    { name: 'Offset top', position: offTop, roundTo: o.leaveTo },
    { name: 'Offset bottom', position: offBottom, roundTo: o.leaveTo },
    { name: 'Leeward', position: l, roundTo: o.leaveTo },
  ]
  const laps = Math.max(1, Math.min(10, Math.round(o.laps)))
  const out: WLMark[] = []
  for (let i = 0; i < laps; i++) for (const m of marks) out.push({ ...m, name: laps > 1 ? `${m.name} ${i + 1}` : m.name })
  return withFinish(out, mid, o)
}
