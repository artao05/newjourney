/**
 * Laylines, beat splits, VMC and the rest of the running tactical numbers.
 *
 * Implements docs/03-algorithms/navigation-math.md §6 (laylines) and §7 (time
 * and distance to a mark), and docs/03-algorithms/polars-and-vpp.md §9 (VMC).
 * Produces the `Layline …`, `Mark …`, `Target …` and `Vmc …` channel families
 * of docs/01-expedition-analysis/channels-reference.md §F, §G and §J.
 */

import {
  DEG,
  RAD,
  angdiff,
  angsep,
  courseFor,
  stdBearing,
  tackOf,
  twaFrom,
  wrap360,
} from './angles'
import {
  LocalFrame,
  bearing,
  crossTrack,
  distance,
  fromPolar,
  midpoint,
  rayIntersect,
  vecScale,
} from './geo'
import type {
  Boat,
  BoatState,
  Course,
  CurrentEstimate,
  Degrees,
  Knots,
  LatLon,
  LaylineInfo,
  NauticalMiles,
  PolarLattice,
  Seconds,
  TacticalNumbers,
  WindEstimate,
} from './types'

export interface TacticalInputs {
  state: BoatState
  wind: WindEstimate | null
  current?: CurrentEstimate | null
  boat: Boat
  lattice?: PolarLattice | null
  course: Course
  activeMarkIndex: number
  /** Recent TWD samples for the oscillation band. */
  windHistory?: Array<{ t: number; twd: number; tws: number }>
}

export type WindHistory = Array<{ t: number; twd: number; tws: number }>

/**
 * Speed through the water, falling back to SOG when no log is fitted.
 * Non-finite in, zero out: one NaN fix must not poison every channel.
 */
function waterSpeed(state: BoatState): Knots {
  const v = state.bsp ?? state.sog
  return Number.isFinite(v) && v > 0 ? v : 0
}

// ------------------------------------------------------------------ current

/**
 * Heading to steer through the water to make good a desired track over ground
 * (navigation-math.md §6):
 *
 *     sin(offset) = (drift / bsp) · sin(set − track)
 *     heading     = track − offset
 *
 * Returns `null` when the triangle has no solution — `|drift·sin(…)| > bsp`,
 * the current is simply stronger across the track than the boat can sail. That
 * is a real case in a tidal gate, and the whole reason this returns a nullable
 * instead of quietly producing NaN from `asin`. Also returns null when the
 * solution exists but the speed made good along the track is backwards: you
 * would be pointing the right way and going the wrong way.
 */
export function headingToMakeGood(o: {
  track: Degrees
  set: Degrees
  drift: Knots
  bsp: Knots
}): Degrees | null {
  if (!(o.bsp > 0)) return null
  if (!(o.drift > 0)) return wrap360(o.track)
  const across = angdiff(o.set, o.track)
  const sinOffset = (o.drift / o.bsp) * Math.sin(across * DEG)
  if (Math.abs(sinOffset) > 1) return null
  const offset = Math.asin(sinOffset) * RAD
  const madeGood = o.bsp * Math.cos(offset * DEG) + o.drift * Math.cos(across * DEG)
  if (!(madeGood > 0)) return null
  return wrap360(o.track - offset)
}

// ----------------------------------------------------------------- laylines

/**
 * Laylines to a mark, with current correction and an oscillation band.
 *
 * NAMING, and please leave it alone: `portBearing` and `distanceToPortLayline`
 * both refer to **the port layline** — the layline you sail *on port tack* to
 * fetch the mark. It sits on the left-hand side of the course, so a boat on
 * starboard tack is the one converging with it.
 *
 * Expedition names the equivalent channels for the tack you are *on* rather
 * than the layline being measured: its `Layline distance on port` is documented
 * as "Distance to the starboard layline". That trap has confused sailors for
 * twenty years (channels-reference.md §G) and we deliberately do not repeat it.
 * If you ever want Expedition's convention for import compatibility, swap the
 * two at the boundary — never in here.
 */
