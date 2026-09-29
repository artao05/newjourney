import { describe, expect, it } from 'vitest'
import { thinLegs, turningPoints, windAlongRouteFC } from './results'
import type { RouteLeg } from '@/lib/types'

const leg = (i: number, heading: number, over: Partial<RouteLeg> = {}): RouteLeg => ({
  t: i * 60_000, position: { lat: 43 + i * 0.001, lon: -70 }, twd: 0, tws: 12, twa: 45, bsp: 6, heading,
  isBeating: false, tack: 'starboard', currentSet: null, currentDrift: null, distanceNm: 0.1, ...over,
})

describe('route results', () => {
  it('thins a long route to a readable number of legs, keeping the last', () => {
    const legs = Array.from({ length: 100 }, (_, i) => leg(i, 0))
    const thin = thinLegs(legs, 24)
    expect(thin.length).toBeLessThanOrEqual(26)
    expect(thin.at(-1)).toBe(legs.at(-1))
    expect(thinLegs(legs.slice(0, 5))).toHaveLength(5)
  })

  it('draws the wind at each leg downwind, longer in more wind, with its speed', () => {
    const fc = windAlongRouteFC([leg(0, 0, { tws: 5 }), leg(1, 0, { tws: 25 })])
    const len = (i: number) => {
      const [[x0, y0], [x1, y1]] = (fc.features[i].geometry as GeoJSON.LineString).coordinates
      return { dy: y1 - y0, dx: x1 - x0 }
    }
    // Wind from the north: the line runs south of the leg.
    expect(len(0).dy).toBeLessThan(0)
    expect(Math.abs(len(1).dy)).toBeGreaterThan(Math.abs(len(0).dy))
    expect(fc.features[1].properties).toMatchObject({ label: '25' })
  })

  it('keeps the start, the finish and the turns, not every leg', () => {
    const legs = [leg(0, 0), leg(1, 2), leg(2, 4), leg(3, 90), leg(4, 92), leg(5, 180), leg(6, 181)]
    expect(turningPoints(legs).map((l) => l.heading)).toEqual([0, 90, 180, 181])
    // Across north, 350 to 10 is 20 degrees.
    expect(turningPoints([leg(0, 350), leg(1, 10), leg(2, 12)]).map((l) => l.heading)).toEqual([350, 10, 12])
  })
})
