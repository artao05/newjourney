/**
 * `WeatherField` implementations: the query-time resolver the whole app codes
 * against.
 *
 * See docs/05-spec/technical-spec.md §4 (provider abstraction) and
 * docs/01-expedition-analysis/how-it-computes.md §3 (priority-resolved merge).
 *
 * The design choice worth naming: sources are NOT pre-merged into one grid.
 * A query `(lat, lon, t, parameter)` walks an ordered stack and takes the first
 * source that covers the point — tidal streams inshore, global GRIB offshore,
 * exactly as Expedition behaves along a Newport–Bermuda track. That makes
 * enabling a source a checkbox rather than a rebuild, and it makes "which model
 * said that?" a free feature rather than an afterthought.
 *
 * Every accessor returns null where nothing covers the point. Never zero.
 */

import type {
  BBox,
  Degrees,
  Knots,
  Millis,
  WaveState,
  WeatherCube,
  WeatherField,
  WindSample,
} from '../types'
import {
  cubeCoverage,
  sampleCube,
  sampleCubeDirection,
  uvFromCurrent,
  uvFromWind,
  windFromUv,
} from './cube'

/** A field backed by one decoded cube. The normal case. */
export class CubeField implements WeatherField {
  readonly cube: WeatherCube
  readonly label: string

  constructor(cube: WeatherCube, label?: string) {
    this.cube = cube
    this.label = label ?? cube.model
  }

  wind(lat: number, lon: number, t: Millis): WindSample | null {
    const u = sampleCube(this.cube, 'u10', lat, lon, t)
    if (u === null) return null
    const v = sampleCube(this.cube, 'v10', lat, lon, t)
    if (v === null) return null
    return { u, v, source: this.label }
  }

  gust(lat: number, lon: number, t: Millis): Knots | null {
    return sampleCube(this.cube, 'gust', lat, lon, t)
  }

  current(lat: number, lon: number, t: Millis): WindSample | null {
    const u = sampleCube(this.cube, 'uo', lat, lon, t)
    if (u === null) return null
    const v = sampleCube(this.cube, 'vo', lat, lon, t)
    if (v === null) return null
    return { u, v, source: this.label }
  }

  waves(lat: number, lon: number, t: Millis): WaveState | null {
    const h = sampleCube(this.cube, 'hs', lat, lon, t)
    if (h === null) return null
    // Height and period interpolate linearly; direction must not. See
    // cube.ts `sampleCubeDirection`.
    const dir = sampleCubeDirection(this.cube, 'wdir', lat, lon, t)
    if (dir === null) return null
    const per = sampleCube(this.cube, 'wper', lat, lon, t)
    // A height with no direction or period would be a fabricated sea state,
    // and the wave polar correction would happily use it.
    if (per === null) return null
    return { heightM: h, directionDeg: dir, periodS: per }
  }

  coverage(): { bbox: BBox; t0: Millis; t1: Millis } {
    return cubeCoverage(this.cube)
  }
}

/**
 * Priority-resolved stack: the first provider that covers the point wins, and
 * its own `source` label comes back with the value.
 *
 * Resolution is per-parameter, not per-provider, which is the behaviour that
 * matters: a tidal-stream source with no wind in it can sit at the top of the
 * stack and override current only.
 */
export class StackedField implements WeatherField {
  readonly providers: WeatherField[]

  constructor(providers: WeatherField[]) {
    this.providers = providers
  }

  wind(lat: number, lon: number, t: Millis): WindSample | null {
    for (const p of this.providers) {
      const s = p.wind(lat, lon, t)
      if (s) return s
    }
    return null
  }

  gust(lat: number, lon: number, t: Millis): Knots | null {
    for (const p of this.providers) {
      const g = p.gust(lat, lon, t)
      if (g !== null) return g
    }
    return null
  }

  current(lat: number, lon: number, t: Millis): WindSample | null {
    for (const p of this.providers) {
      const s = p.current(lat, lon, t)
      if (s) return s
    }
    return null
  }

  waves(lat: number, lon: number, t: Millis): WaveState | null {
    for (const p of this.providers) {
      const w = p.waves(lat, lon, t)
      if (w) return w
    }
    return null
  }

  /** Union of the members' coverage. An empty stack reports an empty box. */
  coverage(): { bbox: BBox; t0: Millis; t1: Millis } {
    if (this.providers.length === 0) {
      // Deliberately inverted, i.e. "contains nothing", and t1 < t0 to match.
      return { bbox: { west: 180, south: 90, east: -180, north: -90 }, t0: 0, t1: -1 }
    }
    let { bbox, t0, t1 } = this.providers[0].coverage()
    bbox = { ...bbox }
    for (let i = 1; i < this.providers.length; i++) {
      const c = this.providers[i].coverage()
      bbox.west = Math.min(bbox.west, c.bbox.west)
      bbox.south = Math.min(bbox.south, c.bbox.south)
      bbox.east = Math.max(bbox.east, c.bbox.east)
      bbox.north = Math.max(bbox.north, c.bbox.north)
      t0 = Math.min(t0, c.t0)
      t1 = Math.max(t1, c.t1)
    }
    return { bbox, t0, t1 }
  }
}

export interface ConstantFieldOptions {
  twd: Degrees
  tws: Knots
  /** Direction the current flows TOWARDS, degrees true. */
  set?: Degrees
  /** Current speed, knots. */
  drift?: Knots
}

/**
 * A uniform, unchanging field. Two real uses: deterministic tests, and the
 * "what-if" manual wind a tactician dials in when the forecast is plainly
 * wrong — which, per how-it-computes.md §3, sits at the TOP of the stack.
 */
export class ConstantField implements WeatherField {
  readonly label: string
  private readonly uv: { u: Knots; v: Knots }
  private readonly speed: Knots
  private readonly cur: { u: Knots; v: Knots } | null

