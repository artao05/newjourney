import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTE_SETTINGS, nonDefaultLabels, requestParts, windHeightFactor, zonesFromNotes } from './settings'

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

describe('mast height lifts the forecast only for a masthead polar', () => {
  it('leaves a 10 m polar alone, since the forecast is at 10 m too', () => {
    expect(windHeightFactor('10m', 20)).toBe(1)
    expect(windHeightFactor(undefined, 20)).toBe(1)
  })

  it("lifts it by the manual's power law for a masthead polar", () => {
    // Expedition's worked example: 20 m, a = 0.12 gives 109 %.
    expect(windHeightFactor('masthead', 20)).toBeCloseTo(Math.pow(2, 0.12), 12)
    expect(Math.round(windHeightFactor('masthead', 20) * 100)).toBe(109)
    // A 10 m rig is the reference height: nothing to lift.
    expect(windHeightFactor('masthead', 10)).toBe(1)
  })

  it("compounds with the sailor's own wind scale in the request", () => {
    const k = windHeightFactor('masthead', 20)
    const p = requestParts({ ...DEFAULT_ROUTE_SETTINGS, windScalePct: 90 }, BOAT, true, k)
    expect(p.scalings.windScalePct).toBeCloseTo(90 * k, 12)
    // And the sailor's setting itself is untouched, so the chip still reads 90 %.
    expect(nonDefaultLabels({ ...DEFAULT_ROUTE_SETTINGS, windScalePct: 90 })).toEqual(['wind 90%'])
  })
})

describe('race notes become keep-out and slow areas', () => {
  const tri = [
    { lat: 43.6, lon: -70.2 },
    { lat: 43.61, lon: -70.2 },
    { lat: 43.61, lon: -70.19 },
  ]
  const note = (over: object) => ({ kind: 'area', points: tri, avoid: false, speedPct: null, ...over })

  it('passes keep-out areas as polygons in lon, lat order', () => {
    expect(zonesFromNotes([note({ avoid: true })])).toEqual({
      avoidAreas: [[[[-70.2, 43.6], [-70.2, 43.61], [-70.19, 43.61]]]],
    })
  })

  it('passes slow areas with their percentage, and a keep-out wins over a speed', () => {
    const z = zonesFromNotes([note({ speedPct: 70 }), note({ avoid: true, speedPct: 50 })])
    expect(z.slowAreas).toEqual([{ polygon: [[[-70.2, 43.6], [-70.2, 43.61], [-70.19, 43.61]]], pct: 70 }])
    expect(z.avoidAreas).toHaveLength(1)
  })

  it('ignores points, lines and plain areas, so an ordinary note changes nothing', () => {
    expect(zonesFromNotes([note({}), note({ kind: 'line', avoid: true }), note({ kind: 'point', speedPct: 50 })])).toEqual({})
  })
})

describe('the weather a route was sailed on is named with it', () => {
  it('names a model other than the default, and a source other than merged', () => {
    expect(nonDefaultLabels(DEFAULT_ROUTE_SETTINGS)).toEqual([])
    expect(nonDefaultLabels({ ...DEFAULT_ROUTE_SETTINGS, model: 'ecmwf_ifs025', source: 'download' })).toEqual(['ecmwf_ifs025', 'download only'])
    expect(nonDefaultLabels({ ...DEFAULT_ROUTE_SETTINGS, source: 'files' })).toEqual(['GRIB files only'])
  })
})

describe('sea-state penalties and air density reach the kernel', () => {
  const boat = { polarPct: 100, polarPctNight: 100, tackPenaltyS: 0, gybePenaltyS: 0 }
  it('sends nothing at the defaults', () => {
    const { scalings } = requestParts(DEFAULT_ROUTE_SETTINGS, boat, true)
    expect(scalings.seaPenalty).toBeUndefined()
    expect(scalings.airDensity).toBeUndefined()
  })

  it('sends the penalties once any is set, and names them with the route', () => {
    const s = { ...DEFAULT_ROUTE_SETTINGS, swellPct: 15, crossedSeaPct: 10, airDensity: true }
    const { scalings } = requestParts(s, boat, true)
    expect(scalings.seaPenalty).toEqual({ swellPct: 15, windWavePct: 0, refHeightM: 2, crossedPct: 10, crossedMinM: 0.5, crossedTotalM: 1.5, crossedMarginDeg: 30 })
    expect(scalings.airDensity).toBe(true)
    expect(nonDefaultLabels(s)).toEqual(['swell −15%', 'crossed sea −10%', 'air density'])
  })
})
