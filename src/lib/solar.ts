/**
 * Day/night for the night-polar factor and the palette by the sun.
 * docs/03-algorithms/navigation-math.md §9 asks for the NOAA solar-position
 * algorithm with civil twilight at −6°, which is the threshold Expedition uses
 * to switch the night polar. This is the low-precision form — good to ~0.01°,
 * far inside what a −6° test needs — so it stays a dozen flops rather than
 * becoming a dependency.
 *
 * Its own file because the shell needs it on every load, and the router, which
 * also uses it, is not something a phone should download to learn the time of day.
 */

import { DEG, RAD, clampUnit, wrap360 } from './angles'
import type { Millis } from './types'

let sunBucket = NaN
let sunDecl = 0
let sunRa = 0
let sunGmst = 0

function sunAt(t: Millis): void {
  // Memoised per 5 minutes. The position-independent part moves far slower than
  // the router steps, and this is evaluated once per frontier node.
  const bucket = Math.round(t / 300_000)
  if (bucket === sunBucket) return
  sunBucket = bucket
  const n = t / 86_400_000 + 2440587.5 - 2451545.0
  const meanLon = wrap360(280.46 + 0.9856474 * n)
  const meanAnom = wrap360(357.528 + 0.9856003 * n) * DEG
  const ecl = (meanLon + 1.915 * Math.sin(meanAnom) + 0.02 * Math.sin(2 * meanAnom)) * DEG
  const obl = (23.439 - 0.0000004 * n) * DEG
  sunDecl = Math.asin(clampUnit(Math.sin(obl) * Math.sin(ecl)))
  sunRa = Math.atan2(Math.cos(obl) * Math.sin(ecl), Math.cos(ecl))
  sunGmst = wrap360(280.46061837 + 360.98564736629 * n)
}

/** Solar elevation above the horizon, degrees. */
export function solarElevationDeg(lat: number, lon: number, t: Millis): number {
  sunAt(t)
  const ha = (sunGmst + lon) * DEG - sunRa
  const phi = lat * DEG
  return (
    Math.asin(
      clampUnit(
        Math.sin(phi) * Math.sin(sunDecl) + Math.cos(phi) * Math.cos(sunDecl) * Math.cos(ha),
      ),
    ) * RAD
  )
}

/** Civil night: the sun more than 6° below the horizon. Matches Expedition. */
export function isNight(lat: number, lon: number, t: Millis): boolean {
  return solarElevationDeg(lat, lon, t) < -6
}
