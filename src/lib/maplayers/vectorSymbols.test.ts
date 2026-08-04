/**
 * Vector-field thinning tests.
 *
 * Cubes are built in memory, and every wind in them is constructed with
 * `windToUV` so the direction assertions are a genuine round trip through the
 * convention in src/lib/wind.ts rather than a restatement of it.
 *
 * The two tests that matter most are the null-dropping one and the 180° one.
 * A hole rendered as a calm arrow, or an arrow drawn pointing upwind, both look
 * completely plausible on screen — see docs/05-spec/technical-spec.md §4 and
 * docs/07-map-layers/render-architecture.md §4.
 */

import { describe, expect, it } from 'vitest'
import { angsep } from '@/lib/angles'
import { windToUV } from '@/lib/wind'
import type { WeatherCube } from '@/lib/types'
import type { ThinOptions } from './types'
import {
  PROP_FROM,
  PROP_MAGNITUDE,
  PROP_TOWARD,
  strideFor,
  thinVectorField,
  vectorSamplesToFC,
} from './vectorSymbols'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0)

interface CubeSpec {
  nx?: number
  ny?: number
  nt?: number
  west?: number
  south?: number
  dx?: number
  dy?: number
  params?: string[]
  /** Value at a node. Return NaN for a hole. */
  at?: (param: string, ix: number, iy: number, it: number) => number
}

function makeCube(spec: CubeSpec = {}): WeatherCube {
  const nx = spec.nx ?? 41
  const ny = spec.ny ?? 41
  const nt = spec.nt ?? 2
  const dx = spec.dx ?? 0.25
  const dy = spec.dy ?? 0.25
  const params = spec.params ?? ['u10', 'v10']
  // A steady 12 kn southwesterly (from 225) unless the spec says otherwise.
  const base = windToUV(225, 12)
  const at =
    spec.at ??
    ((param: string) => (param === 'u10' || param === 'uo' ? base.u : base.v))

  const data: Record<string, Float32Array> = {}
  for (const p of params) {
    const arr = new Float32Array(nt * ny * nx)
    for (let it = 0; it < nt; it++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          arr[(it * ny + iy) * nx + ix] = at(p, ix, iy, it)
        }
      }
    }
    data[p] = arr
  }

  return {
    model: 'test',
    run: new Date(T0).toISOString(),
    bbox: {
      west: spec.west ?? 0,
      south: spec.south ?? 0,
      east: (spec.west ?? 0) + (nx - 1) * dx,
      north: (spec.south ?? 0) + (ny - 1) * dy,
    },
    nx,
    ny,
    dx,
    dy,
    t0: T0,
    dtMs: HOUR,
    nt,
    params,
    data,
  }
}

const wholeCube = (cube: WeatherCube, targetAcross = 12): ThinOptions => ({
  targetAcross,
  bounds: {
    west: cube.bbox.west,
    south: cube.bbox.south,
    east: cube.bbox.west + (cube.nx - 1) * cube.dx,
    north: cube.bbox.south + (cube.ny - 1) * cube.dy,
  },
})

const UV: [string, string] = ['u10', 'v10']

describe('strideFor', () => {
  it('hits the requested symbol count across the shorter axis', () => {
    // 41 x 41 nodes at 0.25° on the equator: 10° x 10°, i.e. 600 x 600 nm.
    // 12 symbols across 600 nm is one every 50 nm, and a cell is 15 nm.
    const cube = makeCube()
    expect(strideFor(cube, wholeCube(cube, 12))).toEqual({ strideX: 3, strideY: 3 })
    expect(strideFor(cube, wholeCube(cube, 10))).toEqual({ strideX: 4, strideY: 4 })
    // Asking for more symbols than there are nodes must not stride by zero.
    expect(strideFor(cube, wholeCube(cube, 500))).toEqual({ strideX: 1, strideY: 1 })
  })

  it('widens the x stride at high latitude, where lon cells are narrow', () => {
    // 59-61°N: a 0.25° cell is 15 nm tall but only ~7.5 nm wide, so equal index
    // strides would draw the symbols in tall thin columns.
    const cube = makeCube({ nx: 33, ny: 9, south: 59 })
    const s = strideFor(cube, wholeCube(cube, 6))
    expect(s.strideX).toBeGreaterThan(s.strideY)
  })

  it('strides on the visible window, not the whole cube', () => {
    const cube = makeCube()
    const zoomed = strideFor(cube, {
      targetAcross: 12,
      bounds: { west: 4, south: 4, east: 5, north: 5 },
    })
    expect(zoomed).toEqual({ strideX: 1, strideY: 1 })
  })

  it('survives a degenerate cube', () => {
    const cube = makeCube({ nx: 1, ny: 1, nt: 1 })
    expect(strideFor(cube, wholeCube(cube))).toEqual({ strideX: 1, strideY: 1 })
  })
})

