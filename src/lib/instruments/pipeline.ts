/**
 * The instrument pipeline: from what the sensors say to what tactics need.
 *
 * In order, as Expedition does it:
 *
 *   1. Damp each channel. Angles are damped on the circle, as unit vectors, so
 *      359° and 1° average to 0° and not 180°.
 *   2. Correct apparent wind for heel, when the instruments do not already.
 *   3. Leeway from heel and boat speed, `k · heel / bsp²`; course = heading + leeway.
 *   4. True wind from apparent, on the water course (unless the instruments'
 *      own true wind is preferred), then ground wind by adding the current.
 *   5. Set and drift from ground and water tracks, only while the boat is not
 *      turning faster than the gate: mid-tack, the residual is lag, not tide.
 *
 * The upwash and mast-twist corrections belong to the calibration tables
 * (worklist 6.5), which slot in between steps 2 and 4.
 */

import { DEG, RAD, wrap180, wrap360 } from '@/lib/angles'
import {
  DEFAULT_LEEWAY_K,
  DEFAULT_ROT_LIMIT,
  apparentToTrue,
  correctForHeel,
  estimateCurrent,
  leewayFrom,
  trueToGround,
} from '@/lib/wind'
import type { Reading } from './nmea0183'
import { headingTrueOf } from './toBoat'

export type DampKind = 'linear' | 'bearing' | 'signed'

/**
 * One channel's damping. `exp` is Expedition's default, weighting recent
 * values most, with time constant `tauS`; `boxcar` is the plain mean of the
 * last `tauS` seconds. A tau of 0 passes values straight through.
 */
export class Damper {
  private x: number | null = null
  private y = 0
  /** With no damping, the last value exactly, not via the unit circle. */
  private raw: number | null = null
  private t: number | null = null
  private window: Array<{ t: number; x: number; y: number }> = []

  constructor(
    private readonly tauS: number,
    private readonly kind: DampKind = 'linear',
    private readonly mode: 'exp' | 'boxcar' = 'exp',
  ) {}

  push(value: number, t: number): number {
    if (!Number.isFinite(value)) return this.value ?? NaN
    if (!(this.tauS > 0)) {
      this.raw = this.kind === 'bearing' ? wrap360(value) : this.kind === 'signed' ? wrap180(value) : value
      return this.raw
    }
    const angle = this.kind !== 'linear'
    const vx = angle ? Math.cos(value * DEG) : value
    const vy = angle ? Math.sin(value * DEG) : 0
    if (this.mode === 'boxcar') {
      this.window.push({ t, x: vx, y: vy })
      while (this.window.length && this.window[0].t <= t - this.tauS * 1000) this.window.shift()
      this.x = this.window.reduce((a, w) => a + w.x, 0) / this.window.length
      this.y = this.window.reduce((a, w) => a + w.y, 0) / this.window.length
    } else if (this.x == null || this.t == null) {
      ;[this.x, this.y] = [vx, vy]
    } else {
      const dt = Math.max(0, (t - this.t) / 1000)
      const a = 1 - Math.exp(-dt / this.tauS)
      this.x += a * (vx - this.x)
      this.y += a * (vy - this.y)
    }
    this.t = t
    return this.value!
  }

  get value(): number | null {
    if (this.raw != null) return this.raw
    if (this.x == null) return null
    if (this.kind === 'linear') return this.x
    const a = Math.atan2(this.y, this.x) * RAD
    return this.kind === 'bearing' ? wrap360(a) : wrap180(a)
  }
}

export interface PipelineSettings {
  /** Seconds of damping for angles and for speeds. 0 is raw. */
  dampAngleS: number
  dampSpeedS: number
  dampMode: 'exp' | 'boxcar'
  /** Correct AWA/AWS for heel. Off when the instruments already do (Nexus FDX and others). */
  heelCorrect: boolean
  leewayK: number
  /** Where true wind comes from: calculated here from apparent, or as the instruments send it. */
  trueWind: 'calculate' | 'instrument'
  /** Set and drift are only estimated below this rate of turn, °/s. */
  rotLimitDegS: number
}

export const DEFAULT_PIPELINE: PipelineSettings = {
  dampAngleS: 3,
  dampSpeedS: 3,
  dampMode: 'exp',
  heelCorrect: false,
  leewayK: DEFAULT_LEEWAY_K,
  trueWind: 'calculate',
  rotLimitDegS: DEFAULT_ROT_LIMIT,
}

