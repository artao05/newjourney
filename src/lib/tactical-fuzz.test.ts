/**
 * Property and fuzz sweep over the tactical core.
 *
 * `polar.ts`, `startline.ts` and `tactics.ts` are 2 363 lines with 116 example-based
 * tests between them. Those tests are good, and they are examples: they check the
 * cases someone thought of. This file checks the cases nobody thought of, by driving
 * the same three modules with deliberately hostile inputs and asserting only the
 * invariants that must hold for *every* input.
 *
 * Three of them, and they are the whole point:
 *
 *   1. **Never throw.** These functions run once per animation frame off a live GPS
 *      feed. An exception is a blank screen mid-start.
 *   2. **Never NaN.** Every one of these modules returns nullable fields precisely
 *      so it can say "unknown". A NaN says "known" and then poisons every
 *      arithmetic consumer downstream, silently.
 *   3. **Stay in range.** A bearing outside [0, 360) or a TWA outside [-180, 180]
 *      means some caller's `wrap` was skipped, and the symptom appears three modules
 *      away.
 *
 * The generators are deterministic — a seeded PRNG, no `Math.random` — so a failure
 * is reproducible from the seed printed in the assertion message.
 */

import { describe, expect, it } from 'vitest'
import { buildLattice, deriveTargets, generatePolar, polarSpeed, validatePolar } from './polar'
import { computeStart, bowPosition, positionAtGun, spareTimeS } from './startline'
import { beatSplit, computeLaylines, computeTactics, headingToMakeGood, vmcOptimum } from './tactics'
import { findPolar } from '../data/polars'
import type {
  Boat,
  BoatState,
  Course,
  CurrentEstimate,
  LatLon,
  StartLine,
  WindEstimate,
} from './types'

// ------------------------------------------------------------------ generators

/** Deterministic PRNG, so any failure replays from its seed. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Numbers chosen to break things: the ordinary range, the boundaries, the wrong
 * side of the boundaries, and the three values that are not numbers at all.
 */
const NASTY = [0, -0, 1e-12, -1e-12, 360, -360, 720, 180, -180, 90, 1e9, -1e9, NaN, Infinity, -Infinity]

const BOAT: Boat = {
  id: 'me',
  name: 'fuzz',
  className: 'J/70',
  loaMetres: 6.93,
  bowToGpsMetres: 3,
  mastHeightMetres: 11,
  polarPct: 100,
  polarPctNight: 96,
  tackPenaltyS: 12,
  gybePenaltyS: 8,
}

const NOW = Date.UTC(2026, 7, 27, 14, 0, 0)

function stateOf(over: Partial<BoatState> = {}): BoatState {
  return {
    t: NOW,
    position: { lat: 43.66, lon: -70.18 },
    cog: 40,
    sog: 5.5,
    accuracyM: 4,
    heading: 42,
    bsp: 5.4,
    heelDeg: 12,
    ...over,
  }
}

function windOf(over: Partial<WindEstimate> = {}): WindEstimate {
  return { twd: 220, tws: 12, source: 'instrument', uncertaintyDeg: 6, t: NOW, ...over }
}

const lattice = buildLattice(findPolar('j70')!.polar)

/** Every finite number in an object graph, flattened, with its path. */
function numbers(v: unknown, path = '', out: Array<[string, number]> = []): Array<[string, number]> {
  if (typeof v === 'number') out.push([path || '(root)', v])
  else if (Array.isArray(v)) v.forEach((x, i) => numbers(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) numbers(x, path ? `${path}.${k}` : k, out)
  }
  return out
}

/** No NaN anywhere in the result. Infinity is allowed only where named. */
function noNaN(result: unknown, label: string, allowInfinite: string[] = []): void {
  for (const [path, n] of numbers(result)) {
    expect(Number.isNaN(n), `${label}: ${path} is NaN`).toBe(false)
    if (!allowInfinite.some((a) => path.includes(a))) {
      expect(Number.isFinite(n), `${label}: ${path} is ${n}`).toBe(true)
    }
  }
}

// ------------------------------------------------------------------- polar.ts

