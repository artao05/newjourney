/**
 * Harmonic tide prediction from a station's constants, as NOAA publishes them:
 *
 *   h(t) = Z0 + Σ f·H·cos(V(t) + u − κ)
 *
 * H and κ are the station's amplitude and Greenwich phase for each constituent.
 * V is the constituent's equilibrium argument, a sum of the mean hour angle of
 * the Sun (T) and the mean longitudes of the Moon (s), the Sun (h), the lunar
 * perigee (p) and the solar perigee (p1); f and u are the node factor and
 * phase correction for the 18.6-year cycle of the Moon's node, after
 * Schureman's Manual of Harmonic Analysis and Prediction of Tides (1958).
 *
 * The mean elements are Meeus's, from J2000.0. The difference between UT and
 * TT (about a minute) is ignored: it moves a tide by well under a second.
 */
import type { Millis } from '../types'

const DEG = Math.PI / 180
const J2000 = Date.UTC(2000, 0, 1, 12)
const wrap = (d: number) => ((d % 360) + 360) % 360

export interface Astro {
  /** Mean hour angle of the Sun at Greenwich, from midnight: 180° + 15°·UT hours. */
  T: number
  s: number
  h: number
  p: number
  N: number
  p1: number
  /** Inclination of the Moon's orbit to the equator, and Schureman's ν, ξ, ν′ and 2ν″. */
  I: number
  nu: number
  xi: number
  nup: number
  nupp2: number
}

export function astro(t: Millis): Astro {
  const c = (t - J2000) / (36525 * 86_400_000)
  const s = wrap(218.3164477 + 481267.88123421 * c)
  const h = wrap(280.46646 + 36000.76983 * c)
  const p = wrap(83.3532465 + 4069.0137287 * c)
  const N = wrap(125.04452 - 1934.136261 * c)
  const p1 = wrap(282.93768 + 1.71946 * c)
  const hours = (((t % 86_400_000) + 86_400_000) % 86_400_000) / 3_600_000
  const T = wrap(180 + 15 * hours)
  // The Moon's orbit against the equator (Schureman §§ 50–57).
  const omega = 23.452 * DEG
  const i = 5.145 * DEG
  const n = N * DEG
  const I = Math.acos(Math.cos(omega) * Math.cos(i) - Math.sin(omega) * Math.sin(i) * Math.cos(n))
  const nu = Math.asin((Math.sin(i) * Math.sin(n)) / Math.sin(I))
  const e1 = Math.atan((Math.cos((omega - i) / 2) / Math.cos((omega + i) / 2)) * Math.tan(n / 2)) - n / 2
  const e2 = Math.atan((Math.sin((omega - i) / 2) / Math.sin((omega + i) / 2)) * Math.tan(n / 2)) - n / 2
  const xi = -(e1 + e2)
  const nup = Math.atan2(Math.sin(2 * I) * Math.sin(nu), Math.sin(2 * I) * Math.cos(nu) + 0.3347)
  const nupp2 = Math.atan2(Math.sin(I) ** 2 * Math.sin(2 * nu), Math.sin(I) ** 2 * Math.cos(2 * nu) + 0.0727)
  return { T, s, h, p, N, p1, I: I / DEG, nu: nu / DEG, xi: xi / DEG, nup: nup / DEG, nupp2: nupp2 / DEG }
}

// ------------------------------------------------ node factors and phases

type Fn = (a: Astro) => number
const sin = (d: number) => Math.sin(d * DEG)
const cos = (d: number) => Math.cos(d * DEG)
const tan = (d: number) => Math.tan(d * DEG)

