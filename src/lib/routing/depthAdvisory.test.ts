/**
 * Depth advisory tests.
 *
 * The sampler and the tide curve are injected, so these drive an analytic seabed
 * whose shallowest point is known by construction — no grid fetch, no network.
 *
 * The behaviour worth defending is mostly about what the advisory *refuses* to
 * claim: it must not report clearance without a draft, must not report a
 * tide-corrected depth outside the prediction, and must not go quiet when it has no
 * data at all.
 */

import { describe, expect, it } from 'vitest'
import { depthAdvisory, type DepthSampler } from './depthAdvisory'
import { PORTLAND_DATUM } from '../tides/datum'
import type { WaterLevelPrediction } from '../tides/coops'
import type { Millis, RouteLeg, RouteResult } from '../types'

const T0 = Date.UTC(2026, 7, 6, 12, 0)
const HOUR = 3_600_000
const MIN = 60_000

function leg(lat: number, lon: number, t: Millis): RouteLeg {
  return {
    t,
    position: { lat, lon },
    twd: 270,
    tws: 12,
    twa: 90,
    bsp: 6,
    heading: 0,
    isBeating: false,
    tack: 'starboard',
    currentSet: null,
    currentDrift: null,
    distanceNm: 0.5,
  } as unknown as RouteLeg
}

/** A route running due north along a fixed meridian, one leg every 10 minutes. */
function route(n: number, ok = true): RouteResult {
  const legs: RouteLeg[] = []
  for (let i = 0; i < n; i++) {
    legs.push(leg(43.5 + i * 0.01, -70.2, T0 + i * 10 * MIN))
  }
  return {
    ok,
    legs,
    etaMs: T0 + n * 10 * MIN,
    elapsedS: (n * 10 * MIN) / 1000,
    directTimeS: 0,
    isochrones: [],
    reverseIsochrones: [],
    sensitivity: null,
    diagnostics: { nodesExplored: 0, timeStepS: 60, computeMs: 0, landAvoided: false, warnings: [] },
  } as unknown as RouteResult
}

/** Deep everywhere except a shoal at one latitude. */
function seabed(shoalLat: number, shoalDepth: number, elsewhere = 40): DepthSampler {
  return (lat) => (Math.abs(lat - shoalLat) < 0.005 ? shoalDepth : elsewhere)
}

/** A tide curve spanning the route, holding at a fixed height above MLLW. */
function flatTide(aboveMllwM: number, hours = 12): WaterLevelPrediction {
  return {
    stationId: '8418150',
    datum: 'MLLW',
    series: [
      { t: T0 - HOUR, m: aboveMllwM },
      { t: T0 + hours * HOUR, m: aboveMllwM },
    ],
    events: [],
    fetchedAt: T0,
  }
}

