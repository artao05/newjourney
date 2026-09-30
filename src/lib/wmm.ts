/**
 * The World Magnetic Model: Earth's main field, and so magnetic variation, at
 * any place and date. Follows the WMM technical report (NOAA NCEI and BGS):
 *
 * 1. The position, geodetic on WGS-84, is turned geocentric (spherical).
 * 2. The Gauss coefficients are carried from the model's epoch to the date by
 *    their secular change.
 * 3. The field is the gradient of a spherical-harmonic potential to degree 12,
 *    with Schmidt semi-normalised associated Legendre functions.
 * 4. It is turned back from geocentric to geodetic axes.
 *
 * Declination (variation) is east positive, NOAA's convention. The model is
 * checked against NCEI's own test values (wmm.test.ts).
 */
import { WMM2025 } from '@/data/wmm2025'

export interface WmmModel {
  name: string
  epoch: number
  validUntil: number
  /** [n, m, g, h, ġ, ḣ]: nT and nT a year. */
  rows: Array<[number, number, number, number, number, number]>
}

export interface MagneticField {
  /** Declination (variation), degrees, east positive. */
  decl: number
  /** Inclination (dip), degrees, down positive. */
  incl: number
  /** Horizontal intensity, north, east and down components, total intensity: nT. */
  h: number
  x: number
  y: number
  z: number
  f: number
  /** Their annual change: degrees a year for decl and incl, nT a year for the rest. */
  declDot: number
  inclDot: number
  hDot: number
  xDot: number
  yDot: number
  zDot: number
  fDot: number
  /** Whether the date lies inside the model's five years. */
  valid: boolean
}

const A_WGS84 = 6378.137
const F_WGS84 = 1 / 298.257223563
const E2 = F_WGS84 * (2 - F_WGS84)
/** The model's reference radius, km. */
const A_REF = 6371.2
const RAD = Math.PI / 180

interface Prepared {
  model: WmmModel
  n: number
  g: number[][]
  h: number[][]
  gd: number[][]
  hd: number[][]
  /** The recursion's constants, ((n-1)² - m²) / ((2n-1)(2n-3)). */
  k: number[][]
  /** Schmidt semi-normalisation factors. */
  s: number[][]
}

const prepared = new WeakMap<WmmModel, Prepared>()

function prepare(model: WmmModel): Prepared {
  const have = prepared.get(model)
  if (have) return have
  const n = Math.max(...model.rows.map((r) => r[0]))
  const grid = () => Array.from({ length: n + 1 }, () => new Array<number>(n + 1).fill(0))
  const p: Prepared = { model, n, g: grid(), h: grid(), gd: grid(), hd: grid(), k: grid(), s: grid() }
  for (const [nn, m, g, h, gd, hd] of model.rows) {
    p.g[nn][m] = g
    p.h[nn][m] = h
    p.gd[nn][m] = gd
    p.hd[nn][m] = hd
  }
  p.s[0][0] = 1
  for (let nn = 1; nn <= n; nn++) {
    p.s[nn][0] = (p.s[nn - 1][0] * (2 * nn - 1)) / nn
    for (let m = 1; m <= nn; m++) p.s[nn][m] = p.s[nn][m - 1] * Math.sqrt(((nn - m + 1) * (m === 1 ? 2 : 1)) / (nn + m))
    for (let m = 0; m <= nn; m++) p.k[nn][m] = nn > 1 ? ((nn - 1) ** 2 - m ** 2) / ((2 * nn - 1) * (2 * nn - 3)) : 0
  }
  prepared.set(model, p)
  return p
}

/**
 * The field at a geodetic latitude and longitude (degrees), a height above the
 * WGS-84 ellipsoid (km) and a decimal year.
 */
