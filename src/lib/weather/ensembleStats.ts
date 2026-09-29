/**
 * The members of an ensemble forecast as one picture: their mean, and how far
 * they spread about it.
 *
 * The mean wind is the mean of the members' u/v vectors, so two members blowing
 * opposite ways cancel instead of averaging to a direction neither forecast.
 * Its speed, though, is the mean of the members' speeds (`tws_mean`), since a
 * vector mean understates the wind wherever members disagree on direction. The
 * spread is the standard deviation of the members' speeds (`tws_sd`) and of
 * their pressure (`prmsl_sd`). Members must share a grid, as one download's do.
 */
import type { WeatherCube } from '../types'

export function sameGrid(a: WeatherCube, b: WeatherCube): boolean {
  return a.nx === b.nx && a.ny === b.ny && a.nt === b.nt && a.t0 === b.t0 && a.dtMs === b.dtMs && a.bbox.west === b.bbox.west && a.bbox.south === b.bbox.south
}

export function ensembleStats(members: WeatherCube[]): WeatherCube | null {
  const ms = members.filter((m) => sameGrid(m, members[0]) && m.data.u10 && m.data.v10)
  if (!ms.length) return null
  const base = ms[0]
  const n = base.nx * base.ny * base.nt
  const u = new Float32Array(n)
  const v = new Float32Array(n)
  const mean = new Float32Array(n)
  const sd = new Float32Array(n)
  const withP = ms.filter((m) => m.data.prmsl)
  const p = withP.length ? new Float32Array(n) : null
  const psd = withP.length ? new Float32Array(n) : null
  for (let i = 0; i < n; i++) {
    let su = 0
    let sv = 0
    let ss = 0
    let ss2 = 0
    let k = 0
    for (const m of ms) {
      const a = m.data.u10[i]
      const b = m.data.v10[i]
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      const s = Math.hypot(a, b)
      su += a
      sv += b
      ss += s
      ss2 += s * s
      k++
    }
    if (!k) {
      u[i] = v[i] = mean[i] = sd[i] = NaN
    } else {
      u[i] = su / k
      v[i] = sv / k
      mean[i] = ss / k
      sd[i] = Math.sqrt(Math.max(0, ss2 / k - (ss / k) ** 2))
    }
    if (p && psd) {
      let sp = 0
      let sp2 = 0
      let kp = 0
      for (const m of withP) {
        const x = m.data.prmsl[i]
        if (!Number.isFinite(x)) continue
        sp += x
        sp2 += x * x
        kp++
      }
      p[i] = kp ? sp / kp : NaN
      psd[i] = kp ? Math.sqrt(Math.max(0, sp2 / kp - (sp / kp) ** 2)) : NaN
    }
  }
  const data: Record<string, Float32Array> = { u10: u, v10: v, tws_mean: mean, tws_sd: sd }
  if (p && psd) {
    data.prmsl = p
    data.prmsl_sd = psd
  }
  return {
    ...base,
    model: `${base.model.replace(/ (control|member \d+)$/i, '')} ensemble mean of ${ms.length}`,
    params: Object.keys(data),
    data,
  }
}
