/**
 * Weather layer tests. No network: every cube here is built in memory.
 *
 * The tests that matter most are the sign and wrap ones. A u/v sign error
 * inverts every route and looks completely plausible on screen, and a direction
 * interpolated across 0/360 produces a wind blowing the opposite way in exactly
 * the conditions (a shifty northerly) where the tactics matter most.
 * See docs/02-data-sources/weather-models.md §7.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { angdiff } from '../angles'
import type { BBox, Millis, WeatherCube, WeatherField } from '../types'
import {
  cubeIndex,
  cubeSizeBytes,
  decodeCube,
  encodeCube,
  sampleCube,
  scaleFor,
  uvFromWind,
  windFromUv,
} from './cube'
import { ConstantField, CubeField, ScaledField, StackedField, twdTws } from './field'
import { clearWeatherCache, cubeNotes, fetchWindCube } from './openmeteo'

const HOUR = 3600_000
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0)

interface CubeSpec {
  nx?: number
  ny?: number
  nt?: number
  west?: number
  south?: number
  dx?: number
  dy?: number
  t0?: Millis
  dtMs?: number
  params?: string[]
  model?: string
  /** Value at a node, per parameter. Return NaN for a hole. */
  at: (param: string, ix: number, iy: number, it: number) => number
}

function makeCube(spec: CubeSpec): WeatherCube {
  const nx = spec.nx ?? 3
  const ny = spec.ny ?? 3
  const nt = spec.nt ?? 2
  const dx = spec.dx ?? 0.25
  const dy = spec.dy ?? 0.25
  const west = spec.west ?? -70
  const south = spec.south ?? 41
  const params = spec.params ?? ['u10', 'v10', 'gust', 'prmsl']
  const bbox: BBox = {
    west,
    south,
    east: west + (nx - 1) * dx,
    north: south + (ny - 1) * dy,
  }
  const cube: WeatherCube = {
    model: spec.model ?? 'test',
    run: '2026-06-01T06:00:00.000Z',
    bbox,
    nx,
    ny,
    dx,
    dy,
    t0: spec.t0 ?? T0,
    dtMs: spec.dtMs ?? HOUR,
    nt,
    params,
    data: {},
  }
  for (const p of params) {
    const arr = new Float32Array(nt * ny * nx)
    for (let it = 0; it < nt; it++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) arr[cubeIndex(cube, ix, iy, it)] = spec.at(p, ix, iy, it)
      }
    }
    cube.data[p] = arr
  }
  return cube
}

/** A uniform wind cube, given as speed/direction and stored as u/v. */
function uniformWindCube(tws: number, twd: number, over?: Partial<CubeSpec>): WeatherCube {
  const uv = uvFromWind(tws, twd)
  return makeCube({
    ...over,
    at: (p) => (p === 'u10' ? uv.u : p === 'v10' ? uv.v : p === 'gust' ? tws * 1.3 : 1013),
  })
}

async function gzipSize(buf: ArrayBuffer): Promise<number> {
  const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))
  return (await new Response(stream).arrayBuffer()).byteLength
}

// ---------------------------------------------------------------- u/v signs

describe('u/v conventions', () => {
  it('a wind FROM 090 has a negative u component', () => {
    const uv = uvFromWind(10, 90)
    expect(uv.u).toBeCloseTo(-10, 9)
    expect(uv.v).toBeCloseTo(0, 9)
  })

  it('a wind FROM 000 (northerly) blows south: v negative, u zero', () => {
    const uv = uvFromWind(10, 0)
    expect(uv.u).toBeCloseTo(0, 9)
    expect(uv.v).toBeCloseTo(-10, 9)
  })

  it('a wind FROM 270 (westerly) blows east: u positive', () => {
    expect(uvFromWind(12, 270).u).toBeCloseTo(12, 9)
  })

  it('round-trips speed/direction through u/v at every 15 degrees', () => {
    for (let dir = 0; dir < 360; dir += 15) {
      for (const speed of [0.5, 6, 17.3, 45]) {
        const uv = uvFromWind(speed, dir)
        const back = windFromUv(uv.u, uv.v)
        expect(back.speed).toBeCloseTo(speed, 9)
        expect(Math.abs(angdiff(back.dir, dir))).toBeLessThan(1e-9)
      }
    }
  })
})

