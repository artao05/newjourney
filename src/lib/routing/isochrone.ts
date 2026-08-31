/**
 * The isochrone weather-routing kernel.
 *
 * Implements docs/03-algorithms/routing-isochrone.md end to end:
 *   §2  frontier expansion loop
 *   §3  heading fan, VMG-angle injection, implicit tacking
 *   §4  spatial-bucket pruning keyed on (cell, tack)
 *   §5  automatic time-step selection
 *   §6  segment-based obstacle tests
 *   §7  multi-leg routing through marks
 *   §8  the backward pass and the forward/backward sensitivity decomposition
 *   §9  the typed-array performance rules
 *
 * Written from that document and the published literature (Hagiwara 1989 and
 * the "modified isochrone" successors) alone — see
 * docs/02-data-sources/licensing-matrix.md §5. No GPL routing source was read.
 *
 * The kernel is a pure function of its inputs: no I/O, no globals that survive
 * a call. That is what lets it run unchanged in a Web Worker, under vitest in
 * Node, or on a server.
 *
 * Why so much of this file is flat typed arrays and hand-inlined trigonometry:
 * §9 budgets 1.7 M candidate evaluations for a 60 nm coastal problem and 7 M
 * offshore, against a 1 s / 10 s wall on a phone. An array of node objects with
 * a `{lat, lon}` allocation per candidate misses that by an order of magnitude.
 * Everything cold — setup, reconstruction, diagnostics — uses the shared
 * helpers in `../geo` and `../angles` normally.
 */

import {
  DEG,
  RAD,
  angdiff,
  angsep,
  clamp,
  clampUnit,
  courseFor,
  manoeuvre,
  tackOf,
  twaFrom,
  wrap180,
  wrap360,
} from '../angles'
import {
  LocalFrame,
  R_NM,
  bboxOf,
  bearing,
  destination,
  distance,
  fromPolar,
  lonSpan,
  vecAdd,
  vecBearing,
} from '../geo'
import type {
  BBox,
  Isochrone,
  LatLon,
  Millis,
  PolarLattice,
  RouteConstraints,
  RouteLeg,
  RouteRequest,
  RouteResolution,
  RouteResult,
  RouteScalings,
  SensitivityField,
  WeatherField,
} from '../types'
import { NULL_LAND_MASK, type LandMask } from './land'

// ------------------------------------------------------------------ context

export interface RouteContext {
  field: WeatherField
  lattice: PolarLattice
  land?: LandMask | null
  /**
   * Optional 0..1 progress tap. Additive to the brief's interface; the worker
   * uses it to post `{type:'progress'}` without the kernel needing to know that
   * `postMessage` exists.
   */
  onProgress?: (fraction: number) => void
}

// ---------------------------------------------------------------- constants

/** Degrees of latitude per nautical mile — the exact inverse of `R_NM`. */
const DEG_PER_NM = RAD / R_NM
const MS_PER_HOUR = 3_600_000
const MAX_STEP_S = 21_600
/** Cosine floor for the local longitude scaling; keeps the poles finite. */
const MIN_COS_LAT = 0.02
/** Extra steps run after the first finish candidate, hunting a cheaper one. */
const FINISH_GRACE_STEPS = 2
/** Steps at full cone width without closing on the mark before we give up. */
const MAX_STALLED_STEPS = 40
const MAX_ISOCHRONES = 120
const MAX_ISOCHRONE_POINTS = 240

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

// -------------------------------------------------------------------- solar
//
// Day/night for the night-polar factor. docs/03-algorithms/navigation-math.md §9
// asks for the NOAA solar-position algorithm with civil twilight at −6°, which
// is the threshold Expedition uses to switch the night polar. This is the
// low-precision form — good to ~0.01°, far inside what a −6° test needs — so it
// stays a dozen flops rather than becoming a dependency.

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

// ------------------------------------------------------- pre-hydrated fields
//
// §9.2: "Pre-hydrate the wind/current fields into a dense local grid over the
// route bbox before starting. Never call a provider inside the loop." The
// provider interface is allowed to be arbitrarily slow — a StackedField walks
// providers in precedence order and allocates a `{u, v, source}` per call — so
// we pay for it once per grid cell rather than once per node per step.

const P_U = 0
const P_V = 1
const P_GUST = 2
const P_WAVE = 3
const P_CU = 4
const P_CV = 5
const P_COUNT = 6

class DenseField {
  readonly lon0: number
  readonly lat0: number
  readonly dLon: number
  readonly dLat: number
  readonly nx: number
  readonly ny: number
  readonly nt: number
  readonly t0: Millis
  readonly dtMs: number
  readonly u: Float32Array
  readonly v: Float32Array
  readonly gust: Float32Array
  readonly wave: Float32Array
  readonly cu: Float32Array
  readonly cv: Float32Array
  hasGust = false
  hasCurrent = false
  hasWaves = false

  constructor(bbox: BBox, nx: number, ny: number, nt: number, t0: Millis, dtMs: number) {
    this.nx = nx
    this.ny = ny
    this.nt = nt
    this.t0 = t0
    this.dtMs = dtMs
    this.lon0 = bbox.west
    this.lat0 = bbox.south
    this.dLon = nx > 1 ? lonSpan(bbox.west, bbox.east) / (nx - 1) : 1
    this.dLat = ny > 1 ? (bbox.north - bbox.south) / (ny - 1) : 1
    const n = nx * ny * nt
    this.u = new Float32Array(n)
    this.v = new Float32Array(n)
    this.gust = new Float32Array(n)
    this.wave = new Float32Array(n)
    this.cu = new Float32Array(n)
    this.cv = new Float32Array(n)
  }

  /**
   * Trilinear sample into `out[P_*]`. Called once per frontier node per step —
   * never per heading, exactly as the §2 pseudo-code hoists `wind(node.p, t)`
   * out of the heading loop.
   */
  sample(lat: number, lon: number, t: Millis, out: Float64Array): void {
    const nx = this.nx
    const ny = this.ny
    const nt = this.nt
    let fx = wrap180(lon - this.lon0) / this.dLon
    let fy = (lat - this.lat0) / this.dLat
    let ft = nt > 1 ? (t - this.t0) / this.dtMs : 0
    fx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx
    fy = fy < 0 ? 0 : fy > ny - 1 ? ny - 1 : fy
    ft = ft < 0 ? 0 : ft > nt - 1 ? nt - 1 : ft
    let ix = fx | 0
    let iy = fy | 0
    let it = ft | 0
    if (ix > nx - 2) ix = nx > 1 ? nx - 2 : 0
    if (iy > ny - 2) iy = ny > 1 ? ny - 2 : 0
    if (it > nt - 2) it = nt > 1 ? nt - 2 : 0
    const gx = nx > 1 ? fx - ix : 0
    const gy = ny > 1 ? fy - iy : 0
    const gt = nt > 1 ? ft - it : 0
    const plane = nx * ny
    const b0 = it * plane + iy * nx + ix
    const b1 = nt > 1 ? b0 + plane : b0
    const sx = nx > 1 ? 1 : 0
    const sy = ny > 1 ? nx : 0
    const w00 = (1 - gx) * (1 - gy)
    const w10 = gx * (1 - gy)
    const w01 = (1 - gx) * gy
    const w11 = gx * gy
    const a = 1 - gt
    out[P_U] = a * bi(this.u, b0, sx, sy, w00, w10, w01, w11) + gt * bi(this.u, b1, sx, sy, w00, w10, w01, w11)
    out[P_V] = a * bi(this.v, b0, sx, sy, w00, w10, w01, w11) + gt * bi(this.v, b1, sx, sy, w00, w10, w01, w11)
    out[P_GUST] = a * bi(this.gust, b0, sx, sy, w00, w10, w01, w11) + gt * bi(this.gust, b1, sx, sy, w00, w10, w01, w11)
    out[P_WAVE] = a * bi(this.wave, b0, sx, sy, w00, w10, w01, w11) + gt * bi(this.wave, b1, sx, sy, w00, w10, w01, w11)
    out[P_CU] = a * bi(this.cu, b0, sx, sy, w00, w10, w01, w11) + gt * bi(this.cu, b1, sx, sy, w00, w10, w01, w11)
    out[P_CV] = a * bi(this.cv, b0, sx, sy, w00, w10, w01, w11) + gt * bi(this.cv, b1, sx, sy, w00, w10, w01, w11)
  }
}

function bi(
  src: Float32Array,
  b: number,
  sx: number,
  sy: number,
  w00: number,
  w10: number,
  w01: number,
  w11: number,
): number {
  return src[b] * w00 + src[b + sx] * w10 + src[b + sy] * w01 + src[b + sx + sy] * w11
}

/**
 * Grid dimensions chosen against a sample budget, respecting the bbox aspect.
 *
 * Also floored at `MIN_CELL_DEG`: no marine forecast resolves finer than about
 * a hundredth of a degree, so resampling one onto a finer grid buys nothing but
 * provider calls and memory. That floor is what keeps a two-mile buoy leg from
 * hydrating the same number of cells as an ocean crossing.
 */