const fM2: Fn = (a) => cos(a.I / 2) ** 4 / 0.9154
const uM2: Fn = (a) => 2 * a.xi - 2 * a.nu
const fO1: Fn = (a) => (sin(a.I) * cos(a.I / 2) ** 2) / 0.38
const uO1: Fn = (a) => 2 * a.xi - a.nu
const fK1: Fn = (a) => Math.sqrt(0.8965 * sin(2 * a.I) ** 2 + 0.6001 * sin(2 * a.I) * cos(a.nu) + 0.1006)
const uK1: Fn = (a) => -a.nup
const fK2: Fn = (a) => Math.sqrt(19.0444 * sin(a.I) ** 4 + 2.7702 * sin(a.I) ** 2 * cos(2 * a.nu) + 0.0981)
const uK2: Fn = (a) => -a.nupp2
const fJ1: Fn = (a) => sin(2 * a.I) / 0.7214
const uJ1: Fn = (a) => -a.nu
const fOO1: Fn = (a) => (sin(a.I) * sin(a.I / 2) ** 2) / 0.0164
const uOO1: Fn = (a) => -2 * a.xi - a.nu
const fMf: Fn = (a) => sin(a.I) ** 2 / 0.1578
const uMf: Fn = (a) => -2 * a.xi
const fMm: Fn = (a) => (2 / 3 - sin(a.I) ** 2) / 0.5021
const fM3: Fn = (a) => cos(a.I / 2) ** 6 / 0.8758
const uM3: Fn = (a) => 3 * a.xi - 3 * a.nu
/** L2's extra terms (Schureman eqs. 213–215), with P = p − ξ. */
const l2R = (a: Astro) => {
  const P = a.p - a.xi
  const t2 = tan(a.I / 2) ** 2
  const R = Math.atan2(sin(2 * P), 1 / (6 * t2) - cos(2 * P)) / DEG
  const invRa = Math.sqrt(1 - 12 * t2 * cos(2 * P) + 36 * t2 * t2)
  return { R, invRa }
}
const fL2: Fn = (a) => fM2(a) * l2R(a).invRa
const uL2: Fn = (a) => 2 * a.xi - 2 * a.nu - l2R(a).R
const one: Fn = () => 1
const zero: Fn = () => 0

export interface Constituent {
  /** Coefficients of T, s, h, p, p1, and a constant phase, degrees. */
  v: [number, number, number, number, number, number]
  f: Fn
  u: Fn
}

const c = (v: Constituent['v'], f: Fn, u: Fn): Constituent => ({ v, f, u })
/** A compound tide: the sum of others, with node factors multiplied and phases added. */
const sum = (...parts: Array<[number, Constituent]>): Constituent => ({
  v: parts.reduce((acc, [k, x]) => acc.map((a, i) => a + k * x.v[i]) as Constituent['v'], [0, 0, 0, 0, 0, 0] as Constituent['v']),
  f: (a) => parts.reduce((m, [k, x]) => m * x.f(a) ** Math.abs(k), 1),
  u: (a) => parts.reduce((m, [k, x]) => m + k * x.u(a), 0),
})

const M2 = c([2, -2, 2, 0, 0, 0], fM2, uM2)
const S2 = c([2, 0, 0, 0, 0, 0], one, zero)
const N2 = c([2, -3, 2, 1, 0, 0], fM2, uM2)
const K1 = c([1, 0, 1, 0, 0, -90], fK1, uK1)
const O1 = c([1, -2, 1, 0, 0, 90], fO1, uO1)
const K2 = c([2, 0, 2, 0, 0, 0], fK2, uK2)