describe('thinVectorField', () => {
  it('reports both directions, exactly 180° apart', () => {
    const cube = makeCube()
    const samples = thinVectorField(cube, UV, T0, wholeCube(cube))
    expect(samples.length).toBeGreaterThan(0)
    for (const s of samples) {
      expect(angsep(s.towardDeg, s.fromDeg)).toBeCloseTo(180, 9)
      expect(s.towardDeg).toBeGreaterThanOrEqual(0)
      expect(s.towardDeg).toBeLessThan(360)
      expect(s.fromDeg).toBeGreaterThanOrEqual(0)
      expect(s.fromDeg).toBeLessThan(360)
    }
  })

  it('puts the FROM direction where the wind comes from', () => {
    // A southwesterly is FROM 225 and blows TOWARD 045.
    const cube = makeCube()
    const s = thinVectorField(cube, UV, T0, wholeCube(cube))[0]
    // 4 dp, not more: the cube stores Float32, so a knot carries about seven
    // significant digits and asserting past that tests the IEEE spec, not us.
    expect(s.fromDeg).toBeCloseTo(225, 4)
    expect(s.towardDeg).toBeCloseTo(45, 4)
    expect(s.magnitude).toBeCloseTo(12, 4)
  })

  it('reports magnitude in knots, matching hypot(u, v)', () => {
    const cube = makeCube({
      at: (p) => (p === 'u10' ? 9 : 12),
    })
    const s = thinVectorField(cube, UV, T0, wholeCube(cube))[0]
    expect(s.magnitude).toBeCloseTo(15, 9)
  })

  it('never emits a symbol outside the bounds', () => {
    const cube = makeCube()
    const bounds = { west: 2, south: 3, east: 4, north: 6 }
    const samples = thinVectorField(cube, UV, T0, { targetAcross: 8, bounds })
    expect(samples.length).toBeGreaterThan(0)
    for (const s of samples) {
      expect(s.lon).toBeGreaterThanOrEqual(bounds.west)
      expect(s.lon).toBeLessThanOrEqual(bounds.east)
      expect(s.lat).toBeGreaterThanOrEqual(bounds.south)
      expect(s.lat).toBeLessThanOrEqual(bounds.north)
    }
  })

  it('drops holes instead of drawing them as calm', () => {
    // Hole over the western half of the grid.
    const base = windToUV(225, 12)
    const cube = makeCube({
      at: (p, ix) => {
        if (ix < 20) return NaN
        return p === 'u10' ? base.u : base.v
      },
    })
    const samples = thinVectorField(cube, UV, T0, wholeCube(cube))
    expect(samples.length).toBeGreaterThan(0)
    // 20 nodes of hole at 0.25° from west 0 means nothing below lon 5 survives.
    // (The node at index 19 is still bilinearly contaminated, so 4.75 is out too.)
    for (const s of samples) expect(s.lon).toBeGreaterThanOrEqual(5)
    for (const s of samples) expect(s.magnitude).toBeCloseTo(12, 4)
  })

  it('drops a sample when only one component is missing', () => {
    // A present u with a missing v is not a wind blowing due east.
    const cube = makeCube({
      at: (p) => (p === 'u10' ? 8 : NaN),
    })
    expect(thinVectorField(cube, UV, T0, wholeCube(cube))).toEqual([])
  })

  it('returns nothing when a named parameter is absent', () => {
    const cube = makeCube()
    expect(thinVectorField(cube, ['uo', 'vo'], T0, wholeCube(cube))).toEqual([])
  })

  it('returns nothing when the viewport misses the cube', () => {
    const cube = makeCube()
    const away: ThinOptions = {
      targetAcross: 12,
      bounds: { west: 40, south: 40, east: 45, north: 45 },
    }
    expect(thinVectorField(cube, UV, T0, away)).toEqual([])
  })

  it('returns nothing outside the time span', () => {
    const cube = makeCube()
    expect(thinVectorField(cube, UV, T0 - HOUR, wholeCube(cube))).toEqual([])
    expect(thinVectorField(cube, UV, T0 + 5 * HOUR, wholeCube(cube))).toEqual([])
  })

  it('interpolates between forecast steps rather than snapping to one', () => {
    // Step 0: 10 kn northerly. Step 1: 20 kn northerly. Halfway is 15.
    const cube = makeCube({
      at: (p, _ix, _iy, it) => {
        const uv = windToUV(0, it === 0 ? 10 : 20)
        return p === 'u10' ? uv.u : uv.v
      },
    })
    const mid = thinVectorField(cube, UV, T0 + HOUR / 2, wholeCube(cube))[0]
    expect(mid.magnitude).toBeCloseTo(15, 6)
    expect(mid.fromDeg).toBeCloseTo(0, 6)
  })

  it('anchors symbols to the cube grid so panning does not reshuffle them', () => {
    const cube = makeCube()
    const { strideX, strideY } = strideFor(cube, wholeCube(cube))
    const samples = thinVectorField(cube, UV, T0, wholeCube(cube))
    for (const s of samples) {
      const ix = Math.round((s.lon - cube.bbox.west) / cube.dx)
      const iy = Math.round((s.lat - cube.bbox.south) / cube.dy)
      expect(ix % strideX, `lon ${s.lon}`).toBe(0)
      expect(iy % strideY, `lat ${s.lat}`).toBe(0)
    }
  })

  it('thins: fewer symbols than grid nodes, but a legible number of them', () => {
    const cube = makeCube()
    const samples = thinVectorField(cube, UV, T0, wholeCube(cube, 12))
    expect(samples.length).toBeLessThan(cube.nx * cube.ny)
    // 41 nodes at stride 3 is 14 across, so ~14 x 14 symbols.
    expect(samples.length).toBeGreaterThan(100)
    expect(samples.length).toBeLessThan(400)
  })

  it('keeps two layers over the same cube on the same nodes', () => {
    // Barbs and current arrows have to agree, or the display looks like two
    // different grids fighting.
    const base = windToUV(225, 12)
    const cube = makeCube({
      params: ['u10', 'v10', 'uo', 'vo'],
      at: (p) => (p === 'u10' || p === 'uo' ? base.u : base.v),
    })
    const opts = wholeCube(cube)
    const wind = thinVectorField(cube, UV, T0, opts)
    const cur = thinVectorField(cube, ['uo', 'vo'], T0, opts)
    expect(cur.map((s) => [s.lon, s.lat])).toEqual(wind.map((s) => [s.lon, s.lat]))
  })
})

