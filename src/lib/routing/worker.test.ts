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

// ------------------------------------------------------- several forecasts

describe('the worker merges the forecasts it is sent, the finest grid first', () => {
  /** A 9×7 file at 0.05°, over the course only, with half the wind of the 0.2° download. */
  function fineFile(kn: number): WeatherCube {
    const nx = 9
    const ny = 7
    const nt = 25
    const bbox = { west: -70.4, south: 43.5, east: -70.0, north: 43.8 }
    return {
      model: 'local.grb2',
      run: '2026-08-06T06:00:00.000Z',
      bbox,
      nx,
      ny,
      dx: 0.05,
      dy: 0.05,
      t0: T0,
      dtMs: HOUR,
      nt,
      params: ['u10', 'v10'],
      data: { u10: new Float32Array(nx * ny * nt).fill(kn), v10: new Float32Array(nx * ny * nt).fill(0) },
    }
  }

  it("sails the course in the finer file's wind wherever it covers", async () => {
    const coarse = await route()
    const merged = await route({ extraCubes: [fineFile(6)] })
    expect(coarse.result.ok && merged.result.ok).toBe(true)
    // 6 kn instead of 12: markedly slower, so the file's wind is the one sailed.
    expect(merged.result.elapsedS! / coarse.result.elapsedS!).toBeGreaterThan(1.2)
    // The order they are sent in does not matter; resolution decides.
    const swapped = await route({ cube: fineFile(6), extraCubes: [cube()] })
    expect(swapped.result.elapsedS).toBeCloseTo(merged.result.elapsedS!, 0)
  })

  it('rebuilds one field that falls back to the coarse forecast outside the file', async () => {
    const f = await rebuildField(cube(), [fineFile(6)])
    expect(f.wind(43.6, -70.2, T0)).toMatchObject({ u: 6, source: 'local.grb2' })
    expect(f.wind(43.9, -69.9, T0)).toMatchObject({ u: 12, source: 'test' })
  })
})

// ------------------------------------------------------- tidal streams

describe('the worker routes with tidal streams over the forecast current', () => {
  // A station on the course with a steady 2.9 kn stream towards the mark (a mean, no tide).
  const station = (towards: number) => ({
    position: { lat: 43.65, lon: -70.2 },
    bin: { bin: 1, depthM: 3, azi: towards, majorMean: 150, minorMean: 0, major: [], minor: [] },
  })
  /** The westerly cube with a 1.5 kn current setting the other way, everywhere. */
  const withCurrent = (setTo: number) => {
    const c = cube()
    const n = c.nx * c.ny * c.nt
    const r = (setTo * Math.PI) / 180
    return { ...c, params: [...c.params, 'uo', 'vo'], data: { ...c.data, uo: new Float32Array(n).fill(1.5 * Math.sin(r)), vo: new Float32Array(n).fill(1.5 * Math.cos(r)) } }
  }

  it('sails faster with a fair stream from the station than with the forecast current against it', async () => {
    const along = 45 // START to MARK is about north-east
    const plain = await route({ cube: withCurrent(along + 180) })
    const tidal = await route({ cube: withCurrent(along + 180), tidal: { sources: [station(along)], radiusNm: 30 } })
    expect(plain.result.ok && tidal.result.ok).toBe(true)
    expect(tidal.result.elapsedS! / plain.result.elapsedS!).toBeLessThan(0.8)
    expect(tidal.result.diagnostics.warnings[0]).toMatch(/Tidal streams from 1 NOAA station take the place of the forecast current within 30 nm/)
  })

  it('leaves the forecast current alone beyond the radius', async () => {
    const plain = await route({ cube: withCurrent(225) })
    const far = await route({ cube: withCurrent(225), tidal: { sources: [{ ...station(45), position: { lat: 40, lon: -60 } }], radiusNm: 5 } })
    expect(far.result.elapsedS).toBeCloseTo(plain.result.elapsedS!, 0)
  })
})

// ------------------------------------------------------- a port-tack polar

describe('the worker sails port tack on its own polar when given one', () => {
  it('builds the second polar and routes a port leg slower on it', async () => {
    // A westerly and a mark to the north-east: the leg is on port tack.
    const slowPort = { ...POLAR, name: 'port', rows: POLAR.rows.map((r) => ({ ...r, bsp: r.bsp.map((v) => v * 0.5) })) }
    const same = await route()
    const port = await route({ polarTablePort: slowPort })
    expect(same.result.ok && port.result.ok).toBe(true)
    const ratio = port.result.elapsedS! / same.result.elapsedS!
    expect(ratio).toBeGreaterThan(1.5)
  })
})

// ------------------------------------------------------- the grid, on request

describe('the worker runs the grid when asked', () => {
  it('routes on the grid, says it did, and runs the isochrones otherwise', async () => {
    const grid = await route({ req: { ...request(), algorithm: 'grid' } })
    expect(grid.result.ok, grid.result.error).toBe(true)
    expect(grid.result.diagnostics.warnings.some((w) => /Grid route/.test(w))).toBe(true)
    expect(grid.result.isochrones).toEqual([])
    const iso = await route()
    expect(iso.result.ok).toBe(true)
    expect(iso.result.diagnostics.warnings.some((w) => /Grid route/.test(w))).toBe(false)
    expect(Math.abs(grid.result.elapsedS! / iso.result.elapsedS! - 1)).toBeLessThan(0.1)
  })
})

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

