/**
 * A synthetic boat, so the app can be demonstrated and tested off the water.
 *
 * This is not a toy: it sails the polar properly, tacks through the no-go zone,
 * drifts with current, and is driven by the same `BoatState` the real GPS
 * produces — so every downstream calculation is exercised exactly as it would
 * be at sea. Pressing "simulate" is how you develop this app in January.
 */

import { angdiff, courseFor, twaFrom, wrap360 } from './angles'
import { LocalFrame, bearing, destination, distance } from './geo'
import type {
  BoatState,
  CurrentEstimate,
  Degrees,
  Knots,
  LatLon,
  Millis,
  PolarLattice,
} from './types'

export type Autopilot =
  | { mode: 'heading'; heading: Degrees }
  | { mode: 'twa'; twa: number }
  | { mode: 'mark'; target: LatLon }
  | { mode: 'drift' }

export interface SimOptions {
  start: LatLon
  twd: Degrees
  tws: Knots
  current?: CurrentEstimate
  lattice?: PolarLattice | null
  /** Fallback speed when there is no polar, knots. */
  fallbackSpeed?: Knots
  /** Random wind oscillation amplitude, degrees. */
  oscillationDeg?: number
  /** Oscillation period, seconds. */
  oscillationPeriodS?: number
}

/**
 * Deterministic pseudo-random so a simulated race replays identically —
 * essential when you are chasing a bug in the tactical numbers.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class BoatSim {
  private pos: LatLon
  private heading: Degrees
  private speed: Knots
  private t: Millis
  /**
   * Wall clock at construction, so the wind pattern can run from *elapsed* time.
   *
   * `t` itself has to stay a real epoch timestamp - the start-line timer and the
   * tide lookups both need one - but the oscillation phase used to be taken from
   * it directly, which meant the same seed produced a different breeze depending on
   * what time of day you pressed simulate. That silently broke the one promise this
   * module makes about being debuggable: replaying a race and getting the same race.
   */
  private readonly t0: Millis
  private pilot: Autopilot = { mode: 'drift' }
  private rng: () => number
  private baseTwd: Degrees
  private noise = 0
  readonly opts: Required<Omit<SimOptions, 'current' | 'lattice'>> &
    Pick<SimOptions, 'current' | 'lattice'>

  constructor(opts: SimOptions, seed = 12345) {
    this.opts = {
      fallbackSpeed: 5.5,
      oscillationDeg: 8,
      oscillationPeriodS: 240,
      ...opts,
    }
    this.pos = { ...opts.start }
    this.baseTwd = opts.twd
    this.heading = wrap360(opts.twd + 140)
    this.speed = 0
    this.t = Date.now()
    this.t0 = this.t
    this.rng = mulberry32(seed)
  }

  setAutopilot(p: Autopilot) {
    this.pilot = p
  }

  getAutopilot(): Autopilot {
    return this.pilot
  }

  setWind(twd: Degrees, tws: Knots) {
    this.baseTwd = twd
    this.opts.twd = twd
    this.opts.tws = tws
  }

  position(): LatLon {
    return { ...this.pos }
  }

  /** Instantaneous true wind, including the oscillation. */
  wind(): { twd: Degrees; tws: Knots } {
    const elapsedS = (this.t - this.t0) / 1000
    const phase = (elapsedS / this.opts.oscillationPeriodS) * 2 * Math.PI
    const osc = Math.sin(phase) * this.opts.oscillationDeg
    return {
      twd: wrap360(this.baseTwd + osc + this.noise),
      tws: this.opts.tws * (1 + 0.08 * Math.sin(phase * 1.7)),
    }
  }

  private targetSpeed(twa: number, tws: number): Knots {
    const lat = this.opts.lattice
    if (!lat) {
      // Crude but not absurd: peak on a beam reach, nothing dead upwind.
      const a = Math.abs(twa)
      if (a < 32) return 0.4
      const shape = Math.sin(((a - 25) / 155) * Math.PI) ** 0.6
      return this.opts.fallbackSpeed * shape * Math.min(1, tws / 12)
    }
    return lat.speed(tws, twa)
  }

  /** Advance the simulation by `dtS` seconds and return the new state. */
  step(dtS: number): BoatState {
    this.t += dtS * 1000
    // Slow random walk on wind direction, bounded.
    this.noise += (this.rng() - 0.5) * dtS * 0.35
    // Decay per second rather than per call: the caller picks dtS (the app steps at
    // 0.5 s, a test may use 30), and an unscaled factor made the breeze wander
    // differently at different frame rates.
    this.noise *= Math.pow(0.995, dtS)
    this.noise = Math.max(-12, Math.min(12, this.noise))

    const { twd, tws } = this.wind()

    // --- autopilot: choose a heading ---------------------------------------
    let wanted = this.heading
    if (this.pilot.mode === 'heading') {
      wanted = this.pilot.heading
    } else if (this.pilot.mode === 'twa') {
      wanted = courseFor(twd, this.pilot.twa)
    } else if (this.pilot.mode === 'mark') {
      const brg = bearing(this.pos, this.pilot.target)
      const twa = twaFrom(brg, twd)
      const targets = this.opts.lattice?.targetsAt(tws)
      const upTwa = targets?.upTwa ?? 42
      const dnTwa = targets?.downTwa ?? 150
      if (Math.abs(twa) < upTwa) {
        // Inside the no-go zone: sail the closest layline, favouring the
        // tack that gets us there — this is what makes the sim tack.
        wanted = courseFor(twd, twa >= 0 ? upTwa : -upTwa)
      } else if (Math.abs(twa) > dnTwa) {
        wanted = courseFor(twd, twa >= 0 ? dnTwa : -dnTwa)
      } else {
        wanted = brg
      }
    }

    // --- turn toward the wanted heading at a plausible rate -----------------
    const rot = 6 // deg/s
    const err = angdiff(wanted, this.heading)
    const turn = Math.max(-rot * dtS, Math.min(rot * dtS, err))
    this.heading = wrap360(this.heading + turn)

    // --- accelerate toward polar speed -------------------------------------
    const twa = twaFrom(this.heading, twd)
    const target = this.pilot.mode === 'drift' ? 0 : this.targetSpeed(twa, tws)
    // Turning costs speed, which is what makes time-to-line non-trivial.
    // `turn` is the angle actually turned this step — already proportional to
    // dtS when turning at full rate — so the loss scales with the step size
    // without an extra `* dtS`. The old `turnLoss * dtS * 0.5` multiplied by
    // dtS twice, giving O(dtS²): the loss vanished as the step shrank and
    // exploded as it grew, exactly the frame-rate bug the noise decay comment
    // on line 143 describes.
    const turnLoss = Math.min(0.6, Math.abs(turn) / 18)
    const tau = target > this.speed ? 14 : 6 // slower to accelerate than to slow
    this.speed += ((target - this.speed) / tau) * dtS
    this.speed *= 1 - turnLoss * 0.5
    this.speed = Math.max(0, this.speed)

    // --- move: water track + current ---------------------------------------
    const frame = new LocalFrame(this.pos)
    const hRad = (this.heading * Math.PI) / 180
    let vx = Math.sin(hRad) * this.speed
    let vy = Math.cos(hRad) * this.speed
    const cur = this.opts.current
    if (cur) {
      const cRad = (cur.set * Math.PI) / 180
      vx += Math.sin(cRad) * cur.drift
      vy += Math.cos(cRad) * cur.drift
    }
    const cog = wrap360((Math.atan2(vx, vy) * 180) / Math.PI)
    // The frame is anchored at the current position, so `toXY(this.pos)` is (0, 0)
    // by construction: the displacement is the whole sum. This used to add it to
    // that zero, projecting the same point twice, and to compute a `dNm` that was
    // then discarded with `void`.
    this.pos = frame.toLatLon({ x: (vx * dtS) / 3600, y: (vy * dtS) / 3600 })

    return {
      t: this.t,
      position: { ...this.pos },
      cog,
      sog: Math.hypot(vx, vy),
      accuracyM: 3.5,
      heading: this.heading,
      bsp: this.speed,
      heelDeg: Math.max(-32, Math.min(32, (Math.abs(twa) < 100 ? 1 : 0.4) * tws * 1.4 * Math.sign(twa || 1))),
    }
  }
}

/** Place a plausible start line near a position, square-ish to the wind. */
export function makeStartLine(
  centre: LatLon,
  twd: Degrees,
  lengthM = 150,
  biasDeg = 6,
): { port: LatLon; starboard: LatLon } {
  const half = lengthM / 2 / 1852
  const lineBearing = wrap360(twd + 90 + biasDeg)
  return {
    port: destination(centre, wrap360(lineBearing + 180), half),
    starboard: destination(centre, lineBearing, half),
  }
}

/** A windward/leeward course anchored on a start line. */
export function makeWLCourse(
  lineMid: LatLon,
  axisDeg: Degrees,
  windwardNm: number,
  leewardNm: number,
) {
  return {
    windward: destination(lineMid, axisDeg, windwardNm),
    leeward: destination(lineMid, wrap360(axisDeg + 180), leewardNm),
  }
}

export { distance as simDistance }
