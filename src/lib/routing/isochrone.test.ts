/**
 * The §10 validation suite from docs/03-algorithms/routing-isochrone.md.
 *
 * Every fixture here is analytic. The point of the doc's validation list is
 * that a weather router has no ground truth to compare against in the general
 * case, so correctness has to be established on the cases where the answer can
 * be written down: constant wind, constant current, dead upwind, and the
 * forward/backward identity. If those hold, the machinery is right and the only
 * remaining error is discretisation.
 *
 * The `WeatherField` and `PolarLattice` fakes are local on purpose — the kernel
 * must be testable without `src/lib/weather` or `src/lib/polar` existing.
 */

import { describe, expect, it, vi } from 'vitest'
import { bearing, crossTrack, destination, distance } from '../geo'
import { DEG, wrap360 } from '../angles'
import type {
  LatLon,
  Millis,
  PolarLattice,
  PolarTable,
  RouteRequest,
  Targets,
  WeatherField,
} from '../types'
import { defaultConstraints, defaultScalings, routeIsochrone } from './isochrone'
import { PolygonLandMask, buildLandMask, extractPolygons } from './land'
import type { RouteWorkerResponse } from './worker'

// ------------------------------------------------------------- fake polar
//
// An analytic polar with a genuine no-go zone. The targets are found by
// numerically maximising VMG on this same curve, so `targetsAt` and `speed` can
// never drift apart — which is what makes the dead-upwind case exact.

const windFactor = (tws: number): number => 1.6 * Math.sqrt(Math.min(Math.max(tws, 0), 30))

function shape(twaAbs: number): number {
  if (twaAbs <= 25) return 0
  const r = Math.min(1, (twaAbs - 25) / 20)
  const rise = r * r * (3 - 2 * r)
  const x = Math.min(1, Math.max(0, (twaAbs - 110) / 70))
  const fall = 1 - 0.4 * Math.pow(x, 1.5)
  return rise * fall
}

const analyticSpeed = (tws: number, twa: number): number =>
  windFactor(tws) * shape(Math.min(180, Math.abs(twa)))

// Baked onto a regular lattice, exactly as `PolarLattice` is defined to be
// (docs/03-algorithms/polars-and-vpp.md §1) and as a production lattice will
// be. Keeping the fake cheap matters: an expensive `speed()` would show up in
// the performance cases as if it were the kernel's cost.
const TWS_STEP = 0.25
const TWA_STEP = 0.5
const TWS_COUNT = Math.round(40 / TWS_STEP) + 1
const TWA_COUNT = Math.round(180 / TWA_STEP) + 1
const GRID = new Float32Array(TWS_COUNT * TWA_COUNT)
for (let i = 0; i < TWS_COUNT; i++) {
  for (let j = 0; j < TWA_COUNT; j++) {
    GRID[i * TWA_COUNT + j] = analyticSpeed(i * TWS_STEP, j * TWA_STEP)
  }
}

function latticeSpeed(tws: number, twa: number): number {
  let a = Math.abs(twa)
  if (a > 180) a = 180
  let fs = tws / TWS_STEP
  if (fs < 0) fs = 0
  else if (fs > TWS_COUNT - 1) fs = TWS_COUNT - 1
  const fa = a / TWA_STEP
  let i = fs | 0
  if (i > TWS_COUNT - 2) i = TWS_COUNT - 2
  let j = fa | 0
  if (j > TWA_COUNT - 2) j = TWA_COUNT - 2
  const u = fs - i
  const v = fa - j
  const b = i * TWA_COUNT + j
  return (
    (1 - u) * ((1 - v) * GRID[b] + v * GRID[b + 1]) +
    u * ((1 - v) * GRID[b + TWA_COUNT] + v * GRID[b + TWA_COUNT + 1])
  )
}

/** Targets found by maximising VMG on the lattice, so they can never disagree. */
function computeTargets(tws: number): Targets {
  let upTwa = 45
  let upVmg = -Infinity
  for (let a = 0.05; a <= 90; a += 0.02) {
    const vmg = latticeSpeed(tws, a) * Math.cos(a * DEG)
    if (vmg > upVmg) {
      upVmg = vmg
      upTwa = a
    }
  }
  let downTwa = 150
  let downVmg = Infinity
  for (let a = 90; a <= 180; a += 0.02) {
    const vmg = latticeSpeed(tws, a) * Math.cos(a * DEG)
    if (vmg < downVmg) {
      downVmg = vmg
      downTwa = a
    }
  }
  return {
    tws,
    upTwa,
    upBsp: latticeSpeed(tws, upTwa),
    upVmg,
    downTwa,
    downBsp: latticeSpeed(tws, downTwa),
    downVmg,
  }
}

function makeLattice(): PolarLattice {
  const cache = new Map<number, Targets>()
  const table: PolarTable = { name: 'analytic test polar', tws: [], rows: [], reference: '10m' }
  return {
    table,
    twsMax: 40,
    twsStep: TWS_STEP,
    twaStep: TWA_STEP,
    grid: GRID,
    twsCount: TWS_COUNT,
    twaCount: TWA_COUNT,
    targets: [],
    speed: latticeSpeed,
    targetsAt(tws: number): Targets {
      const key = Math.round(tws * 100)
      let t = cache.get(key)
      if (!t) {
        t = computeTargets(tws)
        cache.set(key, t)
      }
      return t
    },
  }
}

const LATTICE = makeLattice()

// ------------------------------------------------------------- fake field

interface FieldOpts {
  /** Wind direction the wind blows FROM, degrees true. */
  twd: number | ((lat: number, lon: number, t: Millis) => number)
  tws: number | ((lat: number, lon: number, t: Millis) => number)
  /** Current as u (east) / v (north) knots, or null for no current data. */
  current?: { u: number; v: number } | null
  hours?: number
  /** Forced GRIB cadence, seconds — the kernel clamps its time step to it. */
  gribStepS?: number
}

function makeField(o: FieldOpts): WeatherField {
  const t0 = Date.UTC(2026, 5, 15, 6, 0, 0)
  const hours = o.hours ?? 72
  const dirOf = typeof o.twd === 'function' ? o.twd : () => o.twd as number
  const spdOf = typeof o.tws === 'function' ? o.tws : () => o.tws as number
  const field = {
    wind(lat: number, lon: number, t: Millis) {
      const d = dirOf(lat, lon, t)
      const s = spdOf(lat, lon, t)
      // Meteorological convention: the vector points where the air is going.
      return { u: -s * Math.sin(d * DEG), v: -s * Math.cos(d * DEG), source: 'test' }
    },
    gust: () => null,
    current: (_lat: number, _lon: number, _t: Millis) =>
      o.current ? { ...o.current, source: 'test' } : null,
    waves: () => null,
    coverage: () => ({
      bbox: { west: -180, south: -85, east: 180, north: 85 },
      t0,
      t1: t0 + hours * 3_600_000,
    }),
  }
  // `dtMs` is a declared optional member of WeatherField, so a test field sets it
  // like any other property. It used to be bolted on through a cast, which is how
  // this test came to pass against a production path where nothing had it at all.
  return { ...field, ...(o.gribStepS != null ? { dtMs: o.gribStepS * 1000 } : {}) }
}

