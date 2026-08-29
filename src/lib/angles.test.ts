/**
 * Angle discipline.
 *
 * This module exists to stop one bug: a bearing subtracted with `-`. Everything
 * downstream — laylines, TWA, start-line bias, the routing fan — is built on
 * `angdiff` behaving correctly across the 0/360 seam, and until now it had no
 * direct tests at all. `roadmap.md` Phase 1 called the units package "fully
 * tested"; this file and `geo.test.ts` are what makes that true.
 */

import { describe, expect, it } from 'vitest'
import {
  angdiff,
  angsep,
  clamp,
  clampUnit,
  courseFor,
  lerpBearing,
  manoeuvre,
  meanBearing,
  stdBearing,
  tackOf,
  twaFrom,
  wrap180,
  wrap360,
} from './angles'

describe('wrap360', () => {
  it('normalises into [0, 360)', () => {
    expect(wrap360(0)).toBe(0)
    expect(wrap360(359.9)).toBeCloseTo(359.9, 9)
    expect(wrap360(360)).toBe(0)
    expect(wrap360(720)).toBe(0)
    expect(wrap360(370)).toBeCloseTo(10, 9)
  })

  it('never returns 360 for a hair-negative input', () => {
    /*
     * The interval is half-open, and `r + 360` on its own broke that: for a
     * negative `r` too small to represent alongside 360, the sum rounds up to
     * exactly 360. Trig produces such values constantly — this was reachable
     * through `meanBearing([350, 10])`, which returned 360° for due north.
     */
    expect(wrap360(-1e-16)).toBe(0)
    expect(wrap360(-8e-16)).toBe(0)
    expect(wrap360(-Number.MIN_VALUE)).toBe(0)
    for (const a of [-1e-13, -1e-16, -1e-20, -0]) {
      expect(wrap360(a), `wrap360(${a})`).toBeLessThan(360)
      expect(wrap360(a)).toBeGreaterThanOrEqual(0)
    }
  })

  it('brings negatives round the right way', () => {
    expect(wrap360(-1)).toBeCloseTo(359, 9)
    expect(wrap360(-90)).toBeCloseTo(270, 9)
    expect(wrap360(-370)).toBeCloseTo(350, 9)
  })

  it('propagates NaN and Infinity rather than fabricating north', () => {
    expect(Number.isNaN(wrap360(NaN))).toBe(true)
    expect(Number.isNaN(wrap360(Infinity))).toBe(true)
    expect(Number.isNaN(wrap360(-Infinity))).toBe(true)
  })
})

describe('wrap180', () => {
  it('normalises into (-180, 180]', () => {
    expect(wrap180(0)).toBe(0)
    expect(wrap180(90)).toBeCloseTo(90, 9)
    expect(wrap180(-90)).toBeCloseTo(-90, 9)
    expect(wrap180(190)).toBeCloseTo(-170, 9)
    expect(wrap180(-190)).toBeCloseTo(170, 9)
  })

  it('resolves the closed end to +180, never -180', () => {
    // The documented edge, and the reason the function is not just a modulo:
    // an interval closed at one end has to pick a side and stay there.
    expect(wrap180(180)).toBe(180)
    expect(wrap180(-180)).toBe(180)
    expect(wrap180(540)).toBe(180)
  })
})

describe('angdiff', () => {
  it('takes the short way across the 0/360 seam', () => {
    // The bug this module exists to prevent: 1 - 359 is -358 with a minus sign
    // and +2 in reality.
    expect(angdiff(1, 359)).toBeCloseTo(2, 9)
    expect(angdiff(359, 1)).toBeCloseTo(-2, 9)
    expect(angdiff(10, 350)).toBeCloseTo(20, 9)
  })

  it('is signed: positive means a is clockwise of b', () => {
    expect(angdiff(100, 90)).toBeCloseTo(10, 9)
    expect(angdiff(90, 100)).toBeCloseTo(-10, 9)
  })

  it('gives +180 for opposites, in either order', () => {
    expect(angdiff(0, 180)).toBe(180)
    expect(angdiff(180, 0)).toBe(180)
  })

  it('is antisymmetric except at the closed end', () => {
    for (const [a, b] of [
      [0, 45],
      [12, 300],
      [271, 89.5],
      [359.9, 0.1],
    ]) {
      expect(angdiff(a, b)).toBeCloseTo(-angdiff(b, a), 9)
    }
  })
})

describe('angsep', () => {
  it('is unsigned and symmetric, in [0, 180]', () => {
    expect(angsep(1, 359)).toBeCloseTo(2, 9)
    expect(angsep(359, 1)).toBeCloseTo(2, 9)
    expect(angsep(0, 180)).toBe(180)
    expect(angsep(90, 90)).toBe(0)
  })
})