// ------------------------------------------------------------- sampling

describe('sampleCube', () => {
  const cube = uniformWindCube(10, 225)

  it('returns null outside the bbox rather than a silent zero', () => {
    const inside = sampleCube(cube, 'u10', 41.25, -69.75, T0)
    expect(inside).not.toBeNull()

    expect(sampleCube(cube, 'u10', 41.25, -70.5, T0)).toBeNull() // west
    expect(sampleCube(cube, 'u10', 41.25, -69.0, T0)).toBeNull() // east
    expect(sampleCube(cube, 'u10', 40.5, -69.75, T0)).toBeNull() // south
    expect(sampleCube(cube, 'u10', 42.0, -69.75, T0)).toBeNull() // north
  })

  it('returns null outside the time range', () => {
    expect(sampleCube(cube, 'u10', 41.25, -69.75, T0 - 1000)).toBeNull()
    expect(sampleCube(cube, 'u10', 41.25, -69.75, T0 + HOUR + 1000)).toBeNull()
    expect(sampleCube(cube, 'u10', 41.25, -69.75, T0 + HOUR)).not.toBeNull()
  })

  it('returns null for a parameter the cube does not carry', () => {
    expect(sampleCube(cube, 'uo', 41.25, -69.75, T0)).toBeNull()
  })

  it('is exact at grid nodes', () => {
    // Distinct value per node so an off-by-one in the index maths cannot pass.
    const c = makeCube({
      nx: 4,
      ny: 3,
      nt: 2,
      params: ['u10'],
      at: (_p, ix, iy, it) => ix * 100 + iy * 10 + it,
    })
    for (let it = 0; it < c.nt; it++) {
      for (let iy = 0; iy < c.ny; iy++) {
        for (let ix = 0; ix < c.nx; ix++) {
          const lat = c.bbox.south + iy * c.dy
          const lon = c.bbox.west + ix * c.dx
          const t = c.t0 + it * c.dtMs
          expect(sampleCube(c, 'u10', lat, lon, t)).toBeCloseTo(ix * 100 + iy * 10 + it, 6)
        }
      }
    }
  })

  it('is bilinear between nodes and linear in time', () => {
    const c = makeCube({
      nx: 2,
      ny: 2,
      nt: 2,
      params: ['u10'],
      at: (_p, ix, iy, it) => ix + 2 * iy + 4 * it,
    })
    const midLat = c.bbox.south + c.dy / 2
    const midLon = c.bbox.west + c.dx / 2
    // Spatial mean of 0,1,2,3 = 1.5 at t0; +4 one hour later.
    expect(sampleCube(c, 'u10', midLat, midLon, c.t0)).toBeCloseTo(1.5, 6)
    expect(sampleCube(c, 'u10', midLat, midLon, c.t0 + HOUR)).toBeCloseTo(5.5, 6)
    expect(sampleCube(c, 'u10', midLat, midLon, c.t0 + HOUR / 2)).toBeCloseTo(3.5, 6)
    // Quarter of the way east on the southern edge: 0.25.
    expect(sampleCube(c, 'u10', c.bbox.south, c.bbox.west + c.dx / 4, c.t0)).toBeCloseTo(0.25, 6)
  })

  it('drops missing corners and renormalises rather than returning zero', () => {
    const c = makeCube({
      nx: 2,
      ny: 2,
      nt: 1,
      params: ['u10'],
      // Three sea cells at 8 kn, one land cell with no data.
      at: (_p, ix, iy) => (ix === 1 && iy === 1 ? NaN : 8),
    })
    const v = sampleCube(c, 'u10', c.bbox.south + c.dy / 2, c.bbox.west + c.dx / 2, c.t0)
    expect(v).toBeCloseTo(8, 6)
  })

  it('returns null when the whole neighbourhood is missing', () => {
    const c = makeCube({ nx: 2, ny: 2, nt: 1, params: ['u10'], at: () => NaN })
    expect(sampleCube(c, 'u10', c.bbox.south, c.bbox.west, c.t0)).toBeNull()
  })
})

