import { describe, expect, it } from 'vitest'
import { nearestCurrentStations, parseCurrentHarcon, parseCurrentStations, predictStream, streamAt } from './currents'

// The shape NOAA's metadata API returns for a current station's constants.
const HARCON = {
  units: 'meters, centimeters/second',
  HarmonicConstituents: [
    { binNbr: 2, binDepth: 11.64, constituentName: 'M2', majorAmplitude: 50, majorPhaseGMT: 17.5, minorAmplitude: 0, minorPhaseGMT: 81.3, majorMeanSpeed: 0, minorMeanSpeed: 0, azi: 315 },
    { binNbr: 2, binDepth: 11.64, constituentName: 'S2', majorAmplitude: 0, majorPhaseGMT: 0, minorAmplitude: 0, minorPhaseGMT: 0, majorMeanSpeed: 0, minorMeanSpeed: 0, azi: 315 },
    { binNbr: 8, binDepth: 5.64, constituentName: 'M2', majorAmplitude: 10, majorPhaseGMT: 20, minorAmplitude: 10, minorPhaseGMT: 110, majorMeanSpeed: 5, minorMeanSpeed: 0, azi: 0 },
  ],
}

describe('harmonic tidal streams', () => {
  it('reads each depth bin with its axis, mean and constituents', () => {
    const bins = parseCurrentHarcon(HARCON)
    expect(bins.map((b) => [b.bin, b.depthM, b.azi, b.major.length])).toEqual([[2, 11.64, 315, 2], [8, 5.64, 0, 1]])
    expect(parseCurrentHarcon({})).toEqual([])
  })

  it('floods along the axis and ebbs the other way, twice a lunar day', () => {
    const [b] = parseCurrentHarcon(HARCON)
    const t0 = Date.UTC(2026, 8, 29)
    const sets = new Set<number>()
    let peak = 0
    for (let m = 0; m < 25 * 60; m += 10) {
      const s = predictStream(b, t0 + m * 60_000)
      if (s.drift > 0.3) sets.add(Math.round(s.set))
      peak = Math.max(peak, s.drift)
      expect(Math.abs(s.minorKn)).toBeLessThan(1e-9)
    }
    // Flood to 315°, ebb to 135°, at up to 50 cm/s (0.97 kn) times M2's node factor.
    expect([...sets].sort((a, c) => a - c)).toEqual([135, 315])
    expect(peak).toBeGreaterThan(0.9)
    expect(peak).toBeLessThan(1.02)
  })

  it('turns a rotary stream with the minor axis 90° clockwise of the major, about a mean flow', () => {
    const b = parseCurrentHarcon(HARCON)[1]
    const t0 = Date.UTC(2026, 8, 29)
    const dirs: number[] = []
    for (let m = 0; m < 13 * 60; m += 30) dirs.push(predictStream(b, t0 + m * 60_000).set)
    // A circle of 10 cm/s about a 5 cm/s northward mean: every direction is visited.
    expect(Math.max(...dirs) - Math.min(...dirs)).toBeGreaterThan(300)
  })

  it('keeps only stations with their own constants, and finds those near', () => {
    const list = parseCurrentStations({
      stations: [
        { id: 'CAB1401', name: 'Portland Harbor Entrance', lat: 43.628, lng: -70.2095, type: 'H', currbin: 2 },
        { id: 'CAB1401', name: 'Portland Harbor Entrance', lat: 43.628, lng: -70.2095, type: 'H', currbin: 8 },
        { id: 'ACT0091', name: 'Eastport, Friar Roads', lat: 44.9, lng: -66.98, type: 'S' },
        { id: 'CAB1402', name: 'Far away', lat: 40, lng: -60, type: 'H' },
      ],
    })
    expect(list.map((s) => [s.id, s.bin])).toEqual([['CAB1401', 2], ['CAB1402', 1]])
    expect(nearestCurrentStations(list, { lat: 43.6, lon: -70.25 }, 25).map((s) => s.id)).toEqual(['CAB1401'])
  })
})

describe('the stream between stations', () => {
  const steady = (towards: number, cms: number) => ({ bin: 1, depthM: 3, azi: towards, majorMean: cms, minorMean: 0, major: [], minor: [] })
  it('weights the stations near a point by the inverse square of their distance, and gives none beyond the radius', () => {
    const t = Date.UTC(2026, 8, 29)
    const a = { position: { lat: 43.6, lon: -70.2 }, bin: steady(0, 100) }
    const b = { position: { lat: 43.6, lon: -70.1 }, bin: steady(90, 100) }
    const mid = streamAt([a, b], 43.6, -70.15, t, 10)!
    // Halfway: equal weights, so north and east alike.
    expect(mid.u).toBeCloseTo(mid.v, 6)
    const nearA = streamAt([a, b], 43.6, -70.19, t, 10)!
    expect(nearA.v).toBeGreaterThan(nearA.u * 10)
    // At the station itself, its own stream.
    expect(streamAt([a], 43.6, -70.2, t, 10)!.v).toBeCloseTo(100 * 0.0194384, 5)
    expect(streamAt([a, b], 44.5, -70.2, t, 10)).toBeNull()
  })
})

