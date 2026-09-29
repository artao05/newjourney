/**
 * The forecast at one point, step by step: what a meteogram draws and the
 * weather table lists. Every parameter the forecast has, and null where it has
 * none at that point and time, never a zero.
 */
import { currentFromUv, sampleCube, windFromUv } from './cube'
import type { LatLon, WeatherCube } from '../types'

export interface PointStep {
  t: number
  tws: number | null
  /** Where the wind comes from, degrees true. */
  twd: number | null
  gust: number | null
  prmsl: number | null
  hs: number | null
  t2m: number | null
  sst: number | null
  rain: number | null
  /** Current speed, knots, and where it runs to. */
  drift: number | null
  set: number | null
}

export function pointSeries(cube: WeatherCube, at: LatLon): PointStep[] {
  const out: PointStep[] = []
  const s = (p: string, t: number) => (cube.data[p] ? sampleCube(cube, p, at.lat, at.lon, t) : null)
  for (let k = 0; k < cube.nt; k++) {
    const t = cube.t0 + k * cube.dtMs
    const u = s('u10', t)
    const v = s('v10', t)
    const w = u != null && v != null ? windFromUv(u, v) : null
    const uo = s('uo', t)
    const vo = s('vo', t)
    out.push({
      t,
      tws: w ? w.speed : null,
      twd: w ? w.dir : null,
      gust: s('gust', t),
      prmsl: s('prmsl', t),
      hs: s('hs', t),
      t2m: s('t2m', t),
      sst: s('sst', t),
      rain: s('rain', t),
      drift: uo != null && vo != null ? currentFromUv(uo, vo).drift : null,
      set: uo != null && vo != null ? currentFromUv(uo, vo).set : null,
    })
  }
  return out
}

/** The columns a table of these steps needs: those with a value at some step. */
export function presentColumns(steps: PointStep[]): Array<keyof Omit<PointStep, 't'>> {
  const keys: Array<keyof Omit<PointStep, 't'>> = ['twd', 'tws', 'gust', 'prmsl', 'hs', 't2m', 'sst', 'rain', 'drift', 'set']
  return keys.filter((k) => steps.some((s) => s[k] != null))
}
