/**
 * True and magnetic north.
 *
 * A compass reads magnetic, and every bearing in this app is true. At Portland
 * the two differ by about 14.5 degrees, which on a start line is the whole bias,
 * so the one place a compass reading comes in - the wind a sailor types - has to
 * be told which north it was given.
 *
 * Declination is east positive, NOAA's convention, so Portland's is negative. The
 * sailor's check on the sign: "variation west, magnetic best" - with a westerly
 * variation the magnetic number is the larger one.
 */

import { wrap360 } from './angles'
import type { Degrees, LatLon, Millis } from './types'
import { magneticField } from './wmm'

export interface Declination {
  /** East positive, at `epochYear`. */
  deg: Degrees
  /** Annual change, degrees per year, east positive. */
  perYearDeg: number
  /** Decimal year the value applies to, as NOAA's calculator states it. */
  epochYear: number
  model: string
}

/** The decimal year of a time, e.g. 2026.7369 for 27 September 2026. */
export function decimalYear(t: Millis): number {
  const year = new Date(t).getUTCFullYear()
  const start = Date.UTC(year, 0, 1)
  return year + (t - start) / (Date.UTC(year + 1, 0, 1) - start)
}

/** The declination carried to time `t` by its annual change. */
export function declinationAt(d: Declination, t: Millis): Degrees {
  return d.deg + d.perYearDeg * (decimalYear(t) - d.epochYear)
}

/**
 * Magnetic variation (declination) at a place and time, east positive, from the
 * World Magnetic Model (WMM-2025) at sea level.
 */
export function variationAt(p: LatLon, t: Millis): Degrees {
  return magneticField(p.lat, p.lon, 0, decimalYear(t)).decl
}

/** Variation as a sailor writes it: 14.5°W. */
export function fmtVariation(declEast: Degrees): string {
  return `${Math.abs(declEast).toFixed(1)}°${declEast < 0 ? 'W' : 'E'}`
}

export function trueToMagnetic(bearingT: Degrees, declEast: Degrees): Degrees {
  return wrap360(bearingT - declEast)
}

export function magneticToTrue(bearingM: Degrees, declEast: Degrees): Degrees {
  return wrap360(bearingM + declEast)
}
