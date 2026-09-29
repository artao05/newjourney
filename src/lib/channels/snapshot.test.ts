import { describe, expect, it } from 'vitest'
import { CHANNELS } from './catalogue'
import { PRODUCERS, buildSnapshot, type SnapshotInputs } from './snapshot'
import { BoatSim, makeStartLine } from '@/lib/sim'
import { findPolar } from '@/data/polars'
import { buildLattice } from '@/lib/polar'
import { computeTactics } from '@/lib/tactics'
import { computeStart } from '@/lib/startline'
import { destination } from '@/lib/geo'
import type { Boat, Course } from '@/lib/types'
import { gateAround, gateNumbers } from '@/lib/gates'

const BOAT: Boat = {
  id: 'me',
  name: 'Test',
  className: 'J/70',
  loaMetres: 6.93,
  bowToGpsMetres: 3,
  mastHeightMetres: 11,
  polarPct: 100,
  polarPctNight: 96,
  tackPenaltyS: 12,
  gybePenaltyS: 8,
}

/**
 * A simulated boat mid-beat, two marks upwind, a pinged line and a gun to come.
 * `twa` picks the tack: +45 is starboard, -45 port. `lineAhead` puts the line
 * upwind of her instead of behind.
 */
function simulated(twa = 45, lineAhead = false): SnapshotInputs {
  const lattice = buildLattice(findPolar('j70')!.polar)
  const start = { lat: 43.65, lon: -70.2 }
  const current = { set: 45, drift: 0.6, source: 'sim' }
  // Close-hauled on the app's own autopilot, settled for five minutes.
  const sim = new BoatSim({ start, twd: 200, tws: 12, current, lattice }, 7)
  sim.setAutopilot({ mode: 'twa', twa })
  let state = sim.step(1)
  for (let k = 0; k < 300; k++) state = sim.step(1)
  // Behind the boat by default, which has beaten away from it; ahead of her when
  // asked, for the approaches that need the line in front: the reach.
  const line = makeStartLine(destination(lineAhead ? state.position : start, lineAhead ? 200 : 20, 0.05), 200)
  const course: Course = {
    id: 'c',
    name: 'c',
    marks: [
      { id: 'w', name: 'W', position: destination(start, 200, 3), roundTo: 'port' },
      { id: 'l', name: 'L', position: destination(start, 20, 0.4), roundTo: 'port' },
    ],
    startLine: { ...line, gunTime: state.t + 120_000 },
  }
  const wind = { twd: 200, tws: 12, source: 'manual' as const, uncertaintyDeg: 8, t: state.t }
  const tactics = computeTactics({ state, wind, current, boat: BOAT, lattice, course, activeMarkIndex: 0 })
  const startNums = computeStart({ line: course.startLine, state, wind, current, boat: BOAT, lattice, now: state.t })
  return {
    now: state.t,
    state,
    wind,
    current,
    tactics,
    start: startNums,
    course,
    activeMarkIndex: 0,
    variationDeg: -14.5,
  }
}

describe('the live channel snapshot', () => {
  it("produces exactly the channels the catalogue says are produced today, no more and no fewer", () => {
    const today = CHANNELS.filter((c) => c.today).map((c) => c.id).sort()
    expect(Object.keys(PRODUCERS).sort()).toEqual(today)
  })

  it('gives every today channel a real value on a simulated beat, on one tack or the other', () => {
    // Layline distance and time are for the layline this tack is heading for, so
    // port and starboard can never both be filled at once. Across both tacks,
    // every channel must be.
    // Gate channels need the active mark to be a gate; give the beat one.
    const withGate = (i: SnapshotInputs): SnapshotInputs => {
      const w = i.course.marks[0].position
      return {
        ...i,
        gate: gateNumbers({ from: i.state!.position, ...gateAround(w, 200, 80), wind: i.wind, lattice: null }),
      }
    }
    const tacks = [
      buildSnapshot(withGate(simulated(45))),
      buildSnapshot(withGate(simulated(-45))),
      buildSnapshot(withGate(simulated(45, true))),
    ]
    const missing = CHANNELS.filter((c) => c.today && tacks.every((snap) => snap[c.id] == null)).map(
      (c) => c.id,
    )
    expect(missing).toEqual([])
  })

  it('has a slot for every catalogued channel, null where nothing produces it', () => {
    const snap = buildSnapshot(simulated())
    expect(Object.keys(snap)).toHaveLength(CHANNELS.length)
    expect(snap['backstay']).toBeNull()
    expect(snap['awa']).toBeNull()
  })

  it('turns a missing fix into nulls, not zeros or NaN', () => {
    const snap = buildSnapshot({ ...simulated(), state: null, tactics: null, start: null })
    expect(snap['sog']).toBeNull()
    expect(snap['mark-range']).toBeNull()
    expect(Object.values(snap).some((v) => typeof v === 'number' && !Number.isFinite(v))).toBe(false)
  })

  it('reads the wind from tactics first, so a what-if shows everywhere', () => {
    const i = simulated()
    const snap = buildSnapshot({ ...i, tactics: { ...i.tactics!, twd: 210 } })
    expect(snap['twd']).toBe(210)
  })
})
