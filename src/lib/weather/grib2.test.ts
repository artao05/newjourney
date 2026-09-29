import { describe, expect, it, vi } from 'vitest'
import { decodeGrib2, gribToCube, openGribSync } from './grib2'
import { sampleCube } from './cube'

/*
 * There is no real GFS file in the repo, so these build GRIB2 messages byte by
 * byte to the WMO layout (sections 0–8, templates 3.0, 4.0, 5.0, 5.2 and 5.3),
 * the way NCEP's encoder packs them, and check the decoder reads them back.
 */

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

interface Grid {
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

interface Field {
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
  packing: 'simple' | 'complex' | 'sd1' | 'sd2'
  D?: number
  gridTemplate?: number
  dataTemplate?: number
}

const REF = Date.UTC(2026, 8, 29, 6)

function message(f: Field): number[] {
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
  if (f.packing === 'simple') {
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

const file = (...msgs: number[][]) => new Uint8Array(msgs.flat())

/** A regular grid, north to south and west to east as GFS scans it. */
function gfsGrid(la1: number, lo1: number, ni: number, nj: number, d: number): Grid {
  return { ni, nj, la1, lo1, la2: la1 - (nj - 1) * d, lo2: lo1 + (ni - 1) * d, di: d, dj: d, scanMode: 0 }
}

/** Values over a grid in scan order from a function of latitude and longitude. */
function over(g: Grid, fn: (lat: number, lon: number) => number): number[] {
  const out: number[] = []
  for (let j = 0; j < g.nj; j++) for (let i = 0; i < g.ni; i++) out.push(fn(g.la1 - j * g.dj, g.lo1 + i * g.di))
  return out
}

const smooth = (lat: number, lon: number) => 1013 + 12 * Math.sin(lat / 7) * Math.cos(lon / 11) + lat / 10

describe('GRIB2 decoder', () => {
  it('reads simple packing: the values, the grid, the parameter and the times', () => {
    const g = gfsGrid(45, 290, 4, 3, 0.25)
    const values = over(g, (lat, lon) => 273.15 + lat / 10 - (lon - 290))
    const { messages, skipped } = decodeGrib2(file(message({ category: 0, number: 0, levelType: 103, levelValue: 2, forecastH: 12, grid: g, values, packing: 'simple', D: 2 })))
    expect(skipped).toEqual([])
    expect(messages).toHaveLength(1)
    const m = messages[0]
    expect(m.name).toBe('TMP')
    expect(m.levelType).toBe(103)
    expect(m.levelValue).toBe(2)
    expect(m.refTime).toBe(REF)
    expect(m.forecastMs).toBe(12 * 3_600_000)
    expect(m.validTime).toBe(REF + 12 * 3_600_000)
    expect(m.grid).toMatchObject({ ni: 4, nj: 3, la1: 45, lo1: 290, di: 0.25, dj: 0.25, scanMode: 0 })
    expect(m.grid.la2).toBeCloseTo(44.5, 6)
    for (let i = 0; i < values.length; i++) expect(m.values[i]).toBeCloseTo(Math.round(values[i] * 100) / 100, 4)
  })

  it.each(['complex', 'sd1', 'sd2'] as const)('reads complex packing (%s) to the packed precision', (packing) => {
    const g = gfsGrid(50, 280, 23, 17, 0.5)
    const values = over(g, smooth)
    const { messages, skipped } = decodeGrib2(file(message({ category: 3, number: 1, levelType: 101, grid: g, values, packing, D: 1 })))
    expect(skipped).toEqual([])
    const m = messages[0]
    expect(m.name).toBe('PRMSL')
    expect(m.values).toHaveLength(23 * 17)
    let worst = 0
    for (let i = 0; i < values.length; i++) worst = Math.max(worst, Math.abs(m.values[i] - Math.round(values[i] * 10) / 10))
    // Float32 of a value near 1013 is good to about 1e-4.
    expect(worst).toBeLessThan(2e-4)
  })

  it('reads a field that has falling as well as rising runs with second-order differencing', () => {
    const g = gfsGrid(10, 0, 37, 1, 1)
    const values = over(g, (_lat, lon) => Math.round(50 * Math.sin(lon / 3) - (lon % 7) * 3))
    const m = decodeGrib2(file(message({ category: 2, number: 2, levelType: 103, levelValue: 10, grid: g, values, packing: 'sd2' }))).messages[0]
    expect([...m.values]).toEqual(values)
  })

  it('leaves the points the bitmap marks out as NaN, and the rest in place', () => {
    const g = gfsGrid(44, 290, 5, 4, 0.5)
    const values = over(g, (lat, lon) => (lon > 291 && lat < 43 ? NaN : 1.5 + lat - 40 + (lon - 290) / 4))
    for (const packing of ['simple', 'sd2'] as const) {
      const m = decodeGrib2(file(message({ discipline: 10, category: 0, number: 3, grid: g, values, packing, D: 2 }))).messages[0]
      expect(m.name).toBe('HTSGW')
      for (let i = 0; i < values.length; i++) {
        if (Number.isNaN(values[i])) expect(m.values[i]).toBeNaN()
        else expect(m.values[i]).toBeCloseTo(Math.round(values[i] * 100) / 100, 4)
      }
    }
  })

  it('reads a constant field packed in no bits at all', () => {
    const g = gfsGrid(40, 290, 3, 2, 1)
    const m = decodeGrib2(file(message({ category: 2, number: 22, grid: g, values: [7, 7, 7, 7, 7, 7], packing: 'simple' }))).messages[0]
    expect(m.name).toBe('GUST')
    expect([...m.values]).toEqual([7, 7, 7, 7, 7, 7])
  })

  it('reads every message in a file, skips what it cannot read with the reason, and ignores junk between', () => {
    const g = gfsGrid(40, 290, 3, 2, 1)
    const v = [1, 2, 3, 4, 5, 6]
    const bytes = file(
      [0, 1, 2, 3],
      message({ category: 2, number: 2, levelType: 103, levelValue: 10, grid: g, values: v, packing: 'simple' }),
      message({ category: 2, number: 3, levelType: 103, levelValue: 10, grid: g, values: v, packing: 'simple', dataTemplate: 40 }),
      [9, 9],
      message({ category: 2, number: 3, levelType: 103, levelValue: 10, grid: g, values: v, packing: 'simple', gridTemplate: 30 }),
      // A GRIB1 header: "GRIB", a 3-octet length of 12, edition 1.
      [0x47, 0x52, 0x49, 0x42, 0, 0, 12, 1, 0, 0, 0, 0],
      message({ category: 2, number: 3, levelType: 103, levelValue: 10, forecastH: 3, grid: g, values: v, packing: 'sd1' }),
    )
    const { messages, skipped } = decodeGrib2(bytes)
    expect(messages.map((m) => m.name)).toEqual(['UGRD', 'VGRD'])
    expect(messages[1].forecastMs).toBe(3 * 3_600_000)
    expect(skipped.map((s) => s.reason)).toEqual([
      'data representation template 5.40 is not read yet',
      'grid template 3.30 is not read yet',
      'GRIB edition 1 is not read yet',
    ])
  })

  it('does not run off the end of a truncated file', () => {
    const g = gfsGrid(40, 290, 3, 2, 1)
    const whole = message({ category: 2, number: 2, grid: g, values: [1, 2, 3, 4, 5, 6], packing: 'simple' })
    const { messages, skipped } = decodeGrib2(new Uint8Array(whole.slice(0, whole.length - 10)))
    expect(messages).toEqual([])
    expect(skipped[0].reason).toMatch(/past the end/)
  })

  it('decodes a global 0.5° field quickly enough to do dozens of them', () => {
    const g = gfsGrid(90, 0, 720, 361, 0.5)
    const values = over(g, smooth)
    const bytes = file(message({ category: 3, number: 1, levelType: 101, grid: g, values, packing: 'sd2', D: 1 }))
    const t = performance.now()
    const m = decodeGrib2(bytes).messages[0]
    const ms = performance.now() - t
    expect(m.values[1000]).toBeCloseTo(Math.round(values[1000] * 10) / 10, 3)
    expect(ms).toBeLessThan(2000)
  }, 30_000)
})

describe('GRIB to the weather cube', () => {
  const KN = 1.9438445
  // A global 1° GFS-style grid: 0–359° east, 90° N to 90° S.
  const g = gfsGrid(90, 0, 360, 181, 1)
  const u = (lat: number, lon: number) => 5 + lat / 20 + Math.cos((lon * Math.PI) / 180)
  const v = (lat: number, lon: number) => -3 + Math.sin((lon * Math.PI) / 180) * 2 - lat / 50
  const p = (lat: number, lon: number) => 101300 + 50 * lat + 10 * Math.sin((lon * Math.PI) / 180)
  const lon0 = (lon: number) => (lon < 0 ? lon + 360 : lon)

  function gfsFile(hours: number[]) {
    const msgs: number[][] = []
    for (const h of hours) {
      msgs.push(message({ category: 2, number: 2, levelType: 103, levelValue: 10, forecastH: h, grid: g, values: over(g, (a, o) => u(a, o) + h / 10), packing: 'sd2', D: 2 }))
      msgs.push(message({ category: 2, number: 3, levelType: 103, levelValue: 10, forecastH: h, grid: g, values: over(g, v), packing: 'sd2', D: 2 }))
      msgs.push(message({ category: 3, number: 1, levelType: 101, forecastH: h, grid: g, values: over(g, p), packing: 'sd2', D: 0 }))
      // Wind at 850 hPa is not the 10 m wind, and stays out.
      msgs.push(message({ category: 2, number: 2, levelType: 100, levelValue: 85000, forecastH: h, grid: g, values: over(g, () => 40), packing: 'simple' }))
    }
    return file(...msgs)
  }

  it('crops across the 0/360 seam, turns rows south to north, and converts to knots and hPa', () => {
    const { messages } = decodeGrib2(gfsFile([0, 3]))
    const { cube, warnings } = gribToCube(messages, { bbox: { west: -2.5, east: 3.2, south: 40.2, north: 43 }, model: 'gfs' })
    expect(warnings).toEqual([])
    expect(cube).not.toBeNull()
    const c = cube!
    expect(c.params.sort()).toEqual(['prmsl', 'u10', 'v10'])
    expect(c.bbox).toEqual({ west: -3, east: 4, south: 40, north: 43 })
    expect([c.nx, c.ny, c.nt, c.dtMs, c.t0]).toEqual([8, 4, 2, 3 * 3_600_000, REF])
    expect(c.run).toBe(new Date(REF).toISOString())
    // Row 0 is the south row, column 0 the west column.
    expect(c.data.u10[0]).toBeCloseTo(u(40, lon0(-3)) * KN, 2)
    expect(c.data.u10[3 * 8 + 7]).toBeCloseTo(u(43, 4) * KN, 2)
    expect(c.data.prmsl[8 + 2]).toBeCloseTo(p(41, lon0(-1)) / 100, 2)
    // And the cube reads like any other: a point between grid points, at a time between steps.
    const t = REF + 90 * 60_000
    const got = sampleCube(c, 'u10', 41, 0, t)!
    expect(got).toBeCloseTo((u(41, 0) + 0.15) * KN, 2)
    expect(sampleCube(c, 'v10', 42, -2, REF)).toBeCloseTo(v(42, 358) * KN, 2)
  })

  it('takes the whole grid, with longitudes from −180, when no area is given', () => {
    const small = gfsGrid(50, 350, 21, 5, 1)
    const m = decodeGrib2(file(message({ category: 2, number: 2, levelType: 103, levelValue: 10, grid: small, values: over(small, (a, o) => a + o / 1000), packing: 'simple', D: 3 }))).messages
    const c = gribToCube(m).cube!
    expect(c.bbox).toEqual({ west: -10, east: 10, south: 46, north: 50 })
    expect(c.data.u10[0]).toBeCloseTo((46 + 350 / 1000) * KN, 3)
    // The fixture's own longitudes run on past 360.
    expect(c.data.u10[4 * 21 + 20]).toBeCloseTo((50 + 370 / 1000) * KN, 3)
  })

  it('reads a grid scanned south to north', () => {
    const s2n: Grid = { ni: 3, nj: 3, la1: 30, lo1: 280, la2: 32, lo2: 282, di: 1, dj: 1, scanMode: 0x40 }
    const values: number[] = []
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) values.push(30 + j + i / 10)
    const m = decodeGrib2(file(message({ category: 3, number: 1, levelType: 101, grid: s2n, values: values.map((x) => x * 100), packing: 'simple' }))).messages
    const c = gribToCube(m).cube!
    expect(c.bbox).toEqual({ west: -80, east: -78, south: 30, north: 32 })
    expect([...c.data.prmsl].map((x) => Math.round(x * 10) / 10)).toEqual(values.map((x) => Math.round(x * 10) / 10))
  })

  it('says so when steps are missing, a field is on another grid, or the area is off the file', () => {
    const a = gfsGrid(44, 290, 3, 3, 1)
    const b = gfsGrid(44, 290, 5, 5, 0.5)
    const w = (h: number, grid = a) => message({ category: 2, number: 2, levelType: 103, levelValue: 10, forecastH: h, grid, values: over(grid, () => h), packing: 'simple' })
    const m = decodeGrib2(file(w(0), w(3), w(9), w(3, b))).messages
    const { cube, warnings } = gribToCube(m)
    expect(cube!.nt).toBe(4)
    expect(cube!.data.u10[2 * 9]).toBeNaN()
    expect(cube!.data.u10[3 * 9]).toBeCloseTo(9 * KN, 3)
    expect(warnings).toEqual(['1 field(s) on another grid were left out', "the file's time steps are uneven; 1 step(s) of 3 h have no data"])
    expect(gribToCube(m, { bbox: { west: 10, east: 12, south: 0, north: 2 } }).cube).toBeNull()
    expect(gribToCube([]).warnings).toEqual(['no wind, pressure, wave or current fields in the file'])
  })

  it('gives the catalogue of everything in the file alongside the cube', () => {
    const out = openGribSync(gfsFile([0]), { bbox: { west: -1, east: 1, south: 0, north: 1 } })
    expect(out.catalogue.map((e) => `${e.name}@${e.levelType}/${e.levelValue}`)).toEqual(['UGRD@103/10', 'VGRD@103/10', 'PRMSL@101/0', 'UGRD@100/85000'])
    expect(out.cube!.nx).toBe(3)
    expect(out.skipped).toEqual([])
  })
})

describe('GRIB off the main thread', () => {
  const g = gfsGrid(41, 289, 3, 2, 1)
  const one = () => file(message({ category: 2, number: 2, levelType: 103, levelValue: 10, grid: g, values: [1, 2, 3, 4, 5, 6], packing: 'simple' }))

  it('the worker answers with the cube, and hands its arrays over rather than copying them', async () => {
    const posted: Array<{ msg: unknown; transfer: unknown[] }> = []
    const fake: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown, t?: unknown[]) => void } = {
      onmessage: null,
      postMessage: (msg, transfer = []) => posted.push({ msg, transfer }),
    }
    vi.stubGlobal('self', fake)
    vi.resetModules()
    await import('./gribWorker')
    const buf = one().buffer
    fake.onmessage!({ data: { id: 7, buf } })
    fake.onmessage!({ data: { id: 8, buf: new ArrayBuffer(0) } })
    vi.unstubAllGlobals()
    const [ok, empty] = posted as Array<{ msg: { id: number; ok: boolean; out?: { cube: { data: { u10: Float32Array } } | null; warnings: string[] }; error?: string }; transfer: unknown[] }>
    expect(ok.msg.id).toBe(7)
    expect(ok.msg.ok).toBe(true)
    expect(ok.msg.out!.cube!.data.u10[0]).toBeCloseTo(4 * 1.9438445, 4)
    expect(ok.transfer).toEqual([ok.msg.out!.cube!.data.u10.buffer])
    // An empty file is not an error, just nothing to use.
    expect(empty.msg).toMatchObject({ id: 8, ok: true })
    expect(empty.msg.out!.cube).toBeNull()
    expect(empty.msg.out!.warnings).toEqual(['no wind, pressure, wave or current fields in the file'])
  })

  it('opens on this thread where there are no workers', async () => {
    const { openGrib } = await import('./gribClient')
    expect(typeof Worker).toBe('undefined')
    const out = await openGrib(one().buffer)
    expect(out.cube!.params).toEqual(['u10'])
  })
})