const MIN_CELL_DEG = 0.01

function gridDims(bbox: BBox, budget: number, nt: number): { nx: number; ny: number } {
  const midLat = (bbox.north + bbox.south) / 2
  const spanLonDeg = Math.max(1e-6, lonSpan(bbox.west, bbox.east))
  const spanLatDeg = Math.max(1e-6, bbox.north - bbox.south)
  const spanLon = spanLonDeg * Math.max(0.05, Math.cos(midLat * DEG))
  const perSlice = Math.max(64, Math.floor(budget / Math.max(1, nt)))
  const aspect = spanLon / spanLatDeg
  const capX = Math.ceil(spanLonDeg / MIN_CELL_DEG) + 1
  const capY = Math.ceil(spanLatDeg / MIN_CELL_DEG) + 1
  return {
    nx: Math.round(clamp(Math.round(Math.sqrt(perSlice * aspect)), 4, Math.min(96, capX))),
    ny: Math.round(clamp(Math.round(Math.sqrt(perSlice / aspect)), 4, Math.min(96, capY))),
  }
}

interface HydrateResult {
  field: DenseField | null
  error?: string
}

function hydrate(
  src: WeatherField,
  bbox: BBox,
  t0: Millis,
  horizonMs: number,
  budget: number,
  scalings: RouteScalings,
  warnings: string[],
): HydrateResult {
  let cov: { bbox: BBox; t0: Millis; t1: Millis }
  try {
    cov = src.coverage()
  } catch {
    return { field: null, error: 'the weather field would not report its coverage' }
  }

  // Never hydrate past the forecast: beyond `cov.t1` every sample is the same
  // clamped slice, so spending grid rows there just coarsens the part that has
  // real data. Nodes that run past the end read the extended edge and we warn.
  const wanted = t0 + horizonMs
  const t1 = Math.max(t0 + 2 * MS_PER_HOUR, Math.min(wanted, cov.t1))
  const spanMs = Math.max(60_000, t1 - t0)
  const nt = Math.round(clamp(Math.ceil(spanMs / MS_PER_HOUR) + 1, 2, 64))
  const dtMs = spanMs / (nt - 1)
  const { nx, ny } = gridDims(bbox, budget, nt)
  const out = new DenseField(bbox, nx, ny, nt, t0, dtMs)

  // Scalings are applied once, here, rather than per sample in the inner loop.
  // `windTimeShiftS > 0` means "the forecast happens this much later", so at
  // clock time t we read the field from t − shift.
  const windScale = scalings.windScalePct / 100
  const curScale = scalings.currentScalePct / 100
  const rot = scalings.windRotateDeg * DEG
  const cosR = Math.cos(rot)
  const sinR = Math.sin(rot)
  const shiftMs = scalings.windTimeShiftS * 1000

  const canClampLon = cov.bbox.east >= cov.bbox.west
  let clampedTime = wanted > cov.t1
  let clampedSpace = false
  let missing = 0
  let present = 0
  const valid = new Uint8Array(nx * ny * nt)

  // Probe before hydrating: gust, current and wave layers are frequently
  // absent, and three quarters of the provider calls are pure waste when so.
  const probeT = clamp((t0 + t1) / 2, cov.t0, cov.t1)
  let anyGust = false
  let anyCurrent = false
  let anyWaves = false
  const probes: Array<[number, number]> = [
    [(bbox.north + bbox.south) / 2, (bbox.east + bbox.west) / 2],
    [bbox.south, bbox.west],
    [bbox.north, bbox.east],
  ]
  for (const [pl, pn] of probes) {
    const la = clamp(pl, cov.bbox.south, cov.bbox.north)
    const lo = canClampLon ? clamp(pn, cov.bbox.west, cov.bbox.east) : pn
    try {
      if (src.gust(la, lo, probeT) != null) anyGust = true
      if (src.current(la, lo, probeT) != null) anyCurrent = true
      if (src.waves(la, lo, probeT) != null) anyWaves = true
    } catch {
      /* a provider that throws is treated as absent */
    }
  }
  out.hasGust = anyGust
  out.hasCurrent = anyCurrent
  out.hasWaves = anyWaves

  const plane = nx * ny
  for (let k = 0; k < nt; k++) {
    const tBase = t0 + k * dtMs
    const tWant = tBase - shiftMs
    const tq = clamp(tWant, cov.t0, cov.t1)
    const tNoShift = clamp(tBase, cov.t0, cov.t1)
    if (tq !== tWant) clampedTime = true
    for (let j = 0; j < ny; j++) {
      const lat = out.lat0 + j * out.dLat
      const latq = clamp(lat, cov.bbox.south, cov.bbox.north)
      if (latq !== lat) clampedSpace = true
      for (let i = 0; i < nx; i++) {
        const lon = wrap180(out.lon0 + i * out.dLon)
        const lonq = canClampLon ? clamp(lon, cov.bbox.west, cov.bbox.east) : lon
        if (lonq !== lon) clampedSpace = true
        const idx = k * plane + j * nx + i
        let w: { u: number; v: number } | null
        try {
          w = src.wind(latq, lonq, tq)
        } catch {
          w = null
        }
        if (w == null) {
          missing++
          continue
        }
        present++
        valid[idx] = 1
        const u = w.u * windScale
        const v = w.v * windScale
        // Rotating the wind vector clockwise rotates the reported TWD the same
        // way, which is what "rotate the forecast by N degrees" has to mean.
        out.u[idx] = u * cosR + v * sinR
        out.v[idx] = -u * sinR + v * cosR
        if (anyGust) {
          const g = src.gust(latq, lonq, tq)
          if (g != null) out.gust[idx] = g * windScale
        }
        if (anyCurrent) {
          const c = src.current(latq, lonq, tNoShift)
          if (c != null) {
            out.cu[idx] = c.u * curScale
            out.cv[idx] = c.v * curScale
          }
        }
        if (anyWaves) {
          const wv = src.waves(latq, lonq, tNoShift)
          if (wv != null) out.wave[idx] = wv.heightM
        }
      }
    }
  }

  if (present === 0) {
    return {
      field: null,
      error:
        'no wind data covers the route area or start time — load a forecast that spans the course',
    }
  }
  if (clampedTime) warnings.push('forecast ran out, extended last field in time')
  if (clampedSpace) {
    warnings.push('route area reaches outside the forecast box, extended edge values')
  }
  if (missing > 0) {
    warnings.push(
      `${((100 * missing) / (missing + present)).toFixed(0)}% of the hydrated grid had no wind, filled from neighbours`,
    )
    fillGaps(out, valid)
  }
  return { field: out }
}

/**
 * Nearest-neighbour dilation over the hydrated cube.
 *
 * A hole in the forecast must never read as flat calm — the technical spec is
 * explicit that a silent zero is the failure mode that puts a boat somewhere it
 * did not plan to be. We propagate the nearest real observation outward and
 * warn, rather than leaving zeros behind for the router to exploit.
 */
function fillGaps(f: DenseField, valid: Uint8Array): void {
  const { nx, ny, nt } = f
  const plane = nx * ny
  const total = plane * nt
  const arrays = [f.u, f.v, f.gust, f.wave, f.cu, f.cv]
  const next = new Uint8Array(valid)
  for (let pass = 0; pass < 96; pass++) {
    let filled = 0
    for (let idx = 0; idx < total; idx++) {
      if (valid[idx] === 1) continue
      const it = (idx / plane) | 0
      const rem = idx - it * plane
      const iy = (rem / nx) | 0
      const ix = rem - iy * nx
      let src = -1
      if (ix > 0 && valid[idx - 1] === 1) src = idx - 1
      else if (ix < nx - 1 && valid[idx + 1] === 1) src = idx + 1
      else if (iy > 0 && valid[idx - nx] === 1) src = idx - nx
      else if (iy < ny - 1 && valid[idx + nx] === 1) src = idx + nx
      else if (it > 0 && valid[idx - plane] === 1) src = idx - plane
      else if (it < nt - 1 && valid[idx + plane] === 1) src = idx + plane
      if (src < 0) continue
      for (const a of arrays) a[idx] = a[src]
      next[idx] = 1
      filled++
    }
    if (filled === 0) break
    valid.set(next)
  }
}

// ------------------------------------------------------------------ presets

interface Preset {
  fanStepDeg: number
  targetSteps: number
  minStepS: number
  hydrationBudget: number
  maxNodes: number
  /**
   * Frontier budget. §4.2 calls bucket resolution "the critical tuning knob" —
   * too coarse merges the left and right side of the course, too fine and the
   * frontier explodes. The doc gives the size (one step of travel over 3–5);
   * this is the other end of the same trade-off, the point past which we take
   * the coarser bucket rather than the longer run.
   */
  maxFrontier: number
}

