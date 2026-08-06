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
  RouteRequest,
  RouteResult,
  Targets,
  WeatherField,
} from '../types'

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
function ok(startTime: number, elapsedS: number): RouteResult {
  return {
    ok: true,
    legs: [],
    etaMs: startTime + elapsedS * 1000,
    elapsedS,
    directTimeS: elapsedS,
    isochrones: [],
    reverseIsochrones: [],
    sensitivity: null,
    diagnostics: { nodesExplored: 0, timeStepS: 60, computeMs: 0, warnings: [] },
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
    diagnostics: { nodesExplored: 0, timeStepS: 0, computeMs: 0, warnings: [] },
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

  it('costs are monotonic as the breeze builds', () => {
    // Each later departure is at least as good as the one before it, so the cost
    // relative to the winner never increases going down the list.
    const costs = sweep.options.map((d) => d.costS!)
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeLessThanOrEqual(costs[i - 1] + 1e-6)
    }
  })
})