export function magneticField(lat: number, lon: number, heightKm: number, year: number, model: WmmModel = WMM2025): MagneticField {
  const p = prepare(model)
  const dt = year - model.epoch
  // 1. Geodetic to geocentric.
  const phi = lat * RAD
  const lam = lon * RAD
  const rc = A_WGS84 / Math.sqrt(1 - E2 * Math.sin(phi) ** 2)
  const xp = (rc + heightKm) * Math.cos(phi)
  const zp = (rc * (1 - E2) + heightKm) * Math.sin(phi)
  const r = Math.hypot(xp, zp)
  const phic = Math.asin(zp / r)
  // Colatitude θ, geocentric: cos θ = sin φ', sin θ = cos φ' (kept off zero at the poles).
  const ct = Math.sin(phic)
  const st = Math.max(Math.cos(phic), 1e-12)

  // 2 and 3. Legendre functions P(n, m)(cos θ) and dP/dθ, Gauss-normalised, then Schmidt's factors.
  const N = p.n
  const P = Array.from({ length: N + 1 }, () => new Array<number>(N + 1).fill(0))
  const dP = Array.from({ length: N + 1 }, () => new Array<number>(N + 1).fill(0))
  P[0][0] = 1
  for (let n = 1; n <= N; n++)
    for (let m = 0; m <= n; m++) {
      if (m === n) {
        P[n][n] = st * P[n - 1][n - 1]
        dP[n][n] = st * dP[n - 1][n - 1] + ct * P[n - 1][n - 1]
      } else {
        const p2 = n >= 2 && m <= n - 2 ? P[n - 2][m] : 0
        const d2 = n >= 2 && m <= n - 2 ? dP[n - 2][m] : 0
        P[n][m] = ct * P[n - 1][m] - p.k[n][m] * p2
        dP[n][m] = ct * dP[n - 1][m] - st * P[n - 1][m] - p.k[n][m] * d2
      }
    }

  const cosm = Array.from({ length: N + 1 }, (_, m) => Math.cos(m * lam))
  const sinm = Array.from({ length: N + 1 }, (_, m) => Math.sin(m * lam))
  // Spherical components: north (X'), east (Y'), down (Z'), and their change.
  let bx = 0
  let by = 0
  let bz = 0
  let bxd = 0
  let byd = 0
  let bzd = 0
  for (let n = 1; n <= N; n++) {
    const ar = (A_REF / r) ** (n + 2)
    for (let m = 0; m <= n; m++) {
      const sP = p.s[n][m] * P[n][m]
      const sdP = p.s[n][m] * dP[n][m]
      const g = p.g[n][m] + dt * p.gd[n][m]
      const h = p.h[n][m] + dt * p.hd[n][m]
      const c1 = g * cosm[m] + h * sinm[m]
      const c2 = g * sinm[m] - h * cosm[m]
      const d1 = p.gd[n][m] * cosm[m] + p.hd[n][m] * sinm[m]
      const d2 = p.gd[n][m] * sinm[m] - p.hd[n][m] * cosm[m]
      bx += ar * c1 * sdP
      by += (ar * m * c2 * sP) / st
      bz -= ar * (n + 1) * c1 * sP
      bxd += ar * d1 * sdP
      byd += (ar * m * d2 * sP) / st
      bzd -= ar * (n + 1) * d1 * sP
    }
  }

  // 4. Geocentric to geodetic axes.
  const psi = phic - phi
  const rot = (xs: number, zs: number) => [xs * Math.cos(psi) - zs * Math.sin(psi), xs * Math.sin(psi) + zs * Math.cos(psi)]
  const [x, z] = rot(bx, bz)
  const [xDot, zDot] = rot(bxd, bzd)
  const y = by
  const yDot = byd
  const h = Math.hypot(x, y)
  const f = Math.hypot(h, z)
  const hDot = (x * xDot + y * yDot) / h
  const fDot = (x * xDot + y * yDot + z * zDot) / f
  return {
    decl: Math.atan2(y, x) / RAD,
    incl: Math.atan2(z, h) / RAD,
    h,
    x,
    y,
    z,
    f,
    declDot: (x * yDot - y * xDot) / (h * h) / RAD,
    inclDot: (h * zDot - z * hDot) / (f * f) / RAD,
    hDot,
    xDot,
    yDot,
    zDot,
    fDot,
    valid: year >= model.epoch && year <= model.validUntil,
  }
}

/** Read a WMM coefficient file (WMM.COF): a header of epoch and name, then n m g h ġ ḣ rows, then a line of nines. */
export function parseCof(text: string): WmmModel {
  const lines = text.split(/\r?\n/)
  const [epoch, name] = lines[0].trim().split(/\s+/)
  const rows: WmmModel['rows'] = []
  for (const l of lines.slice(1)) {
    const v = l.trim().split(/\s+/).map(Number)
    if (v.length !== 6 || v.some((x) => !Number.isFinite(x)) || v[0] > 99) continue
    rows.push(v as [number, number, number, number, number, number])
  }
  const e = Number(epoch)
  return { name, epoch: e, validUntil: e + 5, rows }
}
