/**
 * Test fixtures: GRIB2 messages built byte by byte to the WMO layout (sections
 * 0–8, templates 3.0, 4.0, 5.0, 5.2, 5.3 and 5.41), the way NCEP's encoder packs them.
 */
import { encodePng } from './png'
import { aecEncode } from './aec'
import { AEC_DATA_MSB, AEC_DATA_PREPROCESS } from '../aec'

const u16 = (x: number) => [(x >> 8) & 255, x & 255]
const u32 = (x: number) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]
const u64 = (x: number) => [...u32(Math.floor(x / 2 ** 32)), ...u32(x >>> 0)]
/** GRIB's sign-and-magnitude integers. */
const sN = (x: number, n: number) => {
  const m = Math.abs(x)
  const out: number[] = []
  for (let i = n - 1; i >= 0; i--) out.push(Math.floor(m / 256 ** i) & 255)
  if (x < 0) out[0] |= 0x80
  return out
}
const s16 = (x: number) => sN(x, 2)
const s32 = (x: number) => sN(x, 4)
const f32 = (x: number) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setFloat32(0, x)
  return [...b]
}
const section = (num: number, body: number[]) => [...u32(body.length + 5), num, ...body]
const bitsFor = (max: number) => (max <= 0 ? 0 : Math.ceil(Math.log2(max + 1)))

class Bits {
  out: number[] = []
  private acc = 0
  private n = 0
  put(v: number, bits: number) {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | (Math.floor(v / 2 ** i) & 1)
      if (++this.n === 8) {
        this.out.push(this.acc)
        this.acc = 0
        this.n = 0
      }
    }
  }
  align() {
    if (this.n) this.put(0, 8 - this.n)
  }
}

export interface Grid {
  ni: number
  nj: number
  la1: number
  lo1: number
  la2: number
  lo2: number
  di: number
  dj: number
  scanMode?: number
}

export interface Field {
  discipline?: number
  category: number
  number: number
  levelType?: number
  levelValue?: number
  ref?: number
  forecastH?: number
  grid: Grid
  /** In scan order; NaN is a point the bitmap leaves out. */
  values: number[]
  packing: 'simple' | 'complex' | 'sd1' | 'sd2' | 'png' | 'ccsds' | 'jpeg2000'
  /** For JPEG 2000: the codestream of the packed integers, and the reference it is relative to. */
  j2k?: Uint8Array
  R?: number
  D?: number
  gridTemplate?: number
  dataTemplate?: number
}

export const REF = Date.UTC(2026, 8, 29, 6)

