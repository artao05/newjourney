/**
 * GRIB2: the format the world's weather models publish in.
 *
 * A file is a run of messages; each message is one field (say, the 10 m U wind
 * at +24 h) on one grid. This reads the sections a routing app needs:
 *
 *   0 indicator      "GRIB", the discipline, edition 2, the length
 *   1 identification the reference time
 *   3 grid           template 3.0, a regular latitude/longitude grid
 *   4 product        template 4.0 (and 4.8, accumulations), parameter, level, forecast time
 *   5 representation template 5.0 simple packing, 5.2 complex packing,
 *                    5.3 complex packing with spatial differencing (what GFS uses),
 *                    5.41 PNG, and 5.42 CCSDS (what ECMWF's open data uses)
 *   6 bitmap         none, or one that marks the points with data
 *   7 data
 *
 * Edition 1 messages go to grib1.ts. JPEG 2000 packing (5.40) is not read yet. A message this
 * cannot read is skipped with a reason, never guessed at.
 */

import type { BBox, WeatherCube } from '../types'
import { decodePng } from './png'
import { aecDecode } from './aec'
import { BitReader } from './bits'
import { readGrib1Message } from './grib1'

export interface GribGrid {
  ni: number
  nj: number
  /** First and last grid points, degrees; longitudes as given (0–360 in GFS). */
  la1: number
  lo1: number
  la2: number
  lo2: number
  di: number
  dj: number
  /** GRIB scanning mode flags (0 = west to east, north to south, rows consecutive). */
  scanMode: number
}

export interface GribMessage {
  discipline: number
  category: number
  number: number
  /** The WMO short name, e.g. UGRD, VGRD, PRMSL, where known. */
  name: string
  levelType: number
  levelValue: number
  refTime: number
  /** Forecast offset from the reference time, ms. */
  forecastMs: number
  validTime: number
  grid: GribGrid
  /** Row-major as scanned; NaN where the bitmap says there is no data. */
  values: Float32Array
}

export interface GribSkipped {
  offset: number
  reason: string
}

/** The short names this knows, by discipline, category and number. */
export const NAMES: Record<string, string> = {
  '0.0.0': 'TMP',
  '0.1.1': 'RH',
  '0.2.0': 'WDIR',
  '0.2.1': 'WIND',
  '0.2.2': 'UGRD',
  '0.2.3': 'VGRD',
  '0.2.22': 'GUST',
  '0.3.0': 'PRES',
  '0.3.1': 'PRMSL',
  '0.1.7': 'PRATE',
  '0.1.8': 'APCP',
  '10.3.0': 'WTMP',
  // WMO Table 4.2-10-0: combined sea, then the wind-sea and swell partitions,
  // then the primary wave.
  '10.0.3': 'HTSGW',
  '10.0.4': 'WVDIR',
  '10.0.5': 'WVHGT',
  '10.0.6': 'WVPER',
  '10.0.7': 'SWDIR',
  '10.0.8': 'SWELL',
  '10.0.9': 'SWPER',
  '10.0.10': 'DIRPW',
  '10.0.11': 'PERPW',
  '10.1.2': 'UOGRD',
  '10.1.3': 'VOGRD',
}

