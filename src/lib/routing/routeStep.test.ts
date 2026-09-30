import { describe, expect, it } from 'vitest'
import { dnmPct, isochroneNear, isochroneThrough, routeAt, routeSteps } from './routeStep'
import type { Isochrone, RouteLeg } from '../types'

const leg = (t: number, lat: number, bsp = 6): RouteLeg => ({ t, position: { lat, lon: -70 }, twd: 0, tws: 12, twa: 40, bsp, heading: 0, isBeating: false, tack: 'starboard', currentSet: null, currentDrift: null, distanceNm: 1 })
const legs = [leg(0, 43), leg(600_000, 43.1, 7), leg(1_200_000, 43.2)]
// Isochrones every 10 minutes: an east-west line through where the route is.
const iso = (t: number, lat: number): Isochrone => ({ t, points: [-70.05, -70.025, -70, -69.975, -69.95].map((lon) => ({ lat, lon })) })
const isos = [iso(0, 43), iso(600_000, 43.1), iso(1_200_000, 43.2)]

describe('stepping through a route', () => {
  it('steps by the isochrones, or by the legs without them', () => {
    expect(routeSteps({ legs, isochrones: isos })).toEqual([0, 600_000, 1_200_000])
    expect(routeSteps({ legs: legs.slice(0, 2), isochrones: [] })).toEqual([0, 600_000])
  })

  it('has the boat between legs at a time, and says what she has there', () => {
    const at = routeAt(legs, 900_000)!
    expect(at.position.lat).toBeCloseTo(43.15, 9)
    expect(at.leg.bsp).toBe(7)
    expect(routeAt(legs, -5)!.position.lat).toBe(43)
    // At a leg's own time, on that leg.
    expect(routeAt(legs, 600_000)!.leg.bsp).toBe(7)
    expect(routeAt(legs, 9e9)!.position.lat).toBe(43.2)
    expect(routeAt([], 0)).toBeNull()
  })

  it('finds the isochrone for a time, and through a point', () => {
    expect(isochroneNear(isos, 650_000)!.t).toBe(600_000)
    expect(isochroneThrough(isos, { lat: 43.1005, lon: -70.03 })!.iso.t).toBe(600_000)
    expect(isochroneThrough(isos, { lat: 43.15, lon: -70 })).toBeNull()
  })

  it('gives DNM %: 100 at the best point of an isochrone, more elsewhere on it', () => {
    const mark = { lat: 43.5, lon: -70 }
    expect(dnmPct({ lat: 43.1, lon: -70 }, isos[1], mark)).toBeCloseTo(100, 6)
    expect(dnmPct({ lat: 43.1, lon: -70.05 }, isos[1], mark)!).toBeGreaterThan(100)
  })
})
