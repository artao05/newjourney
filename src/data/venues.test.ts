/**
 * The venue manifest, and the constants that have to agree with it.
 *
 * `venues.ts` had no test. Most of it is declarative and a test would only
 * restate it, which is worth nothing — so this file deliberately tests almost
 * none of its contents. What it tests is the **couplings**: values that are
 * written down twice, in two files, and are wrong the moment they disagree.
 *
 * There are four, and three of them are held together by nothing but a comment.
 * `src/lib` never imports `src/data` — a layering rule worth keeping, since the
 * routing and tide maths should not know what a venue is — so the second copy
 * cannot simply be deleted. The copy is the price of the layering, and this is
 * the thing that makes the price safe to pay.
 *
 * A duplicated measurement is not a style problem. It is a measurement that can
 * drift, and the copy nobody remembers is always the one that stays wrong.
 */

import { describe, expect, it } from 'vitest'
import { PILOT_VENUE } from './venues'
import { DEPTH_MISSING, PORTLAND_DEPTH_GRID, PORTLAND_MSL_ABOVE_MLLW_M } from './bathymetry'
import { POLAR_LIBRARY, findPolar } from './polars'
import { PORTLAND_DATUM } from '@/lib/tides/datum'
import { MISSING } from '@/lib/weather/cube'
import { useStore } from '@/state/store'

describe('constants that live in two files', () => {
  it('corrects depths against the station the app actually queries', () => {
    /*
     * `RouteScreen` fetches predictions with `PORTLAND_DATUM.stationId` and
     * corrects them with `PORTLAND_DATUM.mslAboveMllwM`, so those two are
     * self-consistent by construction. The venue manifest names a tide station
     * separately, and nothing tied the two together — not even a comment.
     *
     * The failure is silent and physical: predictions from one station corrected
     * by another station's MSL-to-MLLW gap. Along this coast that gap varies by
     * more than a metre between stations, which is most of the water a keelboat
     * has under it at low tide in Casco Bay.
     */
    const ids = PILOT_VENUE.tideStations.map((s) => s.id)
    expect(ids).toContain(PORTLAND_DATUM.stationId)
    expect(PILOT_VENUE.tideStations[0].id).toBe(PORTLAND_DATUM.stationId)
  })

  it('quotes one datum offset, not two', () => {
    // `datum.ts` says "Mirrors PORTLAND_MSL_ABOVE_MLLW_M in bathymetry.ts". This
    // is what makes that sentence true. The Weather screen captions the depth
    // layer from the bathymetry copy; the route advisory corrects with the tides
    // copy. Drift shows a sailor two different numbers for the same water.
    expect(PORTLAND_DATUM.mslAboveMllwM).toBe(PORTLAND_MSL_ABOVE_MLLW_M)
  })

  it('keeps the offset consistent with the published figures it cites', () => {
    // 13.49 ft MSL - 8.55 ft MLLW = 4.94 ft, stated to the centimetre. Pinned
    // because the comment does the arithmetic and comments do not run.
    const ft = 13.49 - 8.55
    expect(PORTLAND_MSL_ABOVE_MLLW_M).toBeCloseTo(Math.round(ft * 0.3048 * 100) / 100, 10)
  })

  it('uses one missing-data sentinel across the depth grid and the cube', () => {
    // bathymetry.ts: "Int16 sentinel for a cell GEBCO has no value for. Matches
    // the cube's MISSING."
    expect(DEPTH_MISSING).toBe(MISSING)
    // And it must be a value no real reading can reach, or a real depth would
    // decode as a hole: -32768 is the Int16 floor, so nothing can collide with it.
    expect(DEPTH_MISSING).toBe(-32768)
  })

  it('ships a default boat whose length matches the polar it names', () => {
    /*
     * The store's default boat is a J/70 by `className` and by `polarId`, and
     * repeats the length as a number. Boat length is not decoration: the start
     * line reports distance below the line in boat lengths, so a stale copy
     * misreports the one number a helm reads in the last ten seconds.
     */
    const boat = useStore.getState().boat
    const polar = findPolar(useStore.getState().polarId)
    expect(polar, 'the default polarId must exist in the library').toBeDefined()
    expect(boat.className).toBe(polar!.name)
    expect(boat.loaMetres).toBeCloseTo(polar!.loaM, 10)
  })
})

describe('the manifest is internally coherent', () => {
  it('has a bbox that is the right way round', () => {
    const b = PILOT_VENUE.bbox
    expect(b.west).toBeLessThan(b.east)
    expect(b.south).toBeLessThan(b.north)
  })

  const inside = (p: { lat: number; lon: number }, b: typeof PILOT_VENUE.bbox): boolean =>
    p.lon >= b.west && p.lon <= b.east && p.lat >= b.south && p.lat <= b.north

  it('puts its centre and its default start position inside its own box', () => {
    expect(inside(PILOT_VENUE.center, PILOT_VENUE.bbox)).toBe(true)
    expect(inside(PILOT_VENUE.waterStart, PILOT_VENUE.bbox)).toBe(true)
  })

  it('places every station inside the bathymetry grid that has to resolve it', () => {
    /*
     * Not the venue bbox: observation buoys are legitimately outside it, and
     * 44007 sits about half a kilometre south of the box's edge. The grid is the
     * constraint that actually bites, because `bathymetry.test.ts` asserts each
     * moored station reads as water, and a station outside the grid returns null
     * rather than failing loudly.
     */
    const g = PORTLAND_DEPTH_GRID.bbox
    for (const s of [
      ...PILOT_VENUE.tideStations,
      ...PILOT_VENUE.currentStations,
      ...PILOT_VENUE.observationStations,
    ]) {
      expect(inside(s.position, g), `${s.id} ${s.name}`).toBe(true)
    }
  })

  it('gives every station and source a distinct id', () => {
    const ids = [
      ...PILOT_VENUE.tideStations,
      ...PILOT_VENUE.currentStations,
      ...PILOT_VENUE.observationStations,
    ].map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every polar in the library a distinct id, since setup persists it', () => {
    const ids = POLAR_LIBRARY.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    // A persisted id that no longer resolves would silently fall back, so every
    // one has to be findable by the same lookup Setup uses.
    for (const id of ids) expect(findPolar(id), id).toBeDefined()
  })
})
