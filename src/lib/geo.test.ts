/**
 * Spherical geodesy.
 *
 * The other half of the foundation, and like `angles.ts` it had no direct tests
 * — every assertion about it was incidental, via the routing and start-line
 * suites. The anchors used here are definitional where possible (a degree of
 * latitude is 60 nm by definition, so no reference implementation is needed to
 * check it) and the venue's own NOAA station coordinates otherwise.
 *
 * The `LocalFrame` block is the one that earns its keep: it pins the measured
 * error table in that class's docstring, which replaced a claim that was only
 * true along a meridian.
 */

import { describe, expect, it } from 'vitest'
import { angsep } from './angles'
import {
  LocalFrame,
  R_NM,
  alongTrack,
  bboxOf,
  bearing,
  crossTrack,
  destination,
  distance,
  fromPolar,
  midpoint,
  mToNm,
  nmToM,
  rayIntersect,
  rhumbBearing,
  rhumbDistance,
  segmentsIntersect,
  signedDistanceToLine,
  vecBearing,
  vecLen,
} from './geo'
import type { LatLon } from './types'

const P = (lat: number, lon: number): LatLon => ({ lat, lon })

/** Venue anchors, both NOAA stations, both from `venues.ts`. */
const TIDE_GAUGE = P(43.6583, -70.2433)
const HARBOUR_ENTRANCE = P(43.628, -70.2095)

describe('distance', () => {
  /*
   * A nautical mile is a minute of arc, so a degree of latitude "should" be
   * exactly 60 nm — and here it is 60.0405, because `R_NM` is 3440.065 (the mean
   * Earth radius, 6371 km) rather than 3437.747 (the radius for which one minute
   * of arc *is* one nautical mile). Every distance in the app therefore runs
   * 0.0674% long: 12.5 m on a 10 nm leg, 0.67 nm on a 1000 nm passage.
   *
   * Pinned rather than corrected. It is tactically irrelevant — well inside a GPS
   * fix and far inside polar uncertainty — but it is a real inconsistency with the
   * "1 minute = 1 mile" model a sailor reads a chart with, and changing the radius
   * would shift every expectation in the routing suite. Recorded as a decision to
   * revisit in docs/05-spec/improvement-plan.md rather than changed in passing.
   */
  const NM_PER_DEGREE = 60.0405

  it('makes a degree of latitude 60.04 nm — the radius choice, not a bug', () => {
    expect(distance(P(0, 0), P(1, 0))).toBeCloseTo(NM_PER_DEGREE, 3)
    expect(distance(P(43, -70), P(44, -70))).toBeCloseTo(NM_PER_DEGREE, 3)
    expect(distance(P(-10, 30), P(-11, 30))).toBeCloseTo(NM_PER_DEGREE, 3)
    // Within 0.07% of the definitional 60, in the long direction.
    expect(distance(P(0, 0), P(1, 0)) / 60 - 1).toBeCloseTo(0.000674, 6)
  })

  it('shrinks a degree of longitude by the cosine of the latitude', () => {
    const atEquator = distance(P(0, 0), P(0, 1))
    const at60 = distance(P(60, 0), P(60, 1))
    expect(atEquator).toBeCloseTo(60, 1)
    expect(at60).toBeCloseTo(30, 1) // cos 60° = 0.5
  })

  it('is symmetric and zero for a point on itself', () => {
    expect(distance(TIDE_GAUGE, TIDE_GAUGE)).toBe(0)
    expect(distance(TIDE_GAUGE, HARBOUR_ENTRANCE)).toBeCloseTo(
      distance(HARBOUR_ENTRANCE, TIDE_GAUGE),
      12,
    )
  })

  it('takes the short way across the antimeridian', () => {
    // 0.2° of longitude at 43°N, not 359.8° the long way round.
    const short = distance(P(43, 179.9), P(43, -179.9))
    expect(short).toBeCloseTo(distance(P(43, 0.1), P(43, -0.1)), 6)
    expect(short).toBeLessThan(10)
  })

  it('gives half the circumference for antipodes', () => {
    expect(distance(P(0, 0), P(0, 180))).toBeCloseTo(Math.PI * R_NM, 1)
  })
})

