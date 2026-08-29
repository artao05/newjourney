/**
 * Departure sweep tests.
 *
 * The routing function is injected, so these drive it with analytic stubs whose
 * right answer is known by construction — no weather, no polar, no worker. That
 * is the point of taking `route` as a parameter rather than importing the kernel.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  departureAdvice,
  planDepartures,
  sweepDepartures,
  type RouteFn,
} from './departure'
import { routeIsochrone, type RouteContext } from './isochrone'
import type {
  PolarLattice,
  PolarTable,
  RouteRequest,
  RouteResult,
  Targets,
  WeatherCube,
  WeatherField,
} from '../types'
import type { SweepWorkerResponse } from './worker'

const T0 = Date.UTC(2026, 7, 6, 6, 0)
const MIN = 60_000
const HOUR = 3_600_000

const REQUEST = {
  start: { lat: 43.6, lon: -70.2 },
  startTime: 0,
  marks: [{ lat: 43.7, lon: -70.1 }],
  constraints: { avoidLand: false },
  scalings: {
    polarPct: 100,
    polarPctNight: 100,
    windScalePct: 100,
    windRotateDeg: 0,
    windTimeShiftS: 0,
    currentScalePct: 100,
  },
  resolution: 'fast',
  computeSensitivity: false,
} as unknown as RouteRequest

const CTX = {} as RouteContext

/** A result carrying just the fields the sweep reads. */
function ok(startTime: number, elapsedS: number, timeStepS = 60): RouteResult {
  return {
    ok: true,
    legs: [],
    etaMs: startTime + elapsedS * 1000,
    elapsedS,
    directTimeS: elapsedS,
    isochrones: [],
    reverseIsochrones: [],
    sensitivity: null,
    diagnostics: { nodesExplored: 0, timeStepS, computeMs: 0, landAvoided: false, warnings: [] },
  } as unknown as RouteResult
}

function fail(error: string): RouteResult {
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
    diagnostics: { nodesExplored: 0, timeStepS: 0, computeMs: 0, landAvoided: false, warnings: [] },
  } as unknown as RouteResult
}

/**
 * A tide gate: leaving at the sweet spot is fast, and it costs you linearly the
 * further either side you leave. The minimum is at `sweetSpot` by construction.
 */
function gateRouter(sweetSpot: number, baseS = 3600, penaltyPerHourS = 1800): RouteFn {
  return (req) => {
    const offHours = Math.abs(req.startTime - sweetSpot) / HOUR
    return ok(req.startTime, baseS + offHours * penaltyPerHourS)
  }
}

describe('planDepartures', () => {
  it('walks the window inclusively at the requested step', () => {
    const { departures, widened } = planDepartures(T0, T0 + 2 * HOUR, HOUR)
    expect(departures).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR])
    expect(widened).toBe(false)
  })

  it('widens the step rather than truncating the window', () => {
    /*
     * The important behaviour. A sweep that stopped at the cap would report the
     * best of the first few hours and call it the best departure, which is a
     * confidently wrong answer rather than a coarse one.
     */
    const { departures, stepMs, widened } = planDepartures(T0, T0 + 12 * HOUR, 10 * MIN, 6)
    expect(widened).toBe(true)
    expect(departures.length).toBeLessThanOrEqual(6)
    expect(stepMs).toBeGreaterThan(10 * MIN)
    // Both ends of the requested window are still evaluated.
    expect(departures[0]).toBe(T0)
    expect(departures[departures.length - 1]).toBe(T0 + 12 * HOUR)
  })

  it('includes the window end even when the step does not divide it', () => {
    const { departures } = planDepartures(T0, T0 + 95 * MIN, 30 * MIN)
    expect(departures[0]).toBe(T0)
    expect(departures[departures.length - 1]).toBe(T0 + 95 * MIN)
  })

  it('degenerates safely for a zero-length window', () => {
    const { departures } = planDepartures(T0, T0, 30 * MIN)
    expect(departures).toEqual([T0])
  })

  it('does not loop forever on a reversed window', () => {
    const { departures } = planDepartures(T0, T0 - HOUR, 30 * MIN)
    expect(departures).toEqual([T0])
  })
})

