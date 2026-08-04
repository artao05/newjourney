/**
 * The wind triangle, heel correction, leeway, current estimation, and the
 * ground-wind / true-wind distinction.
 *
 * Implements docs/03-algorithms/navigation-math.md §1 (conventions), §3 (the
 * wind triangle), §4 (ground vs. true wind) and §5 (set and drift).
 *
 * Sign discipline, everywhere in this file:
 *   - AWA / TWA are signed, positive on starboard tack.
 *   - Leeway is positive clockwise, so positive on port tack.
 *   - `course = heading + leeway` — the boat's track *through the water*.
 *   - Wind directions are the direction the wind blows FROM.
 *   - Current `set` is the direction the water flows TOWARD.
 * Those last two are opposite conventions, which is exactly why every vector
 * built here goes through `fromPolar` with an explicit +180 where needed.
 */

import { DEG, RAD, wrap180, wrap360 } from './angles'
import { fromPolar, vecAdd, vecBearing, vecLen, vecSub } from './geo'
import type { Degrees, Knots, SignedDegrees } from './types'

/**
 * Default leeway coefficient in `leeway = k · heel / bsp²`.
 * Expedition's own stated relation; k ≈ 8–12 for a fin keel
 * (docs/03-algorithms/polars-and-vpp.md §7). 10 is the middle of that range
 * and is only ever a starting point — it wants per-boat calibration.
 */
export const DEFAULT_LEEWAY_K = 10

/**
 * Default rate-of-turn gate for current estimation, °/s.
 *
 * Steady sailing is well under 1 °/s even in a seaway; a keelboat tacks at
 * 8–15 °/s and a dinghy far faster. 3 °/s therefore sits in the empty band
 * between "sailing" and "manoeuvring". Expedition exposes the same limit as a
 * user setting because the right value is boat-specific.
 */
export const DEFAULT_ROT_LIMIT = 3

/**
 * Apparent wind to true wind (navigation-math.md §3).
 *
 * Works in the boat's frame — x forward along the *water* course, y to
 * starboard — removes the boat's own motion through the water, then rotates
 * the result back to earth. `course` must already include leeway.
 */
export function apparentToTrue(o: {
  awa: SignedDegrees
  aws: Knots
  bsp: Knots
  course: Degrees
}): { twa: SignedDegrees; tws: Knots; twd: Degrees } {
  const awx = o.aws * Math.cos(o.awa * DEG)
  const awy = o.aws * Math.sin(o.awa * DEG)
  const twx = awx - o.bsp
  const twy = awy
  const tws = Math.hypot(twx, twy)
  const twa = wrap180(Math.atan2(twy, twx) * RAD)
  return { twa, tws, twd: wrap360(o.course + twa) }
}

/**
 * True wind to apparent wind — the exact inverse of `apparentToTrue`.
 * Needed for `Next mark Awa/Aws`: what you will actually feel on the next leg.
 */
export function trueToApparent(o: {
  twa: SignedDegrees
  tws: Knots
  bsp: Knots
}): { awa: SignedDegrees; aws: Knots } {
  const twx = o.tws * Math.cos(o.twa * DEG)
  const twy = o.tws * Math.sin(o.twa * DEG)
  const awx = twx + o.bsp
  const awy = twy
  return { awa: wrap180(Math.atan2(awy, awx) * RAD), aws: Math.hypot(awx, awy) }
}

/**
 * Heel correction for a masthead unit (navigation-math.md §3).
 *
 * A masthead vane tilted by heel angle φ sees the transverse component of the
 * flow compressed by cos φ, so it under-reads both AWS and AWA. Undo it on the
 * transverse component only, then rebuild AWS/AWA.
 *
 * Apply this exactly once. Some instrument systems (Nexus FDX and friends) do
 * it internally, and double-applying it is a classic way to invent a knot of
 * wind that is not there.
 */
export function correctForHeel(o: {
  awa: SignedDegrees
  aws: Knots
  heelDeg: SignedDegrees
}): { awa: SignedDegrees; aws: Knots } {
  const cosHeel = Math.cos(o.heelDeg * DEG)
  // Beyond ~85° of heel the correction blows up and the boat has other
  // problems; leave the measurement alone rather than returning infinity.
  if (Math.abs(cosHeel) < 0.09) return { awa: o.awa, aws: o.aws }
  const awx = o.aws * Math.cos(o.awa * DEG)
  const awy = (o.aws * Math.sin(o.awa * DEG)) / cosHeel
  return { awa: wrap180(Math.atan2(awy, awx) * RAD), aws: Math.hypot(awx, awy) }
}

/**
 * Leeway from heel and boat speed: `leeway ≈ k · heel / bsp²`
 * (polars-and-vpp.md §7).
 *
 * Sign falls out of the conventions for free: heel is positive to starboard,
 * which is the heel you carry on *port* tack, and leeway is positive
 * clockwise, which is also port tack. So the raw formula already has the
 * right sign — do not add one.
 *
 * Returns 0 below 0.5 kn, where the relation diverges and is meaningless
 * anyway (a boat that is not moving is not making leeway, it is drifting).
 */
