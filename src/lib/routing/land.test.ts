/**
 * The obstacle layer.
 *
 * `land.ts` is the highest-stakes file in the repo: it is the only thing standing
 * between a computed route and an island, and its own docstring says testing the
 * endpoint instead of the segment is "the most common bug in hobby routers". It
 * was exercised only indirectly — through `landmask.test.ts` against the shipped
 * Portland raster, and through one synthetic island in `isochrone.test.ts`.
 *
 * The test that matters most here is `never misses land that a dense sampling
 * finds`: a property check against brute force over random segments. The mask is
 * allowed to be *conservative* — it dilates deliberately, so reporting land where
 * there is none is by design — but a false negative sails a boat over a rock, and
 * no amount of "it looked right on the map" argues otherwise.
 */

import { describe, expect, it } from 'vitest'
import {
  NULL_LAND_MASK,
  PolygonLandMask,
  RasterLandMask,
  buildLandMask,
  extractPolygons,
} from './land'
import type { BBox, LatLon } from '../types'

const BOX: BBox = { west: -70, south: 43, east: -69, north: 44 }

/** A raster over BOX with the given cells flagged, as `[ix, iy]` pairs. */
function raster(nx: number, ny: number, cells: Array<[number, number]>): RasterLandMask {
  const bits = new Uint32Array(Math.ceil((nx * ny) / 32) || 1)
  for (const [ix, iy] of cells) {
    const k = iy * nx + ix
    bits[k >>> 5] |= 1 << (k & 31)
  }
  return new RasterLandMask(BOX, nx, ny, bits)
}

/** Centre of cell (ix, iy) in a nx x ny raster over BOX. */
function cellCentre(nx: number, ny: number, ix: number, iy: number): LatLon {
  return {
    lon: BOX.west + ((ix + 0.5) * (BOX.east - BOX.west)) / nx,
    lat: BOX.south + ((iy + 0.5) * (BOX.north - BOX.south)) / ny,
  }
}

/** A square polygon, as GeoJSON coordinates. */
function square(west: number, south: number, size: number): number[][][] {
  return [
    [
      [west, south],
      [west + size, south],
      [west + size, south + size],
      [west, south + size],
      [west, south],
    ],
  ]
}

describe('NULL_LAND_MASK', () => {
  it('is open ocean everywhere', () => {
    expect(NULL_LAND_MASK.isLand(43.5, -69.5)).toBe(false)
    expect(NULL_LAND_MASK.crosses({ lat: 0, lon: 0 }, { lat: 60, lon: 100 })).toBe(false)
  })
})

describe('extractPolygons', () => {
  it('finds polygons through every GeoJSON wrapper', () => {
    const poly = { type: 'Polygon', coordinates: square(-70, 43, 0.1) }
    expect(extractPolygons(poly)).toHaveLength(1)
    expect(extractPolygons({ type: 'Feature', geometry: poly })).toHaveLength(1)
    expect(
      extractPolygons({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: poly }] }),
    ).toHaveLength(1)
    expect(
      extractPolygons({ type: 'GeometryCollection', geometries: [poly, poly] }),
    ).toHaveLength(2)
    expect(
      extractPolygons({ type: 'MultiPolygon', coordinates: [square(-70, 43, 0.1), square(-69, 43, 0.1)] }),
    ).toHaveLength(2)
  })

  it('degrades to "no land" on malformed input rather than throwing', () => {
    // Land data arrives from the network and from user imports.
    for (const junk of [null, undefined, 42, 'nope', {}, [], { type: 'Polygon' }, { type: 'Polygon', coordinates: 'x' }]) {
      expect(extractPolygons(junk)).toEqual([])
    }
  })
})

describe('PolygonLandMask', () => {
  const mask = new PolygonLandMask(extractPolygons({ type: 'Polygon', coordinates: square(-69.6, 43.4, 0.2) }))

  it('knows inside from outside', () => {
    expect(mask.isLand(43.5, -69.5)).toBe(true)
    expect(mask.isLand(43.5, -69.9)).toBe(false)
    expect(mask.isLand(43.9, -69.5)).toBe(false)
  })

  it('reads a hole as water', () => {
    // Ring 0 is the boundary, further rings are lakes — a point in a lake crosses
    // one extra boundary and so reads as outside.
    const donut = new PolygonLandMask([
      [square(-69.8, 43.2, 0.6)[0], square(-69.6, 43.4, 0.2)[0]],
    ])
    expect(donut.isLand(43.3, -69.7)).toBe(true) // in the ring of land
    expect(donut.isLand(43.5, -69.5)).toBe(false) // in the lake
  })

  it('blocks a segment straight through the island', () => {
    expect(mask.crosses({ lat: 43.5, lon: -69.9 }, { lat: 43.5, lon: -69.1 })).toBe(true)
  })

  it('allows a segment that passes clear of it', () => {
    expect(mask.crosses({ lat: 43.9, lon: -69.9 }, { lat: 43.9, lon: -69.1 })).toBe(false)
  })

  it('blocks a segment that merely starts or ends on land', () => {
    expect(mask.crosses({ lat: 43.5, lon: -69.5 }, { lat: 43.9, lon: -69.9 })).toBe(true)
    expect(mask.crosses({ lat: 43.9, lon: -69.9 }, { lat: 43.5, lon: -69.5 })).toBe(true)
  })

  it('reports how many polygons it holds', () => {
    expect(mask.polygonCount).toBe(1)
  })
})

