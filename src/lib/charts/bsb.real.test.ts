/** The BSB/KAP reader on a real NOAA raster chart: 14983, Northern Light Lake, BSB 3.0 (fixtures/real). */
import { describe, expect, it } from 'vitest'
import { realFile } from '../../realFiles'
import { readZip } from '../zip'
import { bsbCorners, bsbGeoref, bsbToRgba, decodeBsb } from './bsb'
import { openRaster, rasterTiles, type Corners } from './bsbOpen'

const kap = readZip(realFile('RNC-14983.zip')).find((e) => /\.kap$/i.test(e.name))!
const chart = decodeBsb(kap.bytes)
const h = chart.header

/** Where a map image source puts a point of its picture: a projective map of the unit square onto the corners, in Mercator. */
function warp(corners: Corners) {
  const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners.map(([lon, lat]) => [lon, my(lat)])
  const [dx1, dx2, dy1, dy2] = [x1 - x2, x3 - x2, y1 - y2, y3 - y2]
  const [sx, sy] = [x0 - x1 + x2 - x3, y0 - y1 + y2 - y3]
  const den = dx1 * dy2 - dx2 * dy1
  const g = (sx * dy2 - dx2 * sy) / den
  const k = (dx1 * sy - sx * dy1) / den
  return (u: number, v: number) => {
    const w = g * u + k * v + 1
    const y = (y1 - y0 + g * y1) * u + (y3 - y0 + k * y3) * v + y0
    return { lon: ((x1 - x0 + g * x1) * u + (x3 - x0 + k * x3) * v + x0) / w, lat: (360 / Math.PI) * Math.atan(Math.exp(y / w)) - 90 }
  }
}
const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => Math.hypot((a.lat - b.lat) * 111_120, (a.lon - b.lon) * 111_120 * Math.cos((a.lat * Math.PI) / 180))

describe("NOAA's raster chart 14983", () => {
  it('reads the header, lines wrapped as NOAA wraps them included', () => {
    expect([h.name, h.width, h.height, h.scale, h.projection, h.projectionParam, h.datum, h.depth]).toEqual([
      'NORTHERN LIGHT LAKE', 5622, 4863, 42240, 'LAMBERT CONFORMAL CONIC', -90.667, 'NAD83', 3,
    ])
    expect([h.refs.length, h.border.length]).toEqual([77, 4])
    // Each polynomial wraps onto a second line with no comma at the join.
    for (const p of [h.wpx, h.wpy, h.pwx, h.pwy]) expect(p && [p.order, p.c.length]).toEqual([2, 6])
    for (const name of ['RGB', 'DAY', 'DSK', 'NGT', 'NGR', 'GRY', 'PRC', 'PRG']) expect(h.palettes[name]?.length, name).toBe(6)
  })

  it('decodes every pixel to one of its five colours', () => {
    expect(chart.warnings).toEqual([])
    const seen = new Set(chart.pixels)
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5])
    expect(chart.pixels.length).toBe(5622 * 4863)
  })

  it('places the chart by its pixel-to-world polynomials, to within a pixel of every reference point', () => {
    const geo = bsbGeoref(h)
    expect(geo.method).toBe('polynomial')
    expect(geo.rmsPx).toBeLessThan(0.5)
    for (const r of h.refs) {
      const q = geo.toPixel(r)
      expect(Math.hypot(q.x - r.x, q.y - r.y)).toBeLessThan(1)
      const p = geo.toLatLon(r.x, r.y)
      // A pixel is 4.2 m on the ground here (KNP DX).
      expect(Math.hypot((p.lat - r.lat) * 111_120, (p.lon - r.lon) * 111_120 * Math.cos((r.lat * Math.PI) / 180))).toBeLessThan(5)
    }
    // The top-left corner is PWX's and PWY's constant terms.
    const [nw] = bsbCorners(chart, geo)
    expect(nw[0]).toBeCloseTo(-90.81259694, 8)
    expect(nw[1]).toBeCloseTo(48.34699752, 8)
  })

  it('draws in a palette, shrunk to fit a texture', () => {
    const img = bsbToRgba(chart, 'DAY', 4096)
    expect([img.width, img.height, img.factor]).toEqual([Math.floor(5622 / 2), Math.floor(4863 / 2), 2])
  })

  it('draws in tiles, each within 2 m of the projection, where one warp of the whole chart is 20 m out', () => {
    const geo = bsbGeoref(h)
    const worstOver = (corners: Corners, x0: number, y0: number, w: number, hh: number) => {
      const at = warp(corners)
      let worst = 0
      for (let u = 0; u <= 1.0001; u += 0.1) for (let v = 0; v <= 1.0001; v += 0.1) worst = Math.max(worst, metres(geo.toLatLon(x0 + u * w, y0 + v * hh), at(u, v)))
      return worst
    }
    expect(worstOver(bsbCorners(chart, geo), 0, 0, chart.width, chart.height)).toBeGreaterThan(20)
    const opened = openRaster(kap.bytes)
    const tiles = rasterTiles(opened)
    expect([opened.grid.cols, opened.grid.rows, tiles.length]).toEqual([6, 5, 30])
    // The tiles cover the picture exactly, edge to edge.
    expect(tiles.reduce((s, t) => s + t.w * t.h, 0)).toBe(opened.width * opened.height)
    const f = chart.width / opened.width
    for (const t of tiles) expect(worstOver(t.corners, t.x * f, t.y * (chart.height / opened.height), t.w * f, t.h * (chart.height / opened.height))).toBeLessThan(2)
  })
})