export function computeLaylines(o: {
  from: LatLon
  mark: LatLon
  wind: WindEstimate
  lattice: PolarLattice
  state: BoatState
  current?: CurrentEstimate | null
  windHistory?: WindHistory
}): LaylineInfo {
  const brgToMark = bearing(o.from, o.mark)
  const targets = o.lattice.targetsAt(o.wind.tws)
  // A mark within 90° of the wind's eye is a beat; anything else is a run.
  const upwind = angsep(brgToMark, o.wind.twd) < 90
  const targetTwa = Math.abs(upwind ? targets.upTwa : targets.downTwa)

  // The course you would sail on each tack. Starboard puts the wind on the
  // starboard side, i.e. TWA positive, i.e. course = TWD − targetTwa.
  const starboardBearing = wrap360(o.wind.twd - targetTwa)
  const portBearing = wrap360(o.wind.twd + targetTwa)

  const info: LaylineInfo = {
    portBearing,
    starboardBearing,
    distanceToPortLayline: null,
    distanceToStarboardLayline: null,
    timeToPortLaylineS: null,
    timeToStarboardLaylineS: null,
    twdToLay: null,
    boundsDeg: boundsFrom(o.wind, o.windHistory),
  }

  // The layline is defined in the water frame but drawn over ground: check
  // that a heading exists which makes good each layline track under the
  // current. If not, that layline is unsailable and stays null.
  const bsp = waterSpeed(o.state)
  const sailable = (track: Degrees): boolean => {
    if (!o.current || !(o.current.drift > 0)) return true
    return (
      headingToMakeGood({ track, set: o.current.set, drift: o.current.drift, bsp }) !== null
    )
  }

  const frame = new LocalFrame(o.mark)
  const boatXY = frame.toXY(o.from)
  const markXY = { x: 0, y: 0 }
  const trackDir = fromPolar(o.state.cog, 1)

  /** Distance along the boat's present track to where it meets a layline. */
  const reach = (laylineBearing: Degrees): NauticalMiles | null => {
    if (!sailable(laylineBearing)) return null
    // The layline is the ray running back from the mark, so the intersection
    // must have s >= 0 (short of the mark) and t >= 0 (ahead of the boat).
    const hit = rayIntersect(boatXY, trackDir, markXY, fromPolar(laylineBearing + 180, 1))
    if (!hit || hit.t < 0 || hit.s < 0) return null
    return hit.t
  }

  info.distanceToPortLayline = reach(portBearing)
  info.distanceToStarboardLayline = reach(starboardBearing)
  if (o.state.sog > 0) {
    if (info.distanceToPortLayline !== null) {
      info.timeToPortLaylineS = (info.distanceToPortLayline / o.state.sog) * 3600
    }
    if (info.distanceToStarboardLayline !== null) {
      info.timeToStarboardLaylineS = (info.distanceToStarboardLayline / o.state.sog) * 3600
    }
  }

  const tack = tackOf(twaFrom(o.state.heading ?? o.state.cog, o.wind.twd))
  info.twdToLay = twdToLay({ from: o.from, mark: o.mark, tack, targetTwa })
  return info
}

/**
 * Layline bearing envelope, degrees.
 *
 * Prefer the observed oscillation — the circular standard deviation of the
 * recent TWD samples — over the wind source's nominal uncertainty, because the
 * band that matters is the one this breeze is actually swinging through. Even
 * a plain ±1σ envelope is a large practical improvement on a single hard line:
 * it visibly discourages tacking on the layline in an oscillating breeze.
 */
/**
 * Wind sources whose repeated samples are genuinely independent measurements.
 *
 * This distinction is the whole point: observed variance is only evidence about
 * the breeze when each sample was measured. A hand-entered or held wind echoes
 * one typed number forever, so its observed oscillation is exactly zero — an
 * artefact of the input method, not a steady breeze. Reporting a 0 degree layline
 * band there claims the wind is known perfectly, which is false, and false
 * confidence in a layline is how you overstand a mark.
 */
const MEASURED_SOURCES: ReadonlySet<WindEstimate['source']> = new Set(['instrument', 'estimated'])

