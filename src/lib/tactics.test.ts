/**
 * Tests for laylines, beat splits and VMC, against the worked relations in
 * docs/03-algorithms/navigation-math.md §6–§7 and polars-and-vpp.md §9.
 *
 * Geometry used throughout: the mark lies due north, the boat 1 nm due south
 * of it, TWD 000 and a 40° upwind target angle — so the two laylines bear 320
 * and 040 and every expected number below reduces to cos 40°.
 */

import { describe, expect, it } from 'vitest'
import { wrap180 } from './angles'
import { bearing, destination } from './geo'
import {
  beatSplit,
  computeLaylines,
  computeTactics,
  headingToMakeGood,
  twdToLay,
  vmcOptimum,
} from './tactics'
import type {
  Boat,
  BoatState,
  Course,
  LatLon,
  PolarLattice,
  Targets,
  WindEstimate,
} from './types'

const NOW = 1_700_000_000_000
const D = Math.PI / 180
const MARK: LatLon = { lat: 43, lon: -70 }
/** 1 nm dead downwind of the mark in a northerly. */
const BOAT_POS = destination(MARK, 180, 1)
const COS40 = Math.cos(40 * D)

function expectAngle(actual: number | null, expected: number, digits = 3): void {
  expect(actual).not.toBeNull()
  expect(wrap180(actual! - expected)).toBeCloseTo(0, digits)
}

function boatOf(over: Partial<Boat> = {}): Boat {
  return {
    id: 'b1',
    name: 'Test',
    className: 'generic',
    loaMetres: 10,
    bowToGpsMetres: 0,
    mastHeightMetres: 14,
    polarPct: 100,
    polarPctNight: 100,
    tackPenaltyS: 10,
    gybePenaltyS: 6,
    ...over,
  }
}

function stateOf(over: Partial<BoatState> = {}): BoatState {
  return {
    t: NOW,
    position: BOAT_POS,
    cog: 320,
    sog: 5,
    accuracyM: 5,
    heading: null,
    bsp: null,
    heelDeg: null,
    ...over,
  }
}

function windOf(twd = 0, tws = 12): WindEstimate {
  return { twd, tws, source: 'manual', uncertaintyDeg: 4, t: NOW }
}

/**
 * Stand-in for the real lattice. The targets are hand-set (40°/150°) and are
 * deliberately NOT the true optima of the speed lobe — each test exercises one
 * or the other, never both at once, and hand-set targets keep the expected
 * values legible.
 */
function fakeLattice(): PolarLattice {
  const targetsAt = (tws: number): Targets => ({
    tws,
    upTwa: 40,
    upBsp: 6,
    upVmg: 6 * COS40,
    downTwa: 150,
    downBsp: 8,
    downVmg: 8 * Math.cos(150 * D),
  })
  return {
    table: { name: 'fake', tws: [], rows: [], reference: '10m' },
    twsMax: 30,
    twsStep: 2,
    twaStep: 5,
    grid: new Float32Array(0),
    twsCount: 0,
    twaCount: 0,
    targets: [],
    speed(tws: number, twa: number): number {
      const a = Math.abs(wrap180(twa))
      if (a < 30) return 0
      return tws * 0.55 * Math.sin(((a - 30) / 150) * Math.PI * 0.85 + 0.25)
    },
    targetsAt,
  }
}

function courseOf(marks: LatLon[]): Course {
  return {
    id: 'c1',
    name: 'test',
    marks: marks.map((position, k) => ({
      id: `m${k}`,
      name: `M${k}`,
      position,
      roundTo: 'port' as const,
    })),
    startLine: {
      port: destination(BOAT_POS, 270, 0.05),
      starboard: destination(BOAT_POS, 90, 0.05),
      gunTime: null,
    },
  }
}

// ----------------------------------------------------------------- laylines

