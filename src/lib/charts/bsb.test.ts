import { describe, expect, it } from 'vitest'
import { bsbCorners, bsbGeoref, bsbToRgba, decodeBsb, isBsb, parseBsbHeader } from './bsb'
import { kap } from './fixtures/bsb'
import { openRaster } from './bsbOpen'

const RAD = Math.PI / 180
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2))
const invMercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD

/*
 * A Mercator chart 300 × 200 pixels over Portland: longitude linear in x,
 * Mercator latitude linear in y, as a Mercator chart is drawn.
 */
const W = 300
const H = 200
const west = -70.3
const east = -70.15
const north = 43.7
const south = 43.6
const lonAt = (x: number) => west + ((east - west) * x) / W
const latAt = (y: number) => invMercY(mercY(north) + ((mercY(south) - mercY(north)) * y) / H)
const refs = [
  [0, 0],
  [W, 0],
  [W, H],
  [0, H],
  [150, 90],
].map(([x, y], i) => `REF/${i + 1},${x},${y},${latAt(y).toFixed(8)},${lonAt(x).toFixed(8)}`)
const header = [
  'KNP/SC=20000,GD=NAD83,PR=MERCATOR,PP=43.65,PI=UNKNOWN,SP=,SK=0.0,TA=90,UN=METERS,SD=MLLW,',
  '    DX=5.0,DY=5.0',
  'RGB/1,255,255,255',
  'RGB/2,0,0,0',
  'RGB/3,200,40,40',
  'RGB/4,90,160,220',
  'NGT/1,40,0,0',
  'NGT/2,0,0,0',
  'NGT/3,60,0,0',
  'NGT/4,20,20,60',
  ...refs,
  `PLY/1,${north},${west}`,
  `PLY/2,${north},${east}`,
  `PLY/3,${south},${east}`,
  `PLY/4,${south},${west}`,
  'DTM/0.0,0.0',
  'IFM/3',
]
// Land (red) west of x = 100, water (blue) east, a black line along y = 50, and long white runs at the bottom.
const pixel = (x: number, y: number) => (y === 50 ? 2 : y >= 190 ? 1 : x < 100 ? 3 : 4)

