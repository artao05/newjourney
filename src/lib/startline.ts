/**
 * Start-line mathematics — the flagship pre-start numbers.
 *
 * Implements docs/03-algorithms/start-line-math.md §1–§5, producing the
 * `Start …` channel family catalogued in
 * docs/01-expedition-analysis/channels-reference.md §I.
 *
 * Two rules run through the whole file:
 *
 *  1. Everything happens in a `LocalFrame` anchored at the line midpoint.
 *     Great-circle math on a 100 m line is wasted cycles and invites precision
 *     loss (navigation-math.md §2).
 *  2. Every output is nullable and is `null` — never 0, never NaN — when its
 *     inputs are missing. A missing line end, a missing gun time and a missing
 *     wind must each degrade on their own, because steps 1–4 of the build
 *     order have to work with nothing but a phone GPS and two taps.
 */

import {
  DEG,
  angdiff,
  angsep,
  clamp,
  courseFor,
  manoeuvre,
  twaFrom,
  wrap360,
} from './angles'
import {
  LocalFrame,
  bearing,
  destination,
  distance,
  fromPolar,
  midpoint,
  mToNm,
  nmToM,
  rayIntersect,
  signedDistanceToLine,
  vecBearing,
  vecLen,
  vecScale,
  vecSub,
} from './geo'
import type {
  Boat,
  BoatState,
  CurrentEstimate,
  Degrees,
  Knots,
  LatLon,
  Millis,
  PolarLattice,
  Seconds,
  StartLine,
  StartNumbers,
  WindEstimate,
  XY,
} from './types'

// ------------------------------------------------------------------- inputs

export interface StartInputs {
  line: StartLine
  state: BoatState
  wind: WindEstimate | null
  current?: CurrentEstimate | null
  boat: Boat
  lattice?: PolarLattice | null
  now: Millis
  /** Which approach options count toward time-to-line. Expedition takes the MINIMUM of the enabled ones. */
  approaches?: { ends: boolean; gps: boolean; reach: boolean; port: boolean; starboard: boolean }
}

const ALL_APPROACHES = {
  ends: true,
  gps: true,
  reach: true,
  port: true,
  starboard: true,
} as const

/**
 * Deadband, degrees, inside which the line reads "even".
 * Purely a display choice: `biasAngleDeg` itself is never rounded, but a
 * favoured-end arrow that flips twice a second at 0.05° of bias is noise, not
 * information.
 */
export const EVEN_BIAS_DEG = 0.25

/** Nobody needs a time-to-line beyond this; past it we report `null`. */
const MAX_HORIZON_S = 1800

/**
 * Speed through the water, falling back to SOG when no log is fitted (a phone
 * has no paddlewheel). Non-finite in, zero out — a single NaN from a bad fix
 * would otherwise propagate into every number on the start display.
 */
function waterSpeed(state: BoatState): Knots {
  const v = state.bsp ?? state.sog
  return Number.isFinite(v) && v > 0 ? v : 0
}

// --------------------------------------------------------------- turn model

export interface TurnModel {
  rotDegPerSec(bsp: Knots): number
  accelKnPerMin(tws: Knots, twa: number): number
}

/**
 * Where these numbers come from, and how much to trust them.
 *
 * Expedition drives time-to-line from three user-calibrated tables (rate of
 * turn vs. boat speed, acceleration vs. TWS/TWA, braking) and says plainly
 * that "rate of turn and acceleration are always on, else the time to the line
 * functions can not work". We have no calibration on a first run, so these are
 * generic mid-size-keelboat approximations, chosen to be defensible rather
 * than accurate:
 *
 *   - Rate of turn saturates with speed. A boat with no way on has no steerage
 *     (`ROT_AT_REST` is what you get from backing a jib), and rudder authority
 *     climbs with speed but stops helping once the boat is up and going. The
 *     curve gives ~9 °/s at 6 kn, so a 90° tack takes ~10 s — the right order
 *     for a 30–40 footer.
 *   - Acceleration scales with wind speed and peaks on a reach. 8 kn/min at
 *     10 kn TWS on a beam reach means roughly 45 s from a standstill to 6 kn,
 *     which is about right for a displacement keelboat and much too slow for a
 *     skiff.
 *
 * These are the numbers the doc says to eventually *learn* from the user's own
 * recorded starts — every logged pre-start contains turns and accelerations —
 * at which point `TurnModel` becomes per-boat and this constant becomes the
 * cold-start default only.
 */