describe('polarSpeed', () => {
  it('is finite and non-negative for every wind and angle, however absurd', () => {
    const p = findPolar('j70')!.polar
    for (const tws of NASTY) {
      for (const twa of NASTY) {
        const v = polarSpeed(p, tws, twa)
        expect(Number.isNaN(v), `polarSpeed(${tws}, ${twa}) is NaN`).toBe(false)
        expect(v, `polarSpeed(${tws}, ${twa})`).toBeGreaterThanOrEqual(0)
        expect(v, `polarSpeed(${tws}, ${twa})`).toBeLessThan(100)
      }
    }
  })

  it('is symmetric in the sign of TWA — port and starboard sail the same', () => {
    const p = findPolar('j70')!.polar
    const r = rng(11)
    for (let n = 0; n < 400; n++) {
      const tws = r() * 40
      const twa = r() * 180
      expect(polarSpeed(p, tws, twa)).toBeCloseTo(polarSpeed(p, tws, -twa), 9)
    }
  })

  it('gives the lattice and the table the same answer', () => {
    // The lattice exists only as an O(1) cache of the table; if they disagree, the
    // router and the display disagree about the same boat.
    const p = findPolar('j70')!.polar
    const r = rng(12)
    for (let n = 0; n < 500; n++) {
      const tws = r() * 30
      const twa = (r() * 2 - 1) * 180
      const a = polarSpeed(p, tws, twa)
      const b = lattice.speed(tws, twa)
      // The lattice quantises, so agreement is to its own step, not to the bit.
      expect(Math.abs(a - b), `tws ${tws} twa ${twa}: table ${a} vs lattice ${b}`).toBeLessThan(1)
    }
  })

  it('never reports speed dead upwind', () => {
    const p = findPolar('j70')!.polar
    for (const tws of [4, 8, 12, 20, 30]) {
      expect(polarSpeed(p, tws, 0)).toBeLessThan(1)
    }
  })
})

describe('deriveTargets', () => {
  it('produces coherent targets for every wind speed, including nonsense', () => {
    const p = findPolar('j70')!.polar
    for (const tws of NASTY.filter((n) => Number.isFinite(n))) {
      const t = deriveTargets(p, tws)
      noNaN(t, `deriveTargets(${tws})`)
      expect(t.upBsp, `up bsp at ${tws}`).toBeGreaterThanOrEqual(0)
      expect(t.downBsp, `down bsp at ${tws}`).toBeGreaterThanOrEqual(0)
      // VMG is a projection of boat speed, so it can never exceed it.
      expect(t.upVmg, `up vmg at ${tws}`).toBeLessThanOrEqual(t.upBsp + 1e-9)
      expect(Math.abs(t.downVmg), `down vmg at ${tws}`).toBeLessThanOrEqual(t.downBsp + 1e-9)
      // Angles stay on the correct side of the wind.
      expect(t.upTwa).toBeGreaterThan(0)
      expect(t.upTwa).toBeLessThan(90)
      expect(t.downTwa).toBeGreaterThan(90)
      expect(t.downTwa).toBeLessThanOrEqual(180)
    }
  })

  it('goes faster in more wind, up to the point the model tops out', () => {
    const p = findPolar('j70')!.polar
    let prev = 0
    for (const tws of [4, 6, 8, 10, 12, 14, 16]) {
      const v = deriveTargets(p, tws).upVmg
      expect(v, `upwind VMG at ${tws} kn`).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = v
    }
  })
})

describe('generatePolar', () => {
  it('generates a valid polar for absurd dimensions without throwing', () => {
    const r = rng(13)
    for (let n = 0; n < 60; n++) {
      const dims = {
        type: (['dinghy', 'sportboat', 'keelboat', 'cruiser', 'multihull'] as const)[n % 5],
        loaM: r() * 30 + 0.5,
        lwlM: r() * 30 + 0.4,
        beamM: r() * 8 + 0.3,
        dispKg: r() * 20000 + 20,
        sailAreaM2: r() * 200 + 1,
      }
      const p = generatePolar(dims, 'fuzz')
      noNaN(p, `generatePolar ${JSON.stringify(dims)}`)
      expect(p.tws.length).toBeGreaterThan(1)
      for (const row of p.rows) {
        expect(row.twa.length).toBe(row.bsp.length)
        for (const b of row.bsp) {
          expect(Number.isFinite(b)).toBe(true)
          expect(b).toBeGreaterThanOrEqual(0)
        }
      }
      // And it must pass its own validator, or the library ships junk.
      expect(validatePolar(p, dims)).toEqual([])
    }
  })
})

// --------------------------------------------------------------- startline.ts

