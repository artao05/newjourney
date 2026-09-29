/**
 * GRIB edition 1, which Saildocs and many older services still send.
 *
 *   0 indicator   "GRIB", a 3-octet length, edition 1
 *   1 product     the parameter (Table 2), level, reference time, forecast time,
 *                 decimal scale, and flags for whether sections 2 and 3 follow
 *   2 grid        data representation type 0, a regular latitude/longitude grid
 *   3 bitmap      optional
 *   4 binary data simple grid-point packing, with an IBM floating-point reference
 *   5 "7777"
 *
 * The result has the same shape as a GRIB2 message, with the GRIB2 discipline,
 * category, number and level codes filled in, so everything downstream reads
 * both editions alike. Second-order packing, spherical harmonics and projected
 * grids are skipped with the reason.
 */
import { BitReader } from './bits'
import type { GribMessage } from './grib2'

/**
 * GRIB1 parameters this knows, as GRIB2 codes and names. NCEP's Table 2 (versions
 * 1–3) for everyone but ECMWF, whose own tables 128 and 140 are also here.
 */
const TABLE2: Record<number, [number, number, number, string]> = {
  1: [0, 3, 0, 'PRES'],
  2: [0, 3, 1, 'PRMSL'],
  11: [0, 0, 0, 'TMP'],
  31: [0, 2, 0, 'WDIR'],
  32: [0, 2, 1, 'WIND'],
  33: [0, 2, 2, 'UGRD'],
  34: [0, 2, 3, 'VGRD'],
  49: [10, 1, 2, 'UOGRD'],
  50: [10, 1, 3, 'VOGRD'],
  52: [0, 1, 1, 'RH'],
  59: [0, 1, 7, 'PRATE'],
  61: [0, 1, 8, 'APCP'],
  80: [10, 3, 0, 'WTMP'],
  100: [10, 0, 3, 'HTSGW'],
  101: [10, 0, 4, 'WVDIR'],
  102: [10, 0, 5, 'WVHGT'],
  103: [10, 0, 6, 'WVPER'],
  104: [10, 0, 7, 'SWDIR'],
  105: [10, 0, 8, 'SWELL'],
  106: [10, 0, 9, 'SWPER'],
  107: [10, 0, 10, 'DIRPW'],
  108: [10, 0, 11, 'PERPW'],
  180: [0, 2, 22, 'GUST'],
}
/** ECMWF's parameters, with the level they imply when the product says "surface". */
const ECMWF: Record<string, [number, number, number, string, number?, number?]> = {
  '128.165': [0, 2, 2, 'UGRD', 103, 10],
  '128.166': [0, 2, 3, 'VGRD', 103, 10],
  '128.151': [0, 3, 1, 'PRMSL', 101, 0],
  '128.49': [0, 2, 22, 'GUST', 103, 10],
  // ECMWF's wave table: mean wave direction and period stand in for the primary wave's.
  '140.229': [10, 0, 3, 'HTSGW'],
  '140.230': [10, 0, 10, 'DIRPW'],
  '140.232': [10, 0, 11, 'PERPW'],
  '140.234': [10, 0, 5, 'WVHGT'],
  '140.235': [10, 0, 4, 'WVDIR'],
  '140.236': [10, 0, 6, 'WVPER'],
  '140.237': [10, 0, 8, 'SWELL'],
  '140.238': [10, 0, 7, 'SWDIR'],
  '140.239': [10, 0, 9, 'SWPER'],
}

/** GRIB1 level types to GRIB2's (Table 3 to Table 4.5), and how to scale the value. */
function level(type: number, o11: number, o12: number): [number, number] {
  const v = o11 * 256 + o12
  if (type === 1) return [1, 0]
  if (type === 102) return [101, 0]
  if (type === 100) return [100, v * 100] // hPa to Pa, as GRIB2 gives it
  if (type === 105) return [103, v]
  if (type === 160) return [160, v]
  return [type, v]
}

const UNIT_MS: Record<number, number> = { 0: 60_000, 1: 3_600_000, 2: 86_400_000, 10: 3 * 3_600_000, 11: 6 * 3_600_000, 12: 12 * 3_600_000, 254: 1000 }

const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u24 = (b: Uint8Array, o: number) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]
const s16 = (b: Uint8Array, o: number) => (b[o] & 0x80 ? -(((b[o] & 0x7f) << 8) | b[o + 1]) : u16(b, o))
const s24 = (b: Uint8Array, o: number) => (b[o] & 0x80 ? -(((b[o] & 0x7f) << 16) | (b[o + 1] << 8) | b[o + 2]) : u24(b, o))

/** IBM System/360 single precision: sign, a base-16 exponent in excess 64, a 24-bit fraction. */
export function ibmFloat(b: Uint8Array, o: number): number {
  const sign = b[o] & 0x80 ? -1 : 1
  const exp = (b[o] & 0x7f) - 64
  const mant = u24(b, o + 1)
  return sign * mant * 2 ** (4 * exp - 24)
}

