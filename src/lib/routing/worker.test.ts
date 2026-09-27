/**
 * The routing worker's protocol.
 *
 * 311 lines that nothing exercised. `worker.ts` is the only file in
 * `src/lib/routing/**` that knows about `postMessage`, and it is where a request
 * from the UI becomes a `RouteContext` — so every way of getting that wrong is
 * invisible to the kernel tests, which are handed a context already built.
 *
 * Both handlers are exported precisely so they can be driven in Node without a
 * real `Worker`, which is what this does: a `post` spy stands in for the port.
 *
 * The headline case is `adoptLandRaster`. It validates a transferred raster and
 * returns null when it does not add up, and its own comment gives the reason:
 * "a router that believes land is sea is worse than one with no land data at
 * all — the second warns you, the first does not." That was half true. The
 * rejection worked; the warning did not exist. A rejected pack produced a route
 * computed over open water, and `RouteScreen` — which decided what to say from
 * whether *its* copy of the pack had loaded, not from what the kernel did —
 * labelled it "Land avoided using a 111 m OSM coastline raster".
 */

import { describe, expect, it, vi } from 'vitest'
import { handleRouteMessage, handleSweepMessage, rebuildField, rebuildLattice } from './worker'
import { POLAR_LIBRARY } from '@/data/polars'
import type {
  BBox,
  LatLon,
  PolarTable,
  RouteRequest,
  RouteResult,
  WeatherCube,
} from '../types'
import type { RouteWorkerResponse, SweepWorkerResponse } from './worker'

const T0 = Date.UTC(2026, 7, 6, 12, 0, 0)
const HOUR = 3_600_000

const POLAR: PolarTable = POLAR_LIBRARY[0].polar

/** Uniform 12 kt from the west, steady for a day, over a box around the venue. */
const BOX: BBox = { west: -70.6, south: 43.4, east: -69.8, north: 44.0 }

function cube(over: Partial<WeatherCube> = {}): WeatherCube {
  const nx = 5
  const ny = 5
  const nt = 25
  const n = nx * ny * nt
  // Wind FROM the west: u is the eastward component, so a westerly blows +u.
  const u10 = new Float32Array(n).fill(12)
  const v10 = new Float32Array(n).fill(0)
  return {
    model: 'test',
    run: 'test-run',
    bbox: BOX,
    nx,
    ny,
    dx: (BOX.east - BOX.west) / (nx - 1),
    dy: (BOX.north - BOX.south) / (ny - 1),
    t0: T0,
    dtMs: HOUR,
    nt,
    params: ['u10', 'v10'],
    data: { u10, v10 },
    ...over,
  }
}

const START: LatLon = { lat: 43.55, lon: -70.3 }
const MARK: LatLon = { lat: 43.75, lon: -70.1 }

function request(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    start: START,
    startTime: T0 + HOUR,
    marks: [MARK],
    constraints: { avoidLand: true, tackPenaltyS: 0, gybePenaltyS: 0 },
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
    ...over,
  }
}

/** An all-water raster of the right size — the shape a healthy venue pack has. */
function raster(nx = 16, ny = 16, bitWords?: number) {
  return {
    bbox: BOX,
    nx,
    ny,
    bits: new Uint32Array(bitWords ?? Math.ceil((nx * ny) / 32)),
  }
}

/** Drive one route request and hand back everything the worker posted. */
async function route(
  msg: Partial<Parameters<typeof handleRouteMessage>[0]> = {},
): Promise<{ result: RouteResult; posts: RouteWorkerResponse[] }> {
  const posts: RouteWorkerResponse[] = []
  await handleRouteMessage(
    { type: 'route', id: 7, req: request(), cube: cube(), polarTable: POLAR, ...msg },
    (m) => posts.push(m),
  )
  const last = posts.find((p) => p.type === 'result')
  if (!last || last.type !== 'result') throw new Error('worker posted no result')
  return { result: last.result, posts }
}

// ------------------------------------------------------- the land-mask claim