const PRESETS: Record<RouteResolution, Preset> = {
  fast: {
    fanStepDeg: 12,
    targetSteps: 30,
    minStepS: 300,
    hydrationBudget: 80_000,
    maxNodes: 400_000,
    maxFrontier: 1200,
  },
  balanced: {
    fanStepDeg: 8,
    targetSteps: 50,
    minStepS: 120,
    hydrationBudget: 200_000,
    maxNodes: 1_200_000,
    maxFrontier: 2000,
  },
  best: {
    fanStepDeg: 5,
    targetSteps: 75,
    minStepS: 60,
    hydrationBudget: 400_000,
    maxNodes: 3_000_000,
    maxFrontier: 3000,
  },
}

/**
 * §5 leg-length table, seconds, as [best, balanced, fast].
 *
 *   < 20 nm   buoy racing / harbour   1–5 min
 *   20–100    coastal                 10–30 min
 *   100–500   overnight               1 h
 *   500–3000  offshore                3 h
 *   > 3000    transocean              3–6 h
 */
function baseStepS(nm: number, res: RouteResolution): number {
  const row =
    nm < 20
      ? [60, 180, 300]
      : nm < 100
        ? [600, 1200, 1800]
        : nm < 500
          ? [1800, 3600, 3600]
          : nm < 3000
            ? [3600, 7200, 10_800]
            : [10_800, 14_400, 21_600]
  return res === 'best' ? row[0] : res === 'balanced' ? row[1] : row[2]
}

/**
 * §5 time-step selection.
 *
 *   Δt = clamp(min(grib_step, leg / speed / target_steps, max_step),
 *              min_isochrone_resolution, max_step)
 *
 * The cadence comes from `WeatherField.dtMs`, which is optional: a field with no
 * regular step (constant, station interpolation) declares none and the leg table
 * decides alone. Stepping past the forecast cadence is how a router sails through
 * a front and never notices.
 *
 * This clamp was dead for its first two commits. `dtMs` was read off the field
 * through a cast rather than being part of the interface, no implementation
 * actually had the property, and the only test that covered it bolted one on by
 * hand — so it passed while the production path always fell through to the leg
 * table. Duck-typing across a module boundary is exactly how that hides: nothing
 * fails, the feature simply never happens.
 *
 * The floor matters as much as the ceiling: §4.2 explains that too fine a step
 * against a fixed bucket makes every branch land in the same bucket, distinct
 * tactical options merge, and the search degenerates. Ours scales the bucket
 * with the step, but the preset floor is still the documented safety net.
 */
function chooseTimeStepS(
  legNm: number,
  typicalSpeed: number,
  res: RouteResolution,
  gribStepS: number | null,
): number {
  const preset = PRESETS[res]
  let dt = baseStepS(legNm, res)
  const byCount = ((legNm / Math.max(0.25, typicalSpeed)) * 3600) / preset.targetSteps
  if (byCount < dt) dt = byCount
  if (gribStepS != null && gribStepS > 0 && gribStepS < dt) dt = gribStepS
  return clamp(dt, preset.minStepS, MAX_STEP_S)
}

function gribStepOf(field: WeatherField): number | null {
  const dt = field.dtMs
  return typeof dt === 'number' && dt > 0 ? dt / 1000 : null
}

// ------------------------------------------------------- sensitivity capture

interface Recorder {
  lon0: number
  lat0: number
  dLon: number
  dLat: number
  nx: number
  ny: number
  values: Float64Array
  keepMax: boolean
}

function makeRecorder(bbox: BBox, keepMax: boolean): Recorder {
  const midLat = (bbox.north + bbox.south) / 2
  const aspect = Math.max(
    0.05,
    (lonSpan(bbox.west, bbox.east) * Math.cos(midLat * DEG)) /
      Math.max(1e-6, bbox.north - bbox.south),
  )
  const nx = Math.round(clamp(Math.round(96 * Math.sqrt(aspect)), 16, 192))
  const ny = Math.round(clamp(Math.round(96 / Math.sqrt(aspect)), 16, 192))
  const values = new Float64Array(nx * ny)
  values.fill(keepMax ? -Infinity : Infinity)
  return {
    lon0: bbox.west,
    lat0: bbox.south,
    dLon: lonSpan(bbox.west, bbox.east) / nx,
    dLat: (bbox.north - bbox.south) / ny,
    nx,
    ny,
    values,
    keepMax,
  }
}

function record(r: Recorder, lat: number, lon: number, t: Millis): void {
  const ix = Math.floor(wrap180(lon - r.lon0) / r.dLon)
  if (ix < 0 || ix >= r.nx) return
  const iy = Math.floor((lat - r.lat0) / r.dLat)
  if (iy < 0 || iy >= r.ny) return
  const k = iy * r.nx + ix
  const cur = r.values[k]
  if (r.keepMax ? t > cur : t < cur) r.values[k] = t
}

// -------------------------------------------------------------- node storage
//
// §9.1. Parallel columns, not an array of objects. `pool` persists so the route
// can be reconstructed by walking `parent`; `cand` is a scratch buffer reused
// every step, because only the pruning survivors are worth keeping — otherwise
// a 200-step offshore route would retain 14 M candidate states instead of 400 k.

class NodeStore {
  n = 0
  cap = 0
  lat: Float64Array = new Float64Array(0)
  lon: Float64Array = new Float64Array(0)
  t: Float64Array = new Float64Array(0)
  parent: Int32Array = new Int32Array(0)
  tack: Int8Array = new Int8Array(0)
  twa: Float32Array = new Float32Array(0)
  hdg: Float32Array = new Float32Array(0)
  bsp: Float32Array = new Float32Array(0)
  twd: Float32Array = new Float32Array(0)
  tws: Float32Array = new Float32Array(0)
  beat: Uint8Array = new Uint8Array(0)
  curU: Float32Array = new Float32Array(0)
  curV: Float32Array = new Float32Array(0)
  dist: Float32Array = new Float32Array(0)

  /** Grow to hold `need` entries, preserving the first `this.n`. */
  ensure(need: number): void {
    if (need <= this.cap) return
    let cap = this.cap === 0 ? 8192 : this.cap
    while (cap < need) cap *= 2
    const keep = this.n
    this.lat = growF64(this.lat, cap, keep)
    this.lon = growF64(this.lon, cap, keep)
    this.t = growF64(this.t, cap, keep)
    this.parent = growI32(this.parent, cap, keep)
    this.tack = growI8(this.tack, cap, keep)
    this.twa = growF32(this.twa, cap, keep)
    this.hdg = growF32(this.hdg, cap, keep)
    this.bsp = growF32(this.bsp, cap, keep)
    this.twd = growF32(this.twd, cap, keep)
    this.tws = growF32(this.tws, cap, keep)
    this.beat = growU8(this.beat, cap, keep)
    this.curU = growF32(this.curU, cap, keep)
    this.curV = growF32(this.curV, cap, keep)
    this.dist = growF32(this.dist, cap, keep)
    this.cap = cap
  }
}

function growF64(a: Float64Array, cap: number, keep: number): Float64Array {
  const b = new Float64Array(cap)
  b.set(a.subarray(0, keep))
  return b
}
function growF32(a: Float32Array, cap: number, keep: number): Float32Array {
  const b = new Float32Array(cap)
  b.set(a.subarray(0, keep))
  return b
}
function growI32(a: Int32Array, cap: number, keep: number): Int32Array {
  const b = new Int32Array(cap)
  b.set(a.subarray(0, keep))
  return b
}
function growI8(a: Int8Array, cap: number, keep: number): Int8Array {
  const b = new Int8Array(cap)
  b.set(a.subarray(0, keep))
  return b
}
function growU8(a: Uint8Array, cap: number, keep: number): Uint8Array {
  const b = new Uint8Array(cap)
  b.set(a.subarray(0, keep))
  return b
}

// ---------------------------------------------------------------- the search

interface SearchOpts {
  field: DenseField
  lattice: PolarLattice
  land: LandMask | null
  constraints: RouteConstraints
  scalings: RouteScalings
  preset: Preset
}

interface PassInput {
  origin: LatLon
  goal: LatLon
  /** Clock at `origin`: departure time forward, arrival time backward. */
  t0: Millis
  dtMs: number
  /** +1 expands forward from the start, −1 backward from the finish. */
  dir: 1 | -1
  maxSteps: number
  typicalSpeed: number
  recorder: Recorder | null
  onProgress: ((f: number) => void) | null
  progressBase: number
  progressSpan: number
  /**
   * Tack state and TWA carried from the previous leg's finish node so the
   * mark-rounding tack/gybe penalty fires at the first step of the new leg.
   * Left at zero for the first leg (no prior tack) and for the backward pass
   * (memoryless by §8).
   */
  initialTack?: number
  initialTwa?: number
}

interface PassOutput {
  reached: boolean
  /** Pool index of the arrival node, or −1. */
  finishNode: number
  finishT: Millis
  isochrones: Isochrone[]
  evaluated: number
  stopped: string | null
}

/**
 * One instance runs every pass of one route, forward and backward, so the
 * backward pass provably uses the same machinery. That is the entire basis of
 * the §10.5 forward/backward consistency check — if the two passes were
 * separate code they could agree by accident and disagree in production.
 */
