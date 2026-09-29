import { describe, expect, it } from 'vitest'
import { reachRaceNote } from './raceNoteReach'

const at = { lat: 43.6, lon: -70.2 }
// A square area a mile north, and a line two miles east.
const mile = 1 / 60
const k = Math.cos((43.6 * Math.PI) / 180)
const area = { kind: 'area', points: [{ lat: 43.6 + mile, lon: -70.21 }, { lat: 43.6 + mile, lon: -70.19 }, { lat: 43.6 + 2 * mile, lon: -70.19 }, { lat: 43.6 + 2 * mile, lon: -70.21 }] }
const line = { kind: 'line', points: [{ lat: 43.55, lon: -70.2 + (2 * mile) / k }, { lat: 43.65, lon: -70.2 + (2 * mile) / k }] }

describe('reaching a race note', () => {
  it('finds the nearest crossing along the COG', () => {
    expect(reachRaceNote(at, 0, [area, line])).toBeCloseTo(1, 3)
    expect(reachRaceNote(at, 90, [area, line])).toBeCloseTo(2, 3)
    // Heading away from both.
    expect(reachRaceNote(at, 225, [area, line])).toBeNull()
    // Points are not boundaries.
    expect(reachRaceNote(at, 0, [{ kind: 'point', points: [{ lat: 43.61, lon: -70.2 }] }])).toBeNull()
  })

  it('finds the way out from inside an area', () => {
    const inside = { lat: 43.6 + 1.5 * mile, lon: -70.2 }
    expect(reachRaceNote(inside, 0, [area])).toBeCloseTo(0.5, 3)
  })
})
