/**
 * Angle utilities.
 *
 * Rule for the whole codebase: bearings are NEVER subtracted with `-`.
 * Use `angdiff`. Nearly every compass bug is a subtraction that forgot to wrap.
 * See docs/03-algorithms/navigation-math.md §1.
 */

import type { Degrees, SignedDegrees } from './types'

type Radians = number

export const DEG = Math.PI / 180
export const RAD = 180 / Math.PI

export const toRad = (d: Degrees): Radians => d * DEG
export const toDeg = (r: Radians): Degrees => r * RAD

/** Normalise to [0, 360). */
export function wrap360(a: number): Degrees {
  const r = a % 360
  return r < 0 ? r + 360 : r
}

/** Normalise to (-180, 180]. */
export function wrap180(a: number): SignedDegrees {
  const r = wrap360(a + 180) - 180
  // wrap360 returns [0,360) so this gives [-180, 180); nudge -180 to +180.
  return r === -180 ? 180 : r
}

/** Smallest signed difference a - b, in (-180, 180]. */
export function angdiff(a: Degrees, b: Degrees): SignedDegrees {
  return wrap180(a - b)
}

/** Absolute angular separation, [0, 180]. */
export function angsep(a: Degrees, b: Degrees): Degrees {
  return Math.abs(angdiff(a, b))
}

/**
 * Circular mean of bearings. Arithmetic averaging of angles is wrong
 * (mean of 350 and 10 is 0, not 180).
 */
export function meanBearing(bearings: Degrees[]): Degrees | null {
  if (bearings.length === 0) return null
  let s = 0
  let c = 0
  for (const b of bearings) {
    s += Math.sin(toRad(b))
    c += Math.cos(toRad(b))
  }
  if (s === 0 && c === 0) return null
  return wrap360(toDeg(Math.atan2(s, c)))
}

/**
 * Circular standard deviation, degrees. Uses the mean resultant length,
 * so a tight cluster gives a small number and a uniform spread gives ~81°.
 */
export function stdBearing(bearings: Degrees[]): number {
  if (bearings.length < 2) return 0
  let s = 0
  let c = 0
  for (const b of bearings) {
    s += Math.sin(toRad(b))
    c += Math.cos(toRad(b))
  }
  const n = bearings.length
  const R = Math.hypot(s / n, c / n)
  if (R >= 1) return 0
  return toDeg(Math.sqrt(-2 * Math.log(R)))
}

/** Interpolate between two bearings the short way round. */
export function lerpBearing(a: Degrees, b: Degrees, f: number): Degrees {
  return wrap360(a + angdiff(b, a) * f)
}

/** Clamp for acos/asin arguments; floating point routinely produces 1.0000000002. */
export function clampUnit(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/**
 * True wind angle from a course and a wind direction.
 * Positive on starboard tack, negative on port — Expedition's convention.
 */
export function twaFrom(course: Degrees, twd: Degrees): SignedDegrees {
  return angdiff(twd, course)
}

/** Course that yields a given TWA in a given wind. Inverse of `twaFrom`. */
export function courseFor(twd: Degrees, twa: SignedDegrees): Degrees {
  return wrap360(twd - twa)
}

export type Tack = 'port' | 'starboard'

/** Wind on the starboard side (TWA > 0) means you are on starboard tack. */
export function tackOf(twa: SignedDegrees): Tack {
  return twa >= 0 ? 'starboard' : 'port'
}

/** Did we tack or gybe going from one TWA to another? */
export function manoeuvre(
  fromTwa: SignedDegrees,
  toTwa: SignedDegrees,
): 'none' | 'tack' | 'gybe' {
  if (Math.sign(fromTwa) === Math.sign(toTwa)) return 'none'
  // Crossing sides: through the bow is a tack, through the stern is a gybe.
  const meanAbs = (Math.abs(fromTwa) + Math.abs(toTwa)) / 2
  return meanAbs < 90 ? 'tack' : 'gybe'
}