const T0 = Date.UTC(2026, 5, 15, 12, 0, 0)

function request(over: Partial<RouteRequest> & { marks: LatLon[] }): RouteRequest {
  return {
    start: { lat: 40, lon: -70 },
    startTime: T0,
    constraints: defaultConstraints(),
    scalings: defaultScalings(),
    resolution: 'best',
    computeSensitivity: false,
    ...over,
  }
}

/** North of `from` by `nm`, on the same meridian. */
const north = (from: LatLon, nm: number): LatLon => destination(from, 0, nm)

function routeDistanceNm(legs: { position: LatLon }[]): number {
  let d = 0
  for (let i = 1; i < legs.length; i++) d += distance(legs[i - 1].position, legs[i].position)
  return d
}

const report: string[] = []
const note = (s: string): void => {
  report.push(s)
  console.log(`  · ${s}`)
}

// --------------------------------------------------------------------------

describe('isochrone routing kernel', () => {
  // §10.1
  it('constant wind, beam reach, no current: matches distance / polar speed', () => {
    const start = { lat: 40, lon: -70 }
    const finish = north(start, 30)
    const legNm = distance(start, finish)
    const res = routeIsochrone(
      request({ start, marks: [finish] }),
      { field: makeField({ twd: 90, tws: 12 }), lattice: LATTICE },
    )
    expect(res.ok, res.error).toBe(true)

    // Beam reach: the destination is due north, the wind is from due east, so
    // the optimal heading is straight at the mark at TWA 90.
    const bsp = LATTICE.speed(12, 90)
    const expected = (legNm / bsp) * 3600
    const err = (res.elapsedS! - expected) / expected
    note(
      `10.1 beam reach: ${legNm.toFixed(3)} nm @ ${bsp.toFixed(4)} kn -> expected ${expected.toFixed(1)} s, got ${res.elapsedS!.toFixed(1)} s (${(err * 100).toFixed(3)}%)`,
    )
    expect(Math.abs(err)).toBeLessThan(0.005)

    // …and the path is essentially the great circle.
    let maxXte = 0
    for (const leg of res.legs) {
      maxXte = Math.max(maxXte, Math.abs(crossTrack(leg.position, start, finish)))
    }
    note(`10.1 max cross-track from the great circle: ${maxXte.toFixed(4)} nm`)
    expect(maxXte).toBeLessThan(0.05)
    expect(res.legs[0].isBeating).toBe(false)
    expect(res.legs[0].tack).toBe('starboard')
    expect(Math.abs(res.legs[0].twa - 90)).toBeLessThan(1)
  })

  // §10.2 — "Exact", and the strongest correctness check.
  it('constant wind, dead upwind: matches distance / target VMG upwind', () => {
    const start = { lat: 40, lon: -70 }
    const finish = north(start, 30)
    const legNm = distance(start, finish)
    const res = routeIsochrone(
      request({ start, marks: [finish] }),
      { field: makeField({ twd: 0, tws: 12 }), lattice: LATTICE },
    )
    expect(res.ok, res.error).toBe(true)

    const tgt = LATTICE.targetsAt(12)
    const expected = (legNm / tgt.upVmg) * 3600
    const err = (res.elapsedS! - expected) / expected
    note(
      `10.2 dead upwind: target TWA ${tgt.upTwa.toFixed(2)}°, VMG ${tgt.upVmg.toFixed(4)} kn -> expected ${expected.toFixed(1)} s, got ${res.elapsedS!.toFixed(1)} s (${(err * 100).toFixed(3)}%)`,
    )
    expect(Math.abs(err)).toBeLessThan(0.005)

    // The router must report the substituted zigzag, not pretend it is a course
    // to steer — that is exactly what `RouteLeg.isBeating` exists for.
    expect(res.legs.some((l) => l.isBeating)).toBe(true)
    expect(res.legs.slice(0, -1).every((l) => l.isBeating)).toBe(true)
  })

  it('dead upwind with tack penalties is never faster than without', () => {
    const start = { lat: 40, lon: -70 }
    const finish = north(start, 30)
    const ctx = { field: makeField({ twd: 0, tws: 12 }), lattice: LATTICE }
    const clean = routeIsochrone(request({ start, marks: [finish] }), ctx)
    const penalised = routeIsochrone(
      request({
        start,
        marks: [finish],
        constraints: { ...defaultConstraints(), tackPenaltyS: 90, gybePenaltyS: 90 },
      }),
      ctx,
    )
    expect(clean.ok && penalised.ok).toBe(true)
    note(
      `10.2b tack penalty 90 s: clean ${clean.elapsedS!.toFixed(1)} s, penalised ${penalised.elapsedS!.toFixed(1)} s`,
    )
    expect(penalised.elapsedS!).toBeGreaterThanOrEqual(clean.elapsedS! - 1)
  })

  // §10.3
  it('constant current, constant wind: matches the analytic drift-corrected solution', () => {
    const start = { lat: 40, lon: -70 }
    const finish = north(start, 30)
    const legNm = distance(start, finish)
    const drift = 1.5 // knots, setting due east
    const res = routeIsochrone(
      request({ start, marks: [finish] }),
      {
        field: makeField({ twd: 90, tws: 12, current: { u: drift, v: 0 } }),
        lattice: LATTICE,
      },
    )
    expect(res.ok, res.error).toBe(true)

    // Zermelo in a uniform field: the optimal ground track is the straight line,
    // so crab up-current until the resultant lies on the bearing to the mark,
    // then read off the along-track speed.
    //   boat heading is φ west of north; the constraint is bsp(90 + φ)·sin φ = drift
    let lo = 0
    let hi = 80
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2
      const f = LATTICE.speed(12, 90 + mid) * Math.sin(mid * DEG) - drift
      if (f < 0) lo = mid
      else hi = mid
    }
    const phi = (lo + hi) / 2
    const made = LATTICE.speed(12, 90 + phi) * Math.cos(phi * DEG)
    const expected = (legNm / made) * 3600
    const err = (res.elapsedS! - expected) / expected
    note(
      `10.3 drift ${drift} kn: crab ${phi.toFixed(2)}°, made good ${made.toFixed(4)} kn -> expected ${expected.toFixed(1)} s, got ${res.elapsedS!.toFixed(1)} s (${(err * 100).toFixed(3)}%)`,
    )
    expect(Math.abs(err)).toBeLessThan(0.025)
    expect(res.legs[0].currentDrift).toBeCloseTo(drift, 3)
    expect(res.legs[0].currentSet).toBeCloseTo(90, 3)
  })

  // §10.4 — "If it doesn't, pruning is broken."
  it('refinement convergence: halving the time step changes the answer by less each time', () => {
    const start = { lat: 40, lon: -70 }
    const finish = destination(start, 45, 60)
    // A wind that veers across the course, so the optimal route genuinely bends
    // and there is real discretisation error to converge away.
    const twd = (_lat: number, lon: number): number => wrap360(200 + 55 * (lon + 70))
    const times: number[] = []
    for (const step of [480, 240, 120]) {
      const res = routeIsochrone(
        request({ start, marks: [finish], resolution: 'balanced' }),
        { field: makeField({ twd, tws: 13, gribStepS: step }), lattice: LATTICE },
      )
      expect(res.ok, res.error).toBe(true)
      expect(res.diagnostics.timeStepS).toBeCloseTo(step, 6)
      times.push(res.elapsedS!)
    }
    const d1 = Math.abs(times[0] - times[1])
    const d2 = Math.abs(times[1] - times[2])
    note(
      `10.4 convergence: 480 s -> ${times[0].toFixed(1)} s, 240 s -> ${times[1].toFixed(1)} s, 120 s -> ${times[2].toFixed(1)} s; |Δ1| = ${d1.toFixed(1)} s, |Δ2| = ${d2.toFixed(1)} s`,
    )
    expect(d2).toBeLessThanOrEqual(d1 + 1e-6)
    // …and the whole family agrees to well inside a percent.
    expect(d1 / times[2]).toBeLessThan(0.02)
  })

  // §10.5 — "the strongest single test of the whole pipeline"
  it('forward/backward consistency: T_f(finish) equals T_r(start)', () => {
    const start = { lat: 40, lon: -70 }
    const finish = destination(start, 30, 80)
    const twd = (lat: number, _lon: number): number => wrap360(250 + 40 * (lat - 40))
    const res = routeIsochrone(
      request({ start, marks: [finish], computeSensitivity: true }),
      { field: makeField({ twd, tws: 14 }), lattice: LATTICE },
    )
    expect(res.ok, res.error).toBe(true)
    expect(res.reverseIsochrones.length).toBeGreaterThan(3)
    expect(res.sensitivity).not.toBeNull()

    // The kernel closes the reverse family with the start point itself, stamped
    // at the latest departure time that still makes the ETA. T_r(start) is then
    // ETA − that, and it must equal the forward elapsed time.
    const marker = res.reverseIsochrones[res.reverseIsochrones.length - 1]
    const trStart = (res.etaMs! - marker.t) / 1000
    const errS = Math.abs(trStart - res.elapsedS!)
    note(
      `10.5 forward ${res.elapsedS!.toFixed(1)} s vs backward ${trStart.toFixed(1)} s -> error ${errS.toFixed(2)} s (${((100 * errS) / res.elapsedS!).toFixed(3)}%, Δt = ${res.diagnostics.timeStepS} s)`,
    )
    expect(errS).toBeLessThan(2 * res.diagnostics.timeStepS)
    expect(errS / res.elapsedS!).toBeLessThan(0.02)

    // The sensitivity field must be zero somewhere (on the optimal route) and
    // finite over a useful area.
    const finite = Array.from(res.sensitivity!.loss).filter((v) => isFinite(v))
    expect(finite.length).toBeGreaterThan(20)
    expect(Math.min(...finite)).toBeLessThan(1)
    note(
      `10.5 sensitivity ${res.sensitivity!.nx}x${res.sensitivity!.ny}, ${finite.length} reachable cells, min loss ${Math.min(...finite).toFixed(3)} min`,
    )
  })

  // §10 / §6 — the endpoint-only bug must not survive this.
  it('land avoidance: the route goes round an island and no segment crosses it', () => {
    const start = { lat: 40, lon: -70 }
    const finish = { lat: 40, lon: -69 }
    const island = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-69.56, 39.93],
                [-69.44, 39.93],
                [-69.44, 40.07],
                [-69.56, 40.07],
                [-69.56, 39.93],
              ],
            ],
          },
        },
      ],
    }
    const exact = new PolygonLandMask(extractPolygons(island))
    // Sanity: the problem is real — the direct line does cross the island.
    expect(exact.crosses(start, finish)).toBe(true)

    const mask = buildLandMask(
      island,
      { west: -70.4, south: 39.5, east: -68.6, north: 40.5 },
      0.005,
    )
    const res = routeIsochrone(
      request({ start, marks: [finish], resolution: 'balanced' }),
      { field: makeField({ twd: 0, tws: 14 }), lattice: LATTICE, land: mask },
    )
    expect(res.ok, res.error).toBe(true)

    // Assert on the *segments*, with an independent exact polygon test. An
    // endpoint-only implementation passes a weaker check and fails this one.
    let crossings = 0
    for (let i = 1; i < res.legs.length; i++) {
      if (exact.crosses(res.legs[i - 1].position, res.legs[i].position)) crossings++
      expect(exact.isLand(res.legs[i].position.lat, res.legs[i].position.lon)).toBe(false)
    }
    const direct = distance(start, finish)
    const sailed = routeDistanceNm(res.legs)
    note(
      `10.6 land: ${res.legs.length} legs, ${crossings} crossing land, sailed ${sailed.toFixed(2)} nm vs ${direct.toFixed(2)} nm direct`,
    )
    expect(crossings).toBe(0)
    expect(sailed).toBeGreaterThan(direct * 1.001)
  })

  // The goal hop — the final partial step onto a mark — must check the land
  // mask, or it short-circuits through a peninsula near the mark.
  it('goal hop: the final approach to a mark must not cross land', () => {
    const start = { lat: 40, lon: -71 }
    const finish = { lat: 40, lon: -69 }
    // A thin wall of land right before the mark, spanning enough latitude
    // that the go-around adds real distance. The time step at 'fast' on a
    // ~92 nm leg is large enough that the goal hop can reach the mark from
    // the near side of the wall — and must not.
    const wall = {
      type: 'Polygon',
      coordinates: [
        [
          [-69.03, 39.85],
          [-69.01, 39.85],
          [-69.01, 40.15],
          [-69.03, 40.15],
          [-69.03, 39.85],
        ],
      ],
    }
    const exact = new PolygonLandMask(extractPolygons(wall))
    // Sanity: the direct line crosses the wall.
    expect(exact.crosses(start, finish)).toBe(true)

    const mask = buildLandMask(
      wall,
      { west: -71.5, south: 39.3, east: -68.5, north: 40.7 },
      0.005,
    )
    const res = routeIsochrone(
      request({ start, marks: [finish], resolution: 'fast' }),
      { field: makeField({ twd: 0, tws: 14 }), lattice: LATTICE, land: mask },
    )
    expect(res.ok, res.error).toBe(true)

    // No segment should cross land — including the last hop onto the mark.
    let crossings = 0
    for (let i = 1; i < res.legs.length; i++) {
      if (exact.crosses(res.legs[i - 1].position, res.legs[i].position)) crossings++
    }
    note(
      `goal hop land: ${crossings} crossing segments out of ${res.legs.length - 1}`,
    )
    expect(crossings).toBe(0)
  })

  it('land mask: crosses() catches a segment that hops right over an island', () => {
    const island = {
      type: 'Polygon',
      coordinates: [
        [
          [-69.6, 39.9],
          [-69.4, 39.9],
          [-69.4, 40.1],
          [-69.6, 40.1],
          [-69.6, 39.9],
        ],
      ],
    }
    const mask = buildLandMask(
      island,
      { west: -70.5, south: 39.5, east: -68.5, north: 40.5 },
      0.01,
    )
    // Neither endpoint is on land; the segment straddles the whole island.
    expect(mask.isLand(40, -70)).toBe(false)
    expect(mask.isLand(40, -69)).toBe(false)
    expect(mask.crosses({ lat: 40, lon: -70 }, { lat: 40, lon: -69 })).toBe(true)
    // A segment that passes well to the south is clear.
    expect(mask.crosses({ lat: 39.6, lon: -70 }, { lat: 39.6, lon: -69 })).toBe(false)
  })

  // §10 / constraints
  it('a max-TWS blob forces a detour and never appears in the route', () => {
    const start = { lat: 40, lon: -70 }
    const finish = { lat: 40, lon: -69 }
    // A gale sitting on the rhumb line, 12 nm across.
    const tws = (lat: number, lon: number): number => {
      const dx = (lon + 69.5) * 46
      const dy = (lat - 40) * 60
      return 12 + 22 * Math.exp(-(dx * dx + dy * dy) / 60)
    }
    const res = routeIsochrone(
      request({
        start,
        marks: [finish],
        resolution: 'balanced',
        constraints: { ...defaultConstraints(), maxTws: 20 },
      }),
      { field: makeField({ twd: 0, tws }), lattice: LATTICE },
    )
    expect(res.ok, res.error).toBe(true)
    const worst = Math.max(...res.legs.map((l) => l.tws))
    const sailed = routeDistanceNm(res.legs)
    note(
      `10.7a gale detour: worst TWS on route ${worst.toFixed(2)} kn (limit 20), sailed ${sailed.toFixed(2)} nm vs ${distance(start, finish).toFixed(2)} nm direct`,
    )
    expect(worst).toBeLessThanOrEqual(20 + 1e-6)
    expect(sailed).toBeGreaterThan(distance(start, finish) * 1.001)
  })

  it('an impassable band returns a clean failure, not a throw', () => {
    const start = { lat: 40, lon: -70 }
    const finish = { lat: 40, lon: -69 }
    // A full-width front: there is no way through and no way round.
    const tws = (_lat: number, lon: number): number => (lon > -69.6 && lon < -69.4 ? 40 : 12)
    const res = routeIsochrone(
      request({
        start,
        marks: [finish],
        resolution: 'fast',
        constraints: { ...defaultConstraints(), maxTws: 25 },
      }),
      { field: makeField({ twd: 0, tws }), lattice: LATTICE },
    )
    note(`10.7b impassable band: ok=${res.ok}, error="${res.error ?? ''}"`)
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    expect(res.error!.length).toBeGreaterThan(20)
    expect(res.legs).toHaveLength(0)
  })

  it('never throws on nonsense input', () => {
    const broken: WeatherField = {
      wind: () => {
        throw new Error('provider exploded')
      },
      gust: () => null,
      current: () => null,
      waves: () => null,
      coverage: () => ({ bbox: { west: -1, south: -1, east: 1, north: 1 }, t0: 0, t1: 1 }),
    }
    const res = routeIsochrone(request({ marks: [{ lat: 41, lon: -70 }] }), {
      field: broken,
      lattice: LATTICE,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()

    const noMarks = routeIsochrone(request({ marks: [] }), {
      field: makeField({ twd: 0, tws: 12 }),
      lattice: LATTICE,
    })
    expect(noMarks.ok).toBe(false)
  })

  // §7
  it('routes multiple legs, carrying the arrival time forward', () => {
    const start = { lat: 40, lon: -70 }
    const m1 = destination(start, 45, 25)
    const m2 = destination(m1, 135, 25)
    const res = routeIsochrone(
      request({ start, marks: [m1, m2], resolution: 'balanced' }),
      { field: makeField({ twd: 20, tws: 13 }), lattice: LATTICE },
    )
    expect(res.ok, res.error).toBe(true)
    // The route must actually visit the first mark.
    const closest = Math.min(...res.legs.map((l) => distance(l.position, m1)))
    note(
      `7 multi-leg: ${res.legs.length} legs, closest approach to mark 1 = ${closest.toFixed(4)} nm, ETA ${new Date(res.etaMs!).toISOString()}`,
    )
    expect(closest).toBeLessThan(0.05)
    expect(distance(res.legs[res.legs.length - 1].position, m2)).toBeLessThan(0.05)
    // Times are monotone across the whole multi-leg route.
    for (let i = 1; i < res.legs.length; i++) {
      expect(res.legs[i].t).toBeGreaterThanOrEqual(res.legs[i - 1].t)
    }
  })

  it('reports diagnostics honestly when the forecast runs out', () => {
    const start = { lat: 40, lon: -70 }
    const finish = destination(start, 90, 200)
    const res = routeIsochrone(
      request({ start, marks: [finish], resolution: 'fast' }),
      { field: makeField({ twd: 0, tws: 12, hours: 4 }), lattice: LATTICE },
    )
    expect(res.ok, res.error).toBe(true)
    note(`diagnostics warnings: ${JSON.stringify(res.diagnostics.warnings)}`)
    expect(res.diagnostics.warnings.some((w) => w.includes('forecast ran out'))).toBe(true)
    expect(res.diagnostics.timeStepS).toBeGreaterThan(0)
    expect(res.diagnostics.nodesExplored).toBeGreaterThan(1000)
    expect(res.diagnostics.computeMs).toBeGreaterThan(0)
  })

  it('applies polar and wind scalings', () => {
    const start = { lat: 40, lon: -70 }
    const finish = north(start, 30)
    const ctx = { field: makeField({ twd: 90, tws: 12 }), lattice: LATTICE }
    const base = routeIsochrone(request({ start, marks: [finish] }), ctx)
    const slow = routeIsochrone(
      request({
        start,
        marks: [finish],
        scalings: { ...defaultScalings(), polarPct: 80 },
      }),
      ctx,
    )
    expect(base.ok && slow.ok).toBe(true)
    const ratio = slow.elapsedS! / base.elapsedS!
    note(`scalings: polarPct 80 gives ${ratio.toFixed(4)}x the elapsed time (expect 1.25)`)
    expect(ratio).toBeCloseTo(1.25, 2)

    // Rotating the wind 90° puts the destination dead downwind instead of on
    // the beam, which must change the answer.
    const rotated = routeIsochrone(
      request({
        start,
        marks: [finish],
        scalings: { ...defaultScalings(), windRotateDeg: 90 },
      }),
      ctx,
    )
    expect(rotated.ok).toBe(true)
    expect(Math.abs(rotated.elapsedS! - base.elapsedS!)).toBeGreaterThan(60)
  })

  it('reports a direct-line comparison time', () => {
    const start = { lat: 40, lon: -70 }
    const finish = north(start, 40)
    const res = routeIsochrone(
      request({ start, marks: [finish] }),
      { field: makeField({ twd: 90, tws: 12 }), lattice: LATTICE },
    )
    expect(res.ok, res.error).toBe(true)
    note(
      `direct-line reference ${res.directTimeS!.toFixed(1)} s vs routed ${res.elapsedS!.toFixed(1)} s`,
    )
    // In a uniform beam-reach field the optimum *is* the direct line.
    expect(res.directTimeS).not.toBeNull()
    expect(Math.abs(res.directTimeS! - res.elapsedS!) / res.elapsedS!).toBeLessThan(0.01)
  })

  // §9 / technical-spec §5 performance targets
  it('performance: a 60 nm coastal problem completes well inside 1 s', () => {
    const start = { lat: 40, lon: -70 }
    const finish = destination(start, 60, 60)
    // A realistic-ish field: wind veering with longitude and building with time.
    const twd = (_lat: number, lon: number): number => wrap360(215 + 30 * (lon + 70))
    const tws = (_lat: number, _lon: number, t: Millis): number =>
      11 + 3 * Math.sin((t - T0) / (6 * 3_600_000))
    const ctx = { field: makeField({ twd, tws }), lattice: LATTICE }
    const req = request({ start, marks: [finish], resolution: 'balanced' })

    // Warm the JIT so we measure the kernel, not the first-run compile.
    routeIsochrone(req, ctx)
    const t0 = performance.now()
    const res = routeIsochrone(req, ctx)
    const wall = performance.now() - t0
    expect(res.ok, res.error).toBe(true)
    note(
      `perf 60 nm coastal 'balanced': ${wall.toFixed(0)} ms wall (kernel reports ${res.diagnostics.computeMs.toFixed(0)} ms), ` +
        `Δt ${res.diagnostics.timeStepS.toFixed(0)} s, ${res.diagnostics.nodesExplored.toLocaleString()} candidates, ` +
        `${res.isochrones.length} isochrones, ETA ${(res.elapsedS! / 3600).toFixed(2)} h`,
    )
    expect(wall).toBeLessThan(1000)
  })

  it('performance: a 1500 nm offshore problem completes inside 10 s', () => {
    const start = { lat: 25, lon: -60 }
    const finish = destination(start, 60, 1500)
    const twd = (lat: number, lon: number): number => wrap360(240 + 1.6 * (lon + 60) - 1.1 * (lat - 25))
    const tws = (lat: number, _lon: number, t: Millis): number =>
      13 + 4 * Math.sin((lat - 25) / 6) + 2 * Math.sin((t - T0) / (12 * 3_600_000))
    const ctx = { field: makeField({ twd, tws, hours: 24 * 14 }), lattice: LATTICE }
    const req = request({ start, marks: [finish], resolution: 'balanced' })
    const t0 = performance.now()
    const res = routeIsochrone(req, ctx)
    const wall = performance.now() - t0
    expect(res.ok, res.error).toBe(true)
    note(
      `perf 1500 nm offshore 'balanced': ${wall.toFixed(0)} ms wall, Δt ${(res.diagnostics.timeStepS / 3600).toFixed(2)} h, ` +
        `${res.diagnostics.nodesExplored.toLocaleString()} candidates, ETA ${(res.elapsedS! / 86400).toFixed(2)} days`,
    )
    expect(wall).toBeLessThan(10_000)
  })

  it('performance: a 2 nm buoy leg completes inside 100 ms', () => {
    const start = { lat: 40, lon: -70 }
    const finish = north(start, 2)
    const ctx = { field: makeField({ twd: 0, tws: 10 }), lattice: LATTICE }
    const timings: Record<string, number> = {}
    for (const resolution of ['balanced', 'best'] as const) {
      const req = request({ start, marks: [finish], resolution })
      routeIsochrone(req, ctx)
      const t0 = performance.now()
      const res = routeIsochrone(req, ctx)
      timings[resolution] = performance.now() - t0
      expect(res.ok, res.error).toBe(true)
      note(
        `perf 2 nm buoy leg '${resolution}': ${timings[resolution].toFixed(1)} ms, Δt ${res.diagnostics.timeStepS} s, ${res.diagnostics.nodesExplored.toLocaleString()} candidates`,
      )
    }
    // The spec target is the preset a boat would actually have running live.
    expect(timings.balanced).toBeLessThan(100)
    // 'best' quadruples the frontier for the same two miles; it is a "plan the
    // start sequence" setting, not a live one.
    expect(timings.best).toBeLessThan(400)
  })

  it('prints the measured summary', () => {
    expect(report.length).toBeGreaterThan(0)
  })
})

