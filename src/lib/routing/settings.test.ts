import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTE_SETTINGS, nonDefaultLabels, requestParts } from './settings'

const BOAT = { polarPct: 97, polarPctNight: 92, tackPenaltyS: 12, gybePenaltyS: 8 }

describe('routing settings become a RouteRequest', () => {
  it('asks for exactly what the Route screen used to hard-code, when left at the defaults', () => {
    // The request before settings existed. A default install must route the same.
    expect(requestParts(DEFAULT_ROUTE_SETTINGS, BOAT, true)).toEqual({
      constraints: { avoidLand: true, tackPenaltyS: 12, gybePenaltyS: 8 },
      scalings: {
        polarPct: 97,
        polarPctNight: 92,
        windScalePct: 100,
        windRotateDeg: 0,
        windTimeShiftS: 0,
        currentScalePct: 100,
      },
      resolution: 'balanced',
    })
  })

  it('passes every correction through, with the time shift in seconds', () => {
    const p = requestParts(
      {
        ...DEFAULT_ROUTE_SETTINGS,
        resolution: 'best',
        windScalePct: 85,
        windRotateDeg: -10,
        windTimeShiftMin: 60,
        currentScalePct: 120,
      },
      BOAT,
      false,
    )
    expect(p.resolution).toBe('best')
    expect(p.scalings).toMatchObject({
      windScalePct: 85,
      windRotateDeg: -10,
      windTimeShiftS: 3600,
      currentScalePct: 120,
    })
    expect(p.constraints.avoidLand).toBe(false)
  })

  it('passes a limit only when one is set, so blank never means zero', () => {
    const none = requestParts(DEFAULT_ROUTE_SETTINGS, BOAT, true).constraints
    for (const k of ['maxTws', 'minTws', 'maxGust', 'maxWaveHeightM'] as const) {
      expect(k in none, k).toBe(false)
    }
    const set = requestParts(
      { ...DEFAULT_ROUTE_SETTINGS, maxTws: 25, minTws: 4, maxGust: 32, maxWaveHeightM: 3 },
      BOAT,
      true,
    ).constraints
    expect(set).toMatchObject({ maxTws: 25, minTws: 4, maxGust: 32, maxWaveHeightM: 3 })
  })

  it('names every setting that differs from the defaults, and nothing else', () => {
    expect(nonDefaultLabels(DEFAULT_ROUTE_SETTINGS)).toEqual([])
    expect(
      nonDefaultLabels({
        ...DEFAULT_ROUTE_SETTINGS,
        windRotateDeg: 10,
        windTimeShiftMin: -30,
        maxGust: 30,
      }),
    ).toEqual(['wind +10°', 'wind -30 min', 'gust ≤ 30 kn'])
  })
})
