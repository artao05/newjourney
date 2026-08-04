/**
 * Regression guard for the shipped venue land mask.
 *
 * The important assertions here are the ones checked against coordinates that
 * are water *by definition*: the NOAA tide station, the NOAA current station and
 * both NDBC buoys in `venues.ts` are instruments physically moored in the water.
 * A mask that calls any of them land is wrong, and no amount of "it looked right
 * on the map" argues otherwise.
 *
 * Reads the binary from `public/` directly rather than through `fetch`, so this
 * runs in plain Node.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RasterLandMask } from '@/lib/routing/land'
import { PORTLAND_LAND_MASK, expectedBytes, landFractionOf } from './landmask'
import { PILOT_VENUE } from './venues'

const meta = PORTLAND_LAND_MASK

function loadMask() {
  const path = join(process.cwd(), 'public', 'venue', 'portland-land.bin')
  const buf = readFileSync(path)
  // Copy into a correctly aligned standalone buffer; a Node Buffer is a view
  // into a shared pool and its byteOffset is not guaranteed to be 4-aligned.
  const bytes = new Uint8Array(buf.byteLength)
  bytes.set(buf)
  const bits = new Uint32Array(bytes.buffer)
  return {
    bits,
    mask: new RasterLandMask(meta.bbox, meta.nx, meta.ny, bits),
    byteLength: buf.byteLength,
  }
}

describe('Portland land mask', () => {
  const { bits, mask, byteLength } = loadMask()

  it('is exactly the size its metadata implies', () => {
    // A short file would read as open water past the truncation point, which is
    // the most dangerous way this asset could fail.
    expect(byteLength).toBe(expectedBytes(meta))
    expect(bits.length).toBe(Math.ceil((meta.nx * meta.ny) / 32))
  })

  it('matches the recorded land fraction', () => {
    expect(landFractionOf(bits, meta.nx, meta.ny)).toBeCloseTo(meta.landFraction, 3)
  })

  it('is neither all land nor all water', () => {
    // Guards the two ways the build script could fail silently: a flood fill
    // that escaped everywhere, or one that never started.
    const frac = landFractionOf(bits, meta.nx, meta.ny)
    expect(frac).toBeGreaterThan(0.2)
    expect(frac).toBeLessThan(0.85)
  })

  describe('water by definition — moored instruments', () => {
    const afloat: Array<[string, number, number]> = [
      ['NOAA tide station 8418150 Portland', 43.6583, -70.2433],
      ['NOAA current station Portland Harbor Entrance', 43.628, -70.2095],
      ['NDBC buoy 44007 East Hue and Cry Rock', 43.525, -70.14],
      ['NDBC buoy 44031 Casco Bay', 43.57, -70.06],
    ]
    for (const [label, lat, lon] of afloat) {
      it(`${label} is water`, () => {
        expect(mask.isLand(lat, lon)).toBe(false)
      })
    }

    it('covers every station listed for the pilot venue', () => {
      // Catches a station being added to venues.ts that the mask box excludes.
      const inBox = (lat: number, lon: number) =>
        lat >= meta.bbox.south &&
        lat <= meta.bbox.north &&
        lon >= meta.bbox.west &&
        lon <= meta.bbox.east
      expect(inBox(PILOT_VENUE.center.lat, PILOT_VENUE.center.lon)).toBe(true)
    })

    /*
     * The venue's simulator start must be afloat, and this is the test that keeps
     * it that way. It was originally `center`, which sits on a small island — so
     * the simulated boat began on land and every land-avoided route from it died
     * with "no legal move from the frontier". A map centre and a start position
     * are different requirements; only one of them has to be navigable.
     */
    it('venue waterStart is afloat', () => {
      expect(mask.isLand(PILOT_VENUE.waterStart.lat, PILOT_VENUE.waterStart.lon)).toBe(false)
    })

    it('venue waterStart has sea room in every direction', () => {
      // A start wedged one cell off a beach is technically afloat and useless.
      const { lat, lon } = PILOT_VENUE.waterStart
      const d = 0.004 // ~450 m
      for (const [dLat, dLon] of [
        [d, 0],
        [-d, 0],
        [0, d],
        [0, -d],
      ]) {
        expect(mask.isLand(lat + dLat, lon + dLon)).toBe(false)
      }
    })
  })

  describe('land by definition — inland places', () => {
    const ashore: Array<[string, number, number]> = [
      ['downtown Portland', 43.6591, -70.2568],
      ['Westbrook', 43.677, -70.3712],
      ['inland north-west of the venue', 43.93, -70.5],
    ]
    for (const [label, lat, lon] of ashore) {
      it(`${label} is land`, () => {
        expect(mask.isLand(lat, lon)).toBe(true)
      })
    }
  })

  it('reports open water outside its own box', () => {
    // Documented behaviour: the mask makes no claim beyond the venue, so callers
    // must not read "not land" as "safe" out there.
    expect(mask.isLand(40.0, -60.0)).toBe(false)
  })

  /*
   * The strongest available test of "test the segment, not the endpoints".
   *
   * Both of these are NOAA stations, so both are water by definition — and the
   * straight line between them still crosses the Portland peninsula. An
   * endpoint-only land check passes this happily and routes a boat overland,
   * which is precisely the bug `crosses` exists to prevent.
   */
  it('blocks a straight line between two water stations that crosses land', () => {
    const tideGauge = { lat: 43.6583, lon: -70.2433 }
    const harbourEntrance = { lat: 43.628, lon: -70.2095 }
    expect(mask.isLand(tideGauge.lat, tideGauge.lon)).toBe(false)
    expect(mask.isLand(harbourEntrance.lat, harbourEntrance.lon)).toBe(false)
    expect(mask.crosses(tideGauge, harbourEntrance)).toBe(true)
  })

  it('allows a clear offshore run into the harbour entrance', () => {
    // Casco Bay buoy to the harbour entrance station: verified clear along its
    // whole length. If this ever fails the mask has become too conservative to
    // route with, which is just as broken as being too permissive.
    const cascoBuoy = { lat: 43.57, lon: -70.06 }
    const harbourEntrance = { lat: 43.628, lon: -70.2095 }
    expect(mask.crosses(cascoBuoy, harbourEntrance)).toBe(false)
  })

  it('allows a clear run between the two offshore buoys', () => {
    expect(mask.crosses({ lat: 43.525, lon: -70.14 }, { lat: 43.57, lon: -70.06 })).toBe(false)
  })
})