// ------------------------------------------------------- the 0/360 wrap bug

describe('direction interpolation across the 0/360 wrap', () => {
  it('gives ~000, not 180, between a wind FROM 350 and a wind FROM 010', () => {
    // The bug this whole u/v rule exists to prevent:
    expect((350 + 10) / 2).toBe(180) // naive averaging of directions
    expect(Math.abs(angdiff(180, 0))).toBe(180) // ...is 180 degrees wrong

    const west = uvFromWind(10, 350)
    const east = uvFromWind(10, 10)
    const c = makeCube({
      nx: 2,
      ny: 2,
      nt: 1,
      params: ['u10', 'v10'],
      at: (p, ix) => {
        const uv = ix === 0 ? west : east
        return p === 'u10' ? uv.u : uv.v
      },
    })

    const f = new CubeField(c, 'wrap')
    const mid = twdTws(f, c.bbox.south + c.dy / 2, c.bbox.west + c.dx / 2, c.t0)
    expect(mid).not.toBeNull()
    expect(Math.abs(angdiff(mid!.twd, 0))).toBeLessThan(0.001)
    // Vector averaging also correctly shows the small speed loss from the spread.
    expect(mid!.tws).toBeCloseTo(10 * Math.cos((10 * Math.PI) / 180), 6)
  })
})

// ------------------------------------------------------------ encode/decode