/** NOAA's 37, by the names its harmonic constants use. */
export const CONSTITUENTS: Record<string, Constituent> = {
  M2,
  S2,
  N2,
  K1,
  O1,
  K2,
  P1: c([1, 0, -1, 0, 0, 90], one, zero),
  Q1: c([1, -3, 1, 1, 0, 90], fO1, uO1),
  '2Q1': c([1, -4, 1, 2, 0, 90], fO1, uO1),
  RHO: c([1, -3, 3, -1, 0, 90], fO1, uO1),
  J1: c([1, 1, 1, -1, 0, -90], fJ1, uJ1),
  OO1: c([1, 2, 1, 0, 0, -90], fOO1, uOO1),
  // The radiational S1 has the Sun's hour angle as it is (checked against NOAA's predictions).
  S1: c([1, 0, 0, 0, 0, 0], one, zero),
  // M1's node terms are small and awkward; its equilibrium phase with O1's corrections.
  M1: c([1, -1, 1, 1, 0, -90], fO1, uO1),
  '2N2': c([2, -4, 2, 2, 0, 0], fM2, uM2),
  NU2: c([2, -3, 4, -1, 0, 0], fM2, uM2),
  MU2: c([2, -4, 4, 0, 0, 0], fM2, uM2),
  LAM2: c([2, -1, 0, 1, 0, 180], fM2, uM2),
  L2: c([2, -1, 2, -1, 0, 180], fL2, uL2),
  T2: c([2, 0, -1, 0, 1, 0], one, zero),
  R2: c([2, 0, 1, 0, -1, 180], one, zero),
  '2SM2': sum([2, S2], [-1, M2]),
  M3: c([3, -3, 3, 0, 0, 180], fM3, uM3),
  MK3: sum([1, M2], [1, K1]),
  '2MK3': sum([2, M2], [-1, K1]),
  M4: sum([2, M2]),
  MN4: sum([1, M2], [1, N2]),
  MS4: sum([1, M2], [1, S2]),
  S4: sum([2, S2]),
  M6: sum([3, M2]),
  S6: sum([3, S2]),
  M8: sum([4, M2]),
  MM: c([0, 1, 0, -1, 0, 0], fMm, zero),
  MF: c([0, 2, 0, 0, 0, 0], fMf, uMf),
  MSF: sum([1, S2], [-1, M2]),
  SA: c([0, 0, 1, 0, 0, 0], one, zero),
  SSA: c([0, 0, 2, 0, 0, 0], one, zero),
}

/** Degrees per hour of the mean elements, for a constituent's speed. */
const RATES = [15, 0.5490165, 0.0410686, 0.0046418, 0.0000019, 0]

export function speed(k: Constituent): number {
  return k.v.reduce((s, x, i) => s + x * RATES[i], 0)
}

/** V + u for a constituent at `t`, degrees. */
export function argument(k: Constituent, a: Astro): number {
  const [cT, cs, ch, cp, cp1, c0] = k.v
  return wrap(cT * a.T + cs * a.s + ch * a.h + cp * a.p + cp1 * a.p1 + c0 + k.u(a))
}

export interface HarmonicConstant {
  name: string
  /** Amplitude, in the height unit wanted. */
  amplitude: number
  /** Greenwich phase lag κ, degrees. */
  phase: number
}

/**
 * When the node factors and phases are taken for a time: the middle of its
 * year, as NOAA's own predictions do. Against NOAA's predictions for Portland
 * this gives 2 mm RMS; taking them at the instant itself gives 7 mm.
 */
export function nodeTime(t: Millis): Millis {
  return Date.UTC(new Date(t).getUTCFullYear(), 6, 2)
}

/**
 * The tide at `t` from `constants`, above the datum whose mean is `z0`.
 * Unknown constituents are left out; `missingConstituents` lists them.
 */
export function predictTide(constants: HarmonicConstant[], t: Millis, z0 = 0): number {
  const a = astro(t)
  const b = astro(nodeTime(t))
  let hgt = z0
  for (const k of constants) {
    const con = CONSTITUENTS[k.name]
    if (!con || !k.amplitude) continue
    const [cT, cs, ch, cp, cp1, c0] = con.v
    const V = cT * a.T + cs * a.s + ch * a.h + cp * a.p + cp1 * a.p1 + c0
    hgt += con.f(b) * k.amplitude * cos(V + con.u(b) - k.phase)
  }
  return hgt
}

export function missingConstituents(constants: HarmonicConstant[]): string[] {
  return constants.filter((k) => k.amplitude && !CONSTITUENTS[k.name]).map((k) => k.name)
}

/** NOAA's metadata API harmonic constants, in metres with `units=metric`. */
export function parseHarcon(json: unknown): HarmonicConstant[] {
  const list = (json as { HarmonicConstituents?: unknown } | null)?.HarmonicConstituents
  if (!Array.isArray(list)) return []
  return list
    .map((r: { name?: unknown; amplitude?: unknown; phase_GMT?: unknown }) => ({ name: String(r.name ?? ''), amplitude: Number(r.amplitude), phase: Number(r.phase_GMT) }))
    .filter((k) => k.name && Number.isFinite(k.amplitude) && Number.isFinite(k.phase))
}

export const HARCON_URL = (station: string) =>
  `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${encodeURIComponent(station)}/harcon.json?units=metric`