class Reader {
  private v: DataView
  constructor(readonly bytes: Uint8Array) {
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u8(o: number) {
    return this.bytes[o]
  }
  u16(o: number) {
    return this.v.getUint16(o)
  }
  u32(o: number) {
    return this.v.getUint32(o)
  }
  u64(o: number) {
    return this.v.getUint32(o) * 2 ** 32 + this.v.getUint32(o + 4)
  }
  f32(o: number) {
    return this.v.getFloat32(o)
  }
  /** GRIB's signed integers are sign and magnitude: the top bit is the sign. */
  s16(o: number) {
    const x = this.u16(o)
    return x & 0x8000 ? -(x & 0x7fff) : x
  }
  s32(o: number) {
    const x = this.u32(o)
    return x & 0x80000000 ? -(x & 0x7fffffff) : x
  }
  /** An n-octet sign-and-magnitude integer. */
  sN(o: number, n: number) {
    let x = 0
    for (let i = 0; i < n; i++) x = x * 256 + this.bytes[o + i]
    const top = 2 ** (8 * n - 1)
    return x >= top ? -(x - top) : x
  }
}

const UNIT_MS: Record<number, number> = { 0: 60_000, 1: 3_600_000, 2: 86_400_000, 10: 3 * 3_600_000, 11: 6 * 3_600_000, 12: 12 * 3_600_000, 13: 1000 }

interface Packing {
  template: number
  count: number
  R: number
  E: number
  D: number
  bits: number
  /** CCSDS packing only. */
  aec?: { flags: number; blockSize: number; rsi: number }
  /** Complex packing only. */
  complex?: {
    missing: number
    groups: number
    widthRef: number
    widthBits: number
    lengthRef: number
    lengthInc: number
    lastLength: number
    lengthBits: number
    order: number
    extraOctets: number
  }
}

function readPacking(r: Reader, o: number): Packing | string {
  const template = r.u16(o + 9)
  const base = { template, count: r.u32(o + 5), R: r.f32(o + 11), E: r.s16(o + 15), D: r.s16(o + 17), bits: r.u8(o + 19) }
  if (template === 0 || template === 41) return base
  if (template === 42) return { ...base, aec: { flags: r.u8(o + 21), blockSize: r.u8(o + 22), rsi: r.u16(o + 23) } }
  if (template === 2 || template === 3) {
    return {
      ...base,
      complex: {
        missing: r.u8(o + 22),
        groups: r.u32(o + 31),
        widthRef: r.u8(o + 35),
        widthBits: r.u8(o + 36),
        lengthRef: r.u32(o + 37),
        lengthInc: r.u8(o + 41),
        lastLength: r.u32(o + 42),
        lengthBits: r.u8(o + 46),
        order: template === 3 ? r.u8(o + 47) : 0,
        extraOctets: template === 3 ? r.u8(o + 48) : 0,
      },
    }
  }
  return `data representation template 5.${template} is not read yet`
}

/** The packed integers of section 7, before scaling. */
function unpack(p: Packing, data: Uint8Array): Float64Array | string {
  if (p.aec) {
    if (p.bits === 0) return new Float64Array(p.count)
    try {
      return aecDecode(data, p.count, { bitsPerSample: p.bits, ...p.aec })
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  if (!p.complex) {
    const out = new Float64Array(p.count)
    if (p.bits === 0) return out
    let src = data
    if (p.template === 41) {
      // The image's pixels, row after row, are the packed integers.
      try {
        src = decodePng(data).rows
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    }
    const br = new BitReader(src, 0)
    for (let i = 0; i < p.count; i++) out[i] = br.read(p.bits)
    return out
  }
  const c = p.complex
  if (c.missing !== 0) return 'complex packing with missing-value management is not read yet'
  const r = new Reader(data)
  let at = 0
  const heads: number[] = []
  let gmin = 0
  if (c.order > 0) {
    for (let i = 0; i < c.order; i++) heads.push(r.sN(at + i * c.extraOctets, c.extraOctets))
    gmin = r.sN(at + c.order * c.extraOctets, c.extraOctets)
    at += (c.order + 1) * c.extraOctets
  }
  const br = new BitReader(data, at)
  const refs = new Float64Array(c.groups)
  for (let g = 0; g < c.groups; g++) refs[g] = p.bits ? br.read(p.bits) : 0
  br.align()
  const widths = new Uint8Array(c.groups)
  for (let g = 0; g < c.groups; g++) widths[g] = c.widthRef + (c.widthBits ? br.read(c.widthBits) : 0)
  br.align()
  const lengths = new Uint32Array(c.groups)
  for (let g = 0; g < c.groups; g++) lengths[g] = c.lengthRef + (c.lengthBits ? br.read(c.lengthBits) : 0) * c.lengthInc
  if (c.groups > 0) lengths[c.groups - 1] = c.lastLength
  br.align()
  const total = lengths.reduce((a, b) => a + b, 0)
  const out = new Float64Array(total)
  let k = 0
  for (let g = 0; g < c.groups; g++) {
    for (let i = 0; i < lengths[g]; i++) out[k++] = refs[g] + (widths[g] ? br.read(widths[g]) : 0)
  }
  // Undo the spatial differencing: the first values were sent whole.
  if (c.order === 1) {
    out[0] = heads[0]
    for (let i = 1; i < total; i++) out[i] = out[i] + gmin + out[i - 1]
  } else if (c.order === 2) {
    out[0] = heads[0]
    out[1] = heads[1]
    for (let i = 2; i < total; i++) out[i] = out[i] + gmin + 2 * out[i - 1] - out[i - 2]
  }
  return out
}

/** Every message in a GRIB file (edition 2, or 1), and the ones that could not be read, with why. */
export function decodeGrib2(input: ArrayBuffer | Uint8Array): { messages: GribMessage[]; skipped: GribSkipped[] } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const r = new Reader(bytes)
  const messages: GribMessage[] = []
  const skipped: GribSkipped[] = []
  let off = 0
  while (off + 16 <= bytes.length) {
    // Find the next "GRIB".
    if (!(bytes[off] === 0x47 && bytes[off + 1] === 0x52 && bytes[off + 2] === 0x49 && bytes[off + 3] === 0x42)) {
      off++
      continue
    }
    const edition = bytes[off + 7]
    if (edition === 1) {
      const one = readGrib1Message(bytes, off)
      if (one.message) messages.push(one.message)
      else skipped.push({ offset: off, reason: one.reason ?? 'the GRIB1 message could not be read' })
      off += Math.max(4, one.length)
      continue
    }
    const total = edition === 2 ? r.u64(off + 8) : 0
    if (edition !== 2 || total < 16 || off + total > bytes.length) {
      skipped.push({ offset: off, reason: edition !== 2 ? `GRIB edition ${edition} is not read` : 'message runs past the end of the file' })
      off += 4
      continue
    }
    const end = off + total
    const discipline = bytes[off + 6]
    let refTime = NaN
    let grid: GribGrid | null = null
    let category = -1
    let number = -1
    let levelType = 0
    let levelValue = 0
    let forecastMs = 0
    let packing: Packing | string | null = null
    let bitmap: Uint8Array | null = null
    let s = off + 16
    let problem: string | null = null
    while (s + 5 <= end && !(bytes[s] === 0x37 && bytes[s + 1] === 0x37 && bytes[s + 2] === 0x37 && bytes[s + 3] === 0x37)) {
      const len = r.u32(s)
      const num = bytes[s + 4]
      if (len < 5 || s + len > end) {
        problem = 'a section runs past the end of its message'
        break
      }
      if (num === 1) {
        refTime = Date.UTC(r.u16(s + 12), bytes[s + 14] - 1, bytes[s + 15], bytes[s + 16], bytes[s + 17], bytes[s + 18])
      } else if (num === 3) {
        const tpl = r.u16(s + 12)
        if (tpl !== 0) problem = `grid template 3.${tpl} is not read yet`
        else {
          const basic = r.u32(s + 38)
          const sub = r.u32(s + 42)
          const k = basic === 0 || sub === 0xffffffff || sub === 0 ? 1e-6 : basic / sub
          grid = {
            ni: r.u32(s + 30),
            nj: r.u32(s + 34),
            la1: r.s32(s + 46) * k,
            lo1: r.s32(s + 50) * k,
            la2: r.s32(s + 55) * k,
            lo2: r.s32(s + 59) * k,
            di: r.s32(s + 63) * k,
            dj: r.s32(s + 67) * k,
            scanMode: bytes[s + 71],
          }
        }
      } else if (num === 4) {
        const tpl = r.u16(s + 7)
        if (tpl !== 0 && tpl !== 8) problem = `product template 4.${tpl} is not read yet`
        else {
          category = bytes[s + 9]
          number = bytes[s + 10]
          forecastMs = r.s32(s + 18) * (UNIT_MS[bytes[s + 17]] ?? 3_600_000)
          levelType = bytes[s + 22]
          const scale = bytes[s + 23] === 255 ? 0 : (bytes[s + 23] & 0x80 ? -(bytes[s + 23] & 0x7f) : bytes[s + 23])
          levelValue = r.s32(s + 24) / 10 ** scale
        }
      } else if (num === 5) {
        packing = readPacking(r, s)
      } else if (num === 6) {
        const ind = bytes[s + 5]
        if (ind === 0) bitmap = bytes.subarray(s + 6, s + len)
        else if (ind !== 255) problem = 'a predefined or reused bitmap is not read yet'
      } else if (num === 7) {
        if (problem) break
        if (!grid) problem = 'no grid before the data'
        else if (!packing) problem = 'no data representation before the data'
        else if (typeof packing === 'string') problem = packing
        else {
          const ints = unpack(packing, bytes.subarray(s + 5, s + len))
          if (typeof ints === 'string') problem = ints
          else {
            const n = grid.ni * grid.nj
            const values = new Float32Array(n)
            const scale2 = 2 ** packing.E
            const scale10 = 10 ** -packing.D
            let k = 0
            for (let i = 0; i < n; i++) {
              const has = bitmap ? (bitmap[i >> 3] >> (7 - (i & 7))) & 1 : 1
              if (!has) {
                values[i] = NaN
                continue
              }
              values[i] = (packing.R + (ints[k++] ?? 0) * scale2) * scale10
            }
            messages.push({
              discipline,
              category,
              number,
              name: NAMES[`${discipline}.${category}.${number}`] ?? `${discipline}.${category}.${number}`,
              levelType,
              levelValue,
              refTime,
              forecastMs,
              validTime: refTime + forecastMs,
              grid,
              values,
            })
          }
        }
      }
      s += len
    }
    if (problem) skipped.push({ offset: off, reason: problem })
    off = end
  }
  return { messages, skipped }
}

const MS_TO_KN = 1.9438445

/**
 * Which GRIB fields become which cube parameters, and how to get to the cube's
 * units: wind and current in knots as u/v, pressure in hPa, waves in metres,
 * degrees and seconds.
 */
const CUBE_PARAMS: Array<{ name: string; param: string; level?: [number, number]; k: number; add?: number }> = [
  { name: 'UGRD', param: 'u10', level: [103, 10], k: MS_TO_KN },
  { name: 'VGRD', param: 'v10', level: [103, 10], k: MS_TO_KN },
  { name: 'GUST', param: 'gust', k: MS_TO_KN },
  { name: 'PRMSL', param: 'prmsl', k: 0.01 },
  // The sea state: combined height with the primary wave's direction and period,
  // and the wind-sea and swell partitions on their own.
  { name: 'HTSGW', param: 'hs', k: 1 },
  { name: 'DIRPW', param: 'wdir', k: 1 },
  { name: 'PERPW', param: 'wper', k: 1 },
  { name: 'WVHGT', param: 'wwh', k: 1 },
  { name: 'WVDIR', param: 'wwd', k: 1 },
  { name: 'WVPER', param: 'wwp', k: 1 },
  { name: 'SWELL', param: 'swh', k: 1 },
  { name: 'SWDIR', param: 'swd', k: 1 },
  { name: 'SWPER', param: 'swp', k: 1 },
  { name: 'RH', param: 'rh', level: [103, 2], k: 1 },
  { name: 'UOGRD', param: 'uo', k: MS_TO_KN },
  // For display: air temperature at 2 m and sea temperature in °C, rain as mm/h.
  { name: 'TMP', param: 't2m', level: [103, 2], k: 1, add: -273.15 },
  { name: 'WTMP', param: 'sst', k: 1, add: -273.15 },
  { name: 'PRATE', param: 'rain', k: 3600 },
  { name: 'VOGRD', param: 'vo', k: MS_TO_KN },
]

function sameGrid(a: GribGrid, b: GribGrid): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) < 1e-6
  return a.ni === b.ni && a.nj === b.nj && eq(a.la1, b.la1) && eq(a.lo1, b.lo1) && eq(a.di, b.di) && eq(a.dj, b.dj) && a.scanMode === b.scanMode
}

const lon180 = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180

/**
 * The fields a router uses, on the app's own grid: rows south to north, columns
 * west to east, longitudes −180 to 180, cropped to `bbox` when given (across the
 * 0/360 seam in a global grid, too). Fields on another grid than the first wind
 * field's are left out, with a warning.
 */
export function gribToCube(
  messages: GribMessage[],
  opts: { bbox?: BBox; model?: string } = {},
): { cube: WeatherCube | null; warnings: string[] } {
  const warnings: string[] = []
  const picked: Array<{ m: GribMessage; param: string; k: number; add: number }> = []
  for (const m of messages) {
    const spec = CUBE_PARAMS.find((p) => p.name === m.name && (!p.level || (p.level[0] === m.levelType && p.level[1] === m.levelValue)))
    if (spec) picked.push({ m, param: spec.param, k: spec.k, add: spec.add ?? 0 })
  }
  if (!picked.length) return { cube: null, warnings: ['no wind, pressure, wave or current fields in the file'] }
  const grid = (picked.find((p) => p.param === 'u10') ?? picked[0]).m.grid
  const onGrid = picked.filter((p) => sameGrid(p.m.grid, grid))
  if (onGrid.length < picked.length) warnings.push(`${picked.length - onGrid.length} field(s) on another grid were left out`)
  if (grid.scanMode & 0x10) return { cube: null, warnings: [...warnings, 'alternating-row scanning is not read yet'] }

  const westward = (grid.scanMode & 0x80) !== 0
  const northward = (grid.scanMode & 0x40) !== 0
  const colMajor = (grid.scanMode & 0x20) !== 0
  const { ni, nj, di, dj } = grid
  const global = Math.abs(ni * di - 360) < di / 2
  // The grid's own extent, in −180..180 with west < east unless it is global.
  const gWest = lon180(westward ? grid.lo1 - (ni - 1) * di : grid.lo1)
  const gSouth = northward ? grid.la1 : grid.la1 - (nj - 1) * dj
  const gNorth = gSouth + (nj - 1) * dj

  let west = gWest
  let nx = ni
  let south = gSouth
  let ny = nj
  if (opts.bbox) {
    const b = opts.bbox
    const span = ((((b.east - b.west) % 360) + 360) % 360) || (b.east > b.west ? 360 : 0)
    // How far east of the grid's west edge the area starts: any distance round a
    // global grid, and possibly negative (the area starts outside) in a regional one.
    const dw = global ? (((b.west - gWest) % 360) + 360) % 360 : lon180(b.west - gWest)
    const c0 = Math.max(0, Math.floor(dw / di + 1e-9))
    const cEnd = Math.ceil((dw + span) / di - 1e-9)
    west = lon180(gWest + c0 * di)
    nx = global ? Math.min(ni, cEnd - c0 + 1) : Math.min(ni - 1, cEnd) - c0 + 1
    const r0 = Math.max(0, Math.floor((b.south - gSouth) / dj + 1e-9))
    const r1 = Math.min(nj - 1, Math.ceil((b.north - gSouth) / dj - 1e-9))
    south = gSouth + r0 * dj
    ny = r1 - r0 + 1
    if (nx < 1 || ny < 1 || (!global && (c0 > ni - 1 || cEnd < 0)) || b.north < gSouth || b.south > gNorth) {
      return { cube: null, warnings: [...warnings, 'the area asked for is outside the file'] }
    }
  }

  const times = [...new Set(onGrid.map((p) => p.m.validTime))].sort((a, b) => a - b)
  let dtMs = 3_600_000
  for (let i = 1; i < times.length; i++) dtMs = i === 1 ? times[1] - times[0] : Math.min(dtMs, times[i] - times[i - 1])
  const nt = times.length > 1 ? Math.round((times[times.length - 1] - times[0]) / dtMs) + 1 : 1
  if (times.length > 1 && nt > times.length) warnings.push(`the file's time steps are uneven; ${nt - times.length} step(s) of ${dtMs / 3_600_000} h have no data`)
  const params = [...new Set(onGrid.map((p) => p.param))]
  const data: Record<string, Float32Array> = {}
  for (const p of params) data[p] = new Float32Array(nt * ny * nx).fill(NaN)

  const colIndex = new Int32Array(nx)
  for (let c = 0; c < nx; c++) {
    const east = (((west - gWest) % 360) + 360) % 360 / di + c
    const ie = Math.round(east) % (global ? ni : Infinity)
    colIndex[c] = westward ? ni - 1 - ie : ie
  }
  const rowIndex = new Int32Array(ny)
  for (let r = 0; r < ny; r++) {
    const n = Math.round((south - gSouth) / dj) + r
    rowIndex[r] = northward ? n : nj - 1 - n
  }
  for (const { m, param, k, add } of onGrid) {
    const it = Math.round((m.validTime - times[0]) / dtMs)
    const out = data[param]
    const base = it * ny * nx
    for (let r = 0; r < ny; r++) {
      const j = rowIndex[r]
      for (let c = 0; c < nx; c++) {
        const i = colIndex[c]
        const v = m.values[colMajor ? i * nj + j : j * ni + i]
        out[base + r * nx + c] = v * k + add
      }
    }
  }
  const ref = onGrid[0].m.refTime
  return {
    cube: {
      model: opts.model ?? 'grib',
      run: Number.isFinite(ref) ? new Date(ref).toISOString() : '',
      bbox: { west, south, east: west + (nx - 1) * di, north: south + (ny - 1) * dj },
      nx,
      ny,
      dx: di,
      dy: dj,
      t0: times[0],
      dtMs,
      nt,
      params,
      data,
    },
    warnings,
  }
}

/** One line of what a file holds, for the parameter catalogue. */
export interface GribEntry {
  name: string
  levelType: number
  levelValue: number
  refTime: number
  validTime: number
  ni: number
  nj: number
}

export interface GribOpened {
  cube: WeatherCube | null
  catalogue: GribEntry[]
  skipped: GribSkipped[]
  warnings: string[]
}

/** Decode a file and build its cube, on whatever thread calls it. The worker calls this. */
export function openGribSync(buf: ArrayBuffer | Uint8Array, opts: { bbox?: BBox; model?: string } = {}): GribOpened {
  const { messages, skipped } = decodeGrib2(buf)
  const { cube, warnings } = gribToCube(messages, opts)
  const catalogue = messages.map((m) => ({
    name: m.name,
    levelType: m.levelType,
    levelValue: m.levelValue,
    refTime: m.refTime,
    validTime: m.validTime,
    ni: m.grid.ni,
    nj: m.grid.nj,
  }))
  return { cube, catalogue, skipped, warnings }
}