class Search {
  readonly pool = new NodeStore()
  private readonly cand = new NodeStore()
  private readonly f: DenseField
  private readonly lattice: PolarLattice
  private readonly land: LandMask | null
  private readonly maxTws: number
  private readonly minTws: number
  private readonly maxGust: number
  private readonly maxWave: number
  private readonly tackPen: number
  private readonly gybePen: number
  private readonly polarDay: number
  private readonly polarNight: number
  private readonly fanStep: number
  private readonly maxNodes: number
  private readonly maxFrontier: number

  // Scratch — allocated once, mutated forever. No garbage in the inner loop.
  private readonly s = new Float64Array(P_COUNT)
  private readonly pa: LatLon = { lat: 0, lon: 0 }
  private readonly pb: LatLon = { lat: 0, lon: 0 }
  private readonly fanHdg = new Float64Array(128)
  private readonly fanSin = new Float64Array(128)
  private readonly fanCos = new Float64Array(128)
  private fanN = 0

  // Cached upwind/downwind targets, bucketed at 0.25 kn. `targetsAt` is an
  // external call that may allocate, and the frontier hits the same handful of
  // wind speeds thousands of times per step.
  private readonly tgUpTwa = new Float64Array(321)
  private readonly tgUpVmg = new Float64Array(321)
  private readonly tgDnTwa = new Float64Array(321)
  private readonly tgDnVmg = new Float64Array(321)
  private readonly tgReady = new Uint8Array(321)

  // Open-addressed (cell, tack) label table for §4.2 pruning.
  //
  // It persists for a whole pass, not a step, because §4.2 is explicit that
  // this is "closer to a Dijkstra label-setting relaxation". Bucketing only
  // within a step does not dominate anything: each step's candidates span a
  // radial band one step thick, so the surviving set thickens by a step every
  // step and the frontier degenerates from a curve into a filled disc — the
  // exponential blow-up the section exists to prevent, wearing a disguise.
  // Keeping the earliest arrival *ever seen* per bucket keeps the frontier the
  // one-step-thick shell it is supposed to be.
  private tKey: Int32Array = new Int32Array(0)
  private tScore: Float64Array = new Float64Array(0)
  private tStamp: Int32Array = new Int32Array(0)
  private tStep: Int32Array = new Int32Array(0)
  private tCand: Int32Array = new Int32Array(0)
  private tMask = -1
  private tLive = 0
  private passStamp = 0
  private touched: Int32Array = new Int32Array(4096)
  private touchedN = 0

  private frontier: Int32Array = new Int32Array(4096)
  private frontierN = 0

  private effBsp = 0
  private effBeat = 0
  private hopClosing = 0
  private hopTwa = 0
  private hopHdg = 0
  private hopBsp = 0
  private hopBeat = 0

  constructor(o: SearchOpts) {
    this.f = o.field
    this.lattice = o.lattice
    this.land = o.land
    this.maxTws = o.constraints.maxTws ?? Infinity
    this.minTws = o.constraints.minTws ?? 0
    this.maxGust = o.constraints.maxGust ?? Infinity
    this.maxWave = o.constraints.maxWaveHeightM ?? Infinity
    this.tackPen = o.constraints.tackPenaltyS ?? 0
    this.gybePen = o.constraints.gybePenaltyS ?? 0
    this.polarDay = o.scalings.polarPct / 100
    this.polarNight = o.scalings.polarPctNight / 100
    this.fanStep = o.preset.fanStepDeg
    this.maxNodes = o.preset.maxNodes
    this.maxFrontier = o.preset.maxFrontier
  }

  // ---------------------------------------------------------------- targets

  /** The 0.25 kn target bucket for `tws`, filled on first use. */
  targetBucket(tws: number): number {
    let b = Math.round(tws * 4)
    if (b < 0) b = 0
    else if (b > 320) b = 320
    if (this.tgReady[b] === 0) {
      const t = this.lattice.targetsAt(b / 4)
      this.tgUpTwa[b] = t.upTwa
      this.tgUpVmg[b] = t.upVmg
      this.tgDnTwa[b] = t.downTwa
      this.tgDnVmg[b] = Math.abs(t.downVmg)
      this.tgReady[b] = 1
    }
    return b
  }

  // ------------------------------------------------------ effective speed

  /**
   * Boat speed made good along `twaAbs`, with §3 implicit tacking.
   *
   * Inside the no-go zone there is no direct option, so we substitute the
   * two-tack zigzag whose *net* velocity lies along the wanted bearing. Beating
   * at ±target_twa with an asymmetric time split produces a resultant along
   * that bearing whose component straight upwind is always `target_vmg_up`, so
   * the magnitude along the bearing is `target_vmg_up / cos(twa)`. At dead
   * upwind it collapses to exactly `target_vmg_up`, which is what makes the
   * §10.2 validation case analytically exact.
   *
   * The mirror case downwind is only taken when it genuinely beats sailing the
   * angle — a dead square run is slower than gybing down on most boats, but not
   * all of them and not at every wind speed, so we compare rather than assume.
   *
   * Leaves the answer in `effBsp` / `effBeat`; returning a struct here would
   * allocate once per candidate.
   */
  effective(tws: number, twaAbs: number, tb: number): void {
    const upTwa = this.tgUpTwa[tb]
    if (twaAbs < upTwa) {
      const c = Math.cos(twaAbs * DEG)
      const vmg = this.tgUpVmg[tb]
      this.effBsp = vmg > 0 && c > 1e-6 ? vmg / c : 0
      this.effBeat = 1
      return
    }
    if (twaAbs > this.tgDnTwa[tb]) {
      const direct = this.lattice.speed(tws, twaAbs)
      const c = Math.cos((180 - twaAbs) * DEG)
      const vmg = this.tgDnVmg[tb]
      const gybing = vmg > 0 && c > 1e-6 ? vmg / c : 0
      if (gybing > direct) {
        this.effBsp = gybing
        this.effBeat = 1
      } else {
        this.effBsp = direct
        this.effBeat = 0
      }
      return
    }
    this.effBsp = this.lattice.speed(tws, twaAbs)
    this.effBeat = 0
  }

  /** Effective speed for one heading — the cold path, used by the direct-route reference. */
  speedForHeading(tws: number, twd: number, hdg: number, polarF: number): number {
    const tb = this.targetBucket(tws)
    const twa = twaFrom(hdg, twd)
    this.effective(tws, Math.abs(twa), tb)
    return this.effBsp * polarF
  }

  // -------------------------------------------------------------- fan (§3)

  private fanPush(h: number): void {
    const n = this.fanN
    if (n >= this.fanHdg.length) return
    const r = h * DEG
    this.fanHdg[n] = h
    this.fanSin[n] = Math.sin(r)
    this.fanCos[n] = Math.cos(r)
    this.fanN = n + 1
  }

  /** Push only if the heading is inside the cone — for the injected VMG angles. */
  private fanPushInCone(h: number, centre: number, half: number): void {
    if (angsep(h, centre) <= half) this.fanPush(h)
  }

  /**
   * A cone of ±`half` about `centre`, plus the four exact VMG target angles.
   *
   * §3: injecting `TWD ± target_twa_up` and `TWD ± target_twa_dn` "matters more
   * than the step size" — the optimum upwind heading is almost always exactly
   * the target TWA, so a fan that lands on 44° and 49° either side of a 46.5°
   * target makes *every* upwind leg systematically slow. The exact bearing to
   * the goal goes in too, because that is the heading the implicit-tacking
   * substitution needs in order to make good straight at the mark.
   */
  private buildFan(
    centre: number,
    half: number,
    twd: number,
    upTwa: number,
    dnTwa: number,
  ): void {
    this.fanN = 0
    const step = this.fanStep
    const n = Math.floor(half / step)
    // k = 0 is `centre` exactly, which in the forward pass is the bearing to
    // the goal — the heading the implicit-tacking substitution needs in order
    // to make good straight at the mark.
    for (let k = -n; k <= n; k++) {
      let h = centre + k * step
      if (h >= 360) h -= 360
      else if (h < 0) h += 360
      this.fanPush(h)
    }
    this.fanPushInCone(courseFor(twd, upTwa), centre, half)
    this.fanPushInCone(courseFor(twd, -upTwa), centre, half)
    this.fanPushInCone(courseFor(twd, dnTwa), centre, half)
    this.fanPushInCone(courseFor(twd, -dnTwa), centre, half)
  }

  // ----------------------------------------------------------- label table

  /** Start a new pass: every slot from the previous one becomes dead. */
  private resetLabels(): void {
    this.passStamp++
    this.tLive = 0
    if (this.tMask < 0) this.growLabels(4096)
  }

  /**
   * Make room for `extra` more distinct buckets. Called at the top of a step,
   * before anything is `touched`, so rehashing cannot invalidate slot indices
   * held by the caller.
   */
  private ensureLabels(extra: number): void {
    let cap = this.tMask + 1
    const need = (this.tLive + extra) * 3
    while (cap < need) cap *= 2
    if (cap !== this.tMask + 1) this.growLabels(cap)
  }