describe('depthAdvisory', () => {
  it('finds the shoal the seabed actually has', () => {
    const a = depthAdvisory({
      route: route(10),
      depthAt: seabed(43.53, 3),
      levels: flatTide(PORTLAND_DATUM.mslAboveMllwM), // exactly MSL: no correction
      datum: PORTLAND_DATUM,
      draftM: 1.5,
    })
    expect(a.shallowest?.legIndex).toBe(3)
    expect(a.shallowest?.depthMslM).toBe(3)
    expect(a.shallowest?.depthNowM).toBeCloseTo(3, 6)
    expect(a.shallowest?.underKeelM).toBeCloseTo(1.5, 6)
  })

  it('applies the tide at each leg’s own time, which is the whole point', () => {
    /*
     * A falling tide across the passage: the same seabed gives less water at the
     * end than at the start. This is what a map layer cannot do — it can only show
     * one tide state, and the boat is not there at that time.
     */
    const falling: WaterLevelPrediction = {
      stationId: '8418150',
      datum: 'MLLW',
      series: [
        { t: T0, m: 2.51 }, // 1 m above MSL
        { t: T0 + 100 * MIN, m: 0.51 }, // 1 m below MSL
      ],
      events: [],
      fetchedAt: T0,
    }
    const a = depthAdvisory({
      route: route(11),
      depthAt: () => 10,
      levels: falling,
      datum: PORTLAND_DATUM,
    })
    expect(a.samples[0].depthNowM).toBeCloseTo(11, 2)
    expect(a.samples[a.samples.length - 1].depthNowM).toBeCloseTo(9, 2)
    // Same seabed, 2 m of difference, purely from when you get there.
    expect(a.shallowest?.legIndex).toBe(10)
  })

  it('takes water away at low tide, so a shoal can become a concern', () => {
    // 3 m of water at MLLW is 1.49 m once the datum is applied; a 1.5 m draft is
    // then aground on this model. The uncorrected figure would have said 1.5 m
    // clearance, which is the failure this whole module exists to prevent.
    const a = depthAdvisory({
      route: route(10),
      depthAt: seabed(43.53, 3),
      levels: flatTide(0), // exactly MLLW
      datum: PORTLAND_DATUM,
      draftM: 1.5,
    })
    expect(a.shallowest?.depthNowM).toBeCloseTo(1.49, 2)
    expect(a.shallowest?.underKeelM).toBeCloseTo(-0.01, 2)
    expect(a.concerns.length).toBeGreaterThan(0)
    expect(a.warnings.join(' ')).toMatch(/Shallow water on this route/)
    expect(a.warnings.join(' ')).toMatch(/check a chart/)
  })

  it('reports depth rather than clearance when no draft is set, and says which', () => {
    const a = depthAdvisory({
      route: route(10),
      depthAt: seabed(43.53, 1.2),
      levels: flatTide(PORTLAND_DATUM.mslAboveMllwM),
      datum: PORTLAND_DATUM,
    })
    expect(a.shallowest?.underKeelM).toBeNull()
    expect(a.warnings.join(' ')).toMatch(/No draft set/)
    expect(a.warnings.join(' ')).toMatch(/this is depth, not clearance/)
  })

  it('runs uncorrected with no tide curve, and warns how optimistic that is', () => {
    const a = depthAdvisory({
      route: route(10),
      depthAt: () => 5,
      levels: null,
      datum: PORTLAND_DATUM,
      draftM: 1.5,
    })
    expect(a.samples[0].depthNowM).toBeNull()
    expect(a.samples[0].underKeelM).toBeNull()
    // Ranking falls back to the modelled depth rather than going blank.
    expect(a.shallowest?.depthMslM).toBe(5)
    expect(a.warnings.join(' ')).toMatch(/1\.51 m optimistic at low water/)
  })

  it('counts legs the tide prediction does not reach instead of extrapolating', () => {
    // Tide covers the first hour; the route runs 100 minutes.
    const short: WaterLevelPrediction = {
      stationId: '8418150',
      datum: 'MLLW',
      series: [
        { t: T0, m: 1.51 },
        { t: T0 + HOUR, m: 1.51 },
      ],
      events: [],
      fetchedAt: T0,
    }
    const a = depthAdvisory({ route: route(11), depthAt: () => 10, levels: short, datum: PORTLAND_DATUM })
    expect(a.legsWithoutTide).toBeGreaterThan(0)
    expect(a.warnings.join(' ')).toMatch(/outside the tide prediction and are uncorrected/)
  })

  it('says plainly when it checked nothing at all', () => {
    // The silence failure the improvement plan keeps finding: an advisory with no
    // data must not look like an advisory that found nothing wrong.
    const a = depthAdvisory({
      route: route(10),
      depthAt: () => null,
      levels: flatTide(1.51),
      datum: PORTLAND_DATUM,
      draftM: 1.5,
    })
    expect(a.samples).toHaveLength(0)
    expect(a.shallowest).toBeNull()
    expect(a.concerns).toHaveLength(0)
    expect(a.warnings.join(' ')).toMatch(/No depth data along this route/)
    expect(a.warnings.join(' ')).toMatch(/No grounding check was made/)
  })

  it('is silent about depth on a route that never got one', () => {
    const a = depthAdvisory({
      route: route(0),
      depthAt: () => 10,
      levels: flatTide(1.51),
      datum: PORTLAND_DATUM,
    })
    expect(a.warnings).toHaveLength(0)
    expect(a.shallowest).toBeNull()
  })

  it('says nothing about a failed route', () => {
    const a = depthAdvisory({
      route: route(10, false),
      depthAt: () => 1,
      levels: flatTide(0),
      datum: PORTLAND_DATUM,
      draftM: 2,
    })
    expect(a.samples).toHaveLength(0)
    expect(a.warnings).toHaveLength(0)
  })

  it('thins a long route but always samples the destination', () => {
    /*
     * The destination is the leg most likely to be shallow — a mark sits closer to
     * shore than the water either side of it — and an even stride almost never
     * lands on the last leg. Here the shoal is at the very end.
     */
    const r = route(1000)
    const lastLat = r.legs[999].position.lat
    const a = depthAdvisory({
      route: r,
      depthAt: seabed(lastLat, 1),
      levels: flatTide(PORTLAND_DATUM.mslAboveMllwM, 200),
      datum: PORTLAND_DATUM,
      draftM: 1.5,
      maxSamples: 20,
    })
    expect(a.samples.length).toBeLessThanOrEqual(21)
    expect(a.samples[a.samples.length - 1].legIndex).toBe(999)
    expect(a.shallowest?.legIndex).toBe(999)
  })

  it('does not duplicate the destination when the stride already lands on it', () => {
    const r = route(11)
    const a = depthAdvisory({
      route: r,
      depthAt: () => 10,
      levels: flatTide(1.51, 20),
      datum: PORTLAND_DATUM,
      maxSamples: 1000,
    })
    const lastTwo = a.samples.slice(-2).map((s) => s.legIndex)
    expect(new Set(lastTwo).size).toBe(2)
    expect(a.samples.filter((s) => s.legIndex === 10)).toHaveLength(1)
  })

  it('orders concerns worst first', () => {
    const depths = new Map([
      [43.51, 2.0],
      [43.52, 1.0],
      [43.53, 1.5],
    ])
    const a = depthAdvisory({
      route: route(6),
      depthAt: (lat) => depths.get(+lat.toFixed(2)) ?? 40,
      levels: flatTide(PORTLAND_DATUM.mslAboveMllwM),
      datum: PORTLAND_DATUM,
      draftM: 0,
      alarmM: 3,
    })
    expect(a.concerns.map((c) => c.depthNowM?.toFixed(1))).toEqual(['1.0', '1.5', '2.0'])
    expect(a.warnings.join(' ')).toMatch(/3 legs on this route/)
  })

  it('stays quiet on deep water, which is the common case', () => {
    const a = depthAdvisory({
      route: route(10),
      depthAt: () => 40,
      levels: flatTide(PORTLAND_DATUM.mslAboveMllwM),
      datum: PORTLAND_DATUM,
      draftM: 1.5,
    })
    expect(a.concerns).toHaveLength(0)
    expect(a.warnings).toHaveLength(0)
  })
})