describe('computeLaylines', () => {
  const base = {
    from: BOAT_POS,
    mark: MARK,
    wind: windOf(0),
    lattice: fakeLattice(),
    state: stateOf(),
  }

  it('puts the laylines at TWD ∓ target TWA', () => {
    const l = computeLaylines(base)
    // Starboard tack puts the wind on the starboard side: course = TWD - 40.
    expectAngle(l.starboardBearing, 320)
    expectAngle(l.portBearing, 40)
  })

  it('measures the distance along the present track to the port layline', () => {
    // 1 nm dead downwind, sailing 320 (starboard tack, closing the left-hand
    // side of the course). The port layline runs back from the mark on 220.
    // Symmetric triangle: t = 1 / (2 cos 40°) = 0.652704 nm.
    const l = computeLaylines(base)
    expect(l.distanceToPortLayline).toBeCloseTo(1 / (2 * COS40), 4)
    // At 5 kn that is 469.9 s away.
    expect(l.timeToPortLaylineS).toBeCloseTo(((1 / (2 * COS40)) / 5) * 3600, 2)
    // The boat is already sailing parallel to the starboard layline, so it
    // never converges with it: null, not a huge number and not NaN.
    expect(l.distanceToStarboardLayline).toBeNull()
    expect(l.timeToStarboardLaylineS).toBeNull()
  })

  it('nulls a layline the current is too strong to make good', () => {
    // 6 kn of cross-set against 3 kn of boat speed: |drift·sin| / bsp = 1.53.
    const strong = computeLaylines({
      ...base,
      state: stateOf({ bsp: 3, sog: 3 }),
      current: { set: 90, drift: 6, source: 'test' },
    })
    expect(strong.distanceToPortLayline).toBeNull()
    expect(strong.distanceToStarboardLayline).toBeNull()
    // The bearings still exist — the layline is where it always was, you just
    // cannot get onto it.
    expectAngle(strong.portBearing, 40)

    const weak = computeLaylines({
      ...base,
      state: stateOf({ bsp: 3, sog: 3 }),
      current: { set: 90, drift: 1, source: 'test' },
    })
    expect(weak.distanceToPortLayline).toBeCloseTo(1 / (2 * COS40), 4)
  })

  it('takes the oscillation band from the TWD history, else from the wind', () => {
    expect(computeLaylines(base).boundsDeg).toBeCloseTo(4, 9) // uncertaintyDeg

    const history = [355, 358, 2, 5, 0, 3, 357].map((twd, k) => ({
      t: NOW + k * 1000,
      twd,
      tws: 12,
    }))
    const banded = computeLaylines({ ...base, windHistory: history })
    expect(banded.boundsDeg).toBeGreaterThan(2)
    expect(banded.boundsDeg).toBeLessThan(6)

    // A rock-steady breeze gives a narrow band even if the source is unsure.
    const steady = computeLaylines({
      ...base,
      windHistory: [0, 0, 0, 0].map((twd, k) => ({ t: NOW + k * 1000, twd, tws: 12 })),
    })
    expect(steady.boundsDeg).toBeCloseTo(0, 9)
  })

  it('reports the TWD that would lay the mark on the tack we are on', () => {
    // Sailing 320 in a northerly is starboard tack; the mark bears 000.
    // TWD would have to veer to 000 + 40 = 040 for 320... no: to lay the mark
    // on starboard the course must equal the bearing, so TWD = 000 + 40 = 040.
    const l = computeLaylines({ ...base, state: stateOf({ cog: 320, heading: 320 }) })
    expectAngle(l.twdToLay, 40)
    // On port tack it is the mirror image.
    const port = computeLaylines({ ...base, state: stateOf({ cog: 40, heading: 40 }) })
    expectAngle(port.twdToLay, 320)
  })

  it('switches to the downwind target angle for a leeward mark', () => {
    // Same mark, wind now from the south: the mark is dead downwind, so the
    // laylines are the gybe angles TWD ∓ 150 = 030 and 330.
    const l = computeLaylines({ ...base, wind: windOf(180) })
    expectAngle(l.starboardBearing, 30)
    expectAngle(l.portBearing, 330)
  })
})