describe('sweepDepartures', () => {
  it('finds the departure the router actually makes fastest', () => {
    const sweet = T0 + 3 * HOUR
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: gateRouter(sweet),
      from: T0,
      to: T0 + 6 * HOUR,
      stepMs: HOUR,
    })
    expect(sweep.succeeded).toBe(7)
    expect(sweep.best?.departAt).toBe(sweet)
    expect(sweep.best?.elapsedS).toBeCloseTo(3600, 6)
  })

  it('never mutates the caller’s request', () => {
    // The sweep overrides startTime per solve; doing that in place would leave the
    // caller's template holding the last departure tried.
    const before = { ...REQUEST }
    sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: gateRouter(T0),
      from: T0,
      to: T0 + HOUR,
      stepMs: HOUR,
    })
    expect(REQUEST).toEqual(before)
  })

  it('passes each departure through as startTime', () => {
    const seen: number[] = []
    const route: RouteFn = (req) => {
      seen.push(req.startTime)
      return ok(req.startTime, 100)
    }
    sweepDepartures({ request: REQUEST, ctx: CTX, route, from: T0, to: T0 + 2 * HOUR, stepMs: HOUR })
    expect(seen).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR])
  })

  it('reports cost relative to the winner, not absolute elapsed', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: gateRouter(T0, 3600, 1800),
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
    })
    // Best is T0 at 3600 s; +1 h costs 1800 s; +2 h costs 3600 s.
    expect(sweep.options.map((d) => d.costS)).toEqual([0, 1800, 3600])
  })

  it('reports the spread, which is the number that says whether timing matters', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: gateRouter(T0, 3600, 1800),
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
    })
    expect(sweep.spreadS).toBe(3600)
  })

  it('has no spread from a single solve rather than claiming zero', () => {
    // Zero spread would read as "departure does not matter", which one data point
    // cannot support.
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: gateRouter(T0),
      from: T0,
      to: T0,
      stepMs: HOUR,
    })
    expect(sweep.succeeded).toBe(1)
    expect(sweep.spreadS).toBeNull()
  })

  it('keeps going when one departure fails, and records why', () => {
    const route: RouteFn = (req) =>
      req.startTime === T0 + HOUR ? fail('every heading blocked by land') : ok(req.startTime, 1200)
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route,
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
    })
    expect(sweep.attempted).toBe(3)
    expect(sweep.succeeded).toBe(2)
    expect(sweep.options[1].elapsedS).toBeNull()
    expect(sweep.options[1].error).toMatch(/blocked by land/)
    expect(sweep.best).not.toBeNull()
  })

  it('survives a router that throws, which the kernel promises not to do', () => {
    const route: RouteFn = (req) => {
      if (req.startTime === T0) throw new Error('kaboom')
      return ok(req.startTime, 900)
    }
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route,
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
    })
    expect(sweep.options[0].error).toBe('kaboom')
    expect(sweep.succeeded).toBe(2)
  })

  it('returns no best and says so when nothing routes', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: () => fail('no wind data'),
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
    })
    expect(sweep.best).toBeNull()
    expect(sweep.spreadS).toBeNull()
    expect(sweep.warnings.join(' ')).toMatch(/No departure/)
  })

  it('stops when asked, and says how far it got', () => {
    let calls = 0
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) => {
        calls++
        return ok(req.startTime, 600)
      },
      from: T0,
      to: T0 + 10 * HOUR,
      stepMs: HOUR,
      shouldStop: () => calls >= 3,
    })
    expect(calls).toBe(3)
    expect(sweep.warnings.join(' ')).toMatch(/cancelled after 3 of 11/)
  })

  it('warns when it widened the step, so a coarse answer is not passed off as fine', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: gateRouter(T0),
      from: T0,
      to: T0 + 12 * HOUR,
      stepMs: 5 * MIN,
      maxSolves: 5,
    })
    expect(sweep.attempted).toBeLessThanOrEqual(5)
    expect(sweep.warnings.join(' ')).toMatch(/widened/)
  })

  it('forces sensitivity off — the sweep never reads it and pays twice for one', () => {
    const flags: unknown[] = []
    sweepDepartures({
      request: { ...REQUEST, computeSensitivity: true } as RouteRequest,
      ctx: CTX,
      route: (req) => {
        flags.push(req.computeSensitivity)
        return ok(req.startTime, 600)
      },
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
    })
    expect(flags).toEqual([false, false, false])
  })

  it('reports progress once per departure', () => {
    const onProgress = vi.fn()
    sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) => ok(req.startTime, 300),
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
      onProgress,
    })
    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress).toHaveBeenLastCalledWith(3, 3)
  })
})