describe('meanBearing', () => {
  it('averages across the seam instead of through it', () => {
    // The documented failure of arithmetic averaging: (350 + 10) / 2 = 180,
    // pointing the opposite way to both inputs.
    expect(meanBearing([350, 10])).toBeCloseTo(0, 6)
    expect(meanBearing([355, 5, 0])).toBeCloseTo(0, 6)
    expect(meanBearing([80, 100])).toBeCloseTo(90, 6)
  })

  it('returns the bearing itself for a single sample', () => {
    expect(meanBearing([237])).toBeCloseTo(237, 6)
  })

  it('is null when there is no resultant to point along', () => {
    /*
     * Antipodal inputs have no mean, and this used to return a confident 90°:
     * the guard compared `s` and `c` to exactly zero, but `sin(180°)` is 1.2e-16
     * rather than 0, so the cancellation the guard was watching for never
     * happened in binary. It now tests the resultant length.
     */
    expect(meanBearing([0, 180])).toBeNull()
    expect(meanBearing([90, 270])).toBeNull()
    expect(meanBearing([0, 120, 240])).toBeNull()
    expect(meanBearing([])).toBeNull()
  })
})

describe('stdBearing', () => {
  it('is zero for identical samples and small for a tight cluster', () => {
    expect(stdBearing([90, 90, 90, 90])).toBe(0)
    const tight = stdBearing([88, 90, 92, 89, 91])
    expect(tight).toBeGreaterThan(0)
    expect(tight).toBeLessThan(3)
  })

  it('grows with the spread, and saturates around 81° for a uniform circle', () => {
    const narrow = stdBearing([85, 90, 95])
    const wide = stdBearing([60, 90, 120])
    expect(wide).toBeGreaterThan(narrow)
    // The documented ceiling: a set with no preferred direction.
    const uniform = stdBearing(Array.from({ length: 36 }, (_, i) => i * 10))
    expect(uniform).toBeGreaterThan(70)
  })

  it('is zero rather than NaN below two samples', () => {
    // Callers must not read this as certainty; `tactics.boundsFrom` checks the
    // sample count itself before trusting it.
    expect(stdBearing([])).toBe(0)
    expect(stdBearing([123])).toBe(0)
  })
})

describe('lerpBearing', () => {
  it('interpolates the short way round', () => {
    expect(lerpBearing(350, 10, 0.5)).toBeCloseTo(0, 6)
    expect(lerpBearing(10, 350, 0.5)).toBeCloseTo(0, 6)
    expect(lerpBearing(0, 90, 1 / 3)).toBeCloseTo(30, 6)
  })

  it('returns the endpoints at 0 and 1', () => {
    expect(lerpBearing(200, 250, 0)).toBeCloseTo(200, 6)
    expect(lerpBearing(200, 250, 1)).toBeCloseTo(250, 6)
  })
})

describe('twaFrom / courseFor', () => {
  it('signs TWA to starboard positive, Expedition-style', () => {
    // Wind from 000, sailing 320: the wind is over the starboard bow.
    expect(twaFrom(320, 0)).toBeCloseTo(40, 9)
    expect(twaFrom(40, 0)).toBeCloseTo(-40, 9)
  })

  it('round-trips through courseFor', () => {
    for (const [course, twd] of [
      [320, 0],
      [40, 0],
      [180, 271],
      [5, 355],
    ]) {
      const twa = twaFrom(course, twd)
      expect(wrap360(courseFor(twd, twa))).toBeCloseTo(wrap360(course), 6)
    }
  })

  it('handles dead upwind and dead downwind', () => {
    expect(twaFrom(0, 0)).toBe(0)
    expect(Math.abs(twaFrom(180, 0))).toBe(180)
  })
})

describe('tackOf', () => {
  it('reads the side the wind is on', () => {
    expect(tackOf(40)).toBe('starboard')
    expect(tackOf(-40)).toBe('port')
    expect(tackOf(150)).toBe('starboard')
    // Dead upwind is called starboard by convention; the point is that it is
    // deterministic, not that zero has a real tack.
    expect(tackOf(0)).toBe('starboard')
  })
})

describe('manoeuvre', () => {
  it('is none while the wind stays on one side', () => {
    expect(manoeuvre(40, 60)).toBe('none')
    expect(manoeuvre(-40, -150)).toBe('none')
  })

  it('calls a change of side through the bow a tack', () => {
    expect(manoeuvre(40, -40)).toBe('tack')
    expect(manoeuvre(-35, 35)).toBe('tack')
  })

  it('calls a change of side through the stern a gybe', () => {
    expect(manoeuvre(150, -150)).toBe('gybe')
    expect(manoeuvre(-179, 179)).toBe('gybe')
  })

  it('splits at a mean absolute TWA of 90', () => {
    expect(manoeuvre(89, -89)).toBe('tack')
    expect(manoeuvre(91, -91)).toBe('gybe')
  })
})

describe('clamps', () => {
  it('clampUnit keeps acos/asin arguments legal', () => {
    // The reason it exists: floating point routinely produces 1.0000000002,
    // and Math.acos of that is NaN, which then poisons a whole leg.
    expect(clampUnit(1.0000000002)).toBe(1)
    expect(clampUnit(-1.0000000002)).toBe(-1)
    expect(clampUnit(0.5)).toBe(0.5)
    expect(Number.isNaN(Math.acos(clampUnit(1.0000000002)))).toBe(false)
  })

  it('clamp bounds a value both ways', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})