describe('twdToLay', () => {
  it('round-trips: applying the shift makes the mark exactly layable', () => {
    for (const brg of [0, 25, 100, 200, 305]) {
      const from = destination(MARK, brg + 180, 0.8)
      for (const tack of ['port', 'starboard'] as const) {
        const twd = twdToLay({ from, mark: MARK, tack, targetTwa: 40 })
        const l = computeLaylines({
          from,
          mark: MARK,
          wind: windOf(twd),
          lattice: fakeLattice(),
          state: stateOf({ position: from }),
        })
        // With that TWD, the layline for that tack points straight at the mark.
        // Compare against the great-circle bearing rather than the outbound
        // `brg`: over 0.8 nm the meridians converge by ~0.01°, so the two
        // differ, and only one of them is the bearing the boat actually sees.
        const laid = tack === 'starboard' ? l.starboardBearing : l.portBearing
        expectAngle(laid, bearing(from, MARK), 6)
        // And the beat split degenerates: one tack does the whole distance.
        // Tolerance of 1 m: beatSplit solves in the flat projection while
        // twdToLay uses the great-circle bearing, and over 0.8 nm those two
        // definitions of "toward the mark" differ by about 0.005°.
        const split = beatSplit({ from, mark: MARK, twd, targetTwa: 40 })
        if (split) {
          expect(Math.min(split.portNm, split.starboardNm)).toBeCloseTo(0, 3)
          expect(split.totalNm).toBeCloseTo(0.8, 3)
        }
      }
    }
  })
})

// --------------------------------------------------------------- beat split

describe('beatSplit', () => {
  it('splits a dead-upwind mark symmetrically', () => {
    const s = beatSplit({ from: BOAT_POS, mark: MARK, twd: 0, targetTwa: 40 })!
    expect(s).not.toBeNull()
    // Each tack is 1 / (2 cos 40°) = 0.652704 nm; the beat is 1 / cos 40°.
    expect(s.portNm).toBeCloseTo(1 / (2 * COS40), 5)
    expect(s.starboardNm).toBeCloseTo(1 / (2 * COS40), 5)
    expect(s.totalNm).toBeCloseTo(1 / COS40, 5)
    expect(s.portNm).toBeCloseTo(s.starboardNm, 9)
  })

  it('returns null for a mark that is layable on one tack', () => {
    // 45° off the wind with a 40° target angle: fetchable, no split to make.
    const mark = destination(BOAT_POS, 45, 1)
    expect(beatSplit({ from: BOAT_POS, mark, twd: 0, targetTwa: 40 })).toBeNull()
    // Just inside the no-go zone, there is a split.
    const tight = destination(BOAT_POS, 35, 1)
    const s = beatSplit({ from: BOAT_POS, mark: tight, twd: 0, targetTwa: 40 })!
    expect(s).not.toBeNull()
    expect(s.portNm).toBeGreaterThan(s.starboardNm)
  })

  it('tells you which is the long tack', () => {
    // Mark 20° to the right of the wind's eye. Port tack (course 040) heads
    // that way, so port is the long tack — the first decision of the beat.
    const mark = destination(BOAT_POS, 20, 1)
    const s = beatSplit({ from: BOAT_POS, mark, twd: 0, targetTwa: 40 })!
    expect(s.portNm).toBeGreaterThan(s.starboardNm)
    // 1 nm at 20° off the eye of the wind: 0.879 on port, 0.347 on starboard.
    expect(s.portNm).toBeCloseTo(0.8794, 3)
    expect(s.starboardNm).toBeCloseTo(0.3472, 3)
    expect(s.totalNm).toBeGreaterThan(1)
    // Mirror it and the long tack swaps.
    const mirror = destination(BOAT_POS, 340, 1)
    const m = beatSplit({ from: BOAT_POS, mark: mirror, twd: 0, targetTwa: 40 })!
    expect(m.portNm).toBeCloseTo(s.starboardNm, 4)
    expect(m.starboardNm).toBeCloseTo(s.portNm, 4)
  })

  it('does the same job for a run, with the gybe angles', () => {
    // Mark dead downwind, 150° target: gybe angles are 030 and 330 either side
    // of the rhumb, so each leg is 1 / (2 cos 30°).
    const s = beatSplit({ from: BOAT_POS, mark: destination(BOAT_POS, 180, 1), twd: 0, targetTwa: 150 })!
    expect(s).not.toBeNull()
    expect(s.portNm).toBeCloseTo(1 / (2 * Math.cos(30 * D)), 4)
    expect(s.totalNm).toBeCloseTo(1 / Math.cos(30 * D), 4)
  })
})

// ---------------------------------------------------------------------- VMC