function boundsFrom(wind: WindEstimate, history?: WindHistory): number {
  const nominal = Number.isFinite(wind.uncertaintyDeg) ? wind.uncertaintyDeg : 0
  const twds = (history ?? []).map((s) => s.twd).filter((d) => Number.isFinite(d))
  if (twds.length < 2) return nominal
  const observed = stdBearing(twds)
  // Measured: trust the breeze, even when it is steadier than the source claims.
  // Asserted: the source's own stated uncertainty is a floor.
  return MEASURED_SOURCES.has(wind.source) ? observed : Math.max(observed, nominal)
}

/**
 * What TWD would be needed to lay the mark on the given tack
 * (navigation-math.md §6). Inverts `course = TWD ∓ targetTwa` at the moment
 * the course equals the bearing to the mark.
 *
 * A wonderfully teachable number: "you need a 12° left shift to lay it".
 */
export function twdToLay(o: {
  from: LatLon
  mark: LatLon
  tack: 'port' | 'starboard'
  targetTwa: number
}): Degrees {
  const b = bearing(o.from, o.mark)
  const ta = Math.abs(o.targetTwa)
  return o.tack === 'starboard' ? wrap360(b + ta) : wrap360(b - ta)
}

// --------------------------------------------------------------- beat split

/**
 * Distance to sail on each tack to fetch a mark that is inside the no-go zone
 * (navigation-math.md §7): solve `a·û_port + b·û_stbd = M − P` for a, b ≥ 0.
 *
 * Returns `null` when the mark is layable on one tack — there is no split to
 * make — or when the two tacks are parallel.
 *
 * The same geometry serves a run: pass the downwind target TWA and the two
 * "tacks" become the two gybes. Which is why this is the most useful number on
 * the first beat: it says immediately whether you are on the long tack or the
 * short one.
 */
export function beatSplit(o: {
  from: LatLon
  mark: LatLon
  twd: number
  targetTwa: number
}): { portNm: NauticalMiles; starboardNm: NauticalMiles; totalNm: NauticalMiles } | null {
  const ta = Math.abs(o.targetTwa)
  const frame = new LocalFrame(o.from)
  const m = frame.toXY(o.mark)
  const portDir = fromPolar(wrap360(o.twd + ta), 1)
  const stbdDir = fromPolar(wrap360(o.twd - ta), 1)
  // boat + t·û_port = mark − s·û_stbd  ⇒  mark = boat + t·û_port + s·û_stbd
  const hit = rayIntersect({ x: 0, y: 0 }, portDir, m, vecScale(stbdDir, -1))
  if (!hit) return null
  if (!(hit.t >= 0) || !(hit.s >= 0)) return null
  return { portNm: hit.t, starboardNm: hit.s, totalNm: hit.t + hit.s }
}

// ---------------------------------------------------------------------- VMC

const VMC_COARSE_STEP = 1
const VMC_FINE_STEP = 0.02

/**
 * Velocity made *course*: the component of polar speed toward the mark
 * (polars-and-vpp.md §9), maximised over TWA.
 *
 *     VMC(twa) = polar_speed(tws, twa) · cos(bearing_to_mark − heading(twa))
 *
 * This answers "should I foot off or point up to get to that mark?", which is
 * a different question from VMG's "am I sailing the boat well?". Sail VMG when
 * the mark is dead up or dead downwind, VMC when it is not.
 *
 * Coarse 1° sweep then a 0.02° refine: the VMC curve has two broad lobes and a
 * pure gradient walk would happily settle in the wrong one.
 */
export function vmcOptimum(o: {
  bearingToMark: Degrees
  twd: Degrees
  tws: Knots
  lattice: PolarLattice
}): { vmc: Knots; heading: Degrees; twa: Degrees } {
  const at = (twa: number): number => {
    const heading = courseFor(o.twd, twa)
    return o.lattice.speed(o.tws, twa) * Math.cos(angdiff(o.bearingToMark, heading) * DEG)
  }
  let bestTwa = 0
  let bestVmc = -Infinity
  for (let twa = -180; twa <= 180; twa += VMC_COARSE_STEP) {
    const v = at(twa)
    if (v > bestVmc) {
      bestVmc = v
      bestTwa = twa
    }
  }
  for (
    let twa = bestTwa - VMC_COARSE_STEP;
    twa <= bestTwa + VMC_COARSE_STEP;
    twa += VMC_FINE_STEP
  ) {
    const v = at(twa)
    if (v > bestVmc) {
      bestVmc = v
      bestTwa = twa
    }
  }
  return { vmc: bestVmc, heading: courseFor(o.twd, bestTwa), twa: bestTwa }
}

