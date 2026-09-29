import { describe, expect, it } from 'vitest'
import { courseLegs } from './legs'
import { destination } from './geo'
import { buildLattice } from './polar'
import { findPolar } from '@/data/polars'
import { markTime } from './tactics'
import type { Boat } from './types'

const BOAT: Boat = {
  id: 'me', name: 'T', className: 'J/70', loaMetres: 6.93, bowToGpsMetres: 3,
  mastHeightMetres: 11, polarPct: 100, polarPctNight: 96, tackPenaltyS: 12, gybePenaltyS: 8,
}
const A = { lat: 43.6, lon: -70.2 }

describe('the legs table', () => {
  it('runs from the start through every mark, with bearing and distance', () => {
    const w = destination(A, 0, 1)
    const l = destination(w, 90, 2)
    const legs = courseLegs({
      start: { name: 'Boat', position: A },
      marks: [{ name: 'W', position: w }, { name: 'L', position: l }],
      wind: null,
      lattice: null,
      boat: BOAT,
    })
    expect(legs.map((x) => `${x.from}>${x.to}`)).toEqual(['Boat>W', 'W>L'])
    expect(legs[0].bearing).toBeCloseTo(0, 6)
    expect(legs[0].distanceNm).toBeCloseTo(1, 6)
    expect(legs[1].distanceNm).toBeCloseTo(2, 6)
    // No wind, no angle and no time: never a made-up number.
    expect(legs.every((x) => x.offWindDeg === null && x.timeS === null && x.elapsedS === null)).toBe(true)
  })

  it('gives each leg its angle off the wind and polar time, and adds them up', () => {
    const lattice = buildLattice(findPolar('j70')!.polar)
    const wind = { twd: 0, tws: 12 }
    const w = destination(A, 0, 1)
    const r = destination(w, 90, 1)
    const legs = courseLegs({
      start: { name: 'Boat', position: A },
      marks: [{ name: 'W', position: w }, { name: 'R', position: r }],
      wind,
      lattice,
      boat: BOAT,
    })
    expect(legs[0].offWindDeg).toBeCloseTo(0, 3) // a dead beat
    expect(legs[1].offWindDeg).toBeCloseTo(90, 0) // a beam reach
    const targets = lattice.targetsAt(12)
    expect(legs[0].timeS).toBeCloseTo(markTime(1, legs[0].offWindDeg!, targets, BOAT, lattice, 12)!, 6)
    expect(legs[1].elapsedS).toBeCloseTo(legs[0].timeS! + legs[1].timeS!, 6)
    // The beat includes a tack; the reach does not.
    expect(legs[0].timeS! > 3600 / (targets.upVmg || 1)).toBe(true)
  })

  it('has no legs from a lone mark with no start', () => {
    expect(courseLegs({ start: null, marks: [{ name: 'W', position: A }], wind: null, lattice: null, boat: BOAT })).toEqual([])
  })
})
