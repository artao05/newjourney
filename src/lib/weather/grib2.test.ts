import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { decodeGrib2, gribToCube, openGribSync } from './grib2'
import { sampleCube } from './cube'
import { file, gfsGrid, message, over, REF, type Grid } from './fixtures/grib2'

/*
 * There is no real GFS file in the repo, so these build GRIB2 messages byte by
 * byte to the WMO layout (sections 0–8, templates 3.0, 4.0, 5.0, 5.2 and 5.3),
 * the way NCEP's encoder packs them, and check the decoder reads them back.
 */

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

  it.each(['complex', 'sd1', 'sd2', 'png', 'ccsds'] as const)('reads %s packing to the packed precision', (packing) => {
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
    for (const packing of ['simple', 'sd2', 'ccsds'] as const) {
      const m = decodeGrib2(file(message({ discipline: 10, category: 0, number: 3, grid: g, values, packing, D: 2 }))).messages[0]
      expect(m.name).toBe('HTSGW')
      for (let i = 0; i < values.length; i++) {
        if (Number.isNaN(values[i])) expect(m.values[i]).toBeNaN()
        else expect(m.values[i]).toBeCloseTo(Math.round(values[i] * 100) / 100, 4)
      }
    }
  })

  it.each([
    ['8-bit grey', 2, 0],
    ['16-bit grey', 2, 2],
    ['24-bit colour', 2, 4],
    ['32-bit colour', 2, 7],
  ])('reads PNG packing in %s pixels, with a bitmap', (_label, scale, D) => {
    const g = gfsGrid(44, 290, 9, 7, 0.5)
    const values = over(g, (lat, lon) => (lat > 43 && lon < 291 ? NaN : scale * (lat - 40) + (lon - 290) / 3 + (D > 4 ? 100 : 0)))
    const m = decodeGrib2(file(message({ category: 3, number: 1, grid: g, values, packing: 'png', D }))).messages[0]
    for (let i = 0; i < values.length; i++) {
      if (Number.isNaN(values[i])) expect(m.values[i]).toBeNaN()
      else expect(m.values[i]).toBeCloseTo(Math.round(values[i] * 10 ** D) / 10 ** D, Math.min(D, 4))
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
      message({ category: 2, number: 3, levelType: 103, levelValue: 10, grid: g, values: v, packing: 'simple', dataTemplate: 50 }),
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
      'data representation template 5.50 is not read yet',
      'grid template 3.30 is not read yet',
      'a GRIB1 message is too short or runs past the end of the file',
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

describe('GRIB display parameters', () => {
  it('reads air and sea temperature in °C and rain rate in mm/h', () => {
    const g = gfsGrid(44, 290, 3, 2, 1)
    const { messages } = decodeGrib2(
      file(
        message({ category: 0, number: 0, levelType: 103, levelValue: 2, grid: g, values: over(g, () => 288.15), packing: 'simple', D: 2 }),
        message({ discipline: 10, category: 3, number: 0, levelType: 1, grid: g, values: over(g, () => 285.65), packing: 'simple', D: 2 }),
        message({ category: 1, number: 7, levelType: 1, grid: g, values: over(g, () => 0.0005), packing: 'simple', D: 6 }),
        // Temperature aloft is not the air on deck.
        message({ category: 0, number: 0, levelType: 100, levelValue: 85000, grid: g, values: over(g, () => 270), packing: 'simple' }),
      ),
    )
    expect(messages.map((m) => m.name)).toEqual(['TMP', 'WTMP', 'PRATE', 'TMP'])
    const c = gribToCube(messages).cube!
    expect(c.params).toEqual(['t2m', 'sst', 'rain'])
    expect(c.data.t2m[0]).toBeCloseTo(15, 3)
    expect(c.data.sst[0]).toBeCloseTo(12.5, 3)
    expect(c.data.rain[0]).toBeCloseTo(1.8, 3)
  })
})

describe('GRIB2 wave partitions', () => {
  it('reads the combined sea with the primary wave, and the wind sea and swell apart (Table 4.2-10-0)', () => {
    const g = gfsGrid(44, 290, 3, 2, 1)
    const wave = (number: number, v: number) => message({ discipline: 10, category: 0, number, levelType: 1, grid: g, values: over(g, () => v), packing: 'simple', D: 2 })
    const { messages } = decodeGrib2(file(wave(3, 2.5), wave(4, 200), wave(5, 1.1), wave(6, 4.5), wave(7, 110), wave(8, 2.1), wave(9, 11), wave(10, 120), wave(11, 10.5)))
    expect(messages.map((m) => m.name)).toEqual(['HTSGW', 'WVDIR', 'WVHGT', 'WVPER', 'SWDIR', 'SWELL', 'SWPER', 'DIRPW', 'PERPW'])
    const c = gribToCube(messages).cube!
    const at = (p: string) => Math.round(c.data[p][0] * 100) / 100
    expect(Object.fromEntries(['hs', 'wdir', 'wper', 'wwh', 'wwd', 'wwp', 'swh', 'swd', 'swp'].map((p) => [p, at(p)]))).toEqual({
      hs: 2.5, wdir: 120, wper: 10.5, wwh: 1.1, wwd: 200, wwp: 4.5, swh: 2.1, swd: 110, swp: 11,
    })
  })
})

describe('GRIB2 JPEG 2000 packing (5.40)', () => {
  it('reads the packed integers from an OpenJPEG codestream, scaled by R, E and D', () => {
    const dir = join(__dirname, 'fixtures', 'j2k')
    const j2k = new Uint8Array(readFileSync(join(dir, 'lossless-default.j2k')))
    const raw = readFileSync(join(dir, 'lossless-default.raw'))
    const g = gfsGrid(45, 290, 61, 43, 0.25)
    const m = decodeGrib2(file(message({ category: 3, number: 1, levelType: 101, grid: g, values: new Array(61 * 43).fill(0), packing: 'jpeg2000', j2k, R: 95000, D: 1 }))).messages[0]
    expect(m.values).toHaveLength(61 * 43)
    for (const i of [0, 1, 60, 61, 1000, 61 * 43 - 1]) expect(m.values[i]).toBeCloseTo((95000 + (raw[2 * i] | (raw[2 * i + 1] << 8))) / 10, 2)
  })
})