// ------------------------------------------------------------ the main call

function emptyTactics(): TacticalNumbers {
  return {
    twd: null,
    tws: null,
    twa: null,
    windSource: null,
    targetBsp: null,
    targetTwa: null,
    polarBsp: null,
    polarBspPct: null,
    vmg: null,
    vmgPct: null,
    vmc: null,
    vmcOptimum: null,
    vmcOptimumHeading: null,
    markBearing: null,
    markRange: null,
    markTimeS: null,
    headingToSteer: null,
    xteNm: null,
    distanceToFinishNm: null,
    laylines: null,
    nextMarkBearing: null,
    portTackDistanceNm: null,
    starboardTackDistanceNm: null,
  }
}

/**
 * Run one group of channels, swallowing anything it throws.
 *
 * Deliberate, and the reason it is per-group rather than one big try: the
 * polar comes from a file the user supplied and is the most likely thing in
 * here to explode. When it does, the GPS-derived numbers — bearing, range,
 * VMC, XTE — must survive, because those are exactly the numbers you still
 * need while you work out why the polar is broken. A tactical display that
 * goes blank mid-race is worse than one with gaps in it.
 */
function attempt(fn: () => void): void {
  try {
    fn()
  } catch {
    /* this group of channels stays null; the rest still compute */
  }
}

/** Every running tactical number, degrading field by field. Never throws. */
export function computeTactics(i: TacticalInputs): TacticalNumbers {
  const out = emptyTactics()
  const { state, boat, wind } = i
  const lattice = i.lattice ?? null
  const current = i.current ?? null

  attempt(() => {
    if (!wind) return
    out.twd = wind.twd
    out.tws = wind.tws
    out.windSource = wind.source
    out.twa = twaFrom(state.heading ?? state.cog, wind.twd)
  })

  attempt(() => {
    if (!wind || !lattice || out.twa === null) return
    const pct = boat.polarPct / 100
    const bsp = waterSpeed(state)
    const targets = lattice.targetsAt(wind.tws)
    const upwind = Math.abs(out.twa) < 90
    out.targetTwa = Math.abs(upwind ? targets.upTwa : targets.downTwa)
    out.targetBsp = (upwind ? targets.upBsp : targets.downBsp) * pct
    out.polarBsp = lattice.speed(wind.tws, out.twa) * pct
    if (out.polarBsp > 0) out.polarBspPct = (100 * bsp) / out.polarBsp
    // Signed: positive upwind, negative downwind, so that dividing by the
    // (equally signed) target VMG gives a sane percentage on both.
    out.vmg = bsp * Math.cos(out.twa * DEG)
    const targetVmg = (upwind ? targets.upVmg : targets.downVmg) * pct
    if (Math.abs(targetVmg) > 1e-9) out.vmgPct = (100 * out.vmg) / targetVmg
  })

  const marks = i.course?.marks ?? []
  const mark = marks[i.activeMarkIndex] ?? null
  if (!mark) return out

  // --- mark geometry: GPS only, no polar involved ---------------------------
  attempt(() => {
    out.markBearing = bearing(state.position, mark.position)
    out.markRange = distance(state.position, mark.position)
    // Vmc: the component of SOG toward the mark.
    out.vmc = state.sog * Math.cos(angdiff(out.markBearing, state.cog) * DEG)
    out.headingToSteer = current
      ? headingToMakeGood({
          track: out.markBearing,
          set: current.set,
          drift: current.drift,
          bsp: waterSpeed(state),
        })
      : out.markBearing
  })

  // --- everything that needs the polar --------------------------------------
  attempt(() => {
    if (!wind || !lattice || out.markBearing === null || out.markRange === null) return
    const opt = vmcOptimum({
      bearingToMark: out.markBearing,
      twd: wind.twd,
      tws: wind.tws,
      lattice,
    })
    out.vmcOptimum = opt.vmc * (boat.polarPct / 100)
    out.vmcOptimumHeading = opt.heading

    out.laylines = computeLaylines({
      from: state.position,
      mark: mark.position,
      wind,
      lattice,
      state,
      current,
      windHistory: i.windHistory,
    })

    const targets = lattice.targetsAt(wind.tws)
    const offWind = angsep(out.markBearing, wind.twd)
    const split = beatSplit({
      from: state.position,
      mark: mark.position,
      twd: wind.twd,
      targetTwa: Math.abs(offWind < 90 ? targets.upTwa : targets.downTwa),
    })
    if (split) {
      out.portTackDistanceNm = split.portNm
      out.starboardTackDistanceNm = split.starboardNm
    }
    out.markTimeS = markTime(out.markRange, offWind, targets, boat, lattice, wind.tws)
  })

  // `Mark GPS time`: range over VMC. The fallback whenever the polar route to
  // a mark time did not produce one.
  attempt(() => {
    if (out.markTimeS !== null || out.markRange === null) return
    if (out.vmc !== null && out.vmc > 0) out.markTimeS = (out.markRange / out.vmc) * 3600
  })

  // --- the leg ---------------------------------------------------------------
  attempt(() => {
    // Cross-track from the leg we are on. Before the first mark the leg starts
    // at the middle of the start line, if it has been pinged.
    const prev = previousPoint(i.course, i.activeMarkIndex)
    if (prev) out.xteNm = crossTrack(state.position, prev, mark.position)

    const next = marks[i.activeMarkIndex + 1]
    if (next) out.nextMarkBearing = bearing(mark.position, next.position)

    if (out.markRange === null) return
    let toGo = out.markRange
    for (let k = i.activeMarkIndex; k < marks.length - 1; k++) {
      toGo += distance(marks[k].position, marks[k + 1].position)
    }
    out.distanceToFinishNm = toGo
  })

  return out
}

