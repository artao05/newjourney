import { describe, expect, it } from 'vitest'
import { ibmFloat } from './grib1'
import { decodeGrib2, gribToCube } from './grib2'
import { sampleCube } from './cube'

/*
 * GRIB1 messages built byte by byte to the WMO FM 92 layout, the way a Saildocs
 * file carries them: NCEP Table 2 parameters on a regular lat/lon grid, simple
 * packing, an IBM floating-point reference.
 */

const u16 = (x: number) => [(x >> 8) & 255, x & 255]
const u24 = (x: number) => [(x >> 16) & 255, (x >> 8) & 255, x & 255]
const s16 = (x: number) => u16(x < 0 ? 0x8000 | -x : x)
const s24 = (x: number) => u24(x < 0 ? 0x800000 | -x : x)
/** An integer as an IBM float: exact for anything under 2^24. */
function ibm(x: number): number[] {
  if (x === 0) return [0, 0, 0, 0]
  let a = Math.abs(x)
  let e = 64
  while (a >= 1) {
    a /= 16
    e++
  }
  while (a < 1 / 16) {
    a *= 16
    e--
  }
  return [(x < 0 ? 0x80 : 0) | e, ...u24(Math.round(a * 2 ** 24))]
}
const bitsFor = (max: number) => (max <= 0 ? 0 : Math.ceil(Math.log2(max + 1)))

interface G1 {
  centre?: number
  table?: number
  param: number
  levelType: number
  level?: number
  forecastH?: number
  la1: number
  lo1: number
  ni: number
  nj: number
  d: number
  /** In scan order (north to south, west to east); NaN leaves the point out of the bitmap. */
  values: number[]
  D?: number
  E?: number
  gridType?: number
  secondOrder?: boolean
}

function grib1(m: G1): number[] {
  const D = m.D ?? 0
  const E = m.E ?? 0
  const present = m.values.filter((v) => !Number.isNaN(v))
  const ints = present.map((v) => Math.round(v * 10 ** D))
  const R = ints.reduce((a, b) => Math.min(a, b), Infinity)
  const x = ints.map((v) => Math.round((v - R) / 2 ** E))
  const bits = bitsFor(x.reduce((a, b) => Math.max(a, b), 0))
  const bitmap = present.length < m.values.length
  const pds = [
    ...u24(28), m.table ?? 2, m.centre ?? 7, 81, 255, 0x80 | (bitmap ? 0x40 : 0), m.param, m.levelType, ...u16(m.level ?? 0),
    26, 9, 29, 6, 0, 1, m.forecastH ?? 0, 0, 0, ...u16(0), 0, 21, 0, ...s16(D),
  ]
  const la2 = m.la1 - (m.nj - 1) * m.d
  const lo2 = m.lo1 + (m.ni - 1) * m.d
  const md = (v: number) => s24(Math.round(v * 1000))
  const gds = [
    ...u24(32), 0, 255, m.gridType ?? 0, ...u16(m.ni), ...u16(m.nj), ...md(m.la1), ...md(m.lo1), 0x80,
    ...md(la2), ...md(lo2), ...u16(Math.round(m.d * 1000)), ...u16(Math.round(m.d * 1000)), 0, 0, 0, 0, 0,
  ]
  const bms: number[] = []
  if (bitmap) {
    const bytes = Math.ceil(m.values.length / 8)
    const map = new Array(bytes).fill(0)
    m.values.forEach((v, i) => {
      if (!Number.isNaN(v)) map[i >> 3] |= 0x80 >> (i & 7)
    })
    bms.push(...u24(6 + bytes), bytes * 8 - m.values.length, ...u16(0), ...map)
  }
  const packed: number[] = []
  let acc = 0
  let n = 0
  for (const v of x) {
    for (let i = bits - 1; i >= 0; i--) {
      acc = (acc << 1) | ((v >> i) & 1)
      if (++n === 8) {
        packed.push(acc)
        acc = 0
        n = 0
      }
    }
  }
  const unused = n ? 8 - n : 0
  if (n) packed.push(acc << (8 - n))
  const bds = [...u24(11 + packed.length), (m.secondOrder ? 0x40 : 0) | unused, ...s16(E), ...ibm(R), bits, ...packed]
  const body = [...pds, ...gds, ...bms, ...bds, 0x37, 0x37, 0x37, 0x37]
  return [0x47, 0x52, 0x49, 0x42, ...u24(8 + body.length), 1, ...body]
}