describe('bearing', () => {
  it('reads the cardinal directions', () => {
    expect(bearing(P(0, 0), P(1, 0))).toBeCloseTo(0, 6) // north
    expect(bearing(P(0, 0), P(0, 1))).toBeCloseTo(90, 6) // east
    expect(bearing(P(1, 0), P(0, 0))).toBeCloseTo(180, 6) // south
    expect(bearing(P(0, 1), P(0, 0))).toBeCloseTo(270, 6) // west
  })

  it('works across the antimeridian', () => {
    /*
     * Just *shy* of due east, not exactly 090: two points on the same parallel
     * are joined by a great circle that bulges poleward, so it sets off north of
     * east — 89.93 here, and the reason `rhumbBearing` exists beside this. Bounds
     * rather than a digit count, because the quantity being asserted is "a fraction
     * of a degree north of east", not a number of decimal places.
     */
    const eastbound = bearing(P(43, 179.9), P(43, -179.9))
    expect(eastbound).toBeGreaterThan(89.8)
    expect(eastbound).toBeLessThan(90)

    const westbound = bearing(P(43, -179.9), P(43, 179.9))
    expect(westbound).toBeGreaterThan(270)
    expect(westbound).toBeLessThan(270.2)
  })

  it('is a great-circle bearing, so the reciprocal is not simply +180', () => {
    // On a sphere the return bearing differs from the outbound by more than 180
    // unless you are on a meridian — the classic surprise for anyone expecting
    // rhumb behaviour. Small at venue scale, large across an ocean.
    const a = P(50, -60)
    const b = P(50, 0)
    const out = bearing(a, b)
    const back = bearing(b, a)
    expect(angsep(out, back)).toBeLessThan(180)
    expect(Math.abs(angsep(out, back) - 180)).toBeGreaterThan(1)
  })
})

describe('destination', () => {
  it('inverts bearing and distance', () => {
    for (const [brg, nm] of [
      [0, 10],
      [90, 5],
      [217, 33],
      [359, 1],
    ]) {
      const p = destination(TIDE_GAUGE, brg, nm)
      expect(distance(TIDE_GAUGE, p)).toBeCloseTo(nm, 6)
      expect(bearing(TIDE_GAUGE, p)).toBeCloseTo(brg, 4)
    }
  })

  it('does not move for a zero distance', () => {
    const p = destination(TIDE_GAUGE, 123, 0)
    expect(p.lat).toBeCloseTo(TIDE_GAUGE.lat, 12)
    expect(p.lon).toBeCloseTo(TIDE_GAUGE.lon, 12)
  })

  it('keeps longitude in (-180, 180] when it crosses the seam', () => {
    // 60 nm east of 179.5°E lands just past 180 and comes back as a negative
    // longitude — a hair past -179.5, since 60 nm is 60.0405 minutes of arc here.
    const p = destination(P(0, 179.5), 90, 60)
    expect(p.lon).toBeLessThanOrEqual(180)
    expect(p.lon).toBeGreaterThan(-180)
    expect(p.lon).toBeCloseTo(-179.5, 2)
  })
})

describe('midpoint', () => {
  it('lands halfway along the track', () => {
    const m = midpoint(TIDE_GAUGE, HARBOUR_ENTRANCE)
    const half = distance(TIDE_GAUGE, HARBOUR_ENTRANCE) / 2
    expect(distance(TIDE_GAUGE, m)).toBeCloseTo(half, 6)
    expect(distance(m, HARBOUR_ENTRANCE)).toBeCloseTo(half, 6)
  })
})