describe('cube codec', () => {
  it('round-trips within the Int16 quantisation error', () => {
    const c = makeCube({
      nx: 5,
      ny: 4,
      nt: 3,
      params: ['u10', 'v10', 'gust', 'prmsl', 'hs', 'wdir', 'wper', 'uo', 'vo'],
      at: (p, ix, iy, it) => {
        const f = ix * 0.37 + iy * 0.11 + it * 0.53
        switch (p) {
          case 'u10':
            return -14.37 + f
          case 'v10':
            return 9.21 - f
          case 'gust':
            return 22.5 + f
          case 'prmsl':
            return 1013.25 + f
          case 'hs':
            return 1.85 + f * 0.1
          case 'wdir':
            return (200 + f * 10) % 360
          case 'wper':
            return 7.4 + f * 0.05
          case 'uo':
            return 0.412 - f * 0.01
          default:
            return -0.237 + f * 0.01
        }
      },
    })

    const back = decodeCube(encodeCube(c))
    expect(back.params).toEqual(c.params)
    expect(back.nx).toBe(c.nx)
    expect(back.ny).toBe(c.ny)
    expect(back.nt).toBe(c.nt)
    expect(back.t0).toBe(c.t0)
    expect(back.dtMs).toBe(c.dtMs)
    expect(back.bbox).toEqual(c.bbox)
    expect(back.model).toBe(c.model)
    expect(back.run).toBe(c.run)

    for (const p of c.params) {
      for (let i = 0; i < c.data[p].length; i++) {
        // Half a quantisation step, plus the Float32 representation error of
        // the value itself (~1.2e-7 relative) — which for pressure in hPa is
        // larger than you would guess.
        const tol = scaleFor(p) / 2 + Math.abs(c.data[p][i]) * 1.2e-7 + 1e-9
        expect(Math.abs(back.data[p][i] - c.data[p][i])).toBeLessThanOrEqual(tol)
      }
    }
  })

  it('preserves missing values as NaN, not zero', () => {
    const c = makeCube({
      nx: 2,
      ny: 2,
      nt: 1,
      params: ['u10'],
      at: (_p, ix) => (ix === 0 ? NaN : 5),
    })
    const back = decodeCube(encodeCube(c))
    expect(Number.isNaN(back.data.u10[0])).toBe(true)
    expect(back.data.u10[1]).toBeCloseTo(5, 2)
  })

  it('carries the delta predictor across a hole in time', () => {
    // The delta filter predicts each hour from the one before. A cell that is
    // missing at hour 1 must not corrupt hours 2 and 3 — this is the failure
    // mode where a coastal cell poisons the rest of the forecast.
    const c = makeCube({
      nx: 2,
      ny: 1,
      nt: 4,
      params: ['u10'],
      at: (_p, ix, _iy, it) => (ix === 0 && it === 1 ? NaN : 5 + it),
    })
    const back = decodeCube(encodeCube(c))
    for (let it = 0; it < 4; it++) {
      const hole = it === 1
      expect(Number.isNaN(back.data.u10[it * 2])).toBe(hole)
      if (!hole) expect(back.data.u10[it * 2]).toBeCloseTo(5 + it, 3)
      expect(back.data.u10[it * 2 + 1]).toBeCloseTo(5 + it, 3)
    }
  })

  it('clamps out-of-range values instead of wrapping them into nonsense', () => {
    // ±163 kn at 0.01 kn resolution. A 500 kn "wind" is bad data, and must come
    // back as an absurd-but-positive number, never as a sign-flipped one.
    const c = makeCube({ nx: 1, ny: 1, nt: 1, params: ['u10'], at: () => 500 })
    const back = decodeCube(encodeCube(c))
    expect(back.data.u10[0]).toBeCloseTo(163.83, 2)
  })

  it('sizes a 21x21x48 3-parameter cube for a race-morning download', async () => {
    // The reference case from technical-spec.md §4: 5° x 5° at 0.25°, 48 hourly
    // steps, u/v + gust. Smooth synthetic field so compression is representative.
    const c = makeCube({
      nx: 21,
      ny: 21,
      nt: 48,
      dx: 0.25,
      dy: 0.25,
      params: ['u10', 'v10', 'gust'],
      at: (p, ix, iy, it) => {
        const speed = 12 + 4 * Math.sin((ix + it) / 7) + 2 * Math.cos(iy / 5)
        const dir = 210 + 25 * Math.sin(it / 9) + 6 * Math.cos((ix - iy) / 6)
        const uv = uvFromWind(speed, dir)
        return p === 'u10' ? uv.u : p === 'v10' ? uv.v : speed * 1.35
      },
    })

    const buf = encodeCube(c)
    expect(cubeSizeBytes(c)).toBe(buf.byteLength)
    // 21*21*48*3*2 = 127 008 bytes of body, plus a JSON header of a few hundred.
    expect(buf.byteLength).toBeGreaterThan(127_008)
    expect(buf.byteLength).toBeLessThan(127_008 + 1024)

    const gz = await gzipSize(buf)
    // technical-spec.md §4 budgets ~35 KB compressed. Raw Int16 gzips to about
    // 62 KB here; the delta-in-time + byte-shuffle filter in `encodeCube` is
    // what brings it to ~30 KB. Guard the budget so that filter cannot silently
    // regress — this number is the whole offline story.
    expect(gz).toBeLessThan(36 * 1024)
    expect(gz).toBeGreaterThan(1024)
  })

  it('rejects a buffer that is not a cube', () => {
    expect(() => decodeCube(new ArrayBuffer(64))).toThrow(/magic/)
  })
})

// ------------------------------------------------------------------ fields

describe('CubeField', () => {
  it('reports wind, gust and coverage, and null where the cube has no parameter', () => {
    const c = uniformWindCube(15, 180)
    const f = new CubeField(c, 'ecmwf')
    const w = f.wind(41.25, -69.75, T0)
    expect(w).not.toBeNull()
    expect(w!.source).toBe('ecmwf')
    expect(windFromUv(w!.u, w!.v).speed).toBeCloseTo(15, 5)
    expect(f.gust(41.25, -69.75, T0)).toBeCloseTo(19.5, 5)
    expect(f.current(41.25, -69.75, T0)).toBeNull()
    expect(f.waves(41.25, -69.75, T0)).toBeNull()

    const cov = f.coverage()
    expect(cov.bbox.west).toBeCloseTo(-70, 9)
    expect(cov.bbox.east).toBeCloseTo(-69.5, 9)
    expect(cov.t0).toBe(T0)
    expect(cov.t1).toBe(T0 + HOUR)
  })

  it('defaults its label to the cube model', () => {
    expect(new CubeField(uniformWindCube(10, 0, { model: 'GFS' })).label).toBe('GFS')
  })
})