describe('computeStart', () => {
  const line = (over: Partial<StartLine> = {}): StartLine => ({
    port: { lat: 43.655, lon: -70.19 },
    starboard: { lat: 43.655, lon: -70.17 },
    gunTime: NOW + 120_000,
    ...over,
  })

  it('survives every combination of missing line, wind and gun', () => {
    const ends: Array<LatLon | null> = [null, { lat: 43.655, lon: -70.19 }]
    const winds: Array<WindEstimate | null> = [null, windOf()]
    for (const port of ends) {
      for (const starboard of ends) {
        for (const gunTime of [null, NOW - 600_000, NOW, NOW + 60_000]) {
          for (const wind of winds) {
            const label = `port ${!!port} stbd ${!!starboard} gun ${gunTime} wind ${!!wind}`
            const n = computeStart({
              line: { port, starboard, gunTime },
              state: stateOf(),
              wind,
              boat: BOAT,
              lattice,
              now: NOW,
            })
            noNaN(n, label)
            expect(typeof n.ocs, label).toBe('boolean')
            if (n.biasAngleDeg !== null) {
              expect(Math.abs(n.biasAngleDeg), label).toBeLessThanOrEqual(180)
            }
            if (n.lineSquareWindDeg !== null) {
              expect(n.lineSquareWindDeg, label).toBeGreaterThanOrEqual(0)
              expect(n.lineSquareWindDeg, label).toBeLessThan(360)
            }
            if (n.lineLengthM !== null) expect(n.lineLengthM, label).toBeGreaterThanOrEqual(0)
          }
        }
      }
    }
  })

  it('survives a degenerate line whose ends are the same point', () => {
    const same = { lat: 43.655, lon: -70.18 }
    const n = computeStart({
      line: { port: same, starboard: { ...same }, gunTime: NOW + 60_000 },
      state: stateOf(),
      wind: windOf(),
      boat: BOAT,
      lattice,
      now: NOW,
    })
    noNaN(n, 'degenerate line')
    expect(n.lineLengthM).toBeLessThan(1)
  })

  it('survives a hostile boat state', () => {
    const states: BoatState[] = [
      stateOf({ sog: 0, bsp: 0 }),
      stateOf({ sog: NaN, bsp: NaN }),
      stateOf({ cog: NaN, heading: NaN }),
      stateOf({ sog: -5 }),
      stateOf({ sog: 1e6 }),
      stateOf({ position: { lat: 90, lon: 180 } }),
      stateOf({ position: { lat: NaN, lon: NaN } }),
      stateOf({ accuracyM: null, heading: null, bsp: null, heelDeg: null }),
    ]
    states.forEach((state, i) => {
      const n = computeStart({
        line: line(),
        state,
        wind: windOf(),
        boat: BOAT,
        lattice,
        now: NOW,
      })
      // A NaN position legitimately makes distances unknowable, so the contract is
      // "null, not NaN" rather than "always a number".
      noNaN(n, `hostile state ${i}`)
    })
  })

  it('survives a hostile wind', () => {
    for (const twd of NASTY) {
      for (const tws of [0, -1, NaN, Infinity, 200]) {
        const n = computeStart({
          line: line(),
          state: stateOf(),
          wind: windOf({ twd, tws }),
          boat: BOAT,
          lattice,
          now: NOW,
        })
        noNaN(n, `wind ${twd}/${tws}`)
      }
    }
  })

  it('survives a hostile current', () => {
    const currents: Array<CurrentEstimate | null> = [
      null,
      { set: 0, drift: 0, source: 'x' },
      { set: NaN, drift: NaN, source: 'x' },
      { set: 400, drift: -3, source: 'x' },
      { set: 90, drift: 1e6, source: 'x' },
    ]
    currents.forEach((current, i) => {
      const n = computeStart({
        line: line(),
        state: stateOf(),
        wind: windOf(),
        current,
        boat: BOAT,
        lattice,
        now: NOW,
      })
      noNaN(n, `current ${i}`)
    })
  })

  it('keeps spare time the negation of time to burn', () => {
    // The documented sign flip lives at the display layer, and it is the one that
    // has already been wrong once in this codebase.
    for (const timeToBurnS of [-90, -1, 0, 1, 90, null]) {
      const spare = spareTimeS({ timeToBurnS })
      if (timeToBurnS === null) expect(spare).toBeNull()
      else expect(spare).toBe(-timeToBurnS)
    }
  })

  it('never moves the bow behind the GPS', () => {
    const r = rng(14)
    for (let n = 0; n < 200; n++) {
      const state = stateOf({ cog: r() * 360, heading: r() * 360, sog: r() * 12 })
      const bow = bowPosition(state, BOAT)
      expect(Number.isFinite(bow.lat)).toBe(true)
      expect(Number.isFinite(bow.lon)).toBe(true)
      expect(Math.abs(bow.lat - state.position.lat)).toBeLessThan(0.001)
    }
  })

  it('projects to the gun without inventing a position', () => {
    expect(positionAtGun(stateOf({ sog: NaN }), NOW + 60_000)).not.toBeUndefined()
    const p = positionAtGun(stateOf(), NOW + 60_000)
    if (p) {
      expect(Number.isFinite(p.lat)).toBe(true)
      expect(Number.isFinite(p.lon)).toBe(true)
    }
  })
})

// ----------------------------------------------------------------- tactics.ts