export function leewayFrom(o: {
  heelDeg: SignedDegrees
  bsp: Knots
  k?: number
}): Degrees {
  const k = o.k ?? DEFAULT_LEEWAY_K
  if (!(o.bsp > 0.5)) return 0
  return (k * o.heelDeg) / (o.bsp * o.bsp)
}

/**
 * Set and drift from the difference between the ground track and the water
 * track (navigation-math.md §5):
 *
 *     current = vector(cog, sog) − vector(heading + leeway, bsp)
 *
 * Returns `null` when |ROT| exceeds the gate. Expedition gates this for a good
 * reason: during a manoeuvre heading and BSP are transient and out of phase,
 * so the residual is instrument lag, not water movement. Without the gate the
 * current arrow swings 180° on every tack and the user stops believing the
 * feature — permanently.
 *
 * Damp `cog`/`sog`/`heading`/`bsp` before calling: the difference of two noisy
 * vectors is noisier than either of them.
 */
export function estimateCurrent(o: {
  cog: Degrees
  sog: Knots
  heading: Degrees
  bsp: Knots
  leeway?: Degrees
  rotDegPerSec?: number
  rotLimit?: number
}): { set: Degrees; drift: Knots } | null {
  const limit = o.rotLimit ?? DEFAULT_ROT_LIMIT
  if (o.rotDegPerSec !== undefined && Math.abs(o.rotDegPerSec) > limit) return null
  if (!Number.isFinite(o.cog) || !Number.isFinite(o.sog)) return null
  if (!Number.isFinite(o.heading) || !Number.isFinite(o.bsp)) return null
  const course = wrap360(o.heading + (o.leeway ?? 0))
  const current = vecSub(fromPolar(o.cog, o.sog), fromPolar(course, o.bsp))
  const drift = vecLen(current)
  // Direction of a zero vector is meaningless; report 0 rather than an
  // atan2(0,0) artefact that a caller might plot as a real northerly set.
  return { set: drift < 1e-9 ? 0 : vecBearing(current), drift }
}

/**
 * Ground wind (what a GRIB contains) to true wind (what the polar wants).
 *
 *     ground_wind_vector = true_wind_vector + current_vector
 *     ⇒ TW = GW − current
 *
 * navigation-math.md §4. This is the commonly-skipped correction: in a 3-knot
 * stream against 15 knots of breeze the two differ by ~20 % of wind speed,
 * which is enough to move target angles and change route choice. The boat
 * sails in the water, so the polar is fed true wind, always.
 */
export function groundToTrue(o: {
  gwd: Degrees
  gws: Knots
  set: Degrees
  drift: Knots
}): { twd: Degrees; tws: Knots } {
  // Wind directions are FROM, current set is TOWARD: flip the wind by 180°
  // to get both into the same "vector points where the fluid is going" frame.
  const tw = vecSub(fromPolar(o.gwd + 180, o.gws), fromPolar(o.set, o.drift))
  const tws = vecLen(tw)
  return { twd: tws < 1e-9 ? wrap360(o.gwd) : wrap360(vecBearing(tw) + 180), tws }
}

/** True wind to ground wind — the inverse of `groundToTrue`. GW = TW + current. */
export function trueToGround(o: {
  twd: Degrees
  tws: Knots
  set: Degrees
  drift: Knots
}): { gwd: Degrees; gws: Knots } {
  const gw = vecAdd(fromPolar(o.twd + 180, o.tws), fromPolar(o.set, o.drift))
  const gws = vecLen(gw)
  return { gwd: gws < 1e-9 ? wrap360(o.twd) : wrap360(vecBearing(gw) + 180), gws }
}

/**
 * Wind direction/speed to u/v components, meteorological convention:
 * u is the eastward component of the wind *vector*, v the northward one, so a
 * wind FROM 090 (an easterly) has u negative. Matches `UV` in types.ts and the
 * component layout of every GRIB we will ever read.
 *
 * Directions are interpolated as u/v and never as angles — averaging 350° and
 * 10° arithmetically gives 180°, which is the wrong way round the compass.
 */
export function windToUV(dirFrom: Degrees, speed: Knots): { u: Knots; v: Knots } {
  return { u: -speed * Math.sin(dirFrom * DEG), v: -speed * Math.cos(dirFrom * DEG) }
}

/** u/v components back to a FROM direction and a speed. */
export function uvToWind(u: Knots, v: Knots): { dirFrom: Degrees; speed: Knots } {
  const speed = Math.hypot(u, v)
  return { dirFrom: speed < 1e-12 ? 0 : wrap360(Math.atan2(-u, -v) * RAD), speed }
}