describe('heading fan and VMG injection', () => {
  it('finds the exact target angle even when the fan step would miss it', () => {
    // The fan step is 5° at 'best'; the target TWA is not a multiple of 5°.
    const tgt = LATTICE.targetsAt(12)
    expect(Math.abs(tgt.upTwa % 5)).toBeGreaterThan(0.1)
    const start = { lat: 40, lon: -70 }
    // Destination just outside the no-go zone, so the optimum is to sail the
    // target angle exactly rather than substitute a beat.
    const finish = destination(start, wrap360(tgt.upTwa), 25)
    const res = routeIsochrone(
      request({ start, marks: [finish] }),
      { field: makeField({ twd: 0, tws: 12 }), lattice: LATTICE },
    )
    expect(res.ok, res.error).toBe(true)
    const expected = (distance(start, finish) / LATTICE.speed(12, tgt.upTwa)) * 3600
    const err = (res.elapsedS! - expected) / expected
    note(
      `fan: sailing the exact target TWA ${tgt.upTwa.toFixed(2)}° -> expected ${expected.toFixed(1)} s, got ${res.elapsedS!.toFixed(1)} s (${(err * 100).toFixed(3)}%)`,
    )
    expect(Math.abs(err)).toBeLessThan(0.01)
  })

  it('substitutes gybing angles for a dead square run when it is faster', () => {
    const start = { lat: 40, lon: -70 }
    const finish = north(start, 40)
    const res = routeIsochrone(
      request({ start, marks: [finish] }),
      { field: makeField({ twd: 180, tws: 12 }), lattice: LATTICE },
    )
    expect(res.ok, res.error).toBe(true)
    const tgt = LATTICE.targetsAt(12)
    const expected = (distance(start, finish) / Math.abs(tgt.downVmg)) * 3600
    const err = (res.elapsedS! - expected) / expected
    note(
      `fan: dead run, gybing VMG ${Math.abs(tgt.downVmg).toFixed(4)} kn at ${tgt.downTwa.toFixed(2)}° -> expected ${expected.toFixed(1)} s, got ${res.elapsedS!.toFixed(1)} s (${(err * 100).toFixed(3)}%)`,
    )
    expect(Math.abs(err)).toBeLessThan(0.01)
    expect(res.legs[0].isBeating).toBe(true)
    // Dead downwind is genuinely slower than gybing on this polar.
    expect(Math.abs(tgt.downVmg)).toBeGreaterThan(LATTICE.speed(12, 180))
  })
})