describe('vmcOptimum', () => {
  it('matches a brute-force scan of the synthetic polar', () => {
    const lattice = fakeLattice()
    for (const bearingToMark of [10, 35, 60, 90, 135, 175, 250, 320]) {
      const twd = 0
      const tws = 12
      let bestTwa = 0
      let bestVmc = -Infinity
      for (let twa = -180; twa <= 180; twa += 0.01) {
        const heading = ((twd - twa) % 360 + 360) % 360
        const v =
          lattice.speed(tws, twa) *
          Math.cos((((bearingToMark - heading + 540) % 360) - 180) * D)
        if (v > bestVmc) {
          bestVmc = v
          bestTwa = twa
        }
      }
      const got = vmcOptimum({ bearingToMark, twd, tws, lattice })
      expect(got.vmc).toBeCloseTo(bestVmc, 5)
      expect(wrap180(got.twa - bestTwa)).toBeCloseTo(0, 1)
      expectAngle(got.heading, ((twd - bestTwa) % 360 + 360) % 360, 1)
    }
  })

  it('gives a heading inside the sailable arc for a dead-upwind mark', () => {
    const got = vmcOptimum({ bearingToMark: 0, twd: 0, tws: 12, lattice: fakeLattice() })
    // Cannot point at it, so the optimum is a close-hauled heading and the VMC
    // is strictly less than the boat speed on that heading.
    expect(Math.abs(got.twa)).toBeGreaterThan(30)
    expect(got.vmc).toBeGreaterThan(0)
    expect(got.vmc).toBeLessThan(fakeLattice().speed(12, got.twa))
  })
})

describe('headingToMakeGood', () => {
  it('solves the current triangle', () => {
    // Make good 000 with 2 kn setting 090 and 6 kn of boat speed:
    //   offset = asin(2/6 · sin 90°) = 19.4712°, so steer 340.5288.
    const h = headingToMakeGood({ track: 0, set: 90, drift: 2, bsp: 6 })
    expectAngle(h, 340.5288, 3)
  })

  it('is a no-op with no current and null with no boat speed', () => {
    expectAngle(headingToMakeGood({ track: 137, set: 90, drift: 0, bsp: 6 }), 137)
    expect(headingToMakeGood({ track: 137, set: 90, drift: 2, bsp: 0 })).toBeNull()
  })

  it('returns null when the current is too strong across the track', () => {
    expect(headingToMakeGood({ track: 0, set: 90, drift: 8, bsp: 6 })).toBeNull()
    // Foul tide dead on the nose, stronger than the boat: nominally solvable
    // (offset 0) but the boat goes backwards, so still null.
    expect(headingToMakeGood({ track: 0, set: 180, drift: 8, bsp: 6 })).toBeNull()
  })
})

// ---------------------------------------------------------- the main call