/** One GRIB1 message at `off`: its length, and the message or why it was skipped. */
export function readGrib1Message(b: Uint8Array, off: number): { length: number; message?: GribMessage; reason?: string } {
  const total = u24(b, off + 4)
  if (total < 8 + 28 + 4 || off + total > b.length) return { length: 4, reason: 'a GRIB1 message is too short or runs past the end of the file' }
  const end = off + total
  let s = off + 8
  // Section 1: product definition.
  const pdsLen = u24(b, s)
  if (pdsLen < 28 || s + pdsLen > end) return { length: total, reason: 'the product section is short' }
  const table = b[s + 3]
  const centre = b[s + 4]
  const flags = b[s + 7]
  const param = b[s + 8]
  let [lt, lv] = level(b[s + 9], b[s + 10], b[s + 11])
  const century = b[s + 24] || 21
  const year = (century - 1) * 100 + b[s + 12]
  const refTime = Date.UTC(year, b[s + 13] - 1, b[s + 14], b[s + 15], b[s + 16])
  const unit = UNIT_MS[b[s + 17]] ?? 3_600_000
  const tri = b[s + 20]
  const steps = tri === 10 ? u16(b, s + 18) : tri >= 2 && tri <= 5 ? b[s + 19] : tri === 1 ? 0 : b[s + 18]
  const D = s16(b, s + 26)
  const ec = centre === 98 ? ECMWF[`${table}.${param}`] : undefined
  const code = ec ?? (centre === 98 && table >= 128 ? undefined : TABLE2[param])
  if (ec && ec[4] != null && lt === 1) [lt, lv] = [ec[4], ec[5] ?? 0]
  s += pdsLen

  // Section 2: grid description.
  if (!(flags & 0x80)) return { length: total, reason: 'a GRIB1 message without a grid section is not read' }
  const gdsLen = u24(b, s)
  if (s + gdsLen > end) return { length: total, reason: 'the grid section runs past the end of its message' }
  if (b[s + 5] !== 0) return { length: total, reason: `GRIB1 grid type ${b[s + 5]} is not read yet` }
  const ni = u16(b, s + 6)
  const nj = u16(b, s + 8)
  const la1 = s24(b, s + 10) / 1000
  const lo1 = s24(b, s + 13) / 1000
  const la2 = s24(b, s + 17) / 1000
  const lo2 = s24(b, s + 20) / 1000
  const scanMode = b[s + 27]
  const rawDi = u16(b, s + 23)
  const rawDj = u16(b, s + 25)
  const di = rawDi === 0xffff || !(b[s + 16] & 0x80) ? Math.abs(((((lo2 - lo1) % 360) + 360) % 360 || 360) / Math.max(1, ni - 1)) : rawDi / 1000
  const dj = rawDj === 0xffff || !(b[s + 16] & 0x80) ? Math.abs(la2 - la1) / Math.max(1, nj - 1) : rawDj / 1000
  s += gdsLen

  // Section 3: the bitmap, if any.
  let bitmap: Uint8Array | null = null
  if (flags & 0x40) {
    const bmsLen = u24(b, s)
    if (u16(b, s + 4) !== 0) return { length: total, reason: 'a predefined GRIB1 bitmap is not read' }
    bitmap = b.subarray(s + 6, s + bmsLen)
    s += bmsLen
  }

  // Section 4: the data.
  const bdsLen = u24(b, s)
  if (s + bdsLen > end) return { length: total, reason: 'the data section runs past the end of its message' }
  const bflags = b[s + 3]
  if (bflags & 0x80) return { length: total, reason: 'GRIB1 spherical harmonics are not read' }
  if (bflags & 0x40) return { length: total, reason: 'GRIB1 second-order packing is not read yet' }
  const unused = bflags & 0x0f
  const E = s16(b, s + 4)
  const R = ibmFloat(b, s + 6)
  const bits = b[s + 10]
  const n = ni * nj
  const values = new Float32Array(n)
  const count = bits ? Math.floor(((bdsLen - 11) * 8 - unused) / bits) : n
  const br = new BitReader(b, s + 11)
  const k2 = 2 ** E
  const k10 = 10 ** -D
  let taken = 0
  for (let i = 0; i < n; i++) {
    if (bitmap && !((bitmap[i >> 3] >> (7 - (i & 7))) & 1)) {
      values[i] = NaN
      continue
    }
    const x = bits && taken < count ? br.read(bits) : 0
    taken++
    values[i] = (R + x * k2) * k10
  }
  const [discipline, category, number, name] = code ?? [-1, table, param, `GRIB1 ${centre}.${table}.${param}`]
  const forecastMs = steps * unit
  return {
    length: total,
    message: {
      discipline,
      category,
      number,
      name,
      levelType: lt,
      levelValue: lv,
      refTime,
      forecastMs,
      validTime: refTime + forecastMs,
      grid: { ni, nj, la1, lo1, la2, lo2, di, dj, scanMode },
      values,
    },
  }
}