export interface Derived {
  awa: number | null
  aws: number | null
  heading: number | null
  bsp: number | null
  cog: number | null
  sog: number | null
  heel: number | null
  leeway: number | null
  course: number | null
  twa: number | null
  tws: number | null
  twd: number | null
  gwd: number | null
  gws: number | null
  current: { set: number; drift: number } | null
  /** Rate of turn used for the current gate, °/s: the instrument's, or from the heading. */
  rotDegS: number | null
}

const CHANNELS: Array<[keyof Derived, DampKind, 'angle' | 'speed']> = [
  ['awa', 'signed', 'angle'],
  ['aws', 'linear', 'speed'],
  ['heading', 'bearing', 'angle'],
  ['bsp', 'linear', 'speed'],
  ['cog', 'bearing', 'angle'],
  ['sog', 'linear', 'speed'],
  ['heel', 'signed', 'angle'],
]

/** Runs the pipeline over a stream of readings, keeping each channel's damping. */
export class InstrumentPipeline {
  private dampers = new Map<keyof Derived, Damper>()
  private lastHeading: { t: number; h: number } | null = null

  constructor(readonly settings: PipelineSettings = DEFAULT_PIPELINE) {
    for (const [k, kind, group] of CHANNELS) {
      const tau = group === 'angle' ? settings.dampAngleS : settings.dampSpeedS
      this.dampers.set(k, new Damper(tau, kind, settings.dampMode))
    }
  }

  step(r: Reading, t: number): Derived {
    const s = this.settings
    const damp = (k: keyof Derived, v: number | null | undefined) =>
      v == null || !Number.isFinite(v) ? null : this.dampers.get(k)!.push(v, t)
    const rawHeading = headingTrueOf(r)

    // Rate of turn from the instrument, or from how the raw heading moved.
    let rotDegS: number | null = r.rateOfTurn != null ? r.rateOfTurn / 60 : null
    if (rotDegS == null && rawHeading != null) {
      if (this.lastHeading && t > this.lastHeading.t) {
        rotDegS = wrap180(rawHeading - this.lastHeading.h) / ((t - this.lastHeading.t) / 1000)
      }
      this.lastHeading = { t, h: rawHeading }
    }

    let awa = r.awa ?? null
    let aws = r.aws ?? null
    if (s.heelCorrect && awa != null && aws != null && r.heel != null) {
      ;({ awa, aws } = correctForHeel({ awa, aws, heelDeg: r.heel }))
    }
    const out: Derived = {
      awa: damp('awa', awa),
      aws: damp('aws', aws),
      heading: damp('heading', rawHeading),
      bsp: damp('bsp', r.bsp),
      cog: damp('cog', r.cog),
      sog: damp('sog', r.sog),
      heel: damp('heel', r.heel),
      leeway: null,
      course: null,
      twa: null,
      tws: null,
      twd: null,
      gwd: null,
      gws: null,
      current: null,
      rotDegS,
    }

    if (out.bsp != null) out.leeway = out.heel != null ? leewayFrom({ heelDeg: out.heel, bsp: out.bsp, k: s.leewayK }) : 0
    if (out.heading != null) out.course = wrap360(out.heading + (out.leeway ?? 0))

    const sent = r.tws != null && (r.twd != null || r.twa != null)
    if (s.trueWind === 'calculate' && out.awa != null && out.aws != null && out.bsp != null && out.course != null) {
      const tw = apparentToTrue({ awa: out.awa, aws: out.aws, bsp: out.bsp, course: out.course })
      ;[out.twa, out.tws, out.twd] = [tw.twa, tw.tws, tw.twd]
    } else if (sent) {
      out.tws = r.tws!
      out.twd = r.twd ?? (rawHeading != null && r.twa != null ? wrap360(rawHeading + r.twa) : null)
      out.twa = r.twa ?? (out.twd != null && out.heading != null ? wrap180(out.twd - out.heading) : null)
    }

    if (out.cog != null && out.sog != null && out.heading != null && out.bsp != null) {
      out.current = estimateCurrent({
        cog: out.cog,
        sog: out.sog,
        heading: out.heading,
        bsp: out.bsp,
        leeway: out.leeway ?? 0,
        rotDegPerSec: rotDegS ?? undefined,
        rotLimit: s.rotLimitDegS,
      })
    }
    if (out.twd != null && out.tws != null && out.current) {
      const g = trueToGround({ twd: out.twd, tws: out.tws, set: out.current.set, drift: out.current.drift })
      ;[out.gwd, out.gws] = [g.gwd, g.gws]
    }
    return out
  }
}
