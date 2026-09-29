import { describe, expect, it } from 'vitest'
import { endFromOther, nudgeUpwind } from './lineAdjust'
import { bearing, distance } from './geo'
import { angdiff } from './angles'

const RC = { lat: 43.65, lon: -70.2 }

describe('adjusting a start line', () => {
  it('places an end at a range and bearing from the other end', () => {
    const pin = endFromOther(RC, 250, 280)
    expect(distance(RC, pin) * 1852).toBeCloseTo(250, 3)
    expect(Math.abs(angdiff(bearing(RC, pin), 280))).toBeLessThan(0.01)
  })

  it('nudges an end up or down the wind, and leaves it alone for zero', () => {
    const up = nudgeUpwind(RC, 0, 20)
    expect(up.lat).toBeGreaterThan(RC.lat)
    expect(distance(RC, up) * 1852).toBeCloseTo(20, 3)
    const down = nudgeUpwind(RC, 0, -20)
    expect(down.lat).toBeLessThan(RC.lat)
    expect(nudgeUpwind(RC, 0, 0)).toBe(RC)
  })
})