  private growLabels(cap: number): void {
    const oldKey = this.tKey
    const oldScore = this.tScore
    const oldStamp = this.tStamp
    const oldCap = this.tMask + 1
    this.tKey = new Int32Array(cap)
    this.tScore = new Float64Array(cap)
    this.tStamp = new Int32Array(cap)
    this.tStep = new Int32Array(cap)
    this.tCand = new Int32Array(cap)
    this.tMask = cap - 1
    const stamp = this.passStamp
    let live = 0
    for (let i = 0; i < oldCap; i++) {
      if (oldStamp[i] !== stamp) continue
      const key = oldKey[i]
      let j = (Math.imul(key, 2654435761) >>> 0) & this.tMask
      while (this.tStamp[j] === stamp) j = (j + 1) & this.tMask
      this.tStamp[j] = stamp
      this.tKey[j] = key
      this.tScore[j] = oldScore[i]
      this.tStep[j] = -1
      this.tCand[j] = -1
      live++
    }
    this.tLive = live
  }

  /** Slot for `key`, freshly initialised to "never reached" if it is new. */
  private labelSlot(key: number): number {
    let i = (Math.imul(key, 2654435761) >>> 0) & this.tMask
    for (;;) {
      if (this.tStamp[i] !== this.passStamp) {
        this.tStamp[i] = this.passStamp
        this.tKey[i] = key
        this.tScore[i] = Infinity
        this.tStep[i] = -1
        this.tCand[i] = -1
        this.tLive++
        return i
      }
      if (this.tKey[i] === key) return i
      i = (i + 1) & this.tMask
    }
  }

  // ----------------------------------------------------------- the goal hop

  /**
   * Solve the last partial step onto the mark.
   *
   * Steering straight at a mark in a cross current does not arrive at the mark,
   * so we solve the crab angle: find the heading whose *ground* track lies on
   * the bearing to the goal, then report the along-track closing speed. Three
   * fixed-point iterations suffice because the polar varies slowly over a few
   * degrees of heading. This is what makes the constant-current validation case
   * (§10.3) match its analytic drift-corrected solution instead of tracing a
   * pursuit curve into it.
   *
   * Leaves the closing speed in `hopClosing` and the leg data in `hop*`.
   */
  private goalHop(
    tws: number,
    tb: number,
    twd: number,
    goalBrg: number,
    cu: number,
    cv: number,
    polarF: number,
    dir: 1 | -1,
  ): boolean {
    const gs = Math.sin(goalBrg * DEG)
    const gc = Math.cos(goalBrg * DEG)
    const cAlong = cu * gs + cv * gc
    const cPerp = cu * gc - cv * gs
    const base = dir > 0 ? goalBrg : wrap360(goalBrg + 180)
    let hdg = base
    let phi = 0
    let bsp = 0
    for (let it = 0; it < 4; it++) {
      const twa = angdiff(twd, hdg)
      this.effective(tws, twa < 0 ? -twa : twa, tb)
      bsp = this.effBsp * polarF
      if (bsp <= 1e-9) return false
      if (it === 3) break
      const need = (-dir * cPerp) / bsp
      if (need > 1 || need < -1) return false
      phi = Math.asin(clampUnit(need)) * RAD
      hdg = wrap360(base + phi)
    }
    const along = bsp * Math.cos(phi * DEG)
    const closing = dir > 0 ? along + cAlong : along - cAlong
    if (closing <= 1e-9) return false
    this.hopClosing = closing
    this.hopTwa = angdiff(twd, hdg)
    this.hopHdg = hdg
    this.hopBsp = bsp
    this.hopBeat = this.effBeat
    return true
  }

  // ------------------------------------------------------------------ pass