describe('computeTactics', () => {
  const inputs = {
    state: stateOf({ heading: 320, bsp: 5 }),
    wind: windOf(0),
    boat: boatOf(),
    lattice: fakeLattice(),
    course: courseOf([MARK, destination(MARK, 180, 1.5)]),
    activeMarkIndex: 0,
  }

  it('fills in the wind, target and polar numbers', () => {
    const r = computeTactics(inputs)
    expect(r.twd).toBe(0)
    expect(r.tws).toBe(12)
    expect(r.windSource).toBe('manual')
    // Heading 320 in a northerly: TWA +40, starboard tack.
    expect(r.twa).toBeCloseTo(40, 6)
    expect(r.targetTwa).toBeCloseTo(40, 9)
    expect(r.targetBsp).toBeCloseTo(6, 9)
    expect(r.polarBsp).toBeCloseTo(fakeLattice().speed(12, 40), 9)
    expect(r.polarBspPct).toBeCloseTo((100 * 5) / fakeLattice().speed(12, 40), 6)
    // VMG = bsp · cos(twa) = 5 cos 40° = 3.830222
    expect(r.vmg).toBeCloseTo(5 * COS40, 6)
    expect(r.vmgPct).toBeCloseTo((100 * 5 * COS40) / (6 * COS40), 6)
  })

  it('fills in the mark numbers', () => {
    const r = computeTactics(inputs)
    expectAngle(r.markBearing, 0, 4)
    expect(r.markRange).toBeCloseTo(1, 6)
    // VMC = sog · cos(bearing - cog) = 5 cos 40° with COG 320.
    expect(r.vmc).toBeCloseTo(5 * COS40, 4)
    // Mark dead upwind: beat time = range/cos0 along the wind at target VMG,
    // 1 / (6 cos40) h = 783.24 s, plus one tack penalty.
    expect(r.markTimeS).toBeCloseTo(3600 / (6 * COS40) + 10, 1)
    expect(r.nextMarkBearing).not.toBeNull()
    expect(r.distanceToFinishNm).toBeCloseTo(2.5, 4)
    expect(r.laylines).not.toBeNull()
    expect(r.laylines!.distanceToPortLayline).toBeCloseTo(1 / (2 * COS40), 4)
  })

  it('splits the beat for a mark inside the no-go zone', () => {
    const r = computeTactics(inputs)
    expect(r.portTackDistanceNm).toBeCloseTo(1 / (2 * COS40), 4)
    expect(r.starboardTackDistanceNm).toBeCloseTo(1 / (2 * COS40), 4)
  })

  it('leaves the beat split null for a fetchable mark', () => {
    const r = computeTactics({
      ...inputs,
      course: courseOf([destination(BOAT_POS, 60, 1)]),
    })
    expect(r.portTackDistanceNm).toBeNull()
    expect(r.starboardTackDistanceNm).toBeNull()
    // But the mark time is still there — it is just the direct polar run.
    expect(r.markTimeS).not.toBeNull()
  })

  it('returns every declared field, null where not computable', () => {
    const keys = Object.keys(computeTactics(inputs))
    const bare = computeTactics({
      state: stateOf(),
      wind: null,
      boat: boatOf(),
      course: courseOf([]),
      activeMarkIndex: 0,
    })
    expect(Object.keys(bare).sort()).toEqual(keys.sort())
    for (const [k, v] of Object.entries(bare)) {
      expect(v === null || Number.isFinite(v) || typeof v === 'object').toBe(true)
      expect(v).not.toBeUndefined()
      expect(Number.isNaN(v as number)).toBe(false)
      expect(k.length).toBeGreaterThan(0)
    }
    expect(bare.twd).toBeNull()
    expect(bare.laylines).toBeNull()
    expect(bare.markBearing).toBeNull()
  })

  it('works with a wind but no polar', () => {
    const r = computeTactics({ ...inputs, lattice: null })
    expect(r.twd).toBe(0)
    expect(r.twa).toBeCloseTo(40, 6)
    expect(r.targetBsp).toBeNull()
    expect(r.polarBsp).toBeNull()
    expect(r.laylines).toBeNull()
    // GPS-only numbers survive.
    expect(r.markRange).toBeCloseTo(1, 6)
    expect(r.vmc).toBeCloseTo(5 * COS40, 4)
    expect(r.markTimeS).toBeCloseTo((1 / (5 * COS40)) * 3600, 3)
  })

  it('never throws on hostile input', () => {
    const hostile = [
      { activeMarkIndex: 99 },
      { activeMarkIndex: -1 },
      { state: stateOf({ sog: 0, bsp: 0 }) },
      { wind: windOf(0, 0) },
      { current: { set: 90, drift: 99, source: 'silly' } },
      { state: stateOf({ sog: Number.NaN }) },
    ]
    for (const over of hostile) {
      expect(() => computeTactics({ ...inputs, ...over })).not.toThrow()
    }
    // A NaN fix costs the channels that depend on it, not the whole display.
    const badFix = computeTactics({ ...inputs, state: stateOf({ bsp: Number.NaN, sog: 5 }) })
    expect(badFix.vmg).toBeCloseTo(0, 9)
    expect(badFix.twd).toBe(0)
    expect(Number.isNaN(badFix.vmg!)).toBe(false)
    // A lattice that blows up costs its own fields and nothing else.
    const bad = {
      ...fakeLattice(),
      speed(): number {
        throw new Error('bad polar')
      },
    }
    const r = computeTactics({ ...inputs, lattice: bad })
    expect(r.twd).toBe(0)
    expect(r.markBearing).not.toBeNull()
  })

  it('corrects the heading to steer for current', () => {
    const r = computeTactics({
      ...inputs,
      state: stateOf({ heading: 320, bsp: 6, sog: 6 }),
      current: { set: 90, drift: 2, source: 'test' },
    })
    // Mark bears 000; steering to make that good against a 2 kn easterly set
    // means aiming 19.47° up-current.
    expectAngle(r.headingToSteer, 340.5288, 2)
  })

  it('measures cross-track from the start line before the first mark', () => {
    const r = computeTactics(inputs)
    expect(r.xteNm).not.toBeNull()
    expect(Math.abs(r.xteNm!)).toBeLessThan(1e-6)
  })
})
