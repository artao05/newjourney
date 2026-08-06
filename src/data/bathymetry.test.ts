/**
 * Regression guard for the shipped venue depth grid.
 *
 * Same discipline as `landmask.test.ts`: the assertions that matter are the ones
 * anchored to coordinates whose nature is known independently of the data. The
 * four moored instruments in `venues.ts` are in the water by definition, so a
 * grid that reports no depth at any of them is packed wrong.
 *
 * The tests also pin the *disagreements* — with the land mask, and with NOAA's
 * published depth at buoy 44007. Those are documented properties of a 450 m
 * bathymetric model, and if one of them silently changes, the claim in the UI
 * about what this layer can and cannot do has changed with it.
 *
 * Reads the binary from `public/` directly rather than through `fetch`, so this
 * runs in plain Node.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeScalarField, timeIndices } from '@/lib/maplayers/glutil'
import {
  DEPTH_MISSING,
  DEPTH_PARAM,
  PORTLAND_DEPTH_GRID,
  depthAt,
  depthRenderCube,
  expectedDepthBytes,
  waterFractionOf,
  type LoadedDepthGrid,
} from './bathymetry'
import { PORTLAND_LAND_MASK } from './landmask'
import { PILOT_VENUE } from './venues'

const meta = PORTLAND_DEPTH_GRID

function loadGrid(): { grid: LoadedDepthGrid; byteLength: number } {
  const path = join(process.cwd(), 'public', 'venue', 'portland-depth.bin')
  const buf = readFileSync(path)
  // Copy into a correctly aligned standalone buffer; a Node Buffer is a view into
  // a shared pool and its byteOffset is not guaranteed to be 2-aligned.
  const bytes = new Uint8Array(buf.byteLength)
  bytes.set(buf)
  return {
    grid: { meta, elevDm: new Int16Array(bytes.buffer) },
    byteLength: buf.byteLength,
  }
}

describe('Portland depth grid', () => {
  const { grid, byteLength } = loadGrid()

  it('is exactly the size its metadata implies', () => {
    expect(byteLength).toBe(expectedDepthBytes(meta))
    expect(grid.elevDm.length).toBe(meta.nx * meta.ny)
  })

  it('matches the recorded water fraction', () => {
    expect(waterFractionOf(grid.elevDm)).toBeCloseTo(meta.waterFraction, 3)
  })

  it('is neither all land nor all water', () => {
    // The two ways the build could fail silently: an all-fill grid, or one whose
    // rows landed transposed and so read as uniform.
    const frac = waterFractionOf(grid.elevDm)
    expect(frac).toBeGreaterThan(0.2)
    expect(frac).toBeLessThan(0.8)
  })

  it('has no missing cells and stays inside the Int16 decimetre range', () => {
    let missing = 0
    let deepest = 0
    let highest = 0
    for (const v of grid.elevDm) {
      if (v === DEPTH_MISSING) missing++
      if (v < deepest) deepest = v
      if (v > highest) highest = v
    }
    expect(missing).toBe(0)
    // Measured extremes: 180 m of water in the south-east corner, 205 m of hill
    // inland. Both an order of magnitude clear of the ±3276.7 m encoding limit.
    expect(-deepest / 10).toBeCloseTo(180, 0)
    expect(highest / 10).toBeCloseTo(205, 0)
  })

  describe('water by definition — moored instruments', () => {
    // Bilinear depths, so they differ a little from the nearest-cell figures the
    // build script prints; pinned to the metre only to catch a re-pack that
    // shifts the grid.
    const afloat: Array<[string, number, number, number]> = [
      ['NOAA tide station 8418150 Portland', 43.6583, -70.2433, 10.0],
      ['NOAA current station Portland Harbor Entrance', 43.628, -70.2095, 14.4],
      ['NDBC buoy 44007 East Hue and Cry Rock', 43.525, -70.14, 31.2],
      ['NDBC buoy 44031 Casco Bay', 43.57, -70.06, 39.3],
    ]
    for (const [label, lat, lon, want] of afloat) {
      it(`${label} has water under it`, () => {
        const d = depthAt(grid, lat, lon)
        expect(d).not.toBeNull()
        expect(d as number).toBeGreaterThan(1)
        expect(d as number).toBeCloseTo(want, 0)
      })
    }

    it('venue waterStart has water under it', () => {
      const d = depthAt(grid, PILOT_VENUE.waterStart.lat, PILOT_VENUE.waterStart.lon)
      expect(d).not.toBeNull()
      expect(d as number).toBeGreaterThan(5)
    })
  })

  describe('land by definition — inland places', () => {
    const ashore: Array<[string, number, number]> = [
      ['downtown Portland', 43.6591, -70.2568],
      ['Westbrook', 43.677, -70.3712],
      ['inland north-west of the venue', 43.93, -70.5],
    ]
    for (const [label, lat, lon] of ashore) {
      it(`${label} has no depth`, () => {
        // Null, never 0: a zero would render and read as "awash", which is a
        // depth claim. Land is the absence of one.
        expect(depthAt(grid, lat, lon)).toBeNull()
      })
    }
  })

  it('returns null outside its own box', () => {
    expect(depthAt(grid, 40.0, -60.0)).toBeNull()
    expect(depthAt(grid, meta.bbox.south - 0.1, PILOT_VENUE.center.lon)).toBeNull()
    expect(depthAt(grid, PILOT_VENUE.center.lat, meta.bbox.east + 0.1)).toBeNull()
  })

  it('resolves the last cell inside its box, and stops half a cell outside', () => {
    /*
     * `bbox` is the extent of the cell *centres*, so the edge cells are only half
     * covered — and a half-cell indexing slip shows up here as a null on the
     * corner or a depth well beyond it.
     *
     * The south-east corner is the one corner of the four that is water; the
     * other three are inland Maine and correctly have no depth at all.
     */
    expect(depthAt(grid, meta.bbox.south, meta.bbox.east)).toBeCloseTo(146, 0)
    expect(depthAt(grid, meta.bbox.south - meta.cellDeg * 0.4, meta.bbox.east)).toBeCloseTo(146, 0)
    expect(depthAt(grid, meta.bbox.south - meta.cellDeg * 1.1, meta.bbox.east)).toBeNull()
  })

  it('deepens offshore', () => {
    // Orientation check with real teeth: a transposed or north-flipped grid
    // fails this, while byte-length and water-fraction tests would still pass.
    const harbour = depthAt(grid, 43.64, -70.22) as number
    const midBay = depthAt(grid, 43.56, -70.12) as number
    const offshore = depthAt(grid, 43.42, -69.9) as number
    expect(harbour).toBeLessThan(midBay)
    expect(midBay).toBeLessThan(offshore)
    expect(offshore).toBeGreaterThan(100)
  })

  /*
   * The documented limits, asserted rather than asserted-in-prose.
   *
   * Both of these are the reason the UI says "not a depth check", and both are
   * facts about the data rather than about our code — so if either stops being
   * true, the wording has to be revisited.
   */
  describe('documented limits', () => {
    it('is 18 m shallower than NOAA at buoy 44007', () => {
      // NDBC publishes a 49 m water depth for 44007, at a position known to a
      // metre. GEBCO reads 31 m. A 450 m model is not a survey.
      const d = depthAt(grid, 43.525, -70.14) as number
      expect(49 - d).toBeGreaterThan(10)
    })

    it('misses the small island the land mask resolves at the venue centre', () => {
      // The venue centre is real land at 111 m and 10 m of water at 450 m.
      // Anything narrower than a cell — ledges, rocks, jetties — is not in here.
      const d = depthAt(grid, PILOT_VENUE.center.lat, PILOT_VENUE.center.lon)
      expect(d).not.toBeNull()
    })

    it('covers the same box as the land mask, to within half a cell', () => {
      const l = PORTLAND_LAND_MASK.bbox
      const half = meta.cellDeg / 2 + 1e-9
      expect(Math.abs(meta.bbox.west - l.west)).toBeLessThanOrEqual(half)
      expect(Math.abs(meta.bbox.south - l.south)).toBeLessThanOrEqual(half)
      expect(Math.abs(meta.bbox.east - l.east)).toBeLessThanOrEqual(half)
      expect(Math.abs(meta.bbox.north - l.north)).toBeLessThanOrEqual(half)
    })

    it('agrees with the land mask on how much of the box is water', () => {
      // Two independent derivations — GEBCO soundings and an OSM coastline flood
      // fill — landing within two points of each other is the best cross-check
      // available for either asset.
      const gebcoWater = waterFractionOf(grid.elevDm)
      const osmWater = 1 - PORTLAND_LAND_MASK.landFraction
      expect(Math.abs(gebcoWater - osmWater)).toBeLessThan(0.02)
    })
  })

  describe('render cube', () => {
    const cube = depthRenderCube(grid)

    it('is a single static step over the grid extent', () => {
      expect(cube.nt).toBe(1)
      expect(cube.params).toEqual([DEPTH_PARAM])
      expect(cube.nx).toBe(meta.nx)
      expect(cube.ny).toBe(meta.ny)
      expect(cube.bbox).toEqual(meta.bbox)
      expect(cube.dx).toBeCloseTo(meta.cellDeg, 12)
    })

    it('carries depth in metres positive-down, with land as a hole', () => {
      const field = cube.data[DEPTH_PARAM]
      expect(field.length).toBe(meta.nx * meta.ny)
      const at = (lat: number, lon: number) => {
        const i = Math.round((lon - meta.bbox.west) / meta.cellDeg)
        const j = Math.round((lat - meta.bbox.south) / meta.cellDeg)
        return field[j * meta.nx + i]
      }
      expect(at(43.57, -70.06)).toBeCloseTo(39, 0)
      // A hole must stay a hole: NaN over land, never a 0 the ramp would paint.
      expect(Number.isNaN(at(43.6591, -70.2568))).toBe(true)
      for (const v of field) {
        if (Number.isNaN(v)) continue
        expect(v).toBeGreaterThan(0)
      }
    })

    /*
     * The two ways a correct grid still draws nothing, neither of which any test
     * above would catch and neither of which is visible without a GPU.
     */
    it('survives the clock: a one-step cube pins to its only step', () => {
      // If `timeIndices` did not short-circuit on nt <= 1, a real clock time would
      // index past the single step and the layer would sample nothing all day.
      const now = Date.UTC(2026, 7, 5, 12)
      expect(timeIndices(cube.t0, cube.dtMs, cube.nt, now)).toEqual({ i0: 0, i1: 0, frac: 0 })
    })

    it('encodes to a texture with water covered and land masked out', () => {
      const enc = encodeScalarField(cube.data[DEPTH_PARAM], cube.nx, cube.ny, 0)
      expect(enc.width).toBe(meta.nx)
      expect(enc.height).toBe(meta.ny)
      expect(enc.min).toBeGreaterThanOrEqual(0)
      expect(enc.max).toBeCloseTo(180, 0)

      const alphaAt = (lat: number, lon: number) => {
        const i = Math.round((lon - meta.bbox.west) / meta.cellDeg)
        const j = Math.round((lat - meta.bbox.south) / meta.cellDeg)
        return enc.data[(j * meta.nx + i) * 4 + 3]
      }
      // The fragment shader discards below 0.5 alpha, so these two numbers are the
      // difference between a depth wash over the bay and one over the whole state.
      expect(alphaAt(43.57, -70.06)).toBe(255)
      expect(alphaAt(43.6591, -70.2568)).toBe(0)

      let covered = 0
      for (let i = 3; i < enc.data.length; i += 4) if (enc.data[i] > 0) covered++
      expect(covered / (meta.nx * meta.ny)).toBeCloseTo(meta.waterFraction, 3)
    })
  })
})
