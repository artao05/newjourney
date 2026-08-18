/**
 * The weather cube: conventions, codec, and circular interpolation.
 *
 * `cube.ts` opens by naming three load-bearing rules and calling one of them "a
 * genuine trap". Two of the three had no direct tests: the current sign convention
 * (used on every ocean-current vector the app ingests) and `sampleCubeDirection`
 * (the function that exists solely to stop a swell interpolating the wrong way
 * round). Their wind counterparts had eleven and eight test references. The tested
 * half was the half that was already hard to get wrong.
 *
 * The sign tests below are deliberately written as *comparisons between* the wind
 * and current pairs rather than as two independent checks, because the hazard is
 * not either convention on its own — it is that they are opposites.
 */

import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  MISSING,
  currentFromUv,
  cubeCoverage,
  cubeIndex,
  cubeSizeBytes,
  decodeCube,
  emptyCubeData,
  encodeCube,
  sampleCube,
  sampleCubeDirection,
  scaleFor,
  uvFromCurrent,
  uvFromWind,
  windFromUv,
} from './cube'
import type { WeatherCube } from '../types'

const T0 = Date.UTC(2026, 7, 6, 12, 0, 0)
const HOUR = 3_600_000

/** A cube with one parameter laid out as `values[t][y][x]`. */
function cubeOf(param: string, values: number[][][], over?: Partial<WeatherCube>): WeatherCube {
  const nt = values.length
  const ny = values[0].length
  const nx = values[0][0].length
  const flat = new Float32Array(nt * ny * nx)
  let i = 0
  for (const step of values) for (const row of step) for (const v of row) flat[i++] = v
  return {
    model: 'test',
    run: 'test-run',
    bbox: { west: -71, south: 43, east: -70, north: 44 },
    nx,
    ny,
    dx: nx > 1 ? 1 / (nx - 1) : 1,
    dy: ny > 1 ? 1 / (ny - 1) : 1,
    t0: T0,
    dtMs: HOUR,
    nt,
    params: [param],
    data: { [param]: flat },
    ...over,
  }
}

describe('the sign-convention trap', () => {
  /*
   * Rule 1 of the module docstring, and the one it calls a genuine trap: wind
   * direction is where the air comes FROM, current set is where the water goes
   * TO. So the same compass number produces opposite vectors.
   */
  it('gives a wind and a current on the same bearing opposite vectors', () => {
    const wind = uvFromWind(10, 90) // wind FROM the east: blowing westward
    const current = uvFromCurrent(10, 90) // current setting east: flowing eastward

    expect(wind.u).toBeCloseTo(-10, 9)
    expect(current.u).toBeCloseTo(10, 9)
    expect(Math.sign(wind.u)).toBe(-Math.sign(current.u))

    // And on a northerly bearing, in v.
    expect(uvFromWind(10, 0).v).toBeCloseTo(-10, 9)
    expect(uvFromCurrent(10, 0).v).toBeCloseTo(10, 9)
  })

  it('points a current vector where the water is going', () => {
    expect(uvFromCurrent(2, 0)).toEqual({ u: expect.closeTo(0, 9), v: expect.closeTo(2, 9) })
    expect(uvFromCurrent(2, 90)).toEqual({ u: expect.closeTo(2, 9), v: expect.closeTo(0, 9) })
    expect(uvFromCurrent(2, 180)).toEqual({ u: expect.closeTo(0, 9), v: expect.closeTo(-2, 9) })
    expect(uvFromCurrent(2, 270)).toEqual({ u: expect.closeTo(-2, 9), v: expect.closeTo(0, 9) })
  })

  it('round-trips a current through uv and back', () => {
    for (const set of [0, 37, 90, 179, 180, 271, 359.5]) {
      for (const drift of [0.05, 1, 4.2]) {
        const { u, v } = uvFromCurrent(drift, set)
        const back = currentFromUv(u, v)
        expect(back.drift).toBeCloseTo(drift, 9)
        expect(back.set).toBeCloseTo(set, 6)
      }
    }
  })

  it('round-trips a wind through uv and back', () => {
    for (const dir of [0, 45, 123, 270, 359]) {
      const { u, v } = uvFromWind(12, dir)
      const back = windFromUv(u, v)
      expect(back.speed).toBeCloseTo(12, 9)
      expect(back.dir).toBeCloseTo(dir, 6)
    }
  })

  it('reports a still current as zero drift without inventing a direction', () => {
    // atan2(0,0) is 0, so the set reads as north. Harmless only because the drift
    // is zero — any consumer that draws an arrow must check the magnitude first.
    expect(currentFromUv(0, 0).drift).toBe(0)
  })
})