  run(input: PassInput): PassOutput {
    const { origin, goal, t0, dtMs, dir, recorder } = input
    const f = this.f
    const s = this.s
    const pa = this.pa
    const pb = this.pb
    const P = this.pool
    const C = this.cand
    const dtH = dtMs / MS_PER_HOUR
    const land = this.land
    const isFwd = dir > 0
    const isochrones: Isochrone[] = []
    let evaluated = 0
    let stopped: string | null = null

    // §4.3 — key buckets on (cell, tack) only when there is a penalty to lose.
    // With no tack or gybe cost the problem is memoryless again and the extra
    // state just doubles the frontier for nothing. The backward pass drops the
    // penalties by definition (§8), so it is always memoryless.
    const useTack = isFwd && (this.tackPen > 0 || this.gybePen > 0)

    // §4.2: "bucket size ≈ the distance the boat travels in one time step,
    // divided by 3–5". Too coarse merges the left and right side of the course
    // into one tactical option; too fine and every branch gets its own bucket
    // and the frontier explodes. Scaling with the step keeps that honest at
    // every leg length, and is also the answer to Expedition's warning that too
    // low an isochrone resolution "may yield worse results".
    //
    // The floor is the same trade-off from the other end. The frontier is a
    // 200°-wide shell one step of travel thick, so it holds roughly
    //   3.5 · tackStates · legNm · stepTravel / bucket²
    // nodes by the time it reaches the mark. Solving that for the preset's
    // frontier budget gives the coarsest bucket we are willing to take rather
    // than blow the time budget.
    const stepTravelNm = Math.max(0.01, input.typicalSpeed * dtH)
    const legNm = distance(origin, goal)
    const spanNm = legNm * 1.6 + 20
    let bucketNm = Math.max(0.005, stepTravelNm / 4)
    const byBudget = Math.sqrt(
      (3.5 * (useTack ? 2 : 1) * Math.max(legNm, stepTravelNm) * stepTravelNm) /
        this.maxFrontier,
    )
    if (byBudget > bucketNm) bucketNm = byBudget
    if (spanNm / bucketNm > 8000) bucketNm = spanNm / 8000
    const invBucket = 1 / bucketNm

    // Local tangent frame for the bucket grid, anchored at the leg midpoint.
    // The inner loop inlines this same transform to stay allocation-free.
    const frame = new LocalFrame({
      lat: (origin.lat + goal.lat) / 2,
      lon: origin.lon + wrap180(goal.lon - origin.lon) / 2,
    })
    const gOrigin = frame.toXY(origin)
    const gGoal = frame.toXY(goal)
    const frameLat = frame.origin.lat
    const frameLon = frame.origin.lon
    const frameCos = Math.cos(frameLat * DEG)
    const goalX = gGoal.x
    const goalY = gGoal.y
    // Speed bound for the pruning heuristic below. Generous on purpose: an
    // over-estimate keeps the bound admissible and the tie-break weak, so real
    // time differences (tack penalties) still dominate it.
    const vmax = Math.max(0.5, input.typicalSpeed * 2)

    this.resetLabels()
    P.ensure(P.n + 1)
    const root = P.n++
    P.lat[root] = origin.lat
    P.lon[root] = origin.lon
    P.t[root] = t0
    P.parent[root] = -1
    P.tack[root] = input.initialTack ?? 0
    P.twa[root] = input.initialTwa ?? 0
    P.hdg[root] = 0
    P.bsp[root] = 0
    P.twd[root] = 0
    P.tws[root] = 0
    P.beat[root] = 0
    P.curU[root] = 0
    P.curV[root] = 0
    P.dist[root] = 0
    if (this.frontier.length < 1) this.frontier = new Int32Array(4096)
    this.frontier[0] = root
    this.frontierN = 1
    if (recorder) record(recorder, origin.lat, origin.lon, t0)

    let half = 100
    let stalled = 0
    let noProgress = 0
    let bestSq = (gOrigin.x - goalX) ** 2 + (gOrigin.y - goalY) ** 2
    let finishNode = -1
    let finishT = isFwd ? Infinity : -Infinity
    let finishStep = -1

    for (let k = 0; k < input.maxSteps; k++) {
      if (input.onProgress && (k & 7) === 0) {
        input.onProgress(
          input.progressBase + (input.progressSpan * k) / Math.max(1, input.maxSteps),
        )
      }
      C.n = 0
      let cn = 0

      for (let fi = 0; fi < this.frontierN; fi++) {
        const ni = this.frontier[fi]
        const plat = P.lat[ni]
        const plon = P.lon[ni]
        const pt = P.t[ni]
        // Forward: the wind at the departure time. Backward: the wind at the
        // *earlier* time, sampled here as a stand-in for the as-yet-unknown
        // predecessor. §8 — "getting the time indexing right is the whole trick."
        f.sample(plat, plon, isFwd ? pt : pt - dtMs, s)
        const u = s[P_U]
        const v = s[P_V]
        // `Math.hypot` is correctly rounded and overflow-safe, and roughly an
        // order of magnitude slower than the naive form. Wind speeds and step
        // lengths are nowhere near the ranges that need either property, and
        // this runs millions of times.
        const tws = Math.sqrt(u * u + v * v)
        // Constraint violations kill the node, not just one heading: if the
        // boat cannot legally be here it cannot legally leave here either.
        // (A calm below `minTws` is the same — sitting it out would need a
        // time-expanded state space, which is a v2 problem.)
        if (tws > this.maxTws || tws < this.minTws) continue
        if (f.hasGust && s[P_GUST] > this.maxGust) continue
        if (f.hasWaves && s[P_WAVE] > this.maxWave) continue
        const twd = wrap360(Math.atan2(-u, -v) * RAD)
        const cu = s[P_CU]
        const cv = s[P_CV]
        const tb = this.targetBucket(tws)
        const polarF =
          this.polarNight !== this.polarDay && isNight(plat, plon, pt)
            ? this.polarNight
            : this.polarDay

        pa.lat = plat
        pa.lon = plon
        const goalBrg = bearing(pa, goal)
        const cosLat = Math.max(MIN_COS_LAT, Math.cos(plat * DEG))
        const sinLat = Math.sin(plat * DEG)
        const parentTack = P.tack[ni]
        const parentTwa = P.twa[ni]

        // ---- can we finish from here inside this step? (§2, "record a finish
        // candidate")
        const dGoal = distance(pa, goal)
        if (dGoal > 1e-12 && this.goalHop(tws, tb, twd, goalBrg, cu, cv, polarF, dir)) {
          const hours = dGoal / this.hopClosing
          if (hours <= dtH && (land === null || !land.crosses(pa, goal))) {
            // Apply tack/gybe penalty if the finish hop changes tack, mirroring
            // the fan loop — otherwise a candidate that avoids the fan penalty
            // can reach the mark via the goal hop penalty-free.
            const hopNewTack =
              this.hopTwa > 0 ? 1 : this.hopTwa < 0 ? -1 : parentTack === 0 ? 1 : parentTack
            let hopPen = 0
            if (useTack && parentTack !== 0 && hopNewTack !== parentTack) {
              hopPen = manoeuvre(parentTwa, this.hopTwa) === 'tack' ? this.tackPen : this.gybePen
            }
            const tArr = pt + dir * (hours * MS_PER_HOUR + hopPen * 1000)
            if (isFwd ? tArr < finishT : tArr > finishT) {
              P.ensure(P.n + 1)
              const fnode = P.n++
              P.lat[fnode] = goal.lat
              P.lon[fnode] = goal.lon
              P.t[fnode] = tArr
              P.parent[fnode] = ni
              P.tack[fnode] = hopNewTack
              P.twa[fnode] = this.hopTwa
              P.hdg[fnode] = this.hopHdg
              P.bsp[fnode] = this.hopBsp
              P.twd[fnode] = twd
              P.tws[fnode] = tws
              P.beat[fnode] = this.hopBeat
              P.curU[fnode] = cu
              P.curV[fnode] = cv
              P.dist[fnode] = dGoal
              finishNode = fnode
              finishT = tArr
              if (finishStep < 0) finishStep = k
            }
          }
        }

        // ---- the heading fan
        this.buildFan(
          isFwd ? goalBrg : wrap360(goalBrg + 180),
          half,
          twd,
          this.tgUpTwa[tb],
          this.tgDnTwa[tb],
        )
        const fanN = this.fanN
        C.n = cn
        C.ensure(cn + fanN)
        for (let j = 0; j < fanN; j++) {
          evaluated++
          const twa = angdiff(twd, this.fanHdg[j])
          const twaAbs = twa < 0 ? -twa : twa
          this.effective(tws, twaAbs, tb)
          const bsp = this.effBsp * polarF
          if (bsp <= 1e-9) continue
          const vx = bsp * this.fanSin[j] + cu
          const vy = bsp * this.fanCos[j] + cv
          const dxN = vx * dtH * dir
          const dyN = vy * dtH * dir
          const dLat = dyN * DEG_PER_NM
          const nlat = plat + dLat
          if (nlat > 89 || nlat < -89) continue
          const cosMid = Math.max(MIN_COS_LAT, cosLat - sinLat * dLat * 0.5 * DEG)
          const nlon = wrap180(plon + (dxN * DEG_PER_NM) / cosMid)

          // §6 — the segment, never the endpoint. A 30 nm step straddles most
          // islands, and testing only `nlat/nlon` is how hobby routers sail
          // boats over land.
          if (land !== null) {
            pb.lat = nlat
            pb.lon = nlon
            if (land.crosses(pa, pb)) continue
          }

          // §8 — no tack/gybe penalties on the backward pass. Dropping them is
          // what restores memorylessness, and it is documented Expedition
          // behaviour ("not used for reverse isochrones").
          let newTack = twa > 0 ? 1 : twa < 0 ? -1 : parentTack === 0 ? 1 : parentTack
          let pen = 0
          if (useTack && parentTack !== 0 && newTack !== parentTack) {
            pen = manoeuvre(parentTwa, twa) === 'tack' ? this.tackPen : this.gybePen
          }
          if (!useTack) newTack = 0

          C.lat[cn] = nlat
          C.lon[cn] = nlon
          C.t[cn] = pt + dir * (dtMs + pen * 1000)
          C.parent[cn] = ni
          C.tack[cn] = newTack
          C.twa[cn] = twa
          C.hdg[cn] = this.fanHdg[j]
          C.bsp[cn] = bsp
          C.twd[cn] = twd
          C.tws[cn] = tws
          C.beat[cn] = this.effBeat
          C.curU[cn] = cu
          C.curV[cn] = cv
          C.dist[cn] = Math.sqrt(dxN * dxN + dyN * dyN)
          cn++
        }
      }

      if (cn === 0) {
        stopped =
          'no legal move from the frontier — every heading was blocked by land or by the wind, gust and wave limits'
        break
      }

      // ---------------------------------------------- §4.2 bucket pruning
      this.ensureLabels(cn)
      this.touchedN = 0
      for (let c = 0; c < cn; c++) {
        const bx = wrap180(C.lon[c] - frameLon) * DEG * frameCos * R_NM
        const by = (C.lat[c] - frameLat) * DEG * R_NM
        let ix = Math.round(bx * invBucket)
        let iy = Math.round(by * invBucket)
        ix = ix < -8000 ? -8000 : ix > 8000 ? 8000 : ix
        iy = iy < -8000 ? -8000 : iy > 8000 ? 8000 : iy
        // §4.3 — key on (cell, tack), not cell. Without the tack in the key a
        // node that arrived on port is silently pruned by one that arrived on
        // starboard a few seconds earlier, and the tack penalty vanishes.
        const key = ((ix + 8000) * 16001 + (iy + 8000)) * 3 + (C.tack[c] + 1)
        const slot = this.labelSlot(key)
        // Rank by an admissible bound on *total* time, not arrival time alone.
        //
        // Every candidate in a step usually arrives at the same clock time, so
        // arrival time cannot discriminate between two nodes in one bucket and
        // an arbitrary one wins — one that can sit most of a bucket behind the
        // best. That loss compounds once per step and shows up as a systematic
        // few-percent overestimate of the ETA, which is exactly the kind of bug
        // the §10 analytic cases exist to catch. Adding the remaining distance
        // over the best speed the boat could possibly make keeps the criterion
        // a lower bound on total time (so it is still label-setting) while
        // breaking equal-time ties in favour of real progress.
        const dx = bx - goalX
        const dy = by - goalY
        const remain = Math.sqrt(dx * dx + dy * dy)
        const score = dir * C.t[c] + (remain / vmax) * MS_PER_HOUR
        if (score >= this.tScore[slot]) continue
        this.tScore[slot] = score
        this.tCand[slot] = c
        if (this.tStep[slot] !== k) {
          this.tStep[slot] = k
          if (this.touchedN >= this.touched.length) {
            this.touched = growI32(this.touched, this.touched.length * 2, this.touchedN)
          }
          this.touched[this.touchedN++] = slot
        }
      }

      const survivors = this.touchedN
      P.ensure(P.n + survivors)
      if (this.frontier.length < survivors) this.frontier = new Int32Array(survivors * 2)
      const isoLat = new Float64Array(survivors)
      const isoLon = new Float64Array(survivors)
      let fn = 0
      let newBestSq = Infinity
      for (let ti = 0; ti < survivors; ti++) {
        const c = this.tCand[this.touched[ti]]
        if (c < 0) continue
        const pi = P.n++
        P.lat[pi] = C.lat[c]
        P.lon[pi] = C.lon[c]
        P.t[pi] = C.t[c]
        P.parent[pi] = C.parent[c]
        P.tack[pi] = C.tack[c]
        P.twa[pi] = C.twa[c]
        P.hdg[pi] = C.hdg[c]
        P.bsp[pi] = C.bsp[c]
        P.twd[pi] = C.twd[c]
        P.tws[pi] = C.tws[c]
        P.beat[pi] = C.beat[c]
        P.curU[pi] = C.curU[c]
        P.curV[pi] = C.curV[c]
        P.dist[pi] = C.dist[c]
        this.frontier[fn] = pi
        isoLat[fn] = C.lat[c]
        isoLon[fn] = C.lon[c]
        fn++
        if (recorder) record(recorder, C.lat[c], C.lon[c], C.t[c])
        const bx = wrap180(C.lon[c] - frameLon) * DEG * frameCos * R_NM
        const by = (C.lat[c] - frameLat) * DEG * R_NM
        const d2 = (bx - goalX) ** 2 + (by - goalY) ** 2
        if (d2 < newBestSq) newBestSq = d2
      }
      this.frontierN = fn
      if (fn === 0) {
        // Label-setting termination: nothing improved on anything already
        // known, so the reachable set is closed and the goal is not in it.
        stopped =
          'the search exhausted every reachable position without reaching the destination'
        break
      }
      if (isochrones.length < MAX_ISOCHRONES) {
        isochrones.push(
          makeIsochrone(t0 + dir * (k + 1) * dtMs, isoLat, isoLon, fn, origin),
        )
      }

      // §3 — "the cone adapts… widening when the frontier stops progressing,
      // which is what happens when land or a wind hole forces a large detour."
      if (newBestSq < bestSq - 1e-9) {
        bestSq = newBestSq
        stalled = 0
        noProgress = 0
        if (half > 100) half = Math.max(100, half - 20)
      } else {
        noProgress++
        if (++stalled >= 2 && half < 180) {
          half = Math.min(180, half + 20)
          stalled = 0
        }
      }

      if (finishNode >= 0 && k - finishStep >= FINISH_GRACE_STEPS) break
      // A frontier that has been at full cone width and no closer to the mark
      // for this long is behind something it cannot get round. Grinding out the
      // remaining step budget just explores the whole ocean to say so.
      if (finishNode < 0 && noProgress >= MAX_STALLED_STEPS && half >= 180) {
        stopped =
          'the frontier stopped closing on the destination — something impassable is in the way'
        break
      }
      if (P.n > this.maxNodes) {
        stopped = 'node budget exhausted — try the "fast" resolution or a shorter leg'
        break
      }
    }

    if (finishNode < 0 && stopped === null) {
      stopped = 'destination unreachable within the step budget'
    }
    if (input.onProgress) input.onProgress(input.progressBase + input.progressSpan)
    return {
      reached: finishNode >= 0,
      finishNode,
      finishT,
      isochrones,
      evaluated,
      stopped: finishNode >= 0 ? null : stopped,
    }
  }
}