describe('crossTrack and alongTrack', () => {
  const a = P(43.6, -70.2)
  const b = P(43.7, -70.2) // due north

  it('signs cross-track positive to the right of the track', () => {
    // Heading north, so east is to starboard.
    expect(crossTrack(P(43.65, -70.15), a, b)).toBeGreaterThan(0)
    expect(crossTrack(P(43.65, -70.25), a, b)).toBeLessThan(0)
  })

  it('is zero on the track itself', () => {
    expect(crossTrack(P(43.65, -70.2), a, b)).toBeCloseTo(0, 6)
  })

  it('agrees in sign with signedDistanceToLine, which the whole codebase relies on', () => {
    /*
     * Both are documented as "positive to the right looking from a toward b".
     * If they ever disagree, cross-track error flips sign somewhere between the
     * chart and the start line, and nothing else would catch it.
     */
    const frame = new LocalFrame(a)
    for (const p of [P(43.65, -70.15), P(43.65, -70.25), P(43.62, -70.19)]) {
      const gc = crossTrack(p, a, b)
      const flat = signedDistanceToLine(frame.toXY(p), frame.toXY(a), frame.toXY(b))
      expect(Math.sign(gc)).toBe(Math.sign(flat))
      // Magnitudes agree to 0.2%: the residual is the flat frame's own diagonal
      // error, measured and tabulated in the LocalFrame block below. The sign is
      // the part that must be exact, because a flipped sign puts the boat on the
      // wrong side of the track.
      expect(Math.abs(gc)).toBeCloseTo(Math.abs(flat), 1)
      expect(Math.abs(Math.abs(gc) / Math.abs(flat) - 1)).toBeLessThan(0.002)
    }
  })

  it('measures along-track distance, negative behind the start', () => {
    const ahead = alongTrack(P(43.65, -70.2), a, b)
    expect(ahead).toBeCloseTo(distance(a, P(43.65, -70.2)), 4)
    expect(alongTrack(P(43.55, -70.2), a, b)).toBeLessThan(0)
  })
})

describe('rhumb lines', () => {
  it('matches the great circle along a meridian', () => {
    // North-south is the one case where the two agree exactly.
    expect(rhumbDistance(P(40, -70), P(45, -70))).toBeCloseTo(distance(P(40, -70), P(45, -70)), 3)
    expect(rhumbBearing(P(40, -70), P(45, -70))).toBeCloseTo(0, 6)
  })

  it('is never shorter than the great circle', () => {
    for (const [a, b] of [
      [P(43.6, -70.2), P(43.7, -70.1)],
      [P(50, -60), P(50, 0)],
      [P(10, 20), P(-30, 100)],
    ] as Array<[LatLon, LatLon]>) {
      expect(rhumbDistance(a, b)).toBeGreaterThanOrEqual(distance(a, b) - 1e-6)
    }
  })

  it('holds a constant bearing, unlike the great circle', () => {
    const a = P(50, -60)
    const b = P(50, 0)
    // Due east along a parallel: the rhumb bearing is exactly 090 the whole way,
    // while the great circle starts north of east.
    expect(rhumbBearing(a, b)).toBeCloseTo(90, 6)
    expect(bearing(a, b)).toBeLessThan(90)
  })
})

describe('LocalFrame', () => {
  const origin = P(43.6, -70.2)
  const frame = new LocalFrame(origin)

  it('round-trips a point through XY and back', () => {
    for (const p of [P(43.61, -70.19), P(43.55, -70.3), origin]) {
      const back = frame.toLatLon(frame.toXY(p))
      expect(back.lat).toBeCloseTo(p.lat, 9)
      expect(back.lon).toBeCloseTo(p.lon, 9)
    }
  })

  it('puts the origin at the centre, with x east and y north', () => {
    expect(frame.toXY(origin)).toEqual({ x: 0, y: 0 })
    expect(frame.toXY(P(43.7, -70.2)).y).toBeGreaterThan(0)
    expect(frame.toXY(P(43.6, -70.1)).x).toBeGreaterThan(0)
  })

  /*
   * The measured error table in the `LocalFrame` docstring.
   *
   * It replaced "accurate to well under a metre within ~20 nm", which was true
   * only along a meridian: longitude is scaled by `cos(origin.lat)` alone, so the
   * easting error grows with how far the point has moved in latitude. These bounds
   * are the measured values rounded up, so the table cannot quietly drift.
   */
  const errorMetres = (brg: number, nm: number): number => {
    const p = destination(origin, brg, nm)
    return Math.abs(vecLen(frame.toXY(p)) - nm) * 1852
  }

  it('is exact along a meridian', () => {
    for (const nm of [1, 5, 20]) {
      expect(errorMetres(0, nm)).toBeLessThan(1e-6)
      expect(errorMetres(180, nm)).toBeLessThan(1e-6)
    }
  })

  it('stays sub-metre due east out to 20 nm', () => {
    expect(errorMetres(90, 1)).toBeLessThan(0.01)
    expect(errorMetres(90, 5)).toBeLessThan(0.05)
    expect(errorMetres(90, 20)).toBeLessThan(0.5)
  })

  it('degrades on a diagonal, which is why the docstring now says so', () => {
    expect(errorMetres(45, 1)).toBeLessThan(0.2)
    expect(errorMetres(45, 5)).toBeGreaterThan(1) // ~2.3 m
    expect(errorMetres(45, 5)).toBeLessThan(4)
    expect(errorMetres(45, 20)).toBeGreaterThan(20) // ~36.5 m
    expect(errorMetres(45, 20)).toBeLessThan(50)
  })

  it('is comfortably accurate at start-line scale, which is what it is for', () => {
    // A long start line is ~400 m. Sub-centimetre in every direction.
    for (const brg of [0, 45, 90, 135, 180, 225, 270, 315]) {
      expect(errorMetres(brg, 0.25)).toBeLessThan(0.01)
    }
  })
})

