import { describe, expect, it } from 'vitest'
import { checkRoute, unsafePolygons, withEncHazards } from './encRouting'
import type { EncCell, EncFeature } from './s57'

const square = (west: number, south: number, east: number, north: number): Array<[number, number]> => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
]
const area = (cls: string, attrs: Record<string, string>, ring: Array<[number, number]>): EncFeature => ({ objl: 0, cls, prim: 3, attrs, geometry: { type: 'Polygon', coordinates: [ring] } })
const point = (cls: string, attrs: Record<string, string>, lon: number, lat: number): EncFeature => ({ objl: 0, cls, prim: 1, attrs, geometry: { type: 'Point', coordinates: [lon, lat] } })
const cell = (features: EncFeature[]): EncCell => ({ name: 'T.000', edition: '1', update: '0', comf: 1e7, somf: 10, scale: 0, bounds: { west: -70.3, south: 43.6, east: -70.1, north: 43.7 }, features, counts: {}, warnings: [] })

const shoal = area('DEPARE', { DRVAL1: '1', DRVAL2: '2' }, square(-70.22, 43.64, -70.18, 43.66))
const deep = area('DEPARE', { DRVAL1: '5', DRVAL2: '10' }, square(-70.3, 43.6, -70.1, 43.7))
const island = area('LNDARE', {}, square(-70.15, 43.62, -70.14, 43.63))
const rock = point('UWTROC', { VALSOU: '1.2' }, -70.25, 43.65)
const deepWreck = point('WRECKS', { VALSOU: '20' }, -70.12, 43.68)
const unknownObstruction = point('OBSTRN', {}, -70.28, 43.61)

describe('ENC hazards for the router', () => {
  it('keeps land, water under the safety depth and dangers under it, or of unknown depth', () => {
    const polys = unsafePolygons([cell([deep, shoal, island, rock, deepWreck, unknownObstruction])], 3)
    // The shoal, the island, the rock and the obstruction; not the deep area or the deep wreck.
    expect(polys).toHaveLength(4)
    expect(unsafePolygons([cell([deep, shoal])], 0.5)).toHaveLength(0)
  })

  it('adds them to the land pack in its own grid, without changing the pack', () => {
    const base = { bbox: { west: -70.3, south: 43.6, east: -70.1, north: 43.7 }, nx: 200, ny: 100, bits: new Uint32Array(Math.ceil(20000 / 32)) }
    const g = withEncHazards(base, [cell([deep, shoal])], 3)!
    const on = (lon: number, lat: number) => {
      const i = Math.floor(((lat - 43.6) / 0.1) * 100) * 200 + Math.floor(((lon + 70.3) / 0.2) * 200)
      return (g.bits[i >>> 5] >>> (i & 31)) & 1
    }
    expect(on(-70.2, 43.65)).toBe(1)
    expect(on(-70.25, 43.65)).toBe(0)
    expect(base.bits.every((w) => w === 0)).toBe(true)
    expect(withEncHazards(base, [cell([deep])], 3)).toBe(base)
  })

  it('makes its own grid over the cells when there is no land pack', () => {
    const g = withEncHazards(undefined, [cell([shoal])], 3)!
    expect(g.bbox).toEqual({ west: -70.3, south: 43.6, east: -70.1, north: 43.7 })
    expect([g.nx, g.ny]).toEqual([400, 200])
    expect(g.bits.some((w) => w !== 0)).toBe(true)
  })
})

describe('the route check', () => {
  const cells = [cell([deep, shoal, island, rock, deepWreck])]

  it('names what a route crosses or passes too close to, where it first does, leg by leg', () => {
    const route = [
      { lat: 43.65, lon: -70.29 },
      { lat: 43.65, lon: -70.1 },
    ]
    const h = checkRoute(route, cells, 3, 100)
    expect(h.map((x) => [x.kind, x.leg])).toEqual([
      ['danger', 0],
      ['shallow', 0],
    ])
    expect(h[0].what).toBe('Rock, 1.2 m within 100 m')
    expect(h[1].what).toBe('Depth area 1–2 m, under the 3 m safety depth')
    expect(h[1].at.lon).toBeCloseTo(-70.22, 3)
  })

  it('passes a route in deep water clear of the dangers, and knows land', () => {
    expect(checkRoute([{ lat: 43.61, lon: -70.29 }, { lat: 43.61, lon: -70.11 }], cells, 3)).toEqual([])
    const ashore = checkRoute([{ lat: 43.61, lon: -70.145 }, { lat: 43.64, lon: -70.145 }], cells, 3)
    expect(ashore.map((x) => [x.kind, x.what])).toEqual([['land', 'Land']])
  })
})