const REF = Date.UTC(2026, 8, 29, 6)
const KN = 1.9438445

function over(m: Pick<G1, 'la1' | 'lo1' | 'ni' | 'nj' | 'd'>, fn: (lat: number, lon: number) => number): number[] {
  const out: number[] = []
  for (let j = 0; j < m.nj; j++) for (let i = 0; i < m.ni; i++) out.push(fn(m.la1 - j * m.d, m.lo1 + i * m.d))
  return out
}

describe('GRIB1', () => {
  it('reads IBM floating point', () => {
    expect(ibmFloat(new Uint8Array([0x41, 0x10, 0, 0]), 0)).toBe(1)
    expect(ibmFloat(new Uint8Array([0xc2, 0x76, 0xa0, 0]), 0)).toBe(-118.625)
    expect(ibmFloat(new Uint8Array([0x42, 0x64, 0, 0]), 0)).toBe(100)
    expect(ibmFloat(new Uint8Array(ibm(101325)), 0)).toBe(101325)
  })

  const grid = { la1: 45, lo1: -75, ni: 11, nj: 11, d: 0.5 }
  const u = (lat: number, lon: number) => 6 + (lat - 40) / 2 - (lon + 75) / 5
  const v = (lat: number, lon: number) => -2 + (lon + 75) / 3 + (lat - 40) / 10
  const p = (lat: number, lon: number) => 101000 + 40 * (lat - 40) - 25 * (lon + 75)

  function saildocs(hours: number[]) {
    const out: number[] = []
    for (const h of hours) {
      out.push(...grib1({ ...grid, param: 33, levelType: 105, level: 10, forecastH: h, values: over(grid, (a, o) => u(a, o) + h / 6), D: 2 }))
      out.push(...grib1({ ...grid, param: 34, levelType: 105, level: 10, forecastH: h, values: over(grid, v), D: 2 }))
      out.push(...grib1({ ...grid, param: 2, levelType: 102, forecastH: h, values: over(grid, p), D: -1 }))
    }
    return new Uint8Array(out)
  }

  it('reads a Saildocs-style file of wind and pressure into the cube', () => {
    const { messages, skipped } = decodeGrib2(saildocs([0, 6, 12]))
    expect(skipped).toEqual([])
    expect(messages.map((m) => m.name)).toEqual(['UGRD', 'VGRD', 'PRMSL', 'UGRD', 'VGRD', 'PRMSL', 'UGRD', 'VGRD', 'PRMSL'])
    const m = messages[0]
    expect([m.levelType, m.levelValue, m.refTime, m.validTime]).toEqual([103, 10, REF, REF])
    expect(messages[3].forecastMs).toBe(6 * 3_600_000)
    expect(m.grid).toMatchObject({ ni: 11, nj: 11, la1: 45, lo1: -75, la2: 40, lo2: -70, di: 0.5, dj: 0.5 })
    const { cube, warnings } = gribToCube(messages, { model: 'gfs' })
    expect(warnings).toEqual([])
    const c = cube!
    expect(c.bbox).toEqual({ west: -75, east: -70, south: 40, north: 45 })
    expect([c.nx, c.ny, c.nt, c.dtMs]).toEqual([11, 11, 3, 6 * 3_600_000])
    expect(sampleCube(c, 'u10', 42.25, -72.75, REF + 3 * 3_600_000)).toBeCloseTo((u(42.25, -72.75) + 0.5) * KN, 2)
    // Packed to 0.01 m/s (D = 2).
    expect(sampleCube(c, 'v10', 40, -70, REF)).toBeCloseTo((Math.round(v(40, -70) * 100) / 100) * KN, 4)
    // Pressure packed to the nearest 10 Pa (D = −1), read as hPa.
    expect(sampleCube(c, 'prmsl', 44, -74, REF)).toBeCloseTo(Math.round(p(44, -74) / 10) / 10, 3)
  })

  it('reads a bitmap and a negative binary scale', () => {
    const g = { la1: 30, lo1: 280, ni: 6, nj: 4, d: 1 }
    const values = over(g, (lat, lon) => (lon > 283 && lat < 29 ? NaN : (lat - 25) * 0.1 + (lon - 280) * 0.25))
    const m = decodeGrib2(new Uint8Array(grib1({ ...g, param: 100, levelType: 1, values, D: 2, E: -1 }))).messages[0]
    expect(m.name).toBe('HTSGW')
    for (let i = 0; i < values.length; i++) {
      if (Number.isNaN(values[i])) expect(m.values[i]).toBeNaN()
      else expect(m.values[i]).toBeCloseTo(Math.round(values[i] * 100) / 100, 4)
    }
  })

  it("reads ECMWF's own parameter table, with its surface wind at 10 m", () => {
    const g = { la1: 50, lo1: -5, ni: 3, nj: 3, d: 0.25 }
    const bytes = new Uint8Array([
      ...grib1({ ...g, centre: 98, table: 128, param: 165, levelType: 1, values: over(g, () => 5) }),
      ...grib1({ ...g, centre: 98, table: 128, param: 166, levelType: 1, values: over(g, () => -3) }),
      ...grib1({ ...g, centre: 98, table: 128, param: 151, levelType: 1, values: over(g, () => 101200) }),
      // ECMWF's 33 is not NCEP's UGRD, and must not be read as wind.
      ...grib1({ ...g, centre: 98, table: 128, param: 33, levelType: 1, values: over(g, () => 1) }),
    ])
    const { messages } = decodeGrib2(bytes)
    expect(messages.map((m) => `${m.name}@${m.levelType}/${m.levelValue}`)).toEqual(['UGRD@103/10', 'VGRD@103/10', 'PRMSL@101/0', 'GRIB1 98.128.33@1/0'])
    const c = gribToCube(messages).cube!
    expect(c.data.u10[0]).toBeCloseTo(5 * KN, 4)
    expect(c.data.prmsl[4]).toBeCloseTo(1012, 4)
  })

  it('reads the wave partitions of NCEP Table 2 and ECMWF table 140 alike', () => {
    const g = { la1: 44, lo1: -70, ni: 2, nj: 2, d: 1 }
    const w = (param: number, v: number, centre = 7, table = 2) => grib1({ ...g, centre, table, param, levelType: 1, values: over(g, () => v), D: 1 })
    const ncep = decodeGrib2(new Uint8Array([...w(100, 2), ...w(102, 1), ...w(103, 4), ...w(105, 1.5), ...w(104, 90), ...w(107, 95), ...w(108, 9)])).messages
    expect(ncep.map((m) => m.name)).toEqual(['HTSGW', 'WVHGT', 'WVPER', 'SWELL', 'SWDIR', 'DIRPW', 'PERPW'])
    const ec = decodeGrib2(new Uint8Array([...w(229, 2, 98, 140), ...w(230, 95, 98, 140), ...w(237, 1.5, 98, 140), ...w(238, 90, 98, 140)])).messages
    expect(ec.map((m) => m.name)).toEqual(['HTSGW', 'DIRPW', 'SWELL', 'SWDIR'])
    expect(gribToCube(ec).cube!.params).toEqual(['hs', 'wdir', 'swh', 'swd'])
  })

  it('skips what it does not read, with the reason, and goes on to the next message', () => {
    const g = { la1: 50, lo1: -5, ni: 3, nj: 3, d: 1 }
    const vals = over(g, () => 1)
    const { messages, skipped } = decodeGrib2(
      new Uint8Array([
        ...grib1({ ...g, param: 33, levelType: 105, level: 10, values: vals, gridType: 3 }),
        ...grib1({ ...g, param: 33, levelType: 105, level: 10, values: vals, secondOrder: true }),
        ...grib1({ ...g, param: 34, levelType: 105, level: 10, values: vals }),
      ]),
    )
    expect(messages.map((m) => m.name)).toEqual(['VGRD'])
    expect(skipped.map((s) => s.reason)).toEqual(['GRIB1 grid type 3 is not read yet', 'GRIB1 second-order packing is not read yet'])
  })
})