describe('ConstantField', () => {
  it('applies the meteorological sign convention', () => {
    const f = new ConstantField({ twd: 90, tws: 12 })
    const w = f.wind(0, 0, 0)!
    expect(w.u).toBeCloseTo(-12, 9)
    expect(w.v).toBeCloseTo(0, 9)
  })

  it('treats set as the direction the current flows TOWARDS', () => {
    // A current setting 090 pushes the boat east: positive u.
    const f = new ConstantField({ twd: 0, tws: 10, set: 90, drift: 1.5 })
    const c = f.current(0, 0, 0)!
    expect(c.u).toBeCloseTo(1.5, 9)
    expect(c.v).toBeCloseTo(0, 9)
  })

  it('has no current unless one was given', () => {
    expect(new ConstantField({ twd: 0, tws: 10 }).current(0, 0, 0)).toBeNull()
  })
})

describe('StackedField', () => {
  // A 1° regional box [-71, -70] and a 1° global box [-70.5, -69.5], overlapping
  // over [-70.5, -70] — the inshore/offshore handover this class exists for.
  const west = new CubeField(uniformWindCube(10, 0, { west: -71, south: 41, nx: 5 }), 'regional')
  const east = new CubeField(uniformWindCube(20, 90, { west: -70.5, south: 41, nx: 5 }), 'global')
  const stack = new StackedField([west, east])

  it('returns the first provider that covers the point, with its source', () => {
    // -70.8 is inside `west` only.
    const a = stack.wind(41.1, -70.8, T0)
    expect(a!.source).toBe('regional')
    expect(windFromUv(a!.u, a!.v).speed).toBeCloseTo(10, 4)

    // -69.6 is inside `east` only.
    const b = stack.wind(41.1, -69.6, T0)
    expect(b!.source).toBe('global')
    expect(windFromUv(b!.u, b!.v).speed).toBeCloseTo(20, 4)
  })

  it('prefers the higher-priority provider where they overlap', () => {
    // -70.25 is covered by both; the first one in the stack must win.
    const both = stack.wind(41.1, -70.25, T0)
    expect(both!.source).toBe('regional')
    expect(windFromUv(both!.u, both!.v).speed).toBeCloseTo(10, 4)
  })

  it('falls through per parameter, not per provider', () => {
    // A manual "what-if" wind on top of a forecast that carries the current.
    const manual = new ConstantField({ twd: 315, tws: 8 }, 'manual')
    const forecast = new ConstantField({ twd: 200, tws: 20, set: 45, drift: 2 }, 'grib')
    const s = new StackedField([manual, forecast])
    expect(s.wind(41, -70, T0)!.source).toBe('manual')
    expect(s.current(41, -70, T0)!.source).toBe('grib')
  })

  it('returns null where nothing covers the point', () => {
    expect(stack.wind(0, 0, T0)).toBeNull()
    expect(stack.gust(0, 0, T0)).toBeNull()
    expect(stack.waves(41.1, -70.4, T0)).toBeNull()
  })

  it('reports the union of member coverage', () => {
    const cov = stack.coverage()
    expect(cov.bbox.west).toBeCloseTo(-71, 9)
    expect(cov.bbox.east).toBeCloseTo(-69.5, 9)
  })
})