describe('the resolution floor', () => {
  /*
   * The kernel probes the wind at `startTime` to pick its time step, so a sweep
   * genuinely solves each departure at a different discretisation — and a
   * departure into light air gets the coarsest search of the set. These pin the
   * consequence: the sweep reports how coarse it was, and refuses to rank inside
   * that.
   */
  it('takes the floor from the coarsest successful solve, not the average', () => {
    const steps = new Map([
      [T0, 1800],
      [T0 + HOUR, 300],
      [T0 + 2 * HOUR, 600],
    ])
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) => ok(req.startTime, 7200, steps.get(req.startTime)),
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
    })
    expect(sweep.stepFloorS).toBe(1800)
    expect(sweep.options.map((d) => d.timeStepS)).toEqual([1800, 300, 600])
  })

  it('ignores the step of a departure that failed', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) => (req.startTime === T0 ? fail('no route') : ok(req.startTime, 3600, 120)),
      from: T0,
      to: T0 + HOUR,
      stepMs: HOUR,
    })
    expect(sweep.options[0].timeStepS).toBeNull()
    expect(sweep.stepFloorS).toBe(120)
  })

  it('warns in the sweep itself when the spread is inside the floor', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      // 5 min apart, solved with a 30 min step.
      route: (req) => ok(req.startTime, req.startTime === T0 ? 3600 : 3900, 1800),
      from: T0,
      to: T0 + HOUR,
      stepMs: HOUR,
    })
    expect(sweep.spreadS).toBe(300)
    expect(sweep.warnings.join(' ')).toMatch(/not distinguishable at this resolution/)
  })

  it('is null when nothing routed, so no floor is implied', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: () => fail('nope'),
      from: T0,
      to: T0 + HOUR,
      stepMs: HOUR,
    })
    expect(sweep.stepFloorS).toBeNull()
  })
})

describe('departureAdvice', () => {
  const sweepWith = (baseS: number, penaltyPerHourS: number) =>
    sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: gateRouter(T0, baseS, penaltyPerHourS),
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
    })

  it('says timing barely matters when the spread is a small fraction of the passage', () => {
    // 3 day passage, 20 min spread.
    const a = departureAdvice(sweepWith(72 * HOUR / 1000, 600))
    expect(a?.matters).toBe(false)
    expect(a?.text).toMatch(/barely matters/)
  })

  it('says timing dominates when the spread is a big fraction of the passage', () => {
    // 1 h passage, 1 h spread.
    const a = departureAdvice(sweepWith(3600, 1800))
    expect(a?.matters).toBe(true)
    expect(a?.text).toMatch(/dominates/)
  })

  it('judges by fraction of the passage, not absolute minutes', () => {
    /*
     * The same 30-minute spread is decisive on a two-hour race and irrelevant on a
     * three-day passage. A fixed minute threshold would get one of them wrong.
     */
    const short = departureAdvice(sweepWith(2 * HOUR / 1000, 900))
    const long = departureAdvice(sweepWith(72 * HOUR / 1000, 900))
    expect(short?.matters).toBe(true)
    expect(long?.matters).toBe(false)
  })

  it('refuses to rank a spread inside the router’s own time step', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) => ok(req.startTime, req.startTime === T0 ? 3600 : 4200, 1800),
      from: T0,
      to: T0 + HOUR,
      stepMs: HOUR,
    })
    const a = departureAdvice(sweep)
    expect(a?.matters).toBe(false)
    expect(a?.text).toMatch(/No usable difference/)
    expect(a?.text).toMatch(/30 min time step/)
  })

  it('checks the floor before the fraction, which is where it actually bites', () => {
    /*
     * This ordering is the whole point. A 10 min spread on a 1 h race is 17% of
     * the passage — "departure dominates" by the fraction rule — while the search
     * that produced it was stepping 30 min at a time. A short race is exactly the
     * case where a small spread looks significant AND where the step is
     * proportionally largest, so the fraction rule alone is confidently wrong
     * precisely when it matters most.
     */
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) => ok(req.startTime, req.startTime === T0 ? 3600 : 4200, 1800),
      from: T0,
      to: T0 + HOUR,
      stepMs: HOUR,
    })
    expect(sweep.spreadS! / sweep.best!.elapsedS!).toBeGreaterThan(0.1)
    expect(departureAdvice(sweep)?.matters).toBe(false)
  })

  it('still ranks a spread comfortably clear of the floor', () => {
    // Same shape, fine step: now the difference is real and it says so.
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) => ok(req.startTime, req.startTime === T0 ? 3600 : 4200, 60),
      from: T0,
      to: T0 + HOUR,
      stepMs: HOUR,
    })
    expect(departureAdvice(sweep)?.matters).toBe(true)
    expect(departureAdvice(sweep)?.text).toMatch(/dominates/)
  })

  it('is null when there is nothing honest to say', () => {
    const single = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: gateRouter(T0),
      from: T0,
      to: T0,
      stepMs: HOUR,
    })
    expect(departureAdvice(single)).toBeNull()
    const none = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: () => fail('nope'),
      from: T0,
      to: T0 + HOUR,
      stepMs: HOUR,
    })
    expect(departureAdvice(none)).toBeNull()
  })
})