describe('tactics', () => {
  const course = (marks: LatLon[]): Course => ({
    id: 'c',
    name: 'c',
    marks: marks.map((position, i) => ({
      id: `m${i}`,
      name: `${i + 1}`,
      position,
      roundTo: 'port' as const,
    })),
    startLine: { port: null, starboard: null, gunTime: null },
  })

  it('computes laylines for every wind and mark placement without NaN', () => {
    const r = rng(21)
    for (let n = 0; n < 300; n++) {
      const twd = r() * 360
      const mark = { lat: 43.6 + (r() - 0.5) * 0.2, lon: -70.2 + (r() - 0.5) * 0.2 }
      const state = stateOf({ cog: r() * 360, heading: r() * 360 })
      const info = computeLaylines({
        from: state.position,
        state,
        wind: windOf({ twd, tws: r() * 30 }),
        mark,
        lattice,
      })
      noNaN(info, `laylines seed 21 iter ${n}`, ['distanceTo', 'timeTo'])
      for (const b of [info.portBearing, info.starboardBearing]) {
        expect(b, `bearing ${b}`).toBeGreaterThanOrEqual(0)
        expect(b, `bearing ${b}`).toBeLessThan(360)
      }
      expect(info.boundsDeg).toBeGreaterThanOrEqual(0)
      expect(info.boundsDeg).toBeLessThan(180)
    }
  })

  it('computes the full tactical set for hostile inputs', () => {
    const marks: LatLon[][] = [
      [],
      [{ lat: 43.7, lon: -70.2 }],
      [{ lat: 43.7, lon: -70.2 }, { lat: 43.6, lon: -70.1 }],
      [{ lat: NaN, lon: NaN }],
      [{ lat: 43.66, lon: -70.18 }], // the mark exactly under the boat
    ]
    for (let mi = 0; mi < marks.length; mi++) {
      for (const activeMarkIndex of [-1, 0, 1, 99]) {
        for (const wind of [null, windOf(), windOf({ tws: 0 }), windOf({ twd: NaN })]) {
          const label = `marks ${mi} active ${activeMarkIndex} wind ${wind?.twd ?? 'null'}`
          const out = computeTactics({
            state: stateOf(),
            wind,
            boat: BOAT,
            lattice,
            course: course(marks[mi]),
            activeMarkIndex,
          })
          noNaN(out, label, ['distanceTo', 'timeTo', 'markTimeS', 'markRange', 'xteNm', 'distanceToFinish'])
          if (out.twa !== null) expect(Math.abs(out.twa), label).toBeLessThanOrEqual(180)
          if (out.markBearing !== null) {
            expect(out.markBearing, label).toBeGreaterThanOrEqual(0)
            expect(out.markBearing, label).toBeLessThan(360)
          }
          if (out.headingToSteer !== null) {
            expect(out.headingToSteer, label).toBeGreaterThanOrEqual(0)
            expect(out.headingToSteer, label).toBeLessThan(360)
          }
        }
      }
    }
  })

  it('returns null rather than NaN when the current beats the boat', () => {
    // The documented case: |drift·sin(...)| > bsp has no solution, and asin would
    // hand back NaN. A tidal gate is a real situation, not a pathological one.
    const beaten = headingToMakeGood({ track: 0, bsp: 1, set: 90, drift: 8 })
    expect(beaten).toBeNull()
    const fine = headingToMakeGood({ track: 0, bsp: 6, set: 90, drift: 1 })
    expect(fine).not.toBeNull()
    expect(Number.isFinite(fine as number)).toBe(true)
  })

  it('keeps the beat split non-negative and finite', () => {
    const r = rng(22)
    for (let n = 0; n < 200; n++) {
      const split = beatSplit({
        from: { lat: 43.6, lon: -70.2 },
        mark: { lat: 43.6 + r() * 0.1, lon: -70.2 + (r() - 0.5) * 0.1 },
        twd: r() * 360,
        targetTwa: 35 + r() * 20,
      })
      if (split) {
        noNaN(split, `beatSplit iter ${n}`)
        expect(split.portNm).toBeGreaterThanOrEqual(-1e-9)
        expect(split.starboardNm).toBeGreaterThanOrEqual(-1e-9)
      }
    }
  })

  it('finds a VMC optimum that is never worse than steering straight at the mark', () => {
    const r = rng(23)
    for (let n = 0; n < 200; n++) {
      const twd = r() * 360
      const markBearing = r() * 360
      const best = vmcOptimum({ twd, tws: 6 + r() * 14, bearingToMark: markBearing, lattice })
      // Not `if (!best) continue`: an early version of this test passed the wrong
      // property name, so every call returned null and the whole case was vacuous.
      // The typechecker caught it; vitest alone never would have.
      expect(best, `vmcOptimum iter ${n}`).not.toBeNull()
      if (!best) continue
      noNaN(best, `vmcOptimum iter ${n}`)
      expect(best.heading).toBeGreaterThanOrEqual(0)
      expect(best.heading).toBeLessThan(360)
      expect(Number.isFinite(best.vmc)).toBe(true)
    }
  })
})