const ROT_AT_REST = 2
const ROT_MAX = 12
const ROT_HALF_KN = 2.5
const ACCEL_AT_10KN = 8

export const DEFAULT_TURN_MODEL: TurnModel = {
  rotDegPerSec(bsp: Knots): number {
    const v = bsp > 0 ? bsp : 0
    return ROT_AT_REST + (ROT_MAX - ROT_AT_REST) * (v / (v + ROT_HALF_KN))
  },
  accelKnPerMin(tws: Knots, twa: number): number {
    if (!(tws > 0)) return 0
    // Flat-ish lobe peaking on a reach: a boat accelerates worst pinching and
    // dead downwind, best with the apparent wind forward of the beam.
    const shape = 0.55 + 0.45 * Math.abs(Math.sin(twa * DEG))
    return (ACCEL_AT_10KN * tws * shape) / 10
  },
}

/** Fraction of speed lost per degree of turn, before any manoeuvre penalty. */
const TURN_LOSS_PER_DEG = 0.0015
/** Extra fractional loss for passing the bow (tack) or the stern (gybe) through the wind. */
const TACK_EXTRA_LOSS = 0.35
const GYBE_EXTRA_LOSS = 0.1
const MIN_TURN_LOSS_FACTOR = 0.25

function speedLossFactor(
  deltaDeg: number,
  fromCourse: Degrees,
  toCourse: Degrees,
  twd: Degrees | null,
): number {
  let f = clamp(1 - TURN_LOSS_PER_DEG * Math.abs(deltaDeg), MIN_TURN_LOSS_FACTOR, 1)
  if (twd !== null) {
    const m = manoeuvre(twaFrom(fromCourse, twd), twaFrom(toCourse, twd))
    if (m === 'tack') f *= 1 - TACK_EXTRA_LOSS
    else if (m === 'gybe') f *= 1 - GYBE_EXTRA_LOSS
  }
  return f
}

// -------------------------------------------------------------- boat points

/**
 * Bow position, projected from the GPS antenna along the heading (or COG when
 * there is no compass) by the bow-to-GPS offset.
 *
 * On a 40-footer that offset is 10+ m and the line is only 100 m long, so
 * ignoring it puts the OCS call out by 10 % of the line. The bow is what
 * triggers OCS, not the antenna.
 */
export function bowPosition(state: BoatState, boat: Boat): LatLon {
  const brg = state.heading ?? state.cog
  const d = mToNm(boat.bowToGpsMetres)
  if (!(d > 0) || !Number.isFinite(brg)) return state.position
  return destination(state.position, brg, d)
}

/**
 * Predicted position at the gun, dead-reckoned from the current COG/SOG.
 * Feeds `Start gun dist below line`. Extrapolates backwards happily if the gun
 * has already fired; returns null only when the inputs are not numbers.
 */
export function positionAtGun(state: BoatState, gunTime: Millis): LatLon | null {
  if (!Number.isFinite(gunTime)) return null
  if (!Number.isFinite(state.sog) || !Number.isFinite(state.cog)) return null
  const dtS = (gunTime - state.t) / 1000
  if (!Number.isFinite(dtS)) return null
  return destination(state.position, state.cog, (state.sog * dtS) / 3600)
}

// ------------------------------------------------------------ the dynamics