describe('RasterLandMask', () => {
  it('reads out-of-range cells as open water', () => {
    const m = raster(10, 10, [[5, 5]])
    expect(m.cellIsLand(5, 5)).toBe(true)
    expect(m.cellIsLand(-1, 5)).toBe(false)
    expect(m.cellIsLand(10, 5)).toBe(false)
    expect(m.cellIsLand(5, 10)).toBe(false)
  })

  it('maps a position to the cell containing it', () => {
    const m = raster(10, 10, [[5, 5]])
    const c = cellCentre(10, 10, 5, 5)
    expect(m.isLand(c.lat, c.lon)).toBe(true)
    // One cell west is water.
    const w = cellCentre(10, 10, 4, 5)
    expect(m.isLand(w.lat, w.lon)).toBe(false)
    // Outside the box entirely.
    expect(m.isLand(50, -69.5)).toBe(false)
    expect(m.isLand(43.5, -80)).toBe(false)
  })

  it('checks both endpoint cells, not just the path between them', () => {
    const m = raster(10, 10, [
      [0, 0],
      [9, 9],
    ])
    const start = cellCentre(10, 10, 0, 0)
    const end = cellCentre(10, 10, 9, 9)
    const water = cellCentre(10, 10, 4, 6)
    expect(m.crosses(start, water)).toBe(true)
    expect(m.crosses(water, end)).toBe(true)
  })

  it('walks a diagonal without leaking between cells', () => {
    // A diagonal wall: every step of the DDA must see one of these.
    const wall: Array<[number, number]> = Array.from({ length: 10 }, (_, i) => [i, i])
    const m = raster(10, 10, wall)
    expect(m.crosses(cellCentre(10, 10, 0, 9), cellCentre(10, 10, 9, 0))).toBe(true)
  })

  it('lets a clear segment through', () => {
    const m = raster(10, 10, [[5, 5]])
    // Along row 1, nowhere near the land cell in row 5.
    expect(m.crosses(cellCentre(10, 10, 0, 1), cellCentre(10, 10, 9, 1))).toBe(false)
  })

  it('rejects a segment wholly outside the box without walking', () => {
    const m = raster(10, 10, [[5, 5]])
    expect(m.crosses({ lat: 43.5, lon: -80 }, { lat: 43.5, lon: -75 })).toBe(false)
    expect(m.crosses({ lat: 50, lon: -69.5 }, { lat: 55, lon: -69.5 })).toBe(false)
    expect(m.crosses({ lat: 43.5, lon: -60 }, { lat: 43.5, lon: -55 })).toBe(false)
  })

  /*
   * The walk-budget cliff.
   *
   * The DDA was bounded by `nx + ny + 8` steps and returned `true` — "maybe land"
   * — on exhaustion. A segment starting outside the box spends budget getting
   * there, so a long enough approach reported land in water it never touched. On
   * the shipped Portland raster that threshold is about 1.3° (~80 nm), which is
   * inside the range of a single offshore leg, and it contradicted what
   * `landmask.ts` and the Route screen both promise about behaviour outside the box.
   *
   * The error was conservative — it blocks legal routes rather than allowing routes
   * over land — but "no legal move from the frontier" is a miserable way to find out.
   * The walk is now clipped to the raster box first, so the budget can never be the
   * deciding factor.
   */
  it('does not invent land on a long approach from outside the box', () => {
    const m = raster(10, 10, [[5, 5]])
    const lat = cellCentre(10, 10, 0, 1).lat
    for (const degreesOutside of [0.5, 2, 5, 40, 100]) {
      expect(
        m.crosses({ lat, lon: -70 - degreesOutside }, { lat, lon: -69 + degreesOutside }),
        `${degreesOutside}° outside`,
      ).toBe(false)
    }
  })

  it('still finds land on a long segment that really does cross it', () => {
    const m = raster(10, 10, [[5, 5]])
    const lat = cellCentre(10, 10, 5, 5).lat
    expect(m.crosses({ lat, lon: -100 }, { lat, lon: -40 })).toBe(true)
  })

  /*
   * The property that must never break, checked against brute force.
   *
   * Conservatism is allowed and expected: the raster is a superset of the true
   * coastline. A false *negative* is not, so this asserts one direction only.
   */
  it('never misses land that a dense sampling of the segment finds', () => {
    const nx = 16
    const ny = 16
    // A scattered archipelago, from a fixed pattern so the test is deterministic.
    const cells: Array<[number, number]> = []
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if ((i * 7 + j * 11) % 13 === 0) cells.push([i, j])
      }
    }
    const m = raster(nx, ny, cells)

    // Deterministic pseudo-random segments; no Math.random, so a failure is
    // reproducible.
    let seed = 12345
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    let checked = 0
    let conservative = 0
    for (let n = 0; n < 400; n++) {
      const a = { lat: 43 + rnd(), lon: -70 + rnd() }
      const b = { lat: 43 + rnd(), lon: -70 + rnd() }
      const declared = m.crosses(a, b)

      // Brute force: 3000 samples along the segment.
      let sampledLand = false
      for (let s = 0; s <= 3000 && !sampledLand; s++) {
        const f = s / 3000
        if (m.isLand(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f)) sampledLand = true
      }

      checked++
      if (sampledLand) {
        expect(declared, `segment ${n} touches land but crosses() said clear`).toBe(true)
      } else if (declared) {
        conservative++
      }
    }
    expect(checked).toBe(400)
    // Sanity: the test is exercising both answers, not trivially passing.
    expect(conservative).toBeLessThan(checked)
  })
})