// ------------------------------------------------------- real kernel, no stubs

/**
 * Minimal lattice: speed proportional to wind, zero inside a 40° no-go zone.
 * Enough for the kernel to sail with, small enough to read.
 */
function lattice(): PolarLattice {
  const targets = (tws: number): Targets => ({
    tws,
    upTwa: 45,
    upBsp: tws * 0.42,
    upVmg: tws * 0.42 * Math.cos((45 * Math.PI) / 180),
    downTwa: 150,
    downBsp: tws * 0.5,
    downVmg: -tws * 0.5 * Math.cos((150 * Math.PI) / 180),
  })
  return {
    table: { name: 'test', tws: [], rows: [], reference: '10m' },
    twsMax: 40,
    twsStep: 1,
    twaStep: 1,
    grid: new Float32Array(0),
    twsCount: 0,
    twaCount: 0,
    targets: [],
    speed: (tws, twa) => {
      const a = Math.abs(twa)
      if (a < 40) return 0
      // Peaks on a beam reach, falls away either side. Linear in wind speed.
      return tws * 0.5 * Math.sin(((a - 40) / 140) * Math.PI) ** 0.5
    },
    targetsAt: targets,
  }
}

/** Westerly that fills in from 4 kn to 14 kn over `rampHours`, then holds. */
function fillingBreeze(t0: number, rampHours: number): WeatherField {
  const twd = 270
  const speedAt = (t: number) => {
    const h = Math.max(0, (t - t0) / HOUR)
    return 4 + Math.min(1, h / rampHours) * 10
  }
  return {
    wind: (_lat, _lon, t) => {
      const s = speedAt(t)
      const r = (twd * Math.PI) / 180
      // Meteorological: direction is where it comes FROM.
      return { u: -s * Math.sin(r), v: -s * Math.cos(r), source: 'test' }
    },
    gust: () => null,
    current: () => null,
    waves: () => null,
    coverage: () => ({
      bbox: { west: -71.5, south: 43, east: -69, north: 44.5 },
      t0,
      t1: t0 + 48 * HOUR,
    }),
    dtMs: HOUR,
  }
}