describe('land mask internals', () => {
  it('rasterises a polygon and keeps holes open', () => {
    const donut = {
      type: 'Polygon',
      coordinates: [
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
          [-1, -1],
        ],
        [
          [-0.4, -0.4],
          [0.4, -0.4],
          [0.4, 0.4],
          [-0.4, 0.4],
          [-0.4, -0.4],
        ],
      ],
    }
    const exact = new PolygonLandMask(extractPolygons(donut))
    expect(exact.isLand(0.7, 0.7)).toBe(true)
    expect(exact.isLand(0, 0)).toBe(false)
    expect(exact.isLand(5, 5)).toBe(false)

    const mask = buildLandMask(donut, { west: -2, south: -2, east: 2, north: 2 }, 0.02)
    expect(mask.isLand(0.7, 0.7)).toBe(true)
    expect(mask.isLand(0, 0)).toBe(false)
    // A segment through the middle of the donut still crosses the walls.
    expect(mask.crosses({ lat: 0, lon: -1.5 }, { lat: 0, lon: 1.5 })).toBe(true)
    // A segment entirely inside the hole does not.
    expect(mask.crosses({ lat: -0.2, lon: -0.2 }, { lat: 0.2, lon: 0.2 })).toBe(false)
  })

  it('tolerates junk geojson', () => {
    expect(extractPolygons(null)).toHaveLength(0)
    expect(extractPolygons({ type: 'Nonsense' })).toHaveLength(0)
    expect(extractPolygons({ type: 'Polygon' })).toHaveLength(0)
    const mask = buildLandMask({ type: 'Point', coordinates: [0, 0] }, { west: -1, south: -1, east: 1, north: 1 }, 0.1)
    expect(mask.isLand(0, 0)).toBe(false)
    expect(mask.crosses({ lat: -1, lon: -1 }, { lat: 1, lon: 1 })).toBe(false)
  })
})

