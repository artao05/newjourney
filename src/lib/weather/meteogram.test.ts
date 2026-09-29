import { describe, expect, it } from 'vitest'
import { pointSeries, presentColumns } from './meteogram'
import { uvFromWind } from './cube'
import type { WeatherCube } from '../types'

const T0 = Date.UTC(2026, 8, 29, 12)

function cube(): WeatherCube {
  const nx = 3
  const ny = 3
  const nt = 4
  const n = nx * ny * nt
  const u10 = new Float32Array(n)
  const v10 = new Float32Array(n)
  const prmsl = new Float32Array(n)
  for (let k = 0; k < nt; k++) {
    const w = uvFromWind(8 + k * 2, 200 + k * 10)
    for (let i = 0; i < nx * ny; i++) {
      u10[k * 9 + i] = w.u
      v10[k * 9 + i] = w.v
      prmsl[k * 9 + i] = 1015 - k
    }
  }
  return { model: 't', run: '', bbox: { west: -71, south: 43, east: -70, north: 44 }, nx, ny, dx: 0.5, dy: 0.5, t0: T0, dtMs: 3 * 3_600_000, nt, params: ['u10', 'v10', 'prmsl'], data: { u10, v10, prmsl } }
}

describe('the forecast at a point', () => {
  it('gives each step its wind, from where it blows, and pressure, and null for what the forecast lacks', () => {
    const s = pointSeries(cube(), { lat: 43.5, lon: -70.5 })
    expect(s.map((x) => x.t)).toEqual([0, 1, 2, 3].map((k) => T0 + k * 3 * 3_600_000))
    expect(s.map((x) => Math.round(x.tws!))).toEqual([8, 10, 12, 14])
    expect(s.map((x) => Math.round(x.twd!))).toEqual([200, 210, 220, 230])
    expect(s.map((x) => x.prmsl)).toEqual([1015, 1014, 1013, 1012])
    expect(s[0].gust).toBeNull()
    expect(s[0].drift).toBeNull()
    expect(presentColumns(s)).toEqual(['twd', 'tws', 'prmsl'])
  })

  it('has nothing outside the forecast rather than a calm', () => {
    const s = pointSeries(cube(), { lat: 50, lon: -70.5 })
    expect(s.every((x) => x.tws === null && x.prmsl === null)).toBe(true)
    expect(presentColumns(s)).toEqual([])
  })
})