// --------------------------------------------------------------- isochrones

function makeIsochrone(
  t: Millis,
  lat: Float64Array,
  lon: Float64Array,
  n: number,
  origin: LatLon,
): Isochrone {
  // Order by bearing from the leg origin so the UI can stroke the frontier as a
  // polyline rather than a scatter of dots.
  const brg = new Float64Array(n)
  const p: LatLon = { lat: 0, lon: 0 }
  const order: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    order[i] = i
    p.lat = lat[i]
    p.lon = lon[i]
    brg[i] = bearing(origin, p)
  }
  order.sort((a, b) => brg[a] - brg[b])
  const stride = Math.max(1, Math.ceil(n / MAX_ISOCHRONE_POINTS))
  const points: LatLon[] = []
  for (let i = 0; i < n; i += stride) {
    points.push({ lat: lat[order[i]], lon: lon[order[i]] })
  }
  return { t, points }
}

// ---------------------------------------------------------- direct-time ref

/**
 * How long it takes to just sail the direct line, for comparison. This is the
 * honest "what did routing actually buy me" number the UI puts next to the ETA.
 *
 * Deliberately naive: hold the bearing to the mark and advance at the along-track
 * component of boat-plus-current. Not a route, a baseline.
 */
function directTimeS(
  f: DenseField,
  search: Search,
  start: LatLon,
  marks: LatLon[],
  t0: Millis,
  dtMs: number,
  polarDay: number,
  polarNight: number,
): number | null {
  const s = new Float64Array(P_COUNT)
  const dtH = dtMs / MS_PER_HOUR
  const varyByTime = polarNight !== polarDay
  let p = start
  let t = t0
  for (const m of marks) {
    let arrived = false
    for (let guard = 0; guard < 20_000 && !arrived; guard++) {
      const d = distance(p, m)
      if (d < 0.01) {
        arrived = true
        break
      }
      const brg = bearing(p, m)
      f.sample(p.lat, p.lon, t, s)
      const tws = Math.hypot(s[P_U], s[P_V])
      const twd = wrap360(Math.atan2(-s[P_U], -s[P_V]) * RAD)
      const polar = varyByTime && isNight(p.lat, p.lon, t) ? polarNight : polarDay
      const bsp = search.speedForHeading(tws, twd, brg, polar)
      const total = vecAdd(fromPolar(brg, bsp), { x: s[P_CU], y: s[P_CV] })
      const closing = total.x * Math.sin(brg * DEG) + total.y * Math.cos(brg * DEG)
      if (closing <= 1e-6) return null
      const stepNm = Math.min(d, closing * dtH)
      t += (stepNm / closing) * MS_PER_HOUR
      p = destination(p, brg, stepNm)
    }
    if (!arrived) return null
    p = m
  }
  return (t - t0) / 1000
}

// -------------------------------------------------------------- the entry

/** Sensible defaults — handy for tests and for the UI's initial state. */
export function defaultConstraints(): RouteConstraints {
  return { avoidLand: true, tackPenaltyS: 0, gybePenaltyS: 0 }
}

export function defaultScalings(): RouteScalings {
  return {
    polarPct: 100,
    polarPctNight: 100,
    windScalePct: 100,
    windRotateDeg: 0,
    windTimeShiftS: 0,
    currentScalePct: 100,
  }
}

function failed(
  error: string,
  warnings: string[],
  timeStepS: number,
  nodes: number,
  started: number,
  landAvoided: boolean,
): RouteResult {
  return {
    ok: false,
    error,
    legs: [],
    etaMs: null,
    elapsedS: null,
    directTimeS: null,
    isochrones: [],
    reverseIsochrones: [],
    sensitivity: null,
    diagnostics: {
      nodesExplored: nodes,
      timeStepS,
      computeMs: nowMs() - started,
      landAvoided,
      warnings,
    },
  }
}

/**
 * Route from `req.start` through `req.marks`, minimising arrival time.
 *
 * Never throws: a failure comes back as `{ ok: false, error }` with something a
 * sailor can act on. A router that throws inside a worker on a phone at 3 a.m.
 * is worse than one that says "the forecast ran out".
 */
