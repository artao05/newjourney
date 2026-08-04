/**
 * Tests for the start-line numbers, against the worked cases in
 * docs/03-algorithms/start-line-math.md §2–§5.
 *
 * The line under test is 100 m long, pin (port) to the west and committee boat
 * (starboard) to the east, so the line bears 090 and the square wind is 000 —
 * the geometry every expected value below is hand-computed from.
 */

import { describe, expect, it } from 'vitest'
import { wrap180 } from './angles'
import { destination, mToNm } from './geo'
import {
  DEFAULT_TURN_MODEL,
  bowPosition,
  computeStart,
  positionAtGun,
  timeToPoint,
} from './startline'
import type {
  Boat,
  BoatState,
  LatLon,
  PolarLattice,
  StartLine,
  Targets,
  WindEstimate,
} from './types'

const NOW = 1_700_000_000_000
const MID: LatLon = { lat: 43, lon: -70 }

/** Compare bearings by wrapped difference — 359.9999 and 0 are the same angle. */
function expectAngle(actual: number | null, expected: number, digits = 3): void {
  expect(actual).not.toBeNull()
  expect(wrap180(actual! - expected)).toBeCloseTo(0, digits)
}

function lineOf(lengthM: number, gunTime: number | null = NOW + 60_000): StartLine {
  return {
    port: destination(MID, 270, mToNm(lengthM / 2)),
    starboard: destination(MID, 90, mToNm(lengthM / 2)),
    gunTime,
  }
}

/** A point `m` metres from the line midpoint on a bearing. */
function off(brg: number, m: number): LatLon {
  return destination(MID, brg, mToNm(m))
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
    position: off(180, 50),
    cog: 0,
    sog: 6,
    accuracyM: 5,
    heading: null,
    bsp: null,
    heelDeg: null,
    ...over,
  }
}

function windOf(twd: number, tws = 12): WindEstimate {
  return { twd, tws, source: 'manual', uncertaintyDeg: 5, t: NOW }
}

/**
 * A deliberately simple stand-in for the real lattice: a smooth speed lobe
 * that is zero inside the no-go zone, plus fixed targets. `polar.ts` is
 * another agent's file and this suite must not depend on it existing.
 */