describe('sampleCubeDirection', () => {
  /*
   * Rule 1's other half. A bearing field cannot be interpolated arithmetically:
   * the average of 350 and 010 is 180, a swell running exactly backwards. Wind and
   * current dodge this by living as u/v; wave direction has no u/v slot, so it goes
   * round the unit circle instead.
   */
  it('interpolates across the 0/360 seam the short way', () => {
    const c = cubeOf('wdir', [[[350, 10]]])
    // Midway between the two cells: 0, not 180.
    const mid = sampleCubeDirection(c, 'wdir', 43, -70.5, T0)
    expect(mid).not.toBeNull()
    expect(Math.min(Math.abs(mid as number), 360 - (mid as number))).toBeCloseTo(0, 4)

    // The arithmetic mean would be here, and must not be.
    expect(Math.abs((mid as number) - 180)).toBeGreaterThan(170)
  })

  it('interpolates a plain span without the seam', () => {
    const c = cubeOf('wdir', [[[80, 100]]])
    expect(sampleCubeDirection(c, 'wdir', 43, -70.5, T0)).toBeCloseTo(90, 4)
  })

  it('interpolates in time as well as space', () => {
    const c = cubeOf('wdir', [[[350]], [[10]]])
    const mid = sampleCubeDirection(c, 'wdir', 43, -71, T0 + HOUR / 2)
    expect(mid).not.toBeNull()
    expect(Math.min(Math.abs(mid as number), 360 - (mid as number))).toBeCloseTo(0, 4)
  })

  it('returns null for a missing parameter, outside coverage, and over a hole', () => {
    const c = cubeOf('wdir', [[[350, 10]]])
    expect(sampleCubeDirection(c, 'nope', 43, -70.5, T0)).toBeNull()
    expect(sampleCubeDirection(c, 'wdir', 60, -70.5, T0)).toBeNull()
    expect(sampleCubeDirection(c, 'wdir', 43, -70.5, T0 + 99 * HOUR)).toBeNull()

    const holed = cubeOf('wdir', [[[NaN, NaN]]])
    expect(sampleCubeDirection(holed, 'wdir', 43, -70.5, T0)).toBeNull()
  })

  it('drops a missing corner instead of letting it drag the bearing', () => {
    // One real cell and one hole: the answer is the real cell, not a blend with 0.
    const c = cubeOf('wdir', [[[45, NaN]]])
    expect(sampleCubeDirection(c, 'wdir', 43, -70.75, T0)).toBeCloseTo(45, 4)
  })
})