export function routeIsochrone(req: RouteRequest, ctx: RouteContext): RouteResult {
  const started = nowMs()
  const warnings: string[] = []
  let timeStepS = 0
  let evaluated = 0
  // False until the mask is resolved below, so an early failure reports the
  // truth rather than a default: this route consulted no land data.
  let landAvoided = false
  try {
    if (!req.marks || req.marks.length === 0) {
      return failed('route needs at least one mark to sail to', warnings, 0, 0, started, landAvoided)
    }
    const preset = PRESETS[req.resolution] ?? PRESETS.balanced
    const waypoints = [req.start, ...req.marks]

    let totalNm = 0
    for (let i = 1; i < waypoints.length; i++) {
      totalNm += distance(waypoints[i - 1], waypoints[i])
    }
    if (totalNm < 1e-6) {
      return failed('start and destination are the same point', warnings, 0, 0, started, landAvoided)
    }

    const padNm = Math.min(0.3 * totalNm, 200) + 10
    const bbox = bboxOf(waypoints, padNm)

    // We cannot know the ETA before routing, so hydrate for a pessimistic
    // 4 kn average with generous headroom; `hydrate` trims this to the
    // forecast's own end and warns if the route needs more.
    const horizonMs = clamp(
      (totalNm / 4) * MS_PER_HOUR * 2.5,
      6 * MS_PER_HOUR,
      30 * 24 * MS_PER_HOUR,
    )
    const hyd = hydrate(
      ctx.field,
      bbox,
      req.startTime,
      horizonMs,
      preset.hydrationBudget,
      req.scalings,
      warnings,
    )
    if (hyd.field === null) {
      return failed(hyd.error ?? 'weather field unusable', warnings, 0, 0, started, landAvoided)
    }
    const dense = hyd.field

    // Typical speed from the polar in the wind we actually start in. It sets
    // the time step, the pruning bucket and the step budget, so a wild guess
    // here costs either accuracy or seconds.
    const probe = new Float64Array(P_COUNT)
    dense.sample(req.start.lat, req.start.lon, req.startTime, probe)
    const startTws = Math.hypot(probe[P_U], probe[P_V])
    const typicalSpeed = Math.max(
      0.5,
      ctx.lattice.speed(startTws, 90) * (req.scalings.polarPct / 100),
    )

    const land =
      req.constraints.avoidLand && ctx.land != null && ctx.land !== NULL_LAND_MASK
        ? ctx.land
        : null
    landAvoided = land !== null
    if (req.constraints.avoidLand && !landAvoided) {
      // The caller asked for land avoidance and is not getting it. Silence here
      // is the worst outcome available: the route looks exactly like one that
      // was checked, and the UI upstream has no other way to tell the
      // difference between a mask that was used and one that was rejected.
      warnings.push(
        'Land avoidance was requested but no usable coastline data reached the router. This route has NOT been checked against land.',
      )
    }

    const dtS = chooseTimeStepS(totalNm, typicalSpeed, req.resolution, gribStepOf(ctx.field))
    timeStepS = dtS
    const dtMs = dtS * 1000

    const search = new Search({
      field: dense,
      lattice: ctx.lattice,
      land,
      constraints: req.constraints,
      scalings: req.scalings,
      preset,
    })

    const fwdRecorder = req.computeSensitivity ? makeRecorder(bbox, false) : null
    const bwdRecorder = req.computeSensitivity ? makeRecorder(bbox, true) : null

    // ------------------------------------------------------- §7 multi-leg
    //
    // Leg by leg, carrying the arrival time forward. The doc is explicit that
    // this is not globally optimal — arriving at a mark slightly later can put
    // you into a better field for the next leg — but that is a v2 problem and
    // it is what the commercial product does.
    const legs: RouteLeg[] = []
    const isochrones: Isochrone[] = []
    let clock = req.startTime
    let from = req.start
    const passCount = req.marks.length * (req.computeSensitivity ? 2 : 1)
    let passIndex = 0
    let prevTack = 0
    let prevTwa = 0

    for (let li = 0; li < req.marks.length; li++) {
      const to = req.marks[li]
      const legNm = distance(from, to)
      if (legNm < 1e-6) {
        from = to
        continue
      }
      const maxSteps = Math.min(
        3000,
        Math.ceil(legNm / Math.max(0.05, typicalSpeed * (dtS / 3600))) * 3 + 30,
      )
      const out = search.run({
        origin: from,
        goal: to,
        t0: clock,
        dtMs,
        dir: 1,
        maxSteps,
        typicalSpeed,
        recorder: fwdRecorder,
        onProgress: ctx.onProgress ?? null,
        progressBase: passIndex / passCount,
        progressSpan: 1 / passCount,
        initialTack: prevTack,
        initialTwa: prevTwa,
      })
      passIndex++
      evaluated += out.evaluated
      // Already capped at MAX_ISOCHRONES per pass; a multi-leg course gets that
      // many per leg, which is what the UI wants to draw.
      for (const iso of out.isochrones) isochrones.push(iso)
      if (!out.reached) {
        return failed(
          `leg ${li + 1} of ${req.marks.length}: ${out.stopped ?? 'no route found'}`,
          warnings,
          timeStepS,
          evaluated,
          started,
          landAvoided,
        )
      }
      appendLegs(legs, search, reconstruct(search, out.finishNode), dense.hasCurrent, li > 0)
      prevTack = search.pool.tack[out.finishNode]
      prevTwa = search.pool.twa[out.finishNode]
      clock = out.finishT
      from = to
    }

    if (legs.length === 0) {
      return failed('route collapsed to zero length', warnings, timeStepS, evaluated, started, landAvoided)
    }

    const etaMs = clock
    const elapsedS = (etaMs - req.startTime) / 1000

    // -------------------------------------------------- §8 backward pass
    //
    // Anchored at the forward ETA and run leg by leg in reverse, so a node's
    // time means "leave here at t and you still make the schedule". The
    // remaining time is then `ETA − t`, the ETA cancels out of the loss
    // expression, and the sensitivity field reduces to `T_f(p) − T_b(p)`.
    const reverseIsochrones: Isochrone[] = []
    let sensitivity: SensitivityField | null = null
    let backwardStartT: Millis | null = null
    if (req.computeSensitivity) {
      let anchor = etaMs
      for (let li = req.marks.length - 1; li >= 0; li--) {
        const legFrom = li === 0 ? req.start : req.marks[li - 1]
        const legTo = req.marks[li]
        const legNm = distance(legFrom, legTo)
        if (legNm < 1e-6) continue
        const maxSteps = Math.min(
          3000,
          Math.ceil(legNm / Math.max(0.05, typicalSpeed * (dtS / 3600))) * 3 + 30,
        )
        const back = search.run({
          origin: legTo,
          goal: legFrom,
          t0: anchor,
          dtMs,
          dir: -1,
          maxSteps,
          typicalSpeed,
          recorder: bwdRecorder,
          onProgress: ctx.onProgress ?? null,
          progressBase: passIndex / passCount,
          progressSpan: 1 / passCount,
        })
        passIndex++
        evaluated += back.evaluated
        for (const iso of back.isochrones) reverseIsochrones.push(iso)
        if (!back.reached) {
          warnings.push(
            `backward pass for leg ${li + 1} did not reach its origin — the sensitivity field is partial`,
          )
          break
        }
        anchor = back.finishT
        if (li === 0) backwardStartT = back.finishT
      }
      if (fwdRecorder && bwdRecorder) {
        sensitivity = buildSensitivity(fwdRecorder, bwdRecorder, bbox)
      }
      if (backwardStartT !== null) {
        // The start is, by definition, a point on the reverse isochrone at
        // T_r(start). Emitting it closes the family and hands the caller the
        // §10.5 consistency number — `startTime − t` is the whole pipeline's
        // discretisation error — without inventing a diagnostics field.
        reverseIsochrones.push({ t: backwardStartT, points: [{ ...req.start }] })
        const errS = Math.abs(backwardStartT - req.startTime) / 1000
        if (errS > 3 * dtS) {
          warnings.push(
            `forward and backward passes disagree by ${(errS / 60).toFixed(1)} min — sensitivity is indicative only at this resolution`,
          )
        }
      }
    }

    return {
      ok: true,
      legs,
      etaMs,
      elapsedS,
      directTimeS: directTimeS(
        dense,
        search,
        req.start,
        req.marks,
        req.startTime,
        dtMs,
        req.scalings.polarPct / 100,
        req.scalings.polarPctNight / 100,
      ),
      isochrones,
      reverseIsochrones,
      sensitivity,
      diagnostics: {
        nodesExplored: evaluated,
        timeStepS,
        computeMs: nowMs() - started,
        landAvoided,
        warnings,
      },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return failed(
      `routing failed unexpectedly: ${msg} — please report the course and forecast`,
      warnings,
      timeStepS,
      evaluated,
      started,
      landAvoided,
    )
  }
}

// ------------------------------------------------------------ reconstruction

function reconstruct(search: Search, finishNode: number): Int32Array {
  const P = search.pool
  let n = 0
  for (let i = finishNode; i >= 0; i = P.parent[i]) n++
  const path = new Int32Array(n)
  let k = n - 1
  for (let i = finishNode; i >= 0; i = P.parent[i]) path[k--] = i
  return path
}

/**
 * Turn a node path into `RouteLeg`s.
 *
 * Convention: a leg records where and when you are, and the conditions for the
 * segment that *departs* from there. The last entry is the arrival, carrying
 * the conditions that got you there and zero remaining distance. That lets the
 * UI stroke `legs.map(l => l.position)` as the route line with no fencepost
 * special-casing, and lets the table show "sail this, for this far".
 */
function appendLegs(
  out: RouteLeg[],
  search: Search,
  path: Int32Array,
  hasCurrent: boolean,
  continuing: boolean,
): void {
  const P = search.pool
  // The previous leg ended at this mark with zero distance; this leg starts at
  // the same mark with real conditions, so drop the stale arrival row.
  if (continuing && out.length > 0) out.pop()
  for (let i = 0; i < path.length; i++) {
    const here = path[i]
    const nxt = i + 1 < path.length ? path[i + 1] : -1
    const src = nxt >= 0 ? nxt : here
    const cu = P.curU[src]
    const cv = P.curV[src]
    out.push({
      t: P.t[here],
      position: { lat: P.lat[here], lon: P.lon[here] },
      twd: P.twd[src],
      tws: P.tws[src],
      twa: P.twa[src],
      bsp: P.bsp[src],
      heading: P.hdg[src],
      isBeating: P.beat[src] !== 0,
      tack: tackOf(P.twa[src]),
      currentSet: hasCurrent ? vecBearing({ x: cu, y: cv }) : null,
      currentDrift: hasCurrent ? Math.hypot(cu, cv) : null,
      distanceNm: nxt >= 0 ? P.dist[nxt] : 0,
    })
  }
}

// -------------------------------------------------------------- sensitivity

/**
 * `loss(p) = T_f(p) + T_r(p) − T_optimal`, in minutes (§8).
 *
 * The forward recorder holds the earliest arrival at each cell; the backward
 * recorder holds the latest departure from it that still makes the schedule.
 * Remaining time is `ETA − T_b`, so the ETA cancels and the whole field reduces
 * to `T_f − T_b`: zero along the optimal route, positive everywhere else.
 *
 * This is the number that turns a magenta line into an uncertainty band —
 * "anywhere in here costs you under ten minutes" — which the doc argues should
 * be the default view, not a checkbox.
 */
function buildSensitivity(fwd: Recorder, bwd: Recorder, bbox: BBox): SensitivityField {
  const loss = new Float32Array(fwd.nx * fwd.ny)
  for (let i = 0; i < loss.length; i++) {
    const tf = fwd.values[i]
    const tb = bwd.values[i]
    if (!isFinite(tf) || !isFinite(tb)) {
      loss[i] = Infinity
      continue
    }
    const mins = (tf - tb) / 60_000
    loss[i] = mins > 0 ? mins : 0
  }
  return { bbox, nx: fwd.nx, ny: fwd.ny, loss }
}
