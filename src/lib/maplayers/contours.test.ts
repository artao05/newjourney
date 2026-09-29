import { describe, expect, it } from 'vitest'
import { contourFeatures, contourLevels, fieldAt } from './contours'
import type { WeatherCube } from '@/lib/types'

const T0 = Date.UTC(2026, 8, 29, 12)

function cubeOf(nx: number, ny: number, fn: (x: number, y: number, k: number) => number, params = ['prmsl'], nt = 1): WeatherCube {
  const data: Record<string, Float32Array> = {}
  for (const p of params) {
    const a = new Float32Array(nx * ny * nt)
    for (let k = 0; k < nt; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) a[k * nx * ny + j * nx + i] = fn(i, j, k)
    data[p] = a
  }
  return { model: 't', run: '', bbox: { west: -71, south: 43, east: -71 + (nx - 1) * 0.1, north: 43 + (ny - 1) * 0.1 }, nx, ny, dx: 0.1, dy: 0.1, t0: T0, dtMs: 3_600_000, nt, params, data }
}

describe('contours', () => {
  it('puts levels on whole steps across the field', () => {
    expect(contourLevels([1001.2, 1009.9, NaN, 1015], 4)).toEqual([1004, 1008, 1012])
    expect(contourLevels([3, 3, 3], 0)).toEqual([])
    expect(contourLevels([NaN], 4)).toEqual([])
  })

  it('draws straight isobars where pressure rises steadily northward, in the right place', () => {
    // 1000 hPa on the south edge, 1 hPa per row: 1004 lies on row 4, lat 43.4.
    const c = cubeOf(6, 11, (_i, j) => 1000 + j)
    const f = contourFeatures(c, { param: 'prmsl' }, T0, { step: 4, bold: 1008 }, 'isobar')
    // 1000 is the grid's own south edge, which no cell crosses.
    expect(f.map((x) => x.properties.level)).toEqual([1004, 1008])
    const l1004 = f.find((x) => x.properties.level === 1004)!
    // One joined line across the whole grid, not a segment per cell.
    expect(l1004.geometry.coordinates).toHaveLength(6)
    for (const [lon, lat] of l1004.geometry.coordinates) {
      expect(lat).toBeCloseTo(43.4, 6)
      expect(lon).toBeGreaterThanOrEqual(-71 - 1e-9)
    }
    expect(f.filter((x) => x.properties.bold).map((x) => x.properties.level)).toEqual([1008])
    expect(l1004.properties.label).toBe('1004')
  })

  it('closes a ring round a low', () => {
    const c = cubeOf(21, 21, (i, j) => 990 + Math.hypot(i - 10, j - 10))
    const ring = contourFeatures(c, { param: 'prmsl' }, T0, { step: 5, bold: null }, 'isobar').find((x) => x.properties.level === 995)!
    const pts = ring.geometry.coordinates
    expect(pts[0][0]).toBeCloseTo(pts[pts.length - 1][0], 9)
    expect(pts[0][1]).toBeCloseTo(pts[pts.length - 1][1], 9)
    // Every point about 5 cells (0.5°) from the centre.
    for (const [lon, lat] of pts) expect(Math.hypot(lon - -70, lat - 44)).toBeCloseTo(0.5, 1)
  })

  it('draws isotachs of the wind speed, between forecast steps', () => {
    const c = cubeOf(5, 5, (i, _j, k) => (k === 0 ? i * 3 : i * 3 + 6), ['u10', 'v10'], 2)
    c.data.v10.fill(0)
    const at = fieldAt(c, { speedOf: ['u10', 'v10'] }, T0 + 30 * 60_000)!
    expect(at[4]).toBeCloseTo(15, 5)
    const f = contourFeatures(c, { speedOf: ['u10', 'v10'] }, T0 + 30 * 60_000, { step: 5, bold: 10 }, 'isotach')
    // 3 kn in the first column, 15 in the last: 5, 10 and 15.
    expect(f.map((x) => x.properties.level)).toEqual([5, 10, 15])
  })

  it('draws nothing across a hole in the data', () => {
    const c = cubeOf(4, 4, (i, j) => (i === 1 && j === 1 ? NaN : 1000 + j))
    const f = contourFeatures(c, { param: 'prmsl' }, T0, { step: 1, bold: null }, 'isobar')
    const pts = f.flatMap((x) => x.geometry.coordinates)
    // No point inside the four cells round the missing corner at (1, 1).
    for (const [lon, lat] of pts) expect(!(lon > -71 && lon < -70.8 && lat > 43 && lat < 43.2)).toBe(true)
    expect(contourFeatures(c, { param: 'rain' }, T0, { step: 1, bold: null }, 'rain')).toEqual([])
  })
})