export function message(f: Field): number[] {
  const D = f.D ?? 0
  const present = f.values.filter((v) => !Number.isNaN(v))
  const ints = present.map((v) => Math.round(v * 10 ** D))
  const R = ints.reduce((a, b) => Math.min(a, b), Infinity)
  const z = ints.map((v) => v - R)
  const ref = new Date(f.ref ?? REF)
  const g = f.grid

  const s1 = section(1, [
    ...u16(7), ...u16(0), 2, 1, 1,
    ...u16(ref.getUTCFullYear()), ref.getUTCMonth() + 1, ref.getUTCDate(), ref.getUTCHours(), ref.getUTCMinutes(), ref.getUTCSeconds(),
    0, 1,
  ])
  const micro = (x: number) => s32(Math.round(x * 1e6))
  const s3 = section(3, [
    0, ...u32(g.ni * g.nj), 0, 0, ...u16(f.gridTemplate ?? 0),
    6, 0, ...u32(0), 0, ...u32(0), 0, ...u32(0),
    ...u32(g.ni), ...u32(g.nj), ...u32(0), ...u32(0xffffffff),
    ...micro(g.la1), ...micro(g.lo1), 48, ...micro(g.la2), ...micro(g.lo2), ...micro(g.di), ...micro(g.dj),
    g.scanMode ?? 0,
  ])
  const s4 = section(4, [
    ...u16(0), ...u16(0), f.category, f.number, 2, 0, 96, ...u16(0), 0,
    1, ...u32(f.forecastH ?? 0), f.levelType ?? 1, 0, ...u32(f.levelValue ?? 0), 255, 0, ...u32(0),
  ])
  const bitmap = present.length < f.values.length
  let s6: number[]
  if (bitmap) {
    const b = new Bits()
    for (const v of f.values) b.put(Number.isNaN(v) ? 0 : 1, 1)
    b.align()
    s6 = section(6, [0, ...b.out])
  } else s6 = section(6, [255])

  let s5: number[]
  let s7: number[]
  if (f.packing === 'jpeg2000') {
    // A codestream made elsewhere (OpenJPEG) holds the packed integers; R places them.
    s5 = section(5, [...u32(present.length), ...u16(40), ...f32(f.R ?? 0), ...s16(0), ...s16(D), 16, 0, 0, 255])
    s7 = section(7, [...(f.j2k ?? [])])
  } else if (f.packing === 'ccsds') {
    // As ECMWF packs its open data: preprocessed, J = 32, r = 128.
    const bits = Math.max(1, bitsFor(z.reduce((a, b) => Math.max(a, b), 0)))
    const flags = AEC_DATA_MSB | AEC_DATA_PREPROCESS
    s5 = section(5, [...u32(z.length), ...u16(42), ...f32(R), ...s16(0), ...s16(D), bits, 0, flags, 32, ...u16(128)])
    s7 = section(7, [...aecEncode(z, { bitsPerSample: bits, blockSize: 32, rsi: 128, flags })])
  } else if (f.packing === 'png') {
    // NCEP's encoder rounds the width up to whole octets and makes an image one row per grid row.
    const need = bitsFor(z.reduce((a, b) => Math.max(a, b), 0))
    const bits = need <= 8 ? 8 : need <= 16 ? 16 : need <= 24 ? 24 : 32
    const bpp = bits / 8
    const width = z.length === g.ni * g.nj ? g.ni : z.length
    const height = z.length / width
    const rows = new Uint8Array(z.length * bpp)
    z.forEach((v, i) => {
      for (let k = 0; k < bpp; k++) rows[i * bpp + k] = Math.floor(v / 256 ** (bpp - 1 - k)) & 255
    })
    const [depth, colour] = bits === 8 ? [8, 0] : bits === 16 ? [16, 0] : bits === 24 ? [8, 2] : [8, 6]
    s5 = section(5, [...u32(z.length), ...u16(41), ...f32(R), ...s16(0), ...s16(D), bits, 0])
    s7 = section(7, [...encodePng(width, height, depth, colour, rows, bpp)])
  } else if (f.packing === 'simple') {
    const bits = bitsFor(z.reduce((a, b) => Math.max(a, b), 0))
    s5 = section(5, [...u32(z.length), ...u16(f.dataTemplate ?? 0), ...f32(R), ...s16(0), ...s16(D), bits, 0])
    const b = new Bits()
    for (const v of z) b.put(v, bits)
    b.align()
    s7 = section(7, b.out)
  } else {
    const order = f.packing === 'sd1' ? 1 : f.packing === 'sd2' ? 2 : 0
    const ids = 2
    const d = z.slice()
    let gmin = 0
    if (order === 1) {
      for (let i = z.length - 1; i >= 1; i--) d[i] = z[i] - z[i - 1]
      gmin = d.slice(1).reduce((a, b) => Math.min(a, b), Infinity)
      for (let i = 1; i < d.length; i++) d[i] -= gmin
      d[0] = 0
    } else if (order === 2) {
      for (let i = z.length - 1; i >= 2; i--) d[i] = z[i] - 2 * z[i - 1] + z[i - 2]
      gmin = d.slice(2).reduce((a, b) => Math.min(a, b), Infinity)
      for (let i = 2; i < d.length; i++) d[i] -= gmin
      d[0] = 0
      d[1] = 0
    }
    // Groups of 3, 5, 4, 3, 5, 4… points, the last one whatever is left.
    const lens: number[] = []
    for (let at = 0, k = 0; at < d.length; k++) {
      const L = Math.min([3, 5, 4][k % 3], d.length - at)
      lens.push(L)
      at += L
    }
    const refs: number[] = []
    const widths: number[] = []
    for (let gi = 0, at = 0; gi < lens.length; at += lens[gi], gi++) {
      const grp = d.slice(at, at + lens[gi])
      refs.push(Math.min(...grp))
      widths.push(bitsFor(Math.max(...grp) - Math.min(...grp)))
    }
    const refBits = bitsFor(refs.reduce((a, b) => Math.max(a, b), 0))
    const mn = (a: number[]) => a.reduce((x, y) => Math.min(x, y), Infinity)
    const mx = (a: number[]) => a.reduce((x, y) => Math.max(x, y), -Infinity)
    const widthRef = mn(widths)
    const widthBits = bitsFor(mx(widths) - widthRef)
    const lengthRef = mn(lens)
    const lengthBits = bitsFor(mx(lens) - lengthRef)
    const tpl = f.dataTemplate ?? (order ? 3 : 2)
    s5 = section(5, [
      ...u32(z.length), ...u16(tpl), ...f32(R), ...s16(0), ...s16(D), refBits, 0,
      1, 0, ...u32(0), ...u32(0), ...u32(lens.length), widthRef, widthBits, ...u32(lengthRef), 1,
      ...u32(lens[lens.length - 1]), lengthBits,
      ...(tpl === 3 ? [order, ids] : []),
    ])
    const head: number[] = []
    if (order) {
      for (let i = 0; i < order; i++) head.push(...sN(z[i], ids))
      head.push(...sN(gmin, ids))
    }
    const b = new Bits()
    for (const r of refs) b.put(r, refBits)
    b.align()
    for (const w of widths) b.put(w - widthRef, widthBits)
    b.align()
    for (const L of lens) b.put(L - lengthRef, lengthBits)
    b.align()
    for (let gi = 0, at = 0; gi < lens.length; at += lens[gi], gi++) {
      for (let i = 0; i < lens[gi]; i++) b.put(d[at + i] - refs[gi], widths[gi])
    }
    b.align()
    s7 = section(7, [...head, ...b.out])
  }
  const body = [...s1, ...s3, ...s4, ...s5, ...s6, ...s7, ...[0x37, 0x37, 0x37, 0x37]]
  const total = 16 + body.length
  return [0x47, 0x52, 0x49, 0x42, 0, 0, f.discipline ?? 0, 2, ...u64(total), ...body]
}

export const file = (...msgs: number[][]) => new Uint8Array(msgs.flat())

/** A regular grid, north to south and west to east as GFS scans it. */
export function gfsGrid(la1: number, lo1: number, ni: number, nj: number, d: number): Grid {
  return { ni, nj, la1, lo1, la2: la1 - (nj - 1) * d, lo2: lo1 + (ni - 1) * d, di: d, dj: d, scanMode: 0 }
}

/** Values over a grid in scan order from a function of latitude and longitude. */
export function over(g: Grid, fn: (lat: number, lon: number) => number): number[] {
  const out: number[] = []
  for (let j = 0; j < g.nj; j++) for (let i = 0; i < g.ni; i++) out.push(fn(g.la1 - j * g.dj, g.lo1 + i * g.di))
  return out
}