describe('sweepDepartures against the real isochrone kernel', () => {
  /*
   * The unit tests above prove the sweep's arithmetic against stubs. This proves
   * it composes with the actual router — that `{...request, startTime}` is a
   * request the kernel accepts, and that the whole thing discovers a real,
   * physically-caused preference rather than one a stub was told to have.
   */
  const from = Date.UTC(2026, 7, 6, 0, 0)
  const ctx: RouteContext = { field: fillingBreeze(from, 6), lattice: lattice() }
  const req = {
    start: { lat: 43.5, lon: -70.4 },
    startTime: from,
    // Due east, across a westerly: a beam reach, so no tacking to muddy the test.
    marks: [{ lat: 43.5, lon: -70.0 }],
    constraints: { avoidLand: false },
    scalings: {
      polarPct: 100,
      polarPctNight: 100,
      windScalePct: 100,
      windRotateDeg: 0,
      windTimeShiftS: 0,
      currentScalePct: 100,
    },
    resolution: 'fast',
    computeSensitivity: false,
  } as unknown as RouteRequest

  const sweep = sweepDepartures({
    request: req,
    ctx,
    route: routeIsochrone,
    from,
    to: from + 6 * HOUR,
    stepMs: 2 * HOUR,
  })

  it('produces a real route for every departure in the window', () => {
    expect(sweep.attempted).toBe(4)
    expect(sweep.succeeded).toBe(4)
    for (const d of sweep.options) {
      expect(d.elapsedS, `departure ${new Date(d.departAt).toISOString()}`).toBeGreaterThan(0)
      expect(Number.isFinite(d.elapsedS!)).toBe(true)
    }
  })

  it('discovers that leaving later is faster when the breeze is filling in', () => {
    // Nothing told it this. The wind genuinely doubles over the window, so the
    // last departure must beat the first, and the best must not be the earliest.
    const first = sweep.options[0].elapsedS!
    const last = sweep.options[sweep.options.length - 1].elapsedS!
    expect(last).toBeLessThan(first)
    expect(sweep.best!.departAt).toBeGreaterThan(from)
  })

  it('reports a spread big enough to call departure decisive', () => {
    expect(sweep.spreadS).not.toBeNull()
    expect(sweep.spreadS!).toBeGreaterThan(0)
    const advice = departureAdvice(sweep)
    expect(advice?.matters).toBe(true)
  })

  it('pins every departure to the same step at buoy-race scale', () => {
    /*
     * On a leg this short (~17 nm) the §5 leg table asks for 300 s and the `fast`
     * preset floor is also 300 s, so the wind-dependent term never binds: every
     * departure really is compared at one discretisation. Worth pinning, because
     * it is the case where the sweep's ranking is cleanest — and it is not the
     * general case (see below).
     */
    const steps = sweep.options.map((d) => d.timeStepS!)
    expect(new Set(steps).size).toBe(1)
    expect(sweep.stepFloorS).toBe(steps[0])
  })

  it('costs are monotonic as the breeze builds', () => {
    // Each later departure is at least as good as the one before it, so the cost
    // relative to the winner never increases going down the list.
    const costs = sweep.options.map((d) => d.costS!)
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeLessThanOrEqual(costs[i - 1] + 1e-6)
    }
  })
})

describe('the step really does vary with departure, on a coastal leg', () => {
  /*
   * Why `stepFloorS` exists, demonstrated rather than argued.
   *
   * `routeIsochrone` sizes its time step from the boat speed it probes at
   * `startTime` (§5: `leg / speed / target_steps`). Below about 20 nm the leg
   * table and the preset floor both ask for 300 s and that term never binds — the
   * test above. Past 20 nm it binds hard, and it binds *asymmetrically*: a
   * departure into light air is solved coarsely and a departure into fresh air
   * finely, over the identical course. The discretisation is therefore correlated
   * with the quantity the sweep is trying to compare, and the comparison is only
   * as trustworthy as the coarsest solve in it.
   *
   * Same filling breeze, same beam reach, ~30 nm instead of ~17.
   */
  const from = Date.UTC(2026, 7, 6, 0, 0)
  const ctx: RouteContext = { field: fillingBreeze(from, 6), lattice: lattice() }
  const req = {
    start: { lat: 43.5, lon: -70.4 },
    marks: [{ lat: 43.5, lon: -69.71 }],
    startTime: from,
    constraints: { avoidLand: false },
    scalings: {
      polarPct: 100,
      polarPctNight: 100,
      windScalePct: 100,
      windRotateDeg: 0,
      windTimeShiftS: 0,
      currentScalePct: 100,
    },
    resolution: 'fast',
    computeSensitivity: false,
  } as unknown as RouteRequest

  const sweep = sweepDepartures({
    request: req,
    ctx,
    route: routeIsochrone,
    from,
    to: from + 6 * HOUR,
    stepMs: 3 * HOUR,
  })

  it('gives the lightest departure the coarsest search', () => {
    const steps = sweep.options.map((d) => d.timeStepS!)
    expect(new Set(steps).size).toBeGreaterThan(1)
    expect(steps[0]).toBeGreaterThan(steps[steps.length - 1])
  })

  it('takes the floor from the lightest, most coarsely solved departure', () => {
    const steps = sweep.options.map((d) => d.timeStepS!)
    expect(sweep.stepFloorS).toBe(Math.max(...steps))
    expect(sweep.stepFloorS).toBe(steps[0])
  })

  it('still calls this spread decisive, because it clears the floor by a lot', () => {
    // The floor is a guard against over-claiming, not a gag: a filling breeze
    // moves the ETA by hours and the coarsest step here is half an hour.
    expect(sweep.spreadS!).toBeGreaterThan(sweep.stepFloorS!)
    expect(departureAdvice(sweep)?.matters).toBe(true)
  })
})

