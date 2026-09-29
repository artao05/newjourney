import { describe, expect, it } from 'vitest'
import { boundsFromControlPoints, offsetCorners, offsetFeatures, offsetPosition } from './georef'

const RAD = Math.PI / 180
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2))
const invMercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD

// An 800 × 600 Mercator picture from 44°N 71°W to 43°N 69°W.
const W = 800
const H = 600
const lonAt = (x: number) => -71 + (2 * x) / W
const latAt = (y: number) => invMercY(mercY(44) + ((mercY(43) - mercY(44)) * y) / H)

describe('placing a picture by control points', () => {
  it('finds a Mercator picture’s edges from two points far apart', () => {
    const r = boundsFromControlPoints(
      [
        { x: 100, y: 80, lat: latAt(80), lon: lonAt(100) },
        { x: 700, y: 520, lat: latAt(520), lon: lonAt(700) },
      ],
      W,
      H,
    )!
    expect(r.bbox.west).toBeCloseTo(-71, 9)
    expect(r.bbox.east).toBeCloseTo(-69, 9)
    expect(r.bbox.north).toBeCloseTo(44, 9)
    expect(r.bbox.south).toBeCloseTo(43, 9)
    expect(r.rmsPx).toBeLessThan(1e-6)
  })

  it('fits more points by least squares, and says how well', () => {
    const pts = [
      [50, 50, 2],
      [750, 60, -2],
      [400, 300, 1],
      [60, 560, -1],
      [740, 550, 0],
    ].map(([x, y, e]) => ({ x: x + e, y, lat: latAt(y), lon: lonAt(x) }))
    const r = boundsFromControlPoints(pts, W, H)!
    expect(r.bbox.west).toBeCloseTo(-71, 2)
    expect(r.rmsPx).toBeGreaterThan(0.5)
    expect(r.rmsPx).toBeLessThan(2)
  })

  it('places a latitude/longitude picture with latitude linear in y', () => {
    const r = boundsFromControlPoints(
      [
        { x: 0, y: 0, lat: 50, lon: -80 },
        { x: 400, y: 300, lat: 35, lon: -60 },
      ],
      800,
      600,
      'latlon',
    )!
    expect(r.bbox).toEqual({ west: -80, east: -40, north: 50, south: 20 })
  })

  it('will not place from points in a line, or upside down', () => {
    expect(boundsFromControlPoints([{ x: 10, y: 10, lat: 44, lon: -71 }], W, H)).toBeNull()
    expect(boundsFromControlPoints([{ x: 10, y: 10, lat: 44, lon: -71 }, { x: 10, y: 500, lat: 43, lon: -71 }], W, H)).toBeNull()
    expect(boundsFromControlPoints([{ x: 10, y: 10, lat: 43, lon: -71 }, { x: 500, y: 500, lat: 44, lon: -69 }], W, H)).toBeNull()
  })
})

describe('the chart offset', () => {
  it('moves a position north and east by metres', () => {
    const p = offsetPosition({ lat: 60, lon: 10 }, { northM: 1852, eastM: 926 })
    expect(p.lat).toBeCloseTo(60 + 1 / 60, 9)
    // A mile east at 60°N is two minutes of longitude; half a mile is one.
    expect(p.lon).toBeCloseTo(10 + 1 / 60, 9)
  })

  it('moves every kind of chart feature, keeping sounding depths, and copies rather than changes', () => {
    const features = [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-70, 43] } },
      { type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[-70, 43, 12.5]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-70, 43], [-69, 43], [-69, 44], [-70, 43]]] } },
      { type: 'Feature', properties: {}, geometry: null },
    ]
    const moved = offsetFeatures(features, { northM: 1852 * 60, eastM: 0 }, 43)
    expect(moved[0].geometry!.coordinates).toEqual([-70, 44])
    expect(moved[1].geometry!.coordinates).toEqual([[-70, 44, 12.5]])
    expect((moved[2].geometry!.coordinates as number[][][])[0][2]).toEqual([-69, 45])
    expect(moved[3].geometry).toBeNull()
    expect(features[0].geometry!.coordinates).toEqual([-70, 43])
    expect(offsetFeatures(features, { northM: 0, eastM: 0 }, 43)).toBe(features)
  })

  it('moves an image’s corners', () => {
    const c: Array<[number, number]> = [
      [-70, 44],
      [-69, 44],
    ]
    const m = offsetCorners(c, { northM: -1852 * 60, eastM: 0 })
    expect(m[0][1]).toBeCloseTo(43, 9)
    expect(m[1][0]).toBeCloseTo(-69, 9)
  })
})