describe('BSB/KAP raster charts', () => {
  const file = kap({ width: W, height: H, depth: 3, pixel, lines: header })

  it('reads the header: name, size, scale, projection, palettes, reference points and border', () => {
    expect(isBsb(file)).toBe(true)
    const c = decodeBsb(file)
    const h = c.header
    expect([h.name, h.number, h.width, h.height, h.scale, h.projection, h.projectionParam, h.datum]).toEqual(['Test Harbour', '99999', W, H, 20000, 'MERCATOR', 43.65, 'NAD83'])
    expect(h.palettes.RGB[3]).toEqual([200, 40, 40])
    expect(h.palettes.NGT[4]).toEqual([20, 20, 60])
    expect(h.refs).toHaveLength(5)
    expect(h.border).toHaveLength(4)
    expect(h.depth).toBe(3)
    expect(c.warnings).toEqual([])
  })

  it('decodes every pixel of the run-length rows', () => {
    const c = decodeBsb(file)
    let wrong = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (c.pixels[y * W + x] !== pixel(x, y)) wrong++
    expect(wrong).toBe(0)
  })

  it('decodes seven bits a pixel, runs longer than one byte holds, and rows numbered from zero', () => {
    const p = (x: number, y: number) => 1 + ((x >> 5) + y) % 100
    const c = decodeBsb(kap({ width: 1000, height: 3, depth: 7, pixel: p, lines: ['RGB/1,0,0,0'], firstRow: 0 }))
    expect(c.warnings).toEqual([])
    expect([...c.pixels.subarray(0, 1000)].every((v, x) => v === p(x, 0))).toBe(true)
    expect(c.pixels[2 * 1000 + 999]).toBe(p(999, 2))
    const long = decodeBsb(kap({ width: 5000, height: 1, depth: 1, pixel: () => 1, lines: [] }))
    expect(long.pixels.every((v) => v === 1)).toBe(true)
  })

  it('places a Mercator chart from its reference points, to a fraction of a pixel', () => {
    const geo = bsbGeoref(decodeBsb(file).header)
    expect(geo.method).toBe('mercator')
    expect(geo.rmsPx).toBeLessThan(0.01)
    const p = geo.toLatLon(75, 150)
    expect(p.lat).toBeCloseTo(latAt(150), 6)
    expect(p.lon).toBeCloseTo(lonAt(75), 6)
    const q = geo.toPixel({ lat: 43.65, lon: -70.2 })
    expect(q.x).toBeCloseTo(((-70.2 - west) / (east - west)) * W, 3)
    const corners = bsbCorners({ width: W, height: H }, geo)
    expect(corners[0][0]).toBeCloseTo(west, 6)
    expect(corners[0][1]).toBeCloseTo(north, 6)
    expect(corners[2][0]).toBeCloseTo(east, 6)
    expect(corners[2][1]).toBeCloseTo(south, 6)
  })

  it('shifts by the datum shift, in seconds of arc', () => {
    const shifted = parseBsbHeader([...header.filter((l) => !l.startsWith('DTM')), 'DTM/3.6,-7.2'].join('\n'))
    shifted.width = W
    shifted.height = H
    const p = bsbGeoref(shifted).toLatLon(75, 150)
    expect(p.lat).toBeCloseTo(latAt(150) + 0.001, 6)
    expect(p.lon).toBeCloseTo(lonAt(75) - 0.002, 6)
  })

  it('uses the polynomials for a chart not on Mercator', () => {
    // Longitude = -70.3 + 0.0005·x, latitude = 43.7 - 0.0005·y, and back.
    const h = parseBsbHeader(
      ['KNP/SC=5000,PR=TRANSVERSE MERCATOR', 'REF/1,0,0,43.7,-70.3', 'REF/2,100,100,43.65,-70.25', 'WPX/1,-70.3,0.0005,0', 'WPY/1,43.7,0,-0.0005', 'PWX/1,140600,2000,0', 'PWY/1,87400,0,-2000'].join('\n'),
    )
    const geo = bsbGeoref(h)
    expect(geo.method).toBe('polynomial')
    expect(geo.toLatLon(100, 100).lat).toBeCloseTo(43.65, 9)
    expect(geo.toPixel({ lat: 43.65, lon: -70.25 }).x).toBeCloseTo(100, 6)
    expect(geo.rmsPx).toBeLessThan(1e-6)
  })

  it('draws in the day or night palette, shrunk to fit a texture', () => {
    const c = decodeBsb(file)
    const day = bsbToRgba(c)
    expect([day.width, day.height, day.factor]).toEqual([W, H, 1])
    expect([...day.data.subarray(0, 4)]).toEqual([200, 40, 40, 255])
    const night = bsbToRgba(c, 'NGT', 128)
    expect([night.width, night.height, night.factor]).toEqual([100, 66, 3])
    // Pixel (50, 0) of the shrunk chart is pixel (150, 0): water.
    expect([...night.data.subarray(50 * 4, 50 * 4 + 4)]).toEqual([20, 20, 60, 255])
  })

  it('makes a chart ready for the map: picture, corners and what it is', () => {
    const r = openRaster(file)
    expect([r.name, r.number, r.scale, r.width, r.height]).toEqual(['Test Harbour', '99999', 20000, W, H])
    expect(r.rgba).toHaveLength(W * H * 4)
    expect(r.corners[1][0]).toBeCloseTo(east, 6)
    expect(r.corners[1][1]).toBeCloseTo(north, 6)
    expect(r.warnings).toEqual([])
    // Reference points that do not agree are said to.
    const bad = openRaster(kap({ width: W, height: H, depth: 3, pixel, lines: [...header, `REF/9,10,10,${south},${east}`] }))
    expect(bad.warnings.at(-1)).toMatch(/^the reference points fit to [\d.]+ pixels only$/)
  })

  it('says what is wrong with a file that is not a chart', () => {
    expect(() => decodeBsb(new TextEncoder().encode('just some text'))).toThrow(/no end to the header/)
    expect(() => decodeBsb(new Uint8Array([...new TextEncoder().encode('VER/3.0\r\n'), 0x1a, 0]))).toThrow(/no size/)
    const cut = file.slice(0, 1200)
    expect(decodeBsb(cut).warnings.at(-1)).toMatch(/the picture stops after \d+ of 200 rows/)
  })
})