// ------------------------------------------------------------- worker protocol

/**
 * The sweep crosses to a worker, so the wire contract needs its own test: a
 * cube and a polar table in, one progress tick per departure out, a
 * `DepartureSweep` at the end. `handleSweepMessage` is exported precisely so this
 * can run in plain Node without a real `Worker`.
 */
describe('sweep worker protocol', () => {
  const T = Date.UTC(2026, 7, 6, 12, 0)

  /** 12 kn from due east, uniform over a 2° box, hourly for 24 h. */
  function cube(): WeatherCube {
    const nx = 9
    const ny = 9
    const nt = 25
    const n = nx * ny * nt
    const u = new Float32Array(n)
    const v = new Float32Array(n)
    // Meteorological u/v for a wind FROM 090.
    u.fill(-12 * Math.sin((90 * Math.PI) / 180))
    v.fill(-12 * Math.cos((90 * Math.PI) / 180))
    return {
      model: 'test',
      run: '2026-08-06T06:00:00Z',
      bbox: { west: -71, south: 39.5, east: -69, north: 41.5 },
      nx,
      ny,
      dx: 0.25,
      dy: 0.25,
      t0: T - HOUR,
      dtMs: HOUR,
      nt,
      params: ['u10', 'v10'],
      data: { u10: u, v10: v },
    } as unknown as WeatherCube
  }

  function polarTable(): PolarTable {
    const twas = [0, 30, 40, 50, 60, 75, 90, 110, 120, 135, 150, 165, 180]
    const bspAt = (tws: number, twa: number) => {
      const a = Math.abs(twa)
      if (a < 35) return 0
      return tws * 0.5 * Math.sin(((a - 35) / 145) * Math.PI) ** 0.5
    }
    return {
      name: 'analytic',
      reference: '10m',
      tws: [4, 8, 12, 16, 20],
      rows: [4, 8, 12, 16, 20].map((w) => ({ twa: twas, bsp: twas.map((a) => bspAt(w, a)) })),
    }
  }

  it('round-trips a sweep through the worker handler', async () => {
    const { handleSweepMessage } = await import('./worker')
    const messages: SweepWorkerResponse[] = []
    await handleSweepMessage(
      {
        type: 'sweep',
        id: 11,
        // Due north from mid-box: a beam reach in an easterly.
        req: {
          start: { lat: 40, lon: -70 },
          startTime: T,
          marks: [{ lat: 40.2, lon: -70 }],
          constraints: { avoidLand: false },
          scalings: {
            polarPct: 100,
            polarPctNight: 100,
            windScalePct: 100,
            windRotateDeg: 0,
            windTimeShiftS: 0,
            currentScalePct: 100,
          },
          resolution: 'fast',
          // Left on to prove the wire accepts a template with it set; the sweep
          // strips it per solve, which the unit test above pins directly.
          computeSensitivity: true,
        } as unknown as RouteRequest,
        cube: cube(),
        polarTable: polarTable(),
        from: T,
        to: T + 3 * HOUR,
        stepMs: HOUR,
      },
      (m) => messages.push(m),
    )

    const result = messages.find((m) => m.type === 'sweepResult')
    expect(result).toBeDefined()
    expect(result!.id).toBe(11)
    if (result?.type !== 'sweepResult') throw new Error('unreachable')

    expect(result.sweep.attempted).toBe(4)
    expect(result.sweep.succeeded).toBe(4)
    expect(result.sweep.best?.elapsedS).toBeGreaterThan(0)
    // A uniform, steady wind: every departure must take the same time, so the
    // spread is zero and the advice must not manufacture a preference from it.
    expect(result.sweep.spreadS).toBe(0)
    expect(departureAdvice(result.sweep)?.matters).toBe(false)

    // One progress tick per departure, ending at 1.
    const ticks = messages.filter((m) => m.type === 'progress')
    expect(ticks).toHaveLength(4)
    expect(ticks[ticks.length - 1]).toMatchObject({ fraction: 1 })
  })

  it('reports a bad polar in-band rather than throwing', async () => {
    const { handleSweepMessage } = await import('./worker')
    const messages: SweepWorkerResponse[] = []
    await handleSweepMessage(
      {
        type: 'sweep',
        id: 12,
        req: { start: { lat: 40, lon: -70 }, marks: [{ lat: 40.2, lon: -70 }] } as RouteRequest,
        cube: cube(),
        // Not a polar. `buildLattice` must fail and the failure must arrive as a
        // sweep with no best, the same shape as "nothing routed".
        polarTable: { name: 'broken' } as unknown as PolarTable,
        from: T,
        to: T + HOUR,
        stepMs: HOUR,
      },
      (m) => messages.push(m),
    )
    const result = messages.find((m) => m.type === 'sweepResult')
    if (result?.type !== 'sweepResult') throw new Error('expected a sweepResult')
    expect(result.sweep.best).toBeNull()
    expect(result.sweep.warnings.join(' ')).toMatch(/could not start the sweep/)
  })
})