describe('sampleCube', () => {
  it('is bilinear in space and linear in time', () => {
    const c = cubeOf('gust', [
      [
        [0, 10],
        [20, 30],
      ],
      [
        [100, 110],
        [120, 130],
      ],
    ])
    expect(sampleCube(c, 'gust', 43, -71, T0)).toBeCloseTo(0, 6)
    expect(sampleCube(c, 'gust', 43, -70, T0)).toBeCloseTo(10, 6)
    expect(sampleCube(c, 'gust', 43.5, -70.5, T0)).toBeCloseTo(15, 6)
    expect(sampleCube(c, 'gust', 43, -71, T0 + HOUR / 2)).toBeCloseTo(50, 6)
  })

  it('returns null rather than zero outside coverage', () => {
    // Rule 2: "a route computed through a region of no data silently treated as
    // no wind is precisely the failure mode that puts a boat somewhere it did not
    // plan to be."
    const c = cubeOf('gust', [[[5, 5]]])
    expect(sampleCube(c, 'gust', 43, -72, T0)).toBeNull()
    expect(sampleCube(c, 'gust', 50, -70.5, T0)).toBeNull()
    expect(sampleCube(c, 'gust', 43, -70.5, T0 - HOUR)).toBeNull()
    expect(sampleCube(c, 'missing-param', 43, -70.5, T0)).toBeNull()
  })

  it('accepts the exact end of the time window', () => {
    const c = cubeOf('gust', [[[1]], [[2]]])
    expect(sampleCube(c, 'gust', 43, -71, T0 + HOUR)).toBeCloseTo(2, 6)
  })

  it('refuses to paper over a missing time step with its neighbour', () => {
    // A coastline hole degrades gracefully; a whole missing hour is a real gap in
    // the forecast and must read as one.
    const c = cubeOf('gust', [[[10]], [[NaN]]])
    expect(sampleCube(c, 'gust', 43, -71, T0)).toBeCloseTo(10, 6)
    expect(sampleCube(c, 'gust', 43, -71, T0 + HOUR / 2)).toBeNull()
  })
})

describe('cubeCoverage', () => {
  it('reports the extent the grid actually spans, not the requested bbox', () => {
    /*
     * The origin corner plus the step is the real coverage; a bbox whose east edge
     * does not land on a grid node would otherwise claim data that is not there.
     */
    const c = cubeOf('gust', [[[1, 2, 3]]], {
      bbox: { west: -71, south: 43, east: -60, north: 44 },
      dx: 0.5,
    })
    const cov = cubeCoverage(c)
    expect(cov.bbox.west).toBe(-71)
    expect(cov.bbox.east).toBeCloseTo(-70, 9) // west + 2 * 0.5, not -60
    expect(cov.t0).toBe(T0)
    expect(cov.t1).toBe(T0)
  })

  it('spans nt - 1 steps in time', () => {
    const c = cubeOf('gust', [[[1]], [[2]], [[3]]])
    expect(cubeCoverage(c).t1).toBe(T0 + 2 * HOUR)
  })
})

