/**
 * Datum arithmetic tests.
 *
 * These exist to make a sign inversion fail loudly. Every term in
 * `depthAtTime` is a small number and two of the signs are conventions, so the
 * wrong version of this module still returns a plausible depth — wrong by up to
 * three metres, in the worst direction, at a spring low.
 *
 * The three anchors are checked first and by hand, against figures that can be
 * verified against a published tide table rather than against the implementation:
 *
 *   at MLLW      the correction is −1.51 m   (a metre and a half LESS water)
 *   at MSL       the correction is 0          (the grid is right)
 *   at high water the correction is positive   (MORE water)
 *
 * Real numbers throughout, from NOAA station 8418150 for 2026-08-06: low 0.405 ft
 * at 02:55Z, high 8.779 ft at 09:04Z.
 */

import { describe, expect, it } from 'vitest'
import {
  PORTLAND_DATUM,
  datumNote,
  depthAtTime,
  surfaceAboveMsl,
  underKeel,
} from './datum'
import { FEET_TO_M, type WaterLevelPrediction } from './coops'

const T0 = Date.UTC(2026, 7, 6, 0, 0)
const HOUR = 3_600_000

/** MLLW, MSL and high water as three points an hour apart. */
function levels(): WaterLevelPrediction {
  return {
    stationId: '8418150',
    datum: 'MLLW',
    series: [
      { t: T0, m: 0 }, // exactly MLLW
      { t: T0 + HOUR, m: PORTLAND_DATUM.mslAboveMllwM }, // exactly MSL
      { t: T0 + 2 * HOUR, m: 8.779 * FEET_TO_M }, // today's published high
    ],
    events: [],
    fetchedAt: T0,
  }
}

describe('surfaceAboveMsl — the term whose sign is a convention', () => {
  it('is negative at MLLW, by the full datum offset', () => {
    // The anchor that matters: at the chart datum there is 1.51 m LESS water than
    // a mean-sea-level depth claims, not more.
    expect(surfaceAboveMsl(0, PORTLAND_DATUM)).toBeCloseTo(-1.51, 6)
  })

  it('is zero at mean sea level', () => {
    expect(surfaceAboveMsl(PORTLAND_DATUM.mslAboveMllwM, PORTLAND_DATUM)).toBeCloseTo(0, 6)
  })

  it('is positive at high water', () => {
    // 8.779 ft = 2.676 m above MLLW, so 1.166 m above mean sea level.
    expect(surfaceAboveMsl(8.779 * FEET_TO_M, PORTLAND_DATUM)).toBeCloseTo(1.166, 3)
  })

  it('spans the published range between today’s low and high', () => {
    const lo = surfaceAboveMsl(0.405 * FEET_TO_M, PORTLAND_DATUM)
    const hi = surfaceAboveMsl(8.779 * FEET_TO_M, PORTLAND_DATUM)
    // 8.374 ft of range = 2.55 m. Portland's published mean range is 8.9 ft, so a
    // 8.4 ft day is a plausible neap-ish tide and not a unit error.
    expect(hi - lo).toBeCloseTo(2.552, 2)
    expect(lo).toBeLessThan(0)
    expect(hi).toBeGreaterThan(0)
  })
})

describe('depthAtTime', () => {
  const L = levels()

  it('takes water away at low tide and adds it at high', () => {
    const atMllw = depthAtTime(10, L, PORTLAND_DATUM, T0)
    const atMsl = depthAtTime(10, L, PORTLAND_DATUM, T0 + HOUR)
    const atHigh = depthAtTime(10, L, PORTLAND_DATUM, T0 + 2 * HOUR)
    expect(atMllw).toBeCloseTo(8.49, 2)
    expect(atMsl).toBeCloseTo(10, 6)
    expect(atHigh).toBeCloseTo(11.166, 2)
    // The ordering is the invariant. A sign inversion would reverse it while
    // leaving all three values individually plausible.
    expect(atMllw!).toBeLessThan(atMsl!)
    expect(atMsl!).toBeLessThan(atHigh!)
  })

  it('interpolates between samples', () => {
    // Half way from MLLW to MSL: half the offset restored.
    expect(depthAtTime(10, L, PORTLAND_DATUM, T0 + HOUR / 2)).toBeCloseTo(10 - 1.51 / 2, 2)
  })

  it('can dry a shoal out, and says so with a negative', () => {
    // A 1 m MSL patch at MLLW has −0.51 m of water: it is a rock at low tide.
    // Clamping this to zero would hide the only case anyone needs the number for.
    expect(depthAtTime(1, L, PORTLAND_DATUM, T0)).toBeCloseTo(-0.51, 2)
  })

  it('is null outside the prediction rather than falling back to the raw depth', () => {
    /*
     * The dangerous alternative. Falling back to `depthBelowMslM` would report the
     * optimistic mean-sea-level figure at exactly the moment the correction was
     * unavailable, and nothing in the returned number would say so.
     */
    expect(depthAtTime(10, L, PORTLAND_DATUM, T0 - HOUR)).toBeNull()
    expect(depthAtTime(10, L, PORTLAND_DATUM, T0 + 5 * HOUR)).toBeNull()
  })

  it('is null with no prediction and null over land', () => {
    expect(depthAtTime(10, null, PORTLAND_DATUM, T0)).toBeNull()
    expect(depthAtTime(null, L, PORTLAND_DATUM, T0)).toBeNull()
    expect(depthAtTime(NaN, L, PORTLAND_DATUM, T0)).toBeNull()
  })
})

describe('underKeel', () => {
  it('subtracts the draft', () => {
    expect(underKeel(4.2, 1.45)).toBeCloseTo(2.75, 6)
  })

  it('goes negative when the boat does not fit', () => {
    // Not clamped: "0.0 m under the keel" reads as a near miss, and −0.3 m reads
    // as aground. They are different messages.
    expect(underKeel(1.2, 1.5)).toBeCloseTo(-0.3, 6)
  })

  it('is null with no draft, because there is no default draft to assume', () => {
    expect(underKeel(4.2, null)).toBeNull()
    expect(underKeel(4.2, undefined)).toBeNull()
    expect(underKeel(4.2, NaN)).toBeNull()
  })

  it('is null with no depth', () => {
    expect(underKeel(null, 1.45)).toBeNull()
  })
})

describe('datumNote', () => {
  it('says which way the correction went, so it can be checked against a tide table', () => {
    const L = levels()
    expect(datumNote(L, PORTLAND_DATUM, T0)).toMatch(/1\.51 m less water/)
    expect(datumNote(L, PORTLAND_DATUM, T0 + 2 * HOUR)).toMatch(/1\.17 m more water/)
    expect(datumNote(L, PORTLAND_DATUM, T0)).toContain('8418150')
  })

  it('is null when there is no correction to report', () => {
    expect(datumNote(null, PORTLAND_DATUM, T0)).toBeNull()
    expect(datumNote(levels(), PORTLAND_DATUM, T0 - HOUR)).toBeNull()
  })
})