/*
 * Coverage, and what may be claimed from it.
 *
 * `best` and `spreadS` are computed over the departures that produced a route.
 * When some did not — the usual cause being a forecast that ends inside the
 * window, which fails the later departures — that is a correct answer to a
 * narrower question than the caller asked, and both the sweep and the advice
 * have to say which question they answered.
 */
describe('a partly-solved window says so', () => {
  it('warns when part of the window produced no route', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) => (req.startTime > T0 + HOUR ? fail('forecast ran out') : ok(req.startTime, 3600 + (req.startTime - T0) / 1000)),
      from: T0,
      to: T0 + 5 * HOUR,
      stepMs: HOUR,
    })
    expect(sweep.attempted).toBe(6)
    expect(sweep.succeeded).toBe(2)
    expect(sweep.warnings.join(' ')).toMatch(/4 of 6 departures in this window produced no route/)
  })

  it('stays quiet when every departure produced a route', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) => ok(req.startTime, 3600),
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
    })
    expect(sweep.warnings.join(' ')).not.toMatch(/produced no route/)
  })

  it('does not let the advice claim a window it never explored', () => {
    /*
     * Two solves out of six, an hour apart at the start of a five-hour window,
     * with a spread big enough to trip the "dominates" branch. The sentence used
     * to end "in this window" — a claim about five hours drawn from one, and from
     * the end of the window least affected by whatever cut the forecast short.
     */
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) =>
        req.startTime > T0 + HOUR
          ? fail('forecast ran out')
          : ok(req.startTime, req.startTime === T0 ? 3600 : 7200),
      from: T0,
      to: T0 + 5 * HOUR,
      stepMs: HOUR,
    })
    const a = departureAdvice(sweep)
    expect(a?.text).toMatch(/dominates/)
    expect(a?.text).toMatch(/2 of 6 departures that produced a route/)
    expect(a?.text).not.toMatch(/in this window/)
  })

  it('still says "this window" when the whole window was solved', () => {
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) => ok(req.startTime, req.startTime === T0 ? 3600 : 7200),
      from: T0,
      to: T0 + 2 * HOUR,
      stepMs: HOUR,
    })
    const a = departureAdvice(sweep)
    expect(a?.text).toMatch(/in this window/)
    expect(a?.text).not.toMatch(/produced a route/)
  })

  it('keeps the resolution check ahead of the coverage wording', () => {
    // A spread inside the time step is noise whether or not coverage was partial,
    // and that branch must still win — a partial sweep must not be dressed up as
    // a finding just because it now names its own scope.
    const sweep = sweepDepartures({
      request: REQUEST,
      ctx: CTX,
      route: (req) =>
        req.startTime > T0 + HOUR
          ? fail('forecast ran out')
          : ok(req.startTime, req.startTime === T0 ? 3600 : 3660, 600),
      from: T0,
      to: T0 + 5 * HOUR,
      stepMs: HOUR,
    })
    expect(departureAdvice(sweep)?.matters).toBe(false)
    expect(departureAdvice(sweep)?.text).toMatch(/No usable difference/)
  })
})