/** Start of the current leg: the previous mark, or the start line midpoint. */
function previousPoint(course: Course, activeMarkIndex: number): LatLon | null {
  const prev = course.marks[activeMarkIndex - 1]
  if (prev) return prev.position
  const line = course.startLine
  if (!line || !line.port || !line.starboard) return null
  return midpoint(line.port, line.starboard)
}

/**
 * Time to the mark including the tacks or gybes it takes to get there
 * (navigation-math.md §7).
 *
 * If the mark is inside the no-go zone you cannot sail at it, so the honest
 * answer is the beat (or run) time: the along-wind distance at target VMG plus
 * one manoeuvre. Outside the no-go zone it is the range at the polar speed for
 * that angle.
 */
function markTime(
  rangeNm: NauticalMiles,
  offWindDeg: Degrees,
  targets: { upTwa: Degrees; upVmg: Knots; downTwa: Degrees; downVmg: Knots },
  boat: Boat,
  lattice: PolarLattice,
  tws: Knots,
): Seconds | null {
  const pct = boat.polarPct / 100
  const upTwa = Math.abs(targets.upTwa)
  const downTwa = Math.abs(targets.downTwa)
  if (offWindDeg < upTwa) {
    const vmg = Math.abs(targets.upVmg) * pct
    if (!(vmg > 0)) return null
    const along = rangeNm * Math.cos(offWindDeg * DEG)
    return (along / vmg) * 3600 + boat.tackPenaltyS
  }
  if (offWindDeg > downTwa) {
    const vmg = Math.abs(targets.downVmg) * pct
    if (!(vmg > 0)) return null
    const along = rangeNm * Math.cos((180 - offWindDeg) * DEG)
    return (along / vmg) * 3600 + boat.gybePenaltyS
  }
  const bsp = lattice.speed(tws, offWindDeg) * pct
  if (!(bsp > 0)) return null
  return (rangeNm / bsp) * 3600
}