function fakeLattice(): PolarLattice {
  const targetsAt = (tws: number): Targets => ({
    tws,
    upTwa: 40,
    upBsp: 6,
    upVmg: 6 * Math.cos((40 * Math.PI) / 180),
    downTwa: 150,
    downBsp: 8,
    downVmg: 8 * Math.cos((150 * Math.PI) / 180),
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

// ------------------------------------------------------------------- geometry

describe('line geometry and bias', () => {
  it('reads a square line with the wind straight down the course as unbiased', () => {
    const r = computeStart({
      line: lineOf(100),
      state: stateOf(),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    expectAngle(r.lineSquareWindDeg, 0)
    expect(r.lineLengthM).toBeCloseTo(100, 3)
    expect(r.biasAngleDeg).toBeCloseTo(0, 3)
    expect(r.biasLengthM).toBeCloseTo(0, 3)
    expect(r.favouredEnd).toBe('even')
  })

  it('gives 17.4 m at the starboard end for a 10° right-shifted line', () => {
    // bias_length = 100 · sin(10°) = 17.3648 m. The wind has veered to 010, so
    // the committee-boat (east) end is the one further upwind.
    const r = computeStart({
      line: lineOf(100),
      state: stateOf(),
      wind: windOf(10),
      boat: boatOf(),
      now: NOW,
    })
    expect(r.biasAngleDeg).toBeCloseTo(10, 3)
    expect(r.biasLengthM).toBeCloseTo(17.3648, 3)
    expect(r.favouredEnd).toBe('starboard')
  })

  it('flips the sign and the favoured end for a left-shifted line', () => {
    const r = computeStart({
      line: lineOf(100),
      state: stateOf(),
      wind: windOf(350),
      boat: boatOf(),
      now: NOW,
    })
    expect(r.biasAngleDeg).toBeCloseTo(-10, 3)
    expect(r.biasLengthM).toBeCloseTo(17.3648, 3)
    expect(r.favouredEnd).toBe('port')
  })

  it('scales bias length with line length, which is the whole point of the number', () => {
    const short = computeStart({
      line: lineOf(100),
      state: stateOf(),
      wind: windOf(5),
      boat: boatOf(),
      now: NOW,
    })
    const long = computeStart({
      line: lineOf(1000),
      state: stateOf(),
      wind: windOf(5),
      boat: boatOf(),
      now: NOW,
    })
    expect(short.biasLengthM).toBeCloseTo(8.7156, 3)
    expect(long.biasLengthM).toBeCloseTo(87.156, 2)
    expect(short.biasAngleDeg).toBeCloseTo(long.biasAngleDeg!, 6)
  })
})

describe('distance below the line', () => {
  it('is positive below the line and negative over it', () => {
    const below = computeStart({
      line: lineOf(100),
      state: stateOf({ position: off(180, 50) }),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    const over = computeStart({
      line: lineOf(100),
      state: stateOf({ position: off(0, 50) }),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    expect(below.distanceBelowLineM).toBeCloseTo(50, 2)
    expect(over.distanceBelowLineM).toBeCloseTo(-50, 2)
    expect(below.distanceBelowLineBoatLengths).toBeCloseTo(5, 2)
    expect(over.distanceBelowLineBoatLengths).toBeCloseTo(-5, 2)
  })

  it('measures from the bow, not the antenna', () => {
    // GPS 50 m below the line, heading north, 5 m of bow ahead of it: the bow
    // is 45 m below. On a 100 m line that offset is 5 % of the whole line.
    const r = computeStart({
      line: lineOf(100),
      state: stateOf({ position: off(180, 50), heading: 0 }),
      wind: windOf(0),
      boat: boatOf({ bowToGpsMetres: 5 }),
      now: NOW,
    })
    expect(r.distanceBelowLineM).toBeCloseTo(45, 2)
  })

  it('uses the infinite line, not the segment', () => {
    // 300 m east of the starboard end and 40 m below: still 40 m below.
    const p = destination(off(90, 300), 180, mToNm(40))
    const r = computeStart({
      line: lineOf(100),
      state: stateOf({ position: p }),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    // 1 cm of tolerance: 300 m off the end of the line, the great circle and
    // the flat projection have drifted apart by ~6 mm.
    expect(r.distanceBelowLineM).toBeCloseTo(40, 1)
  })
})

describe('OCS', () => {
  const overTheLine = { position: off(0, 20) }

  it('is true only when the bow is over and the gun has not fired', () => {
    const before = computeStart({
      line: lineOf(100, NOW + 30_000),
      state: stateOf(overTheLine),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    expect(before.ocs).toBe(true)

    const after = computeStart({
      line: lineOf(100, NOW - 30_000),
      state: stateOf(overTheLine),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    expect(after.ocs).toBe(false)

    const belowBeforeGun = computeStart({
      line: lineOf(100, NOW + 30_000),
      state: stateOf({ position: off(180, 20) }),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    expect(belowBeforeGun.ocs).toBe(false)
  })

  it('is false, not null, when there is no gun time at all', () => {
    const r = computeStart({
      line: lineOf(100, null),
      state: stateOf(overTheLine),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    expect(r.ocs).toBe(false)
    expect(r.timeToGunS).toBeNull()
  })
})

// ---------------------------------------------------------------- the times

describe('time to line and time to burn', () => {
  const gpsOnly = { ends: false, gps: true, reach: false, port: false, starboard: false }

  it('computes the GPS approach as plain distance over SOG', () => {
    // 100 m below the line, straight at it at 6 kn:
    //   100 m = 0.0539957 nm ; 0.0539957 / 6 h = 32.3974 s
    const r = computeStart({
      line: lineOf(100),
      state: stateOf({ position: off(180, 100), cog: 0, sog: 6 }),
      wind: null,
      boat: boatOf(),
      now: NOW,
      approaches: gpsOnly,
    })
    expect(r.timeToLineS).toBeCloseTo(32.3974, 2)
  })

  it('subtracts time to gun to get time to burn', () => {
    const r = computeStart({
      line: lineOf(100, NOW + 60_000),
      state: stateOf({ position: off(180, 100), cog: 0, sog: 6 }),
      wind: null,
      boat: boatOf(),
      now: NOW,
      approaches: gpsOnly,
    })
    expect(r.timeToGunS).toBeCloseTo(60, 9)
    expect(r.timeToLineS).toBeCloseTo(32.3974, 2)
    // Arriving 27.6 s early: that is 27.6 s of time to burn.
    expect(r.timeToBurnS).toBeCloseTo(32.3974 - 60, 2)
    expect(r.timeToBurnS).toBeCloseTo(r.timeToLineS! - r.timeToGunS!, 9)
  })

  it('counts the gun down through zero', () => {
    const r = computeStart({
      line: lineOf(100, NOW - 15_000),
      state: stateOf(),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    expect(r.timeToGunS).toBeCloseTo(-15, 9)
  })

  it('reports a negative time to line when the bow is over it', () => {
    const r = computeStart({
      line: lineOf(100),
      state: stateOf({ position: off(0, 30), cog: 0, sog: 6 }),
      wind: null,
      boat: boatOf(),
      now: NOW,
      approaches: gpsOnly,
    })
    expect(r.distanceBelowLineM).toBeLessThan(0)
    expect(r.timeToLineS).toBeLessThan(0)
    // 30 m at 6 kn = 9.719 s of getting back.
    expect(Math.abs(r.timeToLineS!)).toBeCloseTo(9.7192, 2)
  })

  it('takes the minimum over the enabled approaches only', () => {
    const common = {
      line: lineOf(100),
      state: stateOf({ position: off(180, 100), cog: 0, sog: 6, heading: 0 }),
      wind: windOf(0),
      boat: boatOf(),
      lattice: fakeLattice(),
      now: NOW,
    }
    const all = computeStart({ ...common })
    const justGps = computeStart({ ...common, approaches: gpsOnly })
    expect(all.timeToLineS).not.toBeNull()
    expect(all.timeToLineS!).toBeLessThanOrEqual(justGps.timeToLineS! + 1e-9)
  })

  it('still produces end times when the ends are excluded from time-to-line', () => {
    const r = computeStart({
      line: lineOf(400),
      state: stateOf({ position: off(180, 100), cog: 0, sog: 6, heading: 0 }),
      wind: windOf(0),
      boat: boatOf(),
      lattice: fakeLattice(),
      now: NOW,
      approaches: gpsOnly,
    })
    expect(r.timeToPortEndS).not.toBeNull()
    expect(r.timeToStarboardEndS).not.toBeNull()
    // The ends of a 400 m line are much further off than the line itself.
    expect(r.timeToPortEndS!).toBeGreaterThan(r.timeToLineS!)
    // Symmetric geometry, symmetric times.
    expect(r.timeToPortEndS!).toBeCloseTo(r.timeToStarboardEndS!, 3)
  })
})

// --------------------------------------------------------------- degradation

describe('graceful degradation', () => {
  const finiteOrNull = (v: unknown): boolean =>
    v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

  it('never returns NaN or undefined in any field', () => {
    const cases = [
      { line: lineOf(100), wind: windOf(0) as WindEstimate | null, state: stateOf() },
      { line: { port: null, starboard: null, gunTime: null }, wind: null, state: stateOf() },
      { line: lineOf(100, null), wind: null, state: stateOf() },
      // A bad fix: one NaN must not propagate into every number on the display.
      { line: lineOf(100), wind: windOf(0), state: stateOf({ sog: Number.NaN }) },
      { line: lineOf(100), wind: windOf(0), state: stateOf({ bsp: Number.NaN, sog: 4 }) },
    ]
    for (const c of cases) {
      const r = computeStart({
        line: c.line,
        state: c.state,
        wind: c.wind,
        boat: boatOf(),
        now: NOW,
      })
      for (const [k, v] of Object.entries(r)) {
        expect(`${k}=${String(v)}`).toBe(`${k}=${String(v)}`)
        expect(finiteOrNull(v) || typeof v === 'string').toBe(true)
      }
    }
  })

  it('nulls everything line-shaped when an end has not been pinged', () => {
    const r = computeStart({
      line: { port: null, starboard: destination(MID, 90, mToNm(50)), gunTime: NOW + 60_000 },
      state: stateOf(),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    expect(r.lineLengthM).toBeNull()
    expect(r.lineSquareWindDeg).toBeNull()
    expect(r.biasAngleDeg).toBeNull()
    expect(r.biasLengthM).toBeNull()
    expect(r.favouredEnd).toBeNull()
    expect(r.distanceBelowLineM).toBeNull()
    expect(r.timeToLineS).toBeNull()
    expect(r.timeToBurnS).toBeNull()
    expect(r.ocs).toBe(false)
    // The clock still works without a line.
    expect(r.timeToGunS).toBeCloseTo(60, 9)
  })

  it('nulls the gun-relative numbers when there is no gun time', () => {
    const r = computeStart({
      line: lineOf(100, null),
      state: stateOf(),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    expect(r.timeToGunS).toBeNull()
    expect(r.timeToBurnS).toBeNull()
    // Everything geometric survives.
    expect(r.timeToLineS).not.toBeNull()
    expect(r.distanceBelowLineM).toBeCloseTo(50, 2)
    expect(r.biasAngleDeg).toBeCloseTo(0, 3)
  })

  it('keeps the geometry and the GPS time when there is no wind estimate', () => {
    const r = computeStart({
      line: lineOf(100),
      state: stateOf({ position: off(180, 100) }),
      wind: null,
      boat: boatOf(),
      now: NOW,
    })
    expect(r.biasAngleDeg).toBeNull()
    expect(r.biasLengthM).toBeNull()
    expect(r.favouredEnd).toBeNull()
    expectAngle(r.lineSquareWindDeg, 0)
    expect(r.lineLengthM).toBeCloseTo(100, 3)
    expect(r.distanceBelowLineM).toBeCloseTo(100, 2)
    expect(r.timeToLineS).not.toBeNull()
  })

  it('works with no polar lattice at all — the MVP path', () => {
    const r = computeStart({
      line: lineOf(100),
      state: stateOf({ position: off(180, 100), cog: 0, sog: 6 }),
      wind: windOf(0),
      boat: boatOf(),
      lattice: null,
      now: NOW,
    })
    expect(r.timeToLineS).not.toBeNull()
    expect(Number.isFinite(r.timeToLineS!)).toBe(true)
  })

  it('survives a boat that is not moving', () => {
    const r = computeStart({
      line: lineOf(100),
      state: stateOf({ sog: 0, bsp: 0, cog: 0, heading: 0 }),
      wind: windOf(0),
      boat: boatOf(),
      lattice: fakeLattice(),
      now: NOW,
    })
    expect(r.distanceBelowLineM).toBeCloseTo(50, 2)
    expect(r.timeToGunS).toBeCloseTo(60, 9)
  })

  it('survives both ends pinged in the same place', () => {
    const p = destination(MID, 90, mToNm(1))
    const r = computeStart({
      line: { port: p, starboard: p, gunTime: NOW + 60_000 },
      state: stateOf(),
      wind: windOf(0),
      boat: boatOf(),
      now: NOW,
    })
    expect(r.lineLengthM).toBeCloseTo(0, 6)
    expect(r.biasAngleDeg).toBeNull()
    expect(r.distanceBelowLineM).toBeNull()
  })
})

// ------------------------------------------------------------- the dynamics

describe('turn and acceleration dynamics', () => {
  it('has a sane default turn model', () => {
    // No steerage way at rest, saturating with speed.
    expect(DEFAULT_TURN_MODEL.rotDegPerSec(0)).toBeCloseTo(2, 9)
    expect(DEFAULT_TURN_MODEL.rotDegPerSec(6)).toBeCloseTo(2 + 10 * (6 / 8.5), 6)
    expect(DEFAULT_TURN_MODEL.rotDegPerSec(30)).toBeLessThan(12)
    expect(DEFAULT_TURN_MODEL.rotDegPerSec(30)).toBeGreaterThan(
      DEFAULT_TURN_MODEL.rotDegPerSec(6),
    )
    // A 90° tack at 6 kn takes about ten seconds.
    expect(90 / DEFAULT_TURN_MODEL.rotDegPerSec(6)).toBeGreaterThan(8)
    expect(90 / DEFAULT_TURN_MODEL.rotDegPerSec(6)).toBeLessThan(12)
    // Acceleration scales with wind and peaks on a reach.
    expect(DEFAULT_TURN_MODEL.accelKnPerMin(0, 90)).toBe(0)
    expect(DEFAULT_TURN_MODEL.accelKnPerMin(10, 90)).toBeCloseTo(8, 9)
    expect(DEFAULT_TURN_MODEL.accelKnPerMin(20, 90)).toBeCloseTo(16, 9)
    expect(DEFAULT_TURN_MODEL.accelKnPerMin(10, 40)).toBeLessThan(
      DEFAULT_TURN_MODEL.accelKnPerMin(10, 90),
    )
  })

  it('charges for the turn and for the acceleration', () => {
    const lattice = fakeLattice()
    const wind = windOf(0, 12)
    const boat = boatOf()
    const from = MID
    const to = destination(MID, 90, 0.2)
    // Sailing 090 in a northerly is a beam reach: 12 · 0.55 · sin(...) kn.
    const target = lattice.speed(12, 90)
    const idealS = (0.2 / target) * 3600

    const straight = timeToPoint({
      from,
      to,
      state: stateOf({ position: from, cog: 90, heading: 90, bsp: target, sog: target }),
      wind,
      lattice,
      boat,
    })!
    // Already up to speed and pointing at it: the ideal time, near enough.
    expect(straight).toBeCloseTo(idealS, 1)

    const afterTurn = timeToPoint({
      from,
      to,
      state: stateOf({ position: from, cog: 0, heading: 0, bsp: 3, sog: 3 }),
      wind,
      lattice,
      boat,
    })!
    // 90° of turn plus building from 3 kn: strictly slower than the ideal.
    expect(afterTurn).toBeGreaterThan(idealS)
    expect(afterTurn).toBeGreaterThan(straight)
  })

  it('returns null for a point the polar cannot sail to', () => {
    // Dead upwind with a no-go zone of 30°: unreachable in a straight line.
    const t = timeToPoint({
      from: MID,
      to: destination(MID, 0, 0.5),
      state: stateOf({ position: MID, cog: 0, heading: 0, bsp: 5, sog: 5 }),
      wind: windOf(0, 12),
      lattice: fakeLattice(),
      boat: boatOf(),
    })
    expect(t).toBeNull()
  })

  it('falls back to constant speed with no lattice', () => {
    // 0.1 nm dead ahead at 6 kn = 60 s exactly, no polar involved.
    const t = timeToPoint({
      from: MID,
      to: destination(MID, 0, 0.1),
      state: stateOf({ position: MID, cog: 0, heading: 0, bsp: 6, sog: 6 }),
      wind: windOf(90, 12),
      boat: boatOf(),
    })
    expect(t).toBeCloseTo(60, 6)
  })
})

describe('boat reference points', () => {
  it('projects the bow along the heading, falling back to COG', () => {
    const boat = boatOf({ bowToGpsMetres: 10 })
    const withHeading = bowPosition(stateOf({ position: MID, heading: 90, cog: 0 }), boat)
    expect(withHeading.lon).toBeGreaterThan(MID.lon)
    expect(withHeading.lat).toBeCloseTo(MID.lat, 6)

    const withoutHeading = bowPosition(stateOf({ position: MID, heading: null, cog: 0 }), boat)
    expect(withoutHeading.lat).toBeGreaterThan(MID.lat)

    const noOffset = bowPosition(stateOf({ position: MID, heading: 90 }), boatOf())
    expect(noOffset).toEqual(MID)
  })

  it('dead-reckons the position at the gun', () => {
    // 6 kn for 60 s = 0.1 nm north. A degree of latitude on our sphere is
    // R_NM · π/180 = 60.0404 nm, not exactly 60 — the nautical mile is defined
    // on the ellipsoid, geo.ts works on a sphere.
    const degPerNm = 1 / 60.04043
    const p = positionAtGun(stateOf({ position: MID, cog: 0, sog: 6 }), NOW + 60_000)!
    expect(p.lat).toBeCloseTo(MID.lat + 0.1 * degPerNm, 8)
    expect(p.lon).toBeCloseTo(MID.lon, 9)
    // Runs backwards happily once the gun has fired.
    const past = positionAtGun(stateOf({ position: MID, cog: 0, sog: 6 }), NOW - 60_000)!
    expect(past.lat).toBeCloseTo(MID.lat - 0.1 * degPerNm, 8)
    expect(positionAtGun(stateOf(), Number.NaN)).toBeNull()
  })
})