describe('ScaledField', () => {
  const identity = { windScalePct: 100, windRotateDeg: 0, windTimeShiftS: 0, currentScalePct: 100 }

  /** Wind speed ramps 10 kn at t0 to 20 kn one hour later, direction fixed. */
  function rampCube(): WeatherCube {
    return makeCube({
      nx: 2,
      ny: 2,
      nt: 2,
      params: ['u10', 'v10', 'gust'],
      at: (p, _ix, _iy, it) => {
        const uv = uvFromWind(10 + 10 * it, 270)
        return p === 'u10' ? uv.u : p === 'v10' ? uv.v : 10 + 10 * it
      },
    })
  }

  it('is a no-op with identity scalings, and keeps the raw source label', () => {
    const inner = new CubeField(uniformWindCube(14, 45), 'icon')
    const f = new ScaledField(inner, identity)
    const a = inner.wind(41.1, -69.9, T0)!
    const b = f.wind(41.1, -69.9, T0)!
    expect(b.u).toBeCloseTo(a.u, 9)
    expect(b.v).toBeCloseTo(a.v, 9)
    expect(b.source).toBe('icon')
  })

  it('POSITIVE time shift uses the EARLIER field (at 18z, +60 gives the 17z field)', () => {
    const f = new ScaledField(new CubeField(rampCube(), 'gfs'), {
      ...identity,
      windTimeShiftS: 3600,
    })
    const lat = 41.1
    const lon = -69.9

    // Query one hour in: with +60 min we must see the field from t0, i.e. 10 kn,
    // NOT the 20 kn that is actually forecast for that hour.
    const shifted = f.wind(lat, lon, T0 + HOUR)!
    expect(windFromUv(shifted.u, shifted.v).speed).toBeCloseTo(10, 4)
    expect(f.gust(lat, lon, T0 + HOUR)).toBeCloseTo(10, 4)
    expect(shifted.source).toBe('gfs (adjusted)')

    // And half an hour in gives the half-hour-before-t0 field, which does not exist.
    expect(f.wind(lat, lon, T0)).toBeNull()

    // The queryable window therefore moves later by the same amount.
    const cov = f.coverage()
    expect(cov.t0).toBe(T0 + HOUR)
    expect(cov.t1).toBe(T0 + 2 * HOUR)
  })

  it('NEGATIVE time shift uses the LATER field', () => {
    const f = new ScaledField(new CubeField(rampCube(), 'gfs'), {
      ...identity,
      windTimeShiftS: -3600,
    })
    const w = f.wind(41.1, -69.9, T0)!
    expect(windFromUv(w.u, w.v).speed).toBeCloseTo(20, 4)
  })

  it('scales speed without touching direction', () => {
    const f = new ScaledField(new CubeField(uniformWindCube(10, 240), 'x'), {
      ...identity,
      windScalePct: 120,
    })
    const w = twdTws(f, 41.1, -69.9, T0)!
    expect(w.tws).toBeCloseTo(12, 4)
    expect(Math.abs(angdiff(w.twd, 240))).toBeLessThan(1e-4)
  })

  it('rotates the wind clockwise for a positive rotation, without changing speed', () => {
    const f = new ScaledField(new CubeField(uniformWindCube(10, 350), 'x'), {
      ...identity,
      windRotateDeg: 20,
    })
    const w = twdTws(f, 41.1, -69.9, T0)!
    // 350 + 20 = 010, through the wrap.
    expect(Math.abs(angdiff(w.twd, 10))).toBeLessThan(1e-4)
    expect(w.tws).toBeCloseTo(10, 6)
  })

  it('scales current independently, and does not time-shift it', () => {
    const inner: WeatherField = new ConstantField({ twd: 0, tws: 10, set: 90, drift: 2 }, 'tide')
    const f = new ScaledField(inner, { ...identity, currentScalePct: 50, windTimeShiftS: 7200 })
    const c = f.current(41, -70, T0)!
    expect(c.u).toBeCloseTo(1, 9)
    expect(c.source).toBe('tide (adjusted)')
  })
})

// --------------------------------------------------------- ingest (no network)