interface Dynamics {
  /** Speed the boat settles at on this leg, knots. */
  targetBsp: Knots
  /** Initial acceleration toward it, knots per minute. 0 = no accel model. */
  accelKnPerMin: number
  /** TWD if known — only used to tell a tack from a bear-away. */
  twd: Degrees | null
}

/**
 * Time, in seconds, for a straight run of `dNm` starting at `v0` and
 * accelerating toward `vt`.
 *
 * The acceleration model is `dv/dt = a·(1 − v/vt)`, i.e. an exponential
 * approach with time constant `τ = vt/a`, which is both a decent fit to a real
 * boat and impossible to overshoot with:
 *
 *     v(t) = vt + (v0 − vt)·e^(−t/τ)
 *     s(t) = [ vt·t + (v0 − vt)·τ·(1 − e^(−t/τ)) ] / 3600     (nm)
 *
 * `s` is monotone in `t` whenever both speeds are positive, so a bisection is
 * exact enough and cannot get stuck.
 */
function timeForDistance(
  dNm: number,
  v0: Knots,
  vt: Knots,
  aKnPerMin: number,
): Seconds | null {
  if (!(dNm > 0)) return 0
  if (!(aKnPerMin > 0)) {
    // No acceleration model (typically: no polar). Constant speed.
    const v = vt > 0 ? vt : v0
    if (!(v > 0)) return null
    return (dNm / v) * 3600
  }
  // A polar target speed of zero means the boat cannot sail this angle at all
  // (dead head-to-wind), so no amount of time gets it there.
  if (!(vt > 0)) return null
  const a = aKnPerMin / 60
  const tau = vt / a
  const s = (t: number): number =>
    (vt * t + (v0 - vt) * tau * (1 - Math.exp(-t / tau))) / 3600
  if (s(MAX_HORIZON_S) < dNm) return null
  let lo = 0
  let hi = MAX_HORIZON_S
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (s(mid) < dNm) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * Turn, then accelerate, then sail — the small dynamics problem behind every
 * candidate approach in start-line-math.md §4.
 *
 * The turn is modelled as a constant-rate arc: its chord is exactly
 * `v·t·sinc(Δθ/2)` on the mean heading, which is why the boat ends up short of
 * where a naive straight-line model would put it. Speed is then knocked down
 * by the turn (and much harder if the turn was a tack) before the straight leg
 * integrates back up toward the polar target.
 */
function timeToPointCore(
  from: LatLon,
  to: LatLon,
  state: BoatState,
  model: TurnModel,
  dyn: Dynamics,
): Seconds | null {
  const distNm = distance(from, to)
  if (!Number.isFinite(distNm)) return null
  if (distNm < 1e-9) return 0

  const required = bearing(from, to)
  const heading = state.heading ?? state.cog
  if (!Number.isFinite(heading)) return null
  const v0 = waterSpeed(state)

  let turnS = 0
  let p = from
  let v = v0
  const delta = angdiff(required, heading)
  if (Math.abs(delta) > 0.5) {
    const rot = model.rotDegPerSec(v0)
    if (!(rot > 0)) return null
    turnS = Math.abs(delta) / rot
    const half = (Math.abs(delta) * DEG) / 2
    const sinc = half < 1e-9 ? 1 : Math.sin(half) / half
    p = destination(from, wrap360(heading + delta / 2), (v0 / 3600) * turnS * sinc)
    v = v0 * speedLossFactor(delta, heading, required, dyn.twd)
  }

  const straightS = timeForDistance(distance(p, to), v, dyn.targetBsp, dyn.accelKnPerMin)
  if (straightS === null) return null
  const total = turnS + straightS
  return total > MAX_HORIZON_S ? null : total
}

/** Target speed and acceleration for sailing `course` in a given wind. */
function dynamicsFor(
  course: Degrees,
  wind: WindEstimate,
  lattice: PolarLattice | null | undefined,
  boat: Boat,
  state: BoatState,
  model: TurnModel,
): Dynamics {
  if (!lattice) {
    // No polar at all: hold the speed we have. This is the MVP path and it
    // must work, so it degrades to a pure kinematic answer rather than null.
    return { targetBsp: waterSpeed(state), accelKnPerMin: 0, twd: wind.twd }
  }
  const twa = twaFrom(course, wind.twd)
  return {
    targetBsp: lattice.speed(wind.tws, twa) * (boat.polarPct / 100),
    accelKnPerMin: model.accelKnPerMin(wind.tws, twa),
    twd: wind.twd,
  }
}

/**
 * Time to reach a point from the current state, including turn and
 * acceleration dynamics. Null when the point is unreachable (the polar says
 * the boat cannot sail that angle, or it is further away than the horizon).
 */
export function timeToPoint(o: {
  from: LatLon
  to: LatLon
  state: BoatState
  wind: WindEstimate
  lattice?: PolarLattice | null
  model?: TurnModel
  boat: Boat
}): Seconds | null {
  const model = o.model ?? DEFAULT_TURN_MODEL
  const course = bearing(o.from, o.to)
  const dyn = dynamicsFor(course, o.wind, o.lattice, o.boat, o.state, model)
  return timeToPointCore(o.from, o.to, o.state, model, dyn)
}

// ------------------------------------------------------------ the main call

interface Ctx {
  state: BoatState
  wind: WindEstimate | null
  current: CurrentEstimate | null
  boat: Boat
  lattice: PolarLattice | null
  model: TurnModel
}

/**
 * Time to a point over ground, correcting for current by a two-step fixed
 * point: to arrive at M after `t` seconds while the water carries you, you
 * must aim through the water at `M − current·t`.
 *
 * Only the polar-driven approaches go through here. The GPS approach is
 * already a ground-frame measurement (COG/SOG contain the current), and
 * applying the correction there would count it twice.
 */
function timeToPointOverGround(from: LatLon, to: LatLon, ctx: Ctx): Seconds | null {
  const dyn = ctx.wind
    ? dynamicsFor(bearing(from, to), ctx.wind, ctx.lattice, ctx.boat, ctx.state, ctx.model)
    : { targetBsp: waterSpeed(ctx.state), accelKnPerMin: 0, twd: null }
  let t = timeToPointCore(from, to, ctx.state, ctx.model, dyn)
  if (t === null || !ctx.current || !(ctx.current.drift > 0)) return t
  for (let i = 0; i < 2; i++) {
    const aim = destination(
      to,
      wrap360(ctx.current.set + 180),
      (ctx.current.drift * t) / 3600,
    )
    const next = timeToPointCore(from, aim, ctx.state, ctx.model, dyn)
    if (next === null) return t
    t = next
  }
  return t
}

function emptyStart(): StartNumbers {
  return {
    timeToGunS: null,
    timeToLineS: null,
    timeToBurnS: null,
    distanceBelowLineM: null,
    distanceBelowLineBoatLengths: null,
    biasAngleDeg: null,
    biasLengthM: null,
    favouredEnd: null,
    lineSquareWindDeg: null,
    lineLengthM: null,
    timeToPortEndS: null,
    timeToStarboardEndS: null,
    ocs: false,
  }
}

/**
 * Every pre-start number, from as little as two pinged ends and a clock.
 *
 * Degradation ladder, in the order the doc says to build it:
 *   two ends            -> line length, square wind, distance below line
 *   + a gun time        -> time to gun, OCS, time to burn
 *   + COG/SOG           -> GPS time to line
 *   + a wind estimate   -> bias angle, bias length, favoured end
 *   + a polar lattice   -> reach and layline approaches, proper time to line
 */
export function computeStart(i: StartInputs): StartNumbers {
  const out = emptyStart()
  const { line, state, boat } = i
  const approaches = i.approaches ?? ALL_APPROACHES
  const ctx: Ctx = {
    state,
    wind: i.wind,
    current: i.current ?? null,
    boat,
    lattice: i.lattice ?? null,
    model: DEFAULT_TURN_MODEL,
  }

  if (line.gunTime !== null && Number.isFinite(line.gunTime) && Number.isFinite(i.now)) {
    out.timeToGunS = (line.gunTime - i.now) / 1000
  }

  const P = line.port
  const S = line.starboard
  if (!P || !S) return out

  // --- line geometry, in a frame anchored at the line midpoint -------------
  const frame = new LocalFrame(midpoint(P, S))
  const pxy = frame.toXY(P)
  const sxy = frame.toXY(S)
  const lineVec = vecSub(sxy, pxy)
  const lineLenNm = vecLen(lineVec)
  out.lineLengthM = nmToM(lineLenNm)
  if (!(lineLenNm > 1e-9)) return out // both ends pinged in the same spot

  const lineBrg = vecBearing(lineVec) // P -> S
  // Port end left, starboard end right when looking up the course, so the
  // up-course normal is 90° anticlockwise of P->S — and the TWD that squares
  // the line is exactly that direction.
  const squareWind = wrap360(lineBrg - 90)
  out.lineSquareWindDeg = squareWind

  // --- bias ----------------------------------------------------------------
  if (i.wind) {
    // Negative = port end favoured, positive = starboard end favoured.
    // (A leeward start has the ends labelled the other way round; the sign
    // then names the downwind-favoured end, which is still the one to go to.)
    const bias = angdiff(i.wind.twd, squareWind)
    out.biasAngleDeg = bias
    // The number that actually matters: 5° on a 100 m line is one boat length,
    // 5° on a 1 km line is the whole race.
    out.biasLengthM = nmToM(lineLenNm) * Math.sin(Math.abs(bias) * DEG)
    out.favouredEnd =
      Math.abs(bias) < EVEN_BIAS_DEG ? 'even' : bias > 0 ? 'starboard' : 'port'
  }

  // --- distance below the line --------------------------------------------
  // Measured from the BOW, to the INFINITE line through the two ends (not the
  // segment): you can be over early past the end of the line, and the number
  // has to stay continuous. Expedition: "essentially the XTE from the line".
  const bow = bowPosition(state, boat)
  const bowXY = frame.toXY(bow)
  // Orient the sign against a reference point known to be on the pre-start
  // side (90° clockwise of P->S). Done empirically rather than by trusting a
  // remembered sign convention, because that is exactly the kind of thing that
  // silently inverts when a helper is refactored.
  const preStartRef = fromPolar(wrap360(lineBrg + 90), lineLenNm)
  const orient = Math.sign(signedDistanceToLine(preStartRef, pxy, sxy)) || 1
  const belowNm = orient * signedDistanceToLine(bowXY, pxy, sxy)
  // A distance is only a distance if the fix it came from was a position. These
  // stay null for a non-finite one rather than rendering "NaN boat lengths" -
  // the same discipline the rest of this file applies to a bad COG or SOG.
  const belowKnown = Number.isFinite(belowNm)
  out.distanceBelowLineM = belowKnown ? nmToM(belowNm) : null
  out.distanceBelowLineBoatLengths =
    belowKnown && boat.loaMetres > 0 ? nmToM(belowNm) / boat.loaMetres : null

  // OCS only if the bow is over AND the gun has not fired yet.
  out.ocs = belowNm < 0 && out.timeToGunS !== null && out.timeToGunS > 0

  // --- candidate approaches -----------------------------------------------
  const candidates: Seconds[] = []
  const lineDir = vecScale(lineVec, 1 / lineLenNm)

  // GPS: pure kinematics along the present COG at the present SOG. No polar,
  // no dynamics, always available — the fallback the MVP is built on.
  if (approaches.gps && Number.isFinite(state.cog) && state.sog > 0) {
    const hit = rayIntersect(bowXY, fromPolar(state.cog, 1), pxy, lineDir)
    if (hit) {
      // |t| because this approach models no turn: a boat pointing away from
      // the line gets the time it would take on the reciprocal.
      const t = (Math.abs(hit.t) / state.sog) * 3600
      if (t <= MAX_HORIZON_S) candidates.push(t)
    }
  }

  // Ends. Reported whether or not they feed time-to-line — the display draws
  // a time at each end regardless.
  out.timeToPortEndS = timeToPointOverGround(bow, P, ctx)
  out.timeToStarboardEndS = timeToPointOverGround(bow, S, ctx)
  if (approaches.ends) {
    if (out.timeToPortEndS !== null) candidates.push(out.timeToPortEndS)
    if (out.timeToStarboardEndS !== null) candidates.push(out.timeToStarboardEndS)
  }

  // Reaching: hold the present heading at start-polar speed until the line.
  if (approaches.reach) {
    const hdg = state.heading ?? state.cog
    const cross = crossingPoint(bowXY, hdg, pxy, lineDir, frame)
    if (cross) {
      const t = timeToPointOverGround(bow, cross, ctx)
      if (t !== null) candidates.push(t)
    }
  }

  // Close-hauled (or running) approaches on each tack, including the turn onto
  // that tack. `timeToPointCore` charges the tack in both time and speed.
  if (i.wind && ctx.lattice) {
    const targets = ctx.lattice.targetsAt(i.wind.tws)
    // A start line is normally set for a beat, but not always: if the wind is
    // more than 90° from the square wind the course side is downwind and the
    // approach runs at the downwind target angle instead.
    const upwind = angsep(i.wind.twd, squareWind) < 90
    const targetTwa = Math.abs(upwind ? targets.upTwa : targets.downTwa)
    const tacks: Array<['port' | 'starboard', number]> = [
      ['starboard', targetTwa],
      ['port', -targetTwa],
    ]
    for (const [tack, twa] of tacks) {
      if (!approaches[tack]) continue
      const cross = crossingPoint(bowXY, courseFor(i.wind.twd, twa), pxy, lineDir, frame)
      if (!cross) continue
      const t = timeToPointOverGround(bow, cross, ctx)
      if (t !== null) candidates.push(t)
    }
  }

  if (candidates.length > 0) {
    const best = Math.min(...candidates)
    // Expedition's convention: `Start time to line` is negative when you are
    // over the line. The magnitude is still the shortest time to get to it.
    out.timeToLineS = belowNm < 0 ? -best : best
    if (out.timeToGunS !== null) out.timeToBurnS = out.timeToLineS - out.timeToGunS
  }

  return out
}

/**
 * Where a course from `fromXY` meets the infinite start line, or null if it
 * never does ahead of the boat.
 */
function crossingPoint(
  fromXY: XY,
  course: Degrees,
  pxy: XY,
  lineDir: XY,
  frame: LocalFrame,
): LatLon | null {
  if (!Number.isFinite(course)) return null
  const hit = rayIntersect(fromXY, fromPolar(course, 1), pxy, lineDir)
  if (!hit || hit.t <= 0) return null
  return frame.toLatLon(hit.point)
}

/**
 * Seconds in hand before the gun: positive early, negative late.
 *
 * `StartNumbers.timeToBurnS` keeps Expedition's definition, `timeToLine -
 * timeToGun`, which is positive when you arrive AFTER the gun. A sailor asking
 * for "time to burn" means the opposite — the spare seconds to kill before
 * starting — so every display of that number has to flip it. This is that flip,
 * in one tested place, because reading it backwards inverts the most important
 * number on the start screen and looks entirely plausible either way.
 */
export function spareTimeS(n: Pick<StartNumbers, 'timeToBurnS'>): Seconds | null {
  return n.timeToBurnS == null || !Number.isFinite(n.timeToBurnS) ? null : -n.timeToBurnS
}