describe('buildLandMask', () => {
  const geo = { type: 'Polygon', coordinates: square(-69.7, 43.3, 0.4) }

  it('rasterises land and keeps an exact stage behind it', () => {
    const m = buildLandMask(geo, BOX, 0.02)
    expect(m.isLand(43.5, -69.5)).toBe(true)
    expect(m.isLand(43.9, -69.9)).toBe(false)
    expect(m.crosses({ lat: 43.5, lon: -69.95 }, { lat: 43.5, lon: -69.05 })).toBe(true)
    expect(m.crosses({ lat: 43.95, lon: -69.95 }, { lat: 43.95, lon: -69.05 })).toBe(false)
  })

  it('dilates, so the raster is a superset of the polygon', () => {
    /*
     * What licenses the early accept: if no land cell is touched, the segment is
     * genuinely clear. A cell is filled from its centre, so a thin spit can slip
     * between two centres — the dilation covers that, at the cost of flagging a
     * ring of water cells around every coast, which the exact stage then rejects.
     */
    const m = buildLandMask(geo, BOX, 0.02)
    const justOutside = { lat: 43.3 - 0.015, lon: -69.5 }
    // The raster flags it...
    const ix = Math.floor((justOutside.lon - BOX.west) / m.dLon)
    const iy = Math.floor((justOutside.lat - BOX.south) / m.dLat)
    expect(m.cellIsLand(ix, iy)).toBe(true)
    // ...and the exact polygon stage overrules it, so `isLand` stays honest.
    expect(m.isLand(justOutside.lat, justOutside.lon)).toBe(false)
  })

  it('punches holes through, and does not cancel two overlapping islands', () => {
    const donut = {
      type: 'Polygon',
      coordinates: [square(-69.8, 43.2, 0.6)[0], square(-69.6, 43.4, 0.2)[0]],
    }
    const withHole = buildLandMask(donut, BOX, 0.01)
    expect(withHole.isLand(43.3, -69.7)).toBe(true)
    expect(withHole.isLand(43.5, -69.5)).toBe(false)

    // Two islands whose bounding boxes overlap must union, not xor.
    const two = {
      type: 'MultiPolygon',
      coordinates: [square(-69.7, 43.3, 0.3), square(-69.5, 43.4, 0.3)],
    }
    const union = buildLandMask(two, BOX, 0.01)
    expect(union.isLand(43.35, -69.65)).toBe(true)
    expect(union.isLand(43.45, -69.35)).toBe(true)
    expect(union.isLand(43.45, -69.45)).toBe(true) // the overlap itself
  })

  it('survives a bbox with no land in it', () => {
    const m = buildLandMask({ type: 'FeatureCollection', features: [] }, BOX, 0.05)
    expect(m.isLand(43.5, -69.5)).toBe(false)
    expect(m.crosses({ lat: 43.1, lon: -69.9 }, { lat: 43.9, lon: -69.1 })).toBe(false)
  })
})
