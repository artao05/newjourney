import { describe, expect, it } from 'vitest'
import { distanceToLeg, nearestLegInsert } from './courseEdit'
import { distance } from './geo'

const A = { lat: 43.6, lon: -70.2 }
const B = { lat: 43.7, lon: -70.2 }
const C = { lat: 43.7, lon: -70.0 }

describe('the nearest leg', () => {
  it('measures to the leg, or to an end past it', () => {
    // A mile east of the middle of a north-south leg.
    const beside = { lat: 43.65, lon: -70.2 + 1 / 60 / Math.cos((43.65 * Math.PI) / 180) }
    expect(distanceToLeg(beside, A, B)).toBeCloseTo(1, 2)
    const pastB = { lat: 43.75, lon: -70.2 }
    expect(distanceToLeg(pastB, A, B)).toBeCloseTo(distance(pastB, B), 9)
    expect(distanceToLeg(A, A, A)).toBe(0)
  })

  it('puts a mark into the leg it is nearest, counting from the start when there is one', () => {
    const marks = [A, B, C]
    // Near the B → C leg: between them, at index 2.
    expect(nearestLegInsert(marks, { lat: 43.71, lon: -70.1 })).toBe(2)
    // Near the A → B leg: at index 1.
    expect(nearestLegInsert(marks, { lat: 43.65, lon: -70.21 })).toBe(1)
    // From a start to the south, the first leg runs to A: index 0.
    expect(nearestLegInsert(marks, { lat: 43.55, lon: -70.2 }, { lat: 43.5, lon: -70.2 })).toBe(0)
    // No legs: the end.
    expect(nearestLegInsert([A], B)).toBe(1)
    expect(nearestLegInsert([], B)).toBe(0)
  })
})