describe('fetchWindCube ingest', () => {
  const realFetch = globalThis.fetch
  const T = Math.floor(T0 / 1000)

  afterEach(() => {
    globalThis.fetch = realFetch
    clearWeatherCache()
  })

  /** One Open-Meteo location block per requested point; speed encodes the index. */
  function forecastPayload(url: string): unknown {
    const lats = new URL(url).searchParams.get('latitude')!.split(',')
    return lats.map((_lat, i) => ({
      hourly: {
        time: [T, T + 3600],
        wind_speed_10m: [10 + i, 10 + i],
        wind_direction_10m: [90, 90],
        wind_gusts_10m: [(10 + i) * 1.4, (10 + i) * 1.4],
        pressure_msl: [1013.2, 1012.8],
      },
      hourly_units: { wind_speed_10m: 'kn', wind_gusts_10m: 'kn', pressure_msl: 'hPa' },
    }))
  }

  function stub(handler: (url: string) => { ok: boolean; body: unknown }): void {
    globalThis.fetch = ((input: string) => {
      const r = handler(String(input))
      return Promise.resolve({
        ok: r.ok,
        status: r.ok ? 200 : 503,
        statusText: r.ok ? 'OK' : 'Service Unavailable',
        json: () => Promise.resolve(r.body),
      })
    }) as unknown as typeof fetch
  }

  it('lays a multi-point response out in cube order and stores u/v, not speed/direction', async () => {
    stub((url) => ({ ok: true, body: forecastPayload(url) }))
    const cube = await fetchWindCube({
      bbox: { west: -70.5, south: 41, east: -70, north: 41.25 },
      stepDeg: 0.25,
      hours: 2,
    })

    expect(cube.nx).toBe(3)
    expect(cube.ny).toBe(2)
    expect(cube.nt).toBe(2)
    expect(cube.dtMs).toBe(HOUR)
    expect(cube.t0).toBe(T0)
    expect(cube.params).toEqual(['u10', 'v10', 'gust', 'prmsl'])

    // Points go out y-outer/x-inner, so point index = iy*nx + ix must come back
    // in that cell. An index transpose here would be invisible on a wind map.
    for (let iy = 0; iy < cube.ny; iy++) {
      for (let ix = 0; ix < cube.nx; ix++) {
        const expected = uvFromWind(10 + (iy * cube.nx + ix), 90)
        const cell = cubeIndex(cube, ix, iy, 0)
        expect(cube.data.u10[cell]).toBeCloseTo(expected.u, 5)
        expect(cube.data.v10[cell]).toBeCloseTo(expected.v, 5)
      }
    }
    // FROM 090 across the whole grid: every u is negative.
    expect(Array.from(cube.data.u10).every((u) => u < 0)).toBe(true)
  })

  it('keeps the wind when the marine request fails, and says so', async () => {
    stub((url) =>
      url.includes('marine')
        ? { ok: false, body: { reason: 'marine model unavailable' } }
        : { ok: true, body: forecastPayload(url) },
    )
    const cube = await fetchWindCube({
      bbox: { west: -70.5, south: 41, east: -70, north: 41.25 },
      stepDeg: 0.25,
      hours: 2,
      includeWaves: true,
      includeCurrent: true,
    })

    expect(cube.params).toEqual(['u10', 'v10', 'gust', 'prmsl'])
    expect(cube.data.hs).toBeUndefined()
    expect(cube.data.uo).toBeUndefined()
    expect(new CubeField(cube).wind(41.1, -70.4, T0)).not.toBeNull()
    expect(cubeNotes(cube).join(' ')).toMatch(/marine model unavailable/)
  })

  it('coarsens the grid rather than issuing an enormous request', async () => {
    stub((url) => ({ ok: true, body: forecastPayload(url) }))
    // 20° x 20° at 0.25° would be 6561 points.
    const cube = await fetchWindCube({
      bbox: { west: -40, south: 20, east: -20, north: 40 },
      stepDeg: 0.25,
      hours: 2,
    })
    expect(cube.nx * cube.ny).toBeLessThanOrEqual(1600)
    expect(cube.dx).toBeGreaterThan(0.25)
    expect(cubeNotes(cube).join(' ')).toMatch(/coarsened/)
    // The bbox is still spanned exactly, so coverage does not silently shrink.
    expect(cube.bbox.east).toBeCloseTo(-20, 9)
    expect(cube.bbox.north).toBeCloseTo(40, 9)
  })
})