describe('vectorSamplesToFC', () => {
  const cube = makeCube()
  const samples = thinVectorField(cube, UV, T0, wholeCube(cube))
  const fc = vectorSamplesToFC(samples) as {
    type: string
    features: Array<{
      type: string
      properties: Record<string, number>
      geometry: { type: string; coordinates: [number, number] }
    }>
  }

  it('is a FeatureCollection of one Point per sample', () => {
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(samples.length)
    expect(fc.features[0].type).toBe('Feature')
    expect(fc.features[0].geometry.type).toBe('Point')
  })

  it('writes coordinates lon-then-lat', () => {
    // GeoJSON is x,y. Swapping them is the oldest bug in mapping.
    const f = fc.features[0]
    expect(f.geometry.coordinates[0]).toBeCloseTo(samples[0].lon, 5)
    expect(f.geometry.coordinates[1]).toBeCloseTo(samples[0].lat, 5)
  })

  it('carries the properties the symbol layers read', () => {
    const p = fc.features[0].properties
    expect(p[PROP_MAGNITUDE]).toBeCloseTo(12, 1)
    expect(p[PROP_FROM]).toBeCloseTo(225, 1)
    expect(p[PROP_TOWARD]).toBeCloseTo(45, 1)
  })

  it('handles an empty field', () => {
    const empty = vectorSamplesToFC([]) as { features: unknown[] }
    expect(empty.features).toEqual([])
  })
})
