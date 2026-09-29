import { describe, expect, it } from 'vitest'
import { ensembleStats } from './ensembleStats'
import { uvFromWind, windFromUv } from './cube'
import type { WeatherCube } from '../types'

const T0 = Date.UTC(2026, 8, 29, 12)

function member(name: string, kn: number, dir: number, prmsl?: number, over: Partial<WeatherCube> = {}): WeatherCube {
  const n = 2 * 2 * 2
  const w = uvFromWind(kn, dir)
  const data: Record<string, Float32Array> = { u10: new Float32Array(n).fill(w.u), v10: new Float32Array(n).fill(w.v) }
  if (prmsl != null) data.prmsl = new Float32Array(n).fill(prmsl)
  return { model: name, run: '', bbox: { west: -71, south: 43, east: -70, north: 44 }, nx: 2, ny: 2, dx: 1, dy: 1, t0: T0, dtMs: 3_600_000, nt: 2, params: Object.keys(data), data, ...over }
}

describe('ensemble mean and spread', () => {
  it('averages the wind as vectors, and the speed and its spread as speeds', () => {
    const m = ensembleStats([member('gfs control', 10, 180, 1010), member('gfs member 1', 14, 180, 1012), member('gfs member 2', 12, 180, 1014)])!
    expect(m.model).toBe('gfs ensemble mean of 3')
    expect(m.params).toEqual(['u10', 'v10', 'tws_mean', 'tws_sd', 'prmsl', 'prmsl_sd'])
    const w = windFromUv(m.data.u10[0], m.data.v10[0])
    expect(w.speed).toBeCloseTo(12, 4)
    expect(w.dir).toBeCloseTo(180, 4)
    expect(m.data.tws_mean[0]).toBeCloseTo(12, 4)
    expect(m.data.tws_sd[0]).toBeCloseTo(Math.sqrt(8 / 3), 4)
    expect(m.data.prmsl[0]).toBeCloseTo(1012, 3)
    expect(m.data.prmsl_sd[0]).toBeCloseTo(Math.sqrt(8 / 3), 3)
  })

  it('lets opposite winds cancel in the mean, while the mean speed keeps them', () => {
    const m = ensembleStats([member('a', 10, 0), member('b', 10, 180)])!
    expect(Math.hypot(m.data.u10[0], m.data.v10[0])).toBeCloseTo(0, 4)
    expect(m.data.tws_mean[0]).toBeCloseTo(10, 4)
    expect(m.data.tws_sd[0]).toBeCloseTo(0, 4)
    expect(m.params).not.toContain('prmsl')
  })

  it('leaves out a member on another grid, and gives nothing for no members', () => {
    const m = ensembleStats([member('a', 10, 90), member('b', 20, 90, undefined, { nx: 3 })])!
    expect(m.model).toBe('a ensemble mean of 1')
    expect(ensembleStats([])).toBeNull()
  })
})
