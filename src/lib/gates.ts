/**
 * The numbers for a gate: two buoys, either of which can be rounded.
 *
 * - **Square wind**: the wind direction at which neither buoy is favoured, square
 *   to the line between them, as for a start line.
 * - **Bias**: how far the wind is off square, and what that is worth in metres.
 *   The favoured buoy is the one further up the course, the better one to round
 *   for the next beat. The sign is the start line's: negative favours the left buoy
 *   looking upwind, positive the right.
 * - **Gate spot**: Expedition's point where the laylines into the two buoys cross.
 *   From there either buoy can be laid, so it is where to decide.
 */

import type { LatLon, NauticalMiles, PolarLattice, WindEstimate } from '@/lib/types'
import { bearing, destination, distance, midpoint } from '@/lib/geo'
import { angdiff, angsep, wrap360, DEG } from '@/lib/angles'

export interface GateNumbers {
  bearing: number
  rangeNm: NauticalMiles
  lengthM: number
  squareWindDeg: number
  biasAngleDeg: number | null
  biasLengthM: number | null
  favoured: 'left' | 'right' | 'even' | null
  spot: LatLon | null
  spotRangeNm: NauticalMiles | null
  spotTimeS: number | null
}

/** Inside this, the gate reads even: 0.1° of bias is noise, not a decision. */
const EVEN_DEG = 2

/**
 * Where two rays meet: from `a` along bearing `ba`, and from `b` along `bb`.
 * Flat-earth, fine at gate scale. Null when they are parallel or meet behind.
 */
function meet(a: LatLon, ba: number, b: LatLon, bb: number): LatLon | null {
  const k = Math.cos(a.lat * DEG)
  const bx = (b.lon - a.lon) * k
  const by = b.lat - a.lat
  const ax1 = Math.sin(ba * DEG)
  const ay1 = Math.cos(ba * DEG)
  const bx1 = Math.sin(bb * DEG)
  const by1 = Math.cos(bb * DEG)
  const den = ax1 * by1 - ay1 * bx1
  if (Math.abs(den) < 1e-9) return null
  const t = (bx * by1 - by * bx1) / den
  const s = (bx * ay1 - by * ax1) / den
  if (t < 0 || s < 0) return null
  return { lat: a.lat + ay1 * t, lon: a.lon + (ax1 * t) / k }
}

export function gateNumbers(o: {
  from: LatLon
  left: LatLon
  right: LatLon
  wind: Pick<WindEstimate, 'twd' | 'tws'> | null
  lattice: PolarLattice | null
}): GateNumbers {
  const centre = midpoint(o.left, o.right)
  const lineBrg = bearing(o.left, o.right)
  const squareWind = wrap360(lineBrg - 90)
  const lengthM = distance(o.left, o.right) * 1852
  const out: GateNumbers = {
    bearing: bearing(o.from, centre),
    rangeNm: distance(o.from, centre),
    lengthM,
    squareWindDeg: squareWind,
    biasAngleDeg: null,
    biasLengthM: null,
    favoured: null,
    spot: null,
    spotRangeNm: null,
    spotTimeS: null,
  }
  if (!o.wind) return out
  const bias = angdiff(o.wind.twd, squareWind)
  out.biasAngleDeg = bias
  out.biasLengthM = lengthM * Math.sin(Math.abs(bias) * DEG)
  out.favoured = Math.abs(bias) < EVEN_DEG ? 'even' : bias > 0 ? 'right' : 'left'
  if (!o.lattice) return out

  // Laylines into each buoy, for the way the boat is approaching it.
  const t = o.lattice.targetsAt(o.wind.tws)
  const upwind = angsep(out.bearing, o.wind.twd) < 90
  const twa = Math.abs(upwind ? t.upTwa : t.downTwa)
  const bsp = upwind ? t.upBsp : t.downBsp
  const stbdCourse = wrap360(o.wind.twd - twa)
  const portCourse = wrap360(o.wind.twd + twa)
  // Downwind, starboard gybe lays the left buoy and port gybe the right, so their
  // laylines run back up the course from each and cross above the gate. Upwind,
  // the pairing flips and they cross below it.
  const spot = upwind
    ? meet(o.left, wrap360(portCourse + 180), o.right, wrap360(stbdCourse + 180))
    : meet(o.left, wrap360(stbdCourse + 180), o.right, wrap360(portCourse + 180))
  if (spot) {
    out.spot = spot
    out.spotRangeNm = distance(o.from, spot)
    if (bsp > 0) out.spotTimeS = (out.spotRangeNm / bsp) * 3600
  }
  return out
}

/** A gate's two buoys from its middle, width and the course axis (for tests). */
export function gateAround(centre: LatLon, axisTrue: number, widthM: number) {
  const half = widthM / 2 / 1852
  return {
    left: destination(centre, wrap360(axisTrue - 90), half),
    right: destination(centre, wrap360(axisTrue + 90), half),
  }
}