describe('worker protocol', () => {
  /**
   * End-to-end through the real `buildLattice` and `CubeField` rather than the
   * fakes above. This is the only test that touches the sibling modules, and it
   * is here to prove the wire contract — cube in, lattice in, progress out,
   * result out — not to re-test the kernel.
   */
  it('rebuilds its inputs from a cube and a polar table, and reports progress', async () => {
    const { handleRouteMessage } = await import('./worker')

    const twas = [0, 30, 40, 50, 60, 75, 90, 110, 120, 135, 150, 165, 180]
    const polar: PolarTable = {
      name: 'analytic',
      reference: '10m',
      tws: [4, 8, 12, 16, 20],
      rows: [4, 8, 12, 16, 20].map((w) => ({
        twa: twas,
        bsp: twas.map((a) => analyticSpeed(w, a)),
      })),
    }

    // 12 kn from due east over a 2° box, hourly for 24 h.
    const nx = 9
    const ny = 9
    const nt = 25
    const n = nx * ny * nt
    const u = new Float32Array(n)
    const v = new Float32Array(n)
    u.fill(-12 * Math.sin(90 * DEG))
    v.fill(-12 * Math.cos(90 * DEG))
    const cube = {
      model: 'test',
      run: '2026-06-15T06:00:00Z',
      bbox: { west: -71, south: 39.5, east: -69, north: 41.5 },
      nx,
      ny,
      dx: 0.25,
      dy: 0.25,
      t0: T0 - 3_600_000,
      dtMs: 3_600_000,
      nt,
      params: ['u10', 'v10'],
      data: { u10: u, v10: v },
    }

    const start = { lat: 40, lon: -70 }
    const req = request({ start, marks: [north(start, 20)], resolution: 'balanced' })
    const messages: RouteWorkerResponse[] = []
    await handleRouteMessage({ type: 'route', id: 7, req, cube, polarTable: polar }, (m) =>
      messages.push(m),
    )

    const result = messages.find((m) => m.type === 'result')
    expect(result).toBeDefined()
    expect(result!.id).toBe(7)
    expect(messages.some((m) => m.type === 'progress')).toBe(true)
    if (result?.type !== 'result') throw new Error('unreachable')

    // Beam reach again, this time through the production polar interpolator.
    const r = result.result
    expect(r.ok, r.error).toBe(true)
    note(
      `worker round-trip: ETA ${(r.elapsedS! / 3600).toFixed(3)} h over 20 nm, ${r.legs.length} legs, Δt ${r.diagnostics.timeStepS} s`,
    )
    expect(r.legs.length).toBeGreaterThan(3)
    expect(distance(r.legs[r.legs.length - 1].position, req.marks[0])).toBeLessThan(0.05)
  })
})