  constructor(opts: ConstantFieldOptions, label = 'manual') {
    this.label = label
    this.uv = uvFromWind(opts.tws, opts.twd)
    this.speed = opts.tws
    this.cur =
      typeof opts.drift === 'number' ? uvFromCurrent(opts.drift, opts.set ?? 0) : null
  }

  wind(_lat: number, _lon: number, _t: Millis): WindSample | null {
    return { u: this.uv.u, v: this.uv.v, source: this.label }
  }

  /**
   * A constant field has no gust structure, so gusts equal the mean. Returning
   * null instead would quietly disable the max-gust routing constraint, which
   * is a worse failure than reporting no gust factor.
   */
  gust(_lat: number, _lon: number, _t: Millis): Knots | null {
    return this.speed
  }

  current(_lat: number, _lon: number, _t: Millis): WindSample | null {
    return this.cur ? { u: this.cur.u, v: this.cur.v, source: this.label } : null
  }

  waves(_lat: number, _lon: number, _t: Millis): WaveState | null {
    return null
  }

  coverage(): { bbox: BBox; t0: Millis; t1: Millis } {
    // Everywhere, always — the full JS Date range.
    return { bbox: { west: -180, south: -90, east: 180, north: 90 }, t0: -8.64e15, t1: 8.64e15 }
  }
}

export interface FieldScalings {
  /** 100 = leave wind speed alone. */
  windScalePct: number
  /** Added to the direction the wind comes from, degrees. */
  windRotateDeg: Degrees
  /** POSITIVE = the weather is running LATE, so use an EARLIER field. */
  windTimeShiftS: number
  /** 100 = leave current alone. */
  currentScalePct: number
}

const IDENTITY_EPS = 1e-9

/**
 * Routing what-if decorator: scale, rotate and time-shift any field.
 *
 * Time-shift semantics follow Expedition exactly
 * (docs/01-expedition-analysis/feature-inventory.md §4.3):
 *
 *   "+60 minutes -> use the 17z field at 18z"
 *
 * so a POSITIVE shift samples the inner field EARLIER: `inner(t - shift)`.
 * The mental model is "the weather is running an hour late", which is how a
 * navigator states the observation. The sign is easy to invert and impossible
 * to notice, hence the unit test.
 *
 * Only wind is shifted — Expedition's control is a *wind* time shift, and
 * dragging currents (tidal, phase-locked to the moon) along with it would be
 * wrong. Waves pass through untouched for the same reason.
 */
export class ScaledField implements WeatherField {
  private readonly inner: WeatherField
  private readonly windScale: number
  private readonly rotCos: number
  private readonly rotSin: number
  private readonly shiftMs: number
  private readonly currentScale: number
  private readonly identity: boolean

  constructor(inner: WeatherField, s: FieldScalings) {
    this.inner = inner
    this.windScale = s.windScalePct / 100
    const r = (s.windRotateDeg * Math.PI) / 180
    this.rotCos = Math.cos(r)
    this.rotSin = Math.sin(r)
    this.shiftMs = s.windTimeShiftS * 1000
    this.currentScale = s.currentScalePct / 100
    this.identity =
      Math.abs(this.windScale - 1) < IDENTITY_EPS &&
      Math.abs(s.windRotateDeg) < IDENTITY_EPS &&
      Math.abs(this.shiftMs) < IDENTITY_EPS &&
      Math.abs(this.currentScale - 1) < IDENTITY_EPS
  }

  /** Provenance must survive the decorator, but must not pretend to be raw model output. */
  private tag(source: string): string {
    return this.identity ? source : `${source} (adjusted)`
  }

  /**
   * Rotate a vector clockwise in compass terms. Because a wind's u/v points
   * 180° from the direction it comes from, rotating the FROM-direction by θ
   * rotates the vector by the same θ — the formula is shared.
   */
  private rotate(u: Knots, v: Knots, scale: number): { u: Knots; v: Knots } {
    return {
      u: (u * this.rotCos + v * this.rotSin) * scale,
      v: (-u * this.rotSin + v * this.rotCos) * scale,
    }
  }

  wind(lat: number, lon: number, t: Millis): WindSample | null {
    const s = this.inner.wind(lat, lon, t - this.shiftMs)
    if (!s) return null
    const r = this.rotate(s.u, s.v, this.windScale)
    return { u: r.u, v: r.v, source: this.tag(s.source) }
  }

  gust(lat: number, lon: number, t: Millis): Knots | null {
    const g = this.inner.gust(lat, lon, t - this.shiftMs)
    return g === null ? null : g * this.windScale
  }

  current(lat: number, lon: number, t: Millis): WindSample | null {
    const s = this.inner.current(lat, lon, t)
    if (!s) return null
    return { u: s.u * this.currentScale, v: s.v * this.currentScale, source: this.tag(s.source) }
  }

  waves(lat: number, lon: number, t: Millis): WaveState | null {
    return this.inner.waves(lat, lon, t)
  }

  coverage(): { bbox: BBox; t0: Millis; t1: Millis } {
    const c = this.inner.coverage()
    // Sampling at t - shift means the queryable window moves the other way.
    return { bbox: c.bbox, t0: c.t0 + this.shiftMs, t1: c.t1 + this.shiftMs }
  }
}

// ------------------------------------------------------------------ helpers

/** True wind direction and speed at a point, or null. Convenience for the UI. */
export function twdTws(
  field: WeatherField,
  lat: number,
  lon: number,
  t: Millis,
): { twd: Degrees; tws: Knots; source: string } | null {
  const s = field.wind(lat, lon, t)
  if (!s) return null
  const w = windFromUv(s.u, s.v)
  return { twd: w.dir, tws: w.speed, source: s.source }
}