describe('vectors', () => {
  it('reads a bearing from a vector and back', () => {
    for (const brg of [0, 45, 90, 180, 270, 359]) {
      expect(vecBearing(fromPolar(brg, 5))).toBeCloseTo(brg, 6)
    }
    expect(vecLen(fromPolar(123, 7))).toBeCloseTo(7, 9)
  })

  it('uses x = east, y = north, matching LocalFrame', () => {
    expect(fromPolar(90, 1).x).toBeCloseTo(1, 9)
    expect(fromPolar(90, 1).y).toBeCloseTo(0, 9)
    expect(fromPolar(0, 1).y).toBeCloseTo(1, 9)
  })
})

describe('intersections', () => {
  it('finds where two rays cross, with both parameters', () => {
    const hit = rayIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: -1 }, { x: 0, y: 1 })
    expect(hit).not.toBeNull()
    expect(hit?.point.x).toBeCloseTo(2, 9)
    expect(hit?.point.y).toBeCloseTo(0, 9)
    expect(hit?.t).toBeCloseTo(2, 9)
    expect(hit?.s).toBeCloseTo(1, 9)
  })

  it('returns null for parallel rays rather than infinity', () => {
    expect(rayIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 })).toBeNull()
    expect(rayIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, { x: -1, y: 0 })).toBeNull()
  })

  it('detects crossing segments and rejects near misses', () => {
    // The land-crossing test depends on this: a false negative sails a route
    // through an island.
    const cross = segmentsIntersect(
      { x: -1, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: 1 },
    )
    expect(cross).toBe(true)
    const miss = segmentsIntersect(
      { x: -1, y: 0 },
      { x: -0.1, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: 1 },
    )
    expect(miss).toBe(false)
  })

  it('reports collinear segments as not intersecting, as documented', () => {
    // Degenerate and deliberately excluded: the determinant is zero.
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }),
    ).toBe(false)
  })

  it('measures perpendicular distance to a degenerate line as distance to the point', () => {
    expect(signedDistanceToLine({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5, 9)
  })
})

describe('units and bbox', () => {
  it('converts nautical miles and metres', () => {
    expect(nmToM(1)).toBe(1852)
    expect(mToNm(1852)).toBeCloseTo(1, 12)
    expect(mToNm(nmToM(7.3))).toBeCloseTo(7.3, 12)
  })

  it('bounds a set of points and pads in nautical miles', () => {
    const box = bboxOf([P(43.6, -70.2), P(43.7, -70.1)])
    expect(box.south).toBeCloseTo(43.6, 9)
    expect(box.north).toBeCloseTo(43.7, 9)
    expect(box.west).toBeCloseTo(-70.2, 9)
    expect(box.east).toBeCloseTo(-70.1, 9)

    const padded = bboxOf([P(43.6, -70.2), P(43.7, -70.1)], 60)
    // A degree of latitude is 60 nm, so 60 nm of pad is one degree.
    expect(padded.south).toBeCloseTo(42.6, 6)
    expect(padded.north).toBeCloseTo(44.7, 6)
    // Longitude pad is wider, scaled by 1/cos(lat).
    expect(padded.west).toBeLessThan(-71.2)
  })

  it('clamps padding away from the poles', () => {
    const box = bboxOf([P(89.5, 0)], 120)
    expect(box.north).toBeLessThanOrEqual(89.9)
    expect(box.south).toBeGreaterThanOrEqual(-89.9)
  })
})