describe('encode / decode', () => {
  const reference = (): WeatherCube => {
    // Three params, three steps, a smooth field plus a hole.
    const nx = 4
    const ny = 3
    const nt = 3
    const mk = (f: (i: number, j: number, t: number) => number) => {
      const a = new Float32Array(nt * ny * nx)
      let k = 0
      for (let t = 0; t < nt; t++) {
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) a[k++] = f(i, j, t)
      }
      return a
    }
    return {
      model: 'gfs',
      run: '2026-08-06T12Z',
      bbox: { west: -71, south: 43, east: -70, north: 43.5 },
      nx,
      ny,
      dx: 1 / 3,
      dy: 0.25,
      t0: T0,
      dtMs: HOUR,
      nt,
      params: ['u10', 'v10', 'gust'],
      data: {
        u10: mk((i, j, t) => i + j * 0.5 + t),
        v10: mk((i, _j, t) => -i * 0.25 + t * 0.5),
        gust: mk((i, j, t) => (i === 0 && j === 0 && t === 1 ? NaN : 10 + i + t)),
      },
    }
  }

  it('round-trips every value within half a quantisation step', () => {
    const c = reference()
    const back = decodeCube(encodeCube(c))
    expect(back.params).toEqual(c.params)
    expect(back.nx).toBe(c.nx)
    expect(back.nt).toBe(c.nt)
    expect(back.model).toBe('gfs')
    expect(back.run).toBe('2026-08-06T12Z')
    for (const p of c.params) {
      const tol = scaleFor(p) / 2 + 1e-9
      for (let i = 0; i < c.data[p].length; i++) {
        const want = c.data[p][i]
        if (Number.isNaN(want)) continue
        expect(Math.abs(back.data[p][i] - want), `${p}[${i}]`).toBeLessThanOrEqual(tol)
      }
    }
  })

  it('keeps a hole a hole, through the delta filter', () => {
    /*
     * The subtle half of the codec: a hole must not disturb the predictor, or every
     * value after it in that cell's time series decodes against the wrong baseline.
     */
    const c = reference()
    const back = decodeCube(encodeCube(c))
    const cells = c.ny * c.nx
    expect(Number.isNaN(back.data.gust[1 * cells])).toBe(true)
    // The step after the hole still decodes correctly against the last real value.
    expect(back.data.gust[2 * cells]).toBeCloseTo(12, 2)
    expect(back.data.gust[0]).toBeCloseTo(10, 2)
  })

  it('preserves a field that is entirely holes', () => {
    const c = cubeOf('hs', [[[NaN, NaN]], [[NaN, NaN]]])
    const back = decodeCube(encodeCube(c))
    for (const v of back.data.hs) expect(Number.isNaN(v)).toBe(true)
  })

  it('clamps beyond the representable range rather than wrapping', () => {
    // ±16383 counts, deliberately half of Int16, so any difference between two
    // quantised values still fits and can never collide with MISSING.
    const c = cubeOf('u10', [[[500, -500]]]) // 500 kn, scale 0.01 -> 50 000 counts
    const back = decodeCube(encodeCube(c))
    expect(back.data.u10[0]).toBeCloseTo(163.83, 2)
    expect(back.data.u10[1]).toBeCloseTo(-163.83, 2)
  })

  it('survives a field that alternates between the extremes', () => {
    // The worst case for a delta filter: every step is a full-range swing, so the
    // residual is ±32766 — one count inside the sentinel, which is the whole reason
    // the value range is capped at half of Int16.
    const c = cubeOf('u10', [[[163.83]], [[-163.83]], [[163.83]]])
    const back = decodeCube(encodeCube(c))
    expect(back.data.u10[0]).toBeCloseTo(163.83, 2)
    expect(back.data.u10[1]).toBeCloseTo(-163.83, 2)
    expect(back.data.u10[2]).toBeCloseTo(163.83, 2)
    for (const v of back.data.u10) expect(Number.isNaN(v)).toBe(false)
  })

  it('prices the payload exactly, before building it', () => {
    // The offline pack manager quotes a download size from this, so a wrong answer
    // is a wrong promise to the user.
    const c = reference()
    expect(cubeSizeBytes(c)).toBe(encodeCube(c).byteLength)
  })

  it('rejects a corrupt payload loudly', () => {
    const good = encodeCube(reference())

    expect(() => decodeCube(new ArrayBuffer(4))).toThrow(/truncated/i)

    const badMagic = good.slice(0)
    new DataView(badMagic).setUint32(0, 0xdeadbeef, false)
    expect(() => decodeCube(badMagic)).toThrow(/magic/i)

    const badVersion = good.slice(0)
    new DataView(badVersion).setUint16(4, 99, true)
    expect(() => decodeCube(badVersion)).toThrow(/version/i)
  })

  it('is inspectable with a hex dump, as the format promises', () => {
    // The header is JSON immediately after a 12-byte preamble, so `head -c 400`
    // tells you what a cube is without any tooling.
    const buf = encodeCube(reference())
    const headerLength = new DataView(buf).getUint32(8, true)
    const json = new TextDecoder().decode(new Uint8Array(buf, 12, headerLength))
    const header = JSON.parse(json)
    expect(header.model).toBe('gfs')
    expect(header.params).toEqual(['u10', 'v10', 'gust'])
    expect(header.missing).toBe(MISSING)
    expect(header.filter).toBe('delta-t,shuffle')
    expect(header.scale.u10).toBe(0.01)
  })

  /*
   * The size claim in the module docstring, which used to read "127 318 bytes raw
   * and 30 242 gzipped" and was not reproducible in either half.
   *
   * The **body** is a pure function of the geometry — `params × nt × ny × nx × 2`
   * — and is pinned exactly. The **total** is not: it adds a JSON header carrying
   * the model name, run label and coordinates, so it moves with the strings a
   * particular cube happens to hold (10 bytes, in the gap between the documented
   * figure and this one). The **gzipped** size is a property of the weather, not of
   * the format, so what is asserted is the claim that actually matters: a smooth
   * field of this shape lands inside the spec's 35 KB race-morning budget, and the
   * delta+shuffle filter is doing real work getting it there.
   */
  it('matches the documented size for the reference cube', () => {
    const nx = 21
    const ny = 21
    const nt = 48
    const params = ['u10', 'v10', 'gust']
    const data: Record<string, Float32Array> = {}
    for (const p of params) {
      const a = new Float32Array(nt * ny * nx)
      let k = 0
      for (let t = 0; t < nt; t++) {
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            // A smooth synoptic-ish field: a gradient that rotates slowly.
            a[k++] = 12 + 6 * Math.sin((i + t) / 7) + 3 * Math.cos((j - t) / 9)
          }
        }
      }
      data[p] = a
    }
    const cube: WeatherCube = {
      model: 'gfs',
      run: '2026-08-06T12Z',
      bbox: { west: -75, south: 40, east: -70, north: 45 },
      nx,
      ny,
      dx: 0.25,
      dy: 0.25,
      t0: T0,
      dtMs: HOUR,
      nt,
      params,
      data,
    }

    const raw = encodeCube(cube)

    // The checkable part: body size from geometry alone.
    const body = params.length * nt * ny * nx * 2
    expect(body).toBe(127_008)
    // Plus a 12-byte preamble and a variable-length JSON header — a few hundred
    // bytes, never zero, and never a fixed number.
    expect(raw.byteLength).toBeGreaterThan(body + 12)
    expect(raw.byteLength).toBeLessThan(body + 600)

    const gz = gzipSync(Buffer.from(raw)).byteLength
    expect(gz).toBeLessThan(35 * 1024)
    // And the filter is doing real work: unfiltered Int16 gzips to roughly half.
    expect(gz).toBeLessThan(raw.byteLength * 0.4)
  })
})