describe('land avoidance is reported by the kernel, not assumed by the caller', () => {
  it('adopts a well-formed raster and says so', async () => {
    const { result } = await route({ landRaster: raster() })
    expect(result.diagnostics.landAvoided).toBe(true)
    expect(result.diagnostics.warnings.join(' ')).not.toMatch(/NOT been checked/)
  })

  /*
   * The bug this file was written to find.
   *
   * A raster whose bit array is shorter than nx*ny/32 reads as open water past
   * its end, so `adoptLandRaster` refuses it — correctly. What followed was the
   * problem: the route was then computed with no land mask, and said nothing at
   * all about it. `landAvoided` is now the kernel's own answer, so the screen
   * can stop guessing from whether its copy of the pack loaded.
   */
  it('refuses a truncated raster and does not pretend the route was checked', async () => {
    const short = raster(16, 16, 2) // wants 8 words, gets 2
    const { result } = await route({ landRaster: short })
    expect(result.diagnostics.landAvoided).toBe(false)
    expect(result.diagnostics.warnings.join(' ')).toMatch(/NOT been checked against land/)
  })

  it('refuses a raster with a degenerate grid', async () => {
    for (const bad of [raster(0, 16), raster(16, 0)]) {
      const { result } = await route({ landRaster: bad })
      expect(result.diagnostics.landAvoided).toBe(false)
    }
  })

  it('warns when avoidance was asked for and no land data arrived at all', async () => {
    const { result } = await route({})
    expect(result.diagnostics.landAvoided).toBe(false)
    expect(result.diagnostics.warnings.join(' ')).toMatch(/NOT been checked against land/)
  })

  it('stays quiet when avoidance was never requested', async () => {
    // Nothing was promised, so there is nothing to warn about. A warning here
    // would train sailors to ignore the one that matters.
    const { result } = await route({
      req: request({ constraints: { avoidLand: false, tackPenaltyS: 0, gybePenaltyS: 0 } }),
    })
    expect(result.diagnostics.landAvoided).toBe(false)
    expect(result.diagnostics.warnings.join(' ')).not.toMatch(/NOT been checked/)
  })

  it('consults the raster it adopted, rather than merely accepting it', async () => {
    // `landAvoided: true` is a claim about the search, so it needs a test that
    // the bits reached the search rather than only the constructor. Every cell
    // set means there is nowhere legal to sail, and the kernel must say so.
    const r = raster()
    const solid = new Uint32Array(r.bits.length).fill(0xffffffff)
    const { result } = await route({ landRaster: { ...r, bits: solid } })
    expect(result.diagnostics.landAvoided).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/blocked by land/)
  })

  it('rebuilds bits that arrived as a raw buffer rather than a typed array', async () => {
    /*
     * Structured clone preserves a Uint32Array, but a payload assembled from a
     * fetch, a JSON round-trip or a hand-written call need not, and an
     * ArrayBuffer is the shape that punishes a missing conversion quietly: it
     * has no `length`, so the size check compares against undefined and passes,
     * and it has no integer indices, so every cell then reads as open water.
     * A solid-land raster is the only payload that can tell the difference —
     * with an all-water one, a broken mask and a working one agree.
     */
    const r = raster()
    const solid = new Uint32Array(r.bits.length).fill(0xffffffff)
    const { result } = await route({
      landRaster: { ...r, bits: solid.buffer as unknown as Uint32Array },
    })
    expect(result.diagnostics.landAvoided).toBe(true)
    expect(result.error).toMatch(/blocked by land/)
  })
})

// -------------------------------------------------------- never throw upward

describe('a worker that cannot start reports, rather than dying', () => {
  it('turns an unusable polar into a failed result naming the polar', async () => {
    const { result } = await route({
      polarTable: { name: 'Bad Boat 30' } as unknown as PolarTable,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/worker could not start the route/)
    expect(result.error).toMatch(/Bad Boat 30/)
    // A failure has consulted no land either, and must not claim otherwise.
    expect(result.diagnostics.landAvoided).toBe(false)
  })

  it('turns an unusable cube into a failed result', async () => {
    const { result } = await route({ cube: null as unknown as WeatherCube })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/worker could not start the route/)
  })

  it('names the polar even when it has no name', async () => {
    const { result } = await route({ polarTable: undefined as unknown as PolarTable })
    expect(result.error).toMatch(/unnamed polar/)
  })

  it('echoes the request id on every message', async () => {
    const { posts } = await route({ landRaster: raster() })
    expect(posts.length).toBeGreaterThan(0)
    for (const p of posts) expect(p.id).toBe(7)
  })

  it('reports a sweep failure in band, in the shape the UI already renders', async () => {
    const posts: SweepWorkerResponse[] = []
    await handleSweepMessage(
      {
        type: 'sweep',
        id: 3,
        req: request(),
        cube: cube(),
        polarTable: {} as unknown as PolarTable,
        from: T0 + HOUR,
        to: T0 + 3 * HOUR,
        stepMs: HOUR,
      },
      (m) => posts.push(m),
    )
    const res = posts.find((p) => p.type === 'sweepResult')
    expect(res?.type).toBe('sweepResult')
    if (res?.type !== 'sweepResult') throw new Error('unreachable')
    expect(res.sweep.options).toEqual([])
    expect(res.sweep.best).toBeNull()
    expect(res.sweep.warnings.join(' ')).toMatch(/worker could not start the sweep/)
  })
})

// --------------------------------------------------------------- the helpers

describe('the rebuild helpers', () => {
  it('builds a lattice from a real library polar', async () => {
    const lattice = await rebuildLattice(POLAR)
    expect(lattice.speed(12, 90)).toBeGreaterThan(0)
  })

  it('builds a field that samples the cube it was given', async () => {
    const field = await rebuildField(cube())
    const w = field.wind(43.6, -70.2, T0 + HOUR)
    expect(w).not.toBeNull()
    expect(Math.hypot(w!.u, w!.v)).toBeCloseTo(12, 6)
  })

  it('wraps a rebuild failure with something actionable', async () => {
    await expect(rebuildLattice(null as unknown as PolarTable)).rejects.toThrow(
      /could not build the polar lattice/,
    )
  })
})

// ------------------------------------------------------------------ progress

describe('progress reporting', () => {
  it('throttles intermediate progress but always delivers the last tick', async () => {
    // The throttle is time-based, so drive the handler with a frozen clock: every
    // intermediate tick lands inside the same 100 ms window and must be dropped,
    // while fraction 1 is exempt and must survive.
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0)
    try {
      const posts: RouteWorkerResponse[] = []
      await handleRouteMessage(
        { type: 'route', id: 1, req: request(), cube: cube(), polarTable: POLAR },
        (m) => posts.push(m),
      )
      const fractions = posts.filter((p) => p.type === 'progress').map((p) => p.fraction)
      expect(fractions.length).toBeGreaterThan(0)
      expect(fractions.at(-1)).toBe(1)
      // One un-throttled tick at t=0, then only the exempt final one.
      expect(fractions.filter((f) => f < 1).length).toBeLessThanOrEqual(1)
    } finally {
      now.mockRestore()
    }
  })
})

