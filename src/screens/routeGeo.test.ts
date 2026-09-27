/**
 * Beat-segment extraction: the dashed overlay on the route map.
 *
 * `isBeating` on leg i means the segment FROM leg[i] TO leg[i+1] is a beat.
 * The LineString for a contiguous beat run must include the terminal endpoint
 * (the first non-beating position after the run), otherwise the last tacking
 * segment disappears from the map.
 */

import { describe, expect, it } from 'vitest'
import { angdiff, wrap360 } from '@/lib/angles'
import { uvFromWind } from '@/lib/weather/cube'
import type { WeatherCube } from '@/lib/types'
import { extractBeatSegments, windFC } from './RouteScreen'

const leg = (lon: number, lat: number, isBeating: boolean) => ({
  position: { lon, lat },
  isBeating,
})

describe('extractBeatSegments', () => {
  it('returns [] for all-free-sailing legs', () => {
    const legs = [leg(0, 0, false), leg(1, 1, false), leg(2, 2, false)]
    expect(extractBeatSegments(legs)).toEqual([])
  })

  it('returns [] for an empty array', () => {
    expect(extractBeatSegments([])).toEqual([])
  })

  it('includes the terminal endpoint of a beat run', () => {
    // legs 0-2 are beating, leg 3 is free sailing.
    // Segments 0→1, 1→2, 2→3 are beats. The line must be [pos0, pos1, pos2, pos3].
    const legs = [leg(0, 0, true), leg(1, 1, true), leg(2, 2, true), leg(3, 3, false)]
    const segs = extractBeatSegments(legs)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3], // terminal endpoint — must be present
    ])
  })

  it('handles a single beating leg followed by free sailing', () => {
    // Leg 0 is beating → segment 0→1 is a beat. Line must be [pos0, pos1].
    const legs = [leg(0, 0, true), leg(1, 1, false)]
    const segs = extractBeatSegments(legs)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual([
      [0, 0],
      [1, 1],
    ])
  })

  it('handles two disjoint beat runs', () => {
    const legs = [
      leg(0, 0, true),  // beat 0→1
      leg(1, 1, false), // free 1→2
      leg(2, 2, true),  // beat 2→3
      leg(3, 3, true),  // beat 3→4
      leg(4, 4, false), // free 4→5
      leg(5, 5, false),
    ]
    const segs = extractBeatSegments(legs)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual([[0, 0], [1, 1]])
    expect(segs[1]).toEqual([[2, 2], [3, 3], [4, 4]])
  })

  it('handles route ending while still beating', () => {
    // All legs beat, no trailing non-beating leg. Last leg has isBeating from
    // P.beat[here] and distanceNm=0, so no terminal to add.
    const legs = [leg(0, 0, true), leg(1, 1, true), leg(2, 2, true)]
    const segs = extractBeatSegments(legs)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual([[0, 0], [1, 1], [2, 2]])
  })

  it('dead-upwind pattern: all legs beating except last', () => {
    // Matches isochrone test §10.2: legs.slice(0, -1).every(l => l.isBeating)
    const legs = [
      leg(-70, 40, true),
      leg(-70, 41, true),
      leg(-70, 42, true),
      leg(-70, 43, false), // final arrival
    ]
    const segs = extractBeatSegments(legs)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toHaveLength(4) // must include the arrival point
    expect(segs[0][3]).toEqual([-70, 43])
  })
})

/**
 * The route map's wind arrows.
 *
 * They are the only picture of the wind on the Route tab, drawn under a route
 * that may leave hours after the forecast was downloaded. The arrows must show
 * the wind at the time asked for, interpolated the way the router's `CubeField`
 * interpolates it, and nothing at all for a time the forecast does not cover.
 */
describe('windFC', () => {
  const T0 = Date.UTC(2026, 8, 26, 12)
  const HOUR = 3_600_000

  /** A uniform 3x3 field, two hours long, blowing FROM `fromDeg[k]` in hour k. */
  function windCube(fromDeg: [number, number], kn = 12): WeatherCube {
    const nx = 3
    const ny = 3
    const nt = 2
    const u = new Float32Array(nt * ny * nx)
    const v = new Float32Array(nt * ny * nx)
    for (let k = 0; k < nt; k++) {
      const w = uvFromWind(kn, fromDeg[k])
      u.fill(w.u, k * ny * nx, (k + 1) * ny * nx)
      v.fill(w.v, k * ny * nx, (k + 1) * ny * nx)
    }
    return {
      model: 'test',
      run: 'test-run',
      bbox: { west: -70.3, south: 43.6, east: -70.1, north: 43.7 },
      nx,
      ny,
      dx: 0.1,
      dy: 0.05,
      t0: T0,
      dtMs: HOUR,
      nt,
      params: ['u10', 'v10'],
      data: { u10: u, v10: v },
    }
  }

  const arrows = (c: WeatherCube, t: number) =>
    windFC(c, t).features.map((f) => f.properties as { rot: number; kn: number })

  /** Each arrow's bearing, as the direction the wind blows TOWARD. */
  const toward = (c: WeatherCube, t: number) => arrows(c, t).map((a) => wrap360(a.rot))

  it('draws the hour it is asked for, not the first hour of the cube', () => {
    // Northerly at the download hour, easterly an hour later.
    const c = windCube([0, 90])
    const later = toward(c, T0 + HOUR)
    expect(later).toHaveLength(9)
    // FROM 090 blows TOWARD 270.
    for (const b of later) expect(Math.abs(angdiff(b, 270))).toBeLessThan(1e-4)
    // And the first hour is still drawn as itself: FROM 000 blows TOWARD 180.
    for (const b of toward(c, T0)) expect(Math.abs(angdiff(b, 180))).toBeLessThan(1e-4)
  })

  it('interpolates between hours in u/v, as the router does', () => {
    // Halfway from FROM 000 to FROM 090 at equal speed is FROM 045 at 12 cos 45°,
    // not a 12 kn wind swung through 45°.
    const mid = arrows(windCube([0, 90]), T0 + HOUR / 2)
    expect(mid).toHaveLength(9)
    for (const a of mid) {
      expect(Math.abs(angdiff(wrap360(a.rot), 225))).toBeLessThan(1e-4)
      expect(a.kn).toBeCloseTo(12 * Math.SQRT1_2, 1)
    }
  })

  it('draws nothing outside the forecast rather than the nearest hour', () => {
    const c = windCube([0, 90])
    expect(windFC(c, T0 + 3 * HOUR).features).toHaveLength(0)
    expect(windFC(c, T0 - HOUR).features).toHaveLength(0)
  })

  it('leaves a missing forecast hour empty instead of borrowing its neighbour', () => {
    // Hour 1 lost: halfway through it the router has no wind, so neither does
    // the chart. Drawing hour 0 there would show a wind nobody forecast.
    const c = windCube([0, 90])
    c.data.u10.fill(Number.NaN, 9, 18)
    expect(windFC(c, T0 + HOUR / 2).features).toHaveLength(0)
    // The intact hour still draws.
    expect(windFC(c, T0).features).toHaveLength(9)
  })
})