describe('solar helper', () => {
  it('puts civil night where it belongs', async () => {
    const { isNight, solarElevationDeg } = await import('./isochrone')
    // Boston, midsummer. Local noon is about 16:00 UTC.
    expect(isNight(42.3, -71.1, Date.UTC(2026, 5, 21, 16, 0))).toBe(false)
    expect(isNight(42.3, -71.1, Date.UTC(2026, 5, 21, 5, 0))).toBe(true)
    // Midwinter, mid-afternoon local, sun is up but low.
    const el = solarElevationDeg(42.3, -71.1, Date.UTC(2026, 11, 21, 17, 0))
    expect(el).toBeGreaterThan(0)
    expect(el).toBeLessThan(30)
    // The bearing helper is exercised elsewhere; keep the import honest.
    expect(bearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 6)
  })
})

// --------------------------------------------------------------------------
// Kernel invariants, swept rather than exemplified.
//
// The suite above establishes correctness on the cases where the answer can be
// written down. This section asserts the properties that must hold on EVERY
// solve, across a spread of winds, currents, courses and resolutions. 1915 lines
// of kernel had 25 example tests; these are the checks that do not need to know
// the right answer in order to catch a wrong one.
// --------------------------------------------------------------------------

describe('kernel invariants', () => {
  interface Scenario {
    label: string
    req: RouteRequest
    field: WeatherField
  }

  function scenarios(): Scenario[] {
    const start = { lat: 40, lon: -70 }
    const out: Scenario[] = []
    const resolutions = ['fast', 'balanced', 'best'] as const

    // A spread of beats, reaches and runs.
    const winds = [0, 45, 90, 180, 270]
    for (let i = 0; i < winds.length; i++) {
      const twd = winds[i]
      out.push({
        label: `twd ${twd}, 12 kn, no current`,
        field: makeField({ twd, tws: 12 }),
        req: request({ marks: [north(start, 12)], resolution: resolutions[i % 3] }),
      })
    }

    out.push({
      label: 'cross current',
      field: makeField({ twd: 180, tws: 12, current: { u: 1.5, v: 0 } }),
      req: request({ marks: [north(start, 10)] }),
    })
    out.push({
      label: 'wind gradient with latitude',
      field: makeField({ twd: 200, tws: (lat) => 6 + (lat - 40) * 20 }),
      req: request({ marks: [north(start, 8)] }),
    })
    out.push({
      label: 'veering wind with time',
      field: makeField({ twd: (_lat, _lon, t) => 180 + ((t - T0) / 3_600_000) * 10, tws: 11 }),
      req: request({ marks: [north(start, 10)] }),
    })
    out.push({
      label: 'two legs',
      field: makeField({ twd: 225, tws: 13 }),
      req: request({ marks: [north(start, 6), destination(north(start, 6), 90, 5)] }),
    })
    out.push({
      label: 'light air',
      field: makeField({ twd: 90, tws: 3.5 }),
      req: request({ marks: [north(start, 4)] }),
    })
    out.push({
      label: 'scaled polar and rotated wind',
      field: makeField({ twd: 200, tws: 14 }),
      req: request({
        marks: [north(start, 9)],
        scalings: { ...defaultScalings(), polarPct: 85, windRotateDeg: 12, windScalePct: 110 },
      }),
    })
    return out
  }

  const solved = scenarios().map((s) => ({
    ...s,
    result: routeIsochrone(s.req, { field: s.field, lattice: LATTICE, land: null }),
  }))

  it('solves every scenario', () => {
    for (const s of solved) {
      expect(s.result.ok, `${s.label}: ${s.result.error ?? ''}`).toBe(true)
      expect(s.result.legs.length, s.label).toBeGreaterThan(1)
    }
  })

  it('never emits a NaN or an infinity in a leg', () => {
    for (const s of solved) {
      for (let i = 0; i < s.result.legs.length; i++) {
        const l = s.result.legs[i]
        for (const [k, v] of Object.entries(l)) {
          if (typeof v === 'number') {
            expect(Number.isFinite(v), `${s.label} leg ${i}: ${k} is ${v}`).toBe(true)
          }
        }
        expect(Number.isFinite(l.position.lat), `${s.label} leg ${i}: lat`).toBe(true)
        expect(Number.isFinite(l.position.lon), `${s.label} leg ${i}: lon`).toBe(true)
      }
    }
  })

  it('keeps every angle in its documented range', () => {
    for (const s of solved) {
      for (let i = 0; i < s.result.legs.length; i++) {
        const l = s.result.legs[i]
        const at = `${s.label} leg ${i}`
        expect(l.twd, `${at} twd`).toBeGreaterThanOrEqual(0)
        expect(l.twd, `${at} twd`).toBeLessThan(360)
        expect(l.heading, `${at} heading`).toBeGreaterThanOrEqual(0)
        expect(l.heading, `${at} heading`).toBeLessThan(360)
        expect(Math.abs(l.twa), `${at} twa`).toBeLessThanOrEqual(180)
        expect(l.tws, `${at} tws`).toBeGreaterThanOrEqual(0)
        expect(l.bsp, `${at} bsp`).toBeGreaterThanOrEqual(0)
        expect(l.distanceNm, `${at} distanceNm`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('reports an elapsed time that matches its own ETA and leg clock', () => {
    for (const s of solved) {
      const legs = s.result.legs
      expect(s.result.etaMs, s.label).not.toBeNull()
      expect(s.result.elapsedS, s.label).not.toBeNull()
      const eta = s.result.etaMs as number
      const elapsed = s.result.elapsedS as number

      expect(eta - s.req.startTime, `${s.label}: eta vs elapsed`).toBeCloseTo(elapsed * 1000, 3)
      expect(legs[legs.length - 1].t, `${s.label}: last leg is the ETA`).toBeCloseTo(eta, 3)
      /*
       * Non-decreasing, not strictly increasing. A zero-duration leg does occur -
       * arriving at a mark exactly on a step boundary produces one - and it is
       * harmless as long as the clock never runs backwards, which is the property
       * that would actually break an ETA.
       */
      for (let i = 1; i < legs.length; i++) {
        expect(legs[i].t, `${s.label} leg ${i} clock`).toBeGreaterThanOrEqual(legs[i - 1].t)
      }
    }
  })

  it('moves each leg at the speed it claims to be sailing', () => {
    /*
     * The invariant that needs no ground truth: whatever the kernel decided, the
     * distance between two consecutive legs must equal the reported speed times
     * the time between them. If those disagree, every derived number - the ETA,
     * distance to finish, the results table - describes a boat that did not sail
     * the drawn line.
     *
     * Checked only where there is no current, because with a set running, speed
     * through the water is deliberately not speed over ground. Beating legs are
     * included: their bsp is the VMG-equivalent speed along the drawn path, which
     * is exactly what this measures.
     */
    for (const s of solved) {
      if (s.label.includes('current')) continue
      const legs = s.result.legs
      for (let i = 1; i < legs.length; i++) {
        const dtH = (legs[i].t - legs[i - 1].t) / 3_600_000
        if (dtH <= 0) continue
        const moved = distance(legs[i - 1].position, legs[i].position)
        const claimed = legs[i].bsp * dtH
        // 2% or a tenth of a mile, whichever is larger: leg positions are
        // great-circle steps and the speed is a mean over the step.
        const tol = Math.max(0.1, claimed * 0.02)
        expect(
          Math.abs(moved - claimed),
          `${s.label} leg ${i}: moved ${moved.toFixed(3)} nm, claimed ${claimed.toFixed(3)} nm`,
        ).toBeLessThan(tol)
      }
    }
  })

  it('measures distanceNm forward, to the next leg', () => {
    /*
     * The field is the distance OUT of a leg, not into it - `P.dist[nxt]` at the
     * emit site, while twa, bsp and heading all come from `src`. The natural
     * reading is the other one, which is why this is pinned and why the type now
     * says so: the value leaves the app as the `dist_nm` CSV column.
     */
    for (const s of solved) {
      const legs = s.result.legs
      for (let i = 0; i < legs.length - 1; i++) {
        const ahead = distance(legs[i].position, legs[i + 1].position)
        const tol = Math.max(0.1, ahead * 0.02)
        expect(
          Math.abs(legs[i].distanceNm - ahead),
          `${s.label} leg ${i}: distanceNm ${legs[i].distanceNm.toFixed(3)} vs ${ahead.toFixed(3)} ahead`,
        ).toBeLessThan(tol)
      }
      // Nowhere left to go from the last one.
      expect(legs[legs.length - 1].distanceNm, `${s.label}: last leg`).toBe(0)
    }
  })

  it('never sails faster than the polar allows for the angle it reports', () => {
    // Excludes beating legs, whose reported bsp is a VMG-equivalent along a
    // zigzag rather than the polar speed at the drawn heading.
    for (const s of solved) {
      const pct = s.req.scalings.polarPct / 100
      for (let i = 0; i < s.result.legs.length; i++) {
        const l = s.result.legs[i]
        if (l.isBeating) continue
        const ceiling = LATTICE.speed(l.tws, l.twa) * pct
        expect(
          l.bsp,
          `${s.label} leg ${i}: bsp ${l.bsp.toFixed(3)} over polar ${ceiling.toFixed(3)} at twa ${l.twa.toFixed(1)}`,
        ).toBeLessThan(ceiling + 0.35)
      }
    }
  })

  it('finishes at the last mark', () => {
    for (const s of solved) {
      const marks = s.req.marks
      const last = s.result.legs[s.result.legs.length - 1]
      expect(
        distance(last.position, marks[marks.length - 1]),
        `${s.label}: finished short of the mark`,
      ).toBeLessThan(0.75)
    }
  })

  it('gives the same answer twice for the same question', { timeout: 60_000 }, () => {
    /*
     * Determinism is not a nicety. Every claim this project makes about the
     * confidence band, and every bug anyone chases in a route, assumes the same
     * inputs produce the same route. Map iteration order, float accumulation or a
     * stray Date.now() in the kernel would each break it silently, and the symptom
     * would be a route that changes when you press the button again.
     */
    for (const s of solved) {
      const again = routeIsochrone(s.req, { field: s.field, lattice: LATTICE, land: null })
      expect(again.ok, s.label).toBe(s.result.ok)
      expect(again.legs.length, `${s.label}: leg count`).toBe(s.result.legs.length)
      expect(again.elapsedS, `${s.label}: elapsed`).toBe(s.result.elapsedS)
      for (let i = 0; i < again.legs.length; i++) {
        expect(again.legs[i].position.lat, `${s.label} leg ${i} lat`).toBe(
          s.result.legs[i].position.lat,
        )
        expect(again.legs[i].position.lon, `${s.label} leg ${i} lon`).toBe(
          s.result.legs[i].position.lon,
        )
        expect(again.legs[i].bsp, `${s.label} leg ${i} bsp`).toBe(s.result.legs[i].bsp)
      }
    }
  })

  it('emits isochrones in increasing time order, inside the route window', () => {
    for (const s of solved) {
      const iso = s.result.isochrones
      expect(iso.length, s.label).toBeGreaterThan(0)
      /*
       * NOT globally monotonic, and that is structural rather than a defect: a
       * multi-leg route concatenates one series per leg, and leg two starts from
       * the arrival time at mark one while leg one's grid may have reached past it.
       * So the assertion is that the series only ever steps backwards where a new
       * leg begins, never within a leg.
       */
      let backwards = 0
      for (let k = 1; k < iso.length; k++) {
        if (iso[k].t < iso[k - 1].t) backwards++
      }
      expect(backwards, `${s.label}: isochrone series restarts`).toBeLessThan(
        Math.max(1, s.req.marks.length),
      )
      for (const ring of iso) {
        expect(ring.t, `${s.label}: isochrone before the start`).toBeGreaterThanOrEqual(
          s.req.startTime,
        )
        for (const p of ring.points) {
          expect(Number.isFinite(p.lat), `${s.label}: isochrone lat`).toBe(true)
          expect(Number.isFinite(p.lon), `${s.label}: isochrone lon`).toBe(true)
        }
      }
    }
  })

  it('reports diagnostics that describe the solve it actually did', () => {
    for (const s of solved) {
      const d = s.result.diagnostics
      expect(d.nodesExplored, s.label).toBeGreaterThan(0)
      expect(d.timeStepS, s.label).toBeGreaterThan(0)
      expect(Number.isFinite(d.computeMs), s.label).toBe(true)
      expect(Array.isArray(d.warnings), s.label).toBe(true)
      // The step must not exceed the whole elapsed time, which would mean the
      // route was decided in fewer than two steps.
      expect(d.timeStepS, `${s.label}: step vs elapsed`).toBeLessThanOrEqual(
        (s.result.elapsedS as number) + 1,
      )
    }
  })
})

describe('wind time shift does not drag current or waves', () => {
  it('queries current at unshifted time', () => {
    const windCalls: Array<[number, number, number]> = []
    const currentCalls: Array<[number, number, number]> = []
    const t0Field = Date.UTC(2026, 5, 15, 6, 0, 0)
    const shiftS = 3600
    const shiftMs = shiftS * 1000

    const field: WeatherField = {
      wind(lat: number, lon: number, t: Millis) {
        windCalls.push([lat, lon, t])
        return { u: 0, v: -12, source: 'test' }
      },
      gust: () => null,
      current(lat: number, lon: number, t: Millis) {
        currentCalls.push([lat, lon, t])
        return { u: 0.5, v: 0, source: 'test' }
      },
      waves: () => null,
      coverage: () => ({
        bbox: { west: -180, south: -85, east: 180, north: 85 },
        t0: t0Field,
        t1: t0Field + 72 * 3_600_000,
      }),
    }

    const start: LatLon = { lat: 40, lon: -70 }
    const mark = destination(start, 0, 10)
    const req = request({
      start,
      marks: [mark],
      scalings: { ...defaultScalings(), windTimeShiftS: shiftS },
    })

    routeIsochrone(req, { field, lattice: LATTICE })

    expect(windCalls.length).toBeGreaterThan(0)

    // hydrate probes current at 3 spatial points before the grid loop, so
    // skip those; the remaining calls pair 1:1 with wind calls.
    const gridCurrentCalls = currentCalls.slice(3)
    expect(gridCurrentCalls.length).toBe(windCalls.length)

    for (let i = 0; i < windCalls.length; i++) {
      const [wLat, wLon, wT] = windCalls[i]
      const [cLat, cLon, cT] = gridCurrentCalls[i]
      expect(cLat).toBe(wLat)
      expect(cLon).toBe(wLon)
      expect(
        cT - wT,
        'current must be queried shiftMs later than wind (i.e. at the unshifted time)',
      ).toBe(shiftMs)
    }
  })
})