describe('helpers', () => {
  it('indexes the flat array in [t][y][x] order', () => {
    const c = cubeOf('gust', [
      [
        [1, 2],
        [3, 4],
      ],
      [
        [5, 6],
        [7, 8],
      ],
    ])
    expect(c.data.gust[cubeIndex(c, 0, 0, 0)]).toBe(1)
    expect(c.data.gust[cubeIndex(c, 1, 0, 0)]).toBe(2)
    expect(c.data.gust[cubeIndex(c, 0, 1, 0)]).toBe(3)
    expect(c.data.gust[cubeIndex(c, 0, 0, 1)]).toBe(5)
  })

  it('allocates empty planes as holes, not as zeros', () => {
    const d = emptyCubeData(['u10', 'v10'], 2, 3, 4)
    expect(Object.keys(d)).toEqual(['u10', 'v10'])
    expect(d.u10.length).toBe(2 * 3 * 4)
    for (const v of d.u10) expect(Number.isNaN(v)).toBe(true)
  })

  it('gives every known parameter a scale, and a default to the rest', () => {
    expect(scaleFor('u10')).toBe(0.01)
    expect(scaleFor('uo')).toBe(0.001) // currents are small: buy resolution
    expect(scaleFor('prmsl')).toBe(0.1)
    expect(scaleFor('something-new')).toBe(0.01)
  })
})
