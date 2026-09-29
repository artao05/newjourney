/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { nearestStations, parseDatums, parseStations, stationTides, tideStations, tideTurns, type TideStation } from './stations'

afterEach(() => localStorage.clear())

const LIST = {
  count: 3,
  stations: [
    { id: '8418150', name: 'Portland', lat: 43.6581, lng: -70.2442, state: 'ME' },
    { id: '8419870', name: 'Seavey Island', lat: 43.08, lng: -70.7417, state: 'ME' },
    { id: '8443970', name: 'Boston', lat: 42.3539, lng: -71.0503, state: 'MA' },
    { id: '', name: 'broken', lat: 'x', lng: 0 },
  ],
}

describe('tide stations', () => {
  it('reads the station list and finds the nearest', () => {
    const list = parseStations(LIST)
    expect(list.map((s) => s.id)).toEqual(['8418150', '8419870', '8443970'])
    const near = nearestStations(list, { lat: 43.55, lon: -70.3 }, 2)
    expect(near.map((s) => s.name)).toEqual(['Portland', 'Seavey Island'])
    expect(near[0].nm).toBeGreaterThan(6)
    expect(near[0].nm).toBeLessThan(8)
  })

  it('reads the datums, and works out chart datum below mean sea level', () => {
    expect(parseDatums({ datums: [{ name: 'MSL', value: 1.531 }, { name: 'MLLW', value: 0 }, { name: 'MHHW', value: 3.03 }] })).toEqual({ MSL: 1.531, MLLW: 0, MHHW: 3.03 })
    expect(parseDatums(null)).toEqual({})
  })

  it('fetches the list and a station once, then works from the device', async () => {
    const asked: string[] = []
    const fake = (async (url: string) => {
      asked.push(url)
      const body = url.includes('stations.json')
        ? LIST
        : url.includes('harcon')
          ? { HarmonicConstituents: [{ name: 'M2', amplitude: 1.35, phase_GMT: 107 }] }
          : { datums: [{ name: 'MSL', value: 1.531 }, { name: 'MLLW', value: 0.02 }] }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    const list = await tideStations(fake)
    const again = await tideStations(fake)
    expect(again).toEqual(list)
    const t = await stationTides(list[0], fake)
    expect(t.constants).toEqual([{ name: 'M2', amplitude: 1.35, phase: 107 }])
    expect(t.mslAboveMllw).toBeCloseTo(1.511, 6)
    await stationTides(list[0], fake)
    expect(asked.filter((u) => u.includes('stations.json'))).toHaveLength(1)
    expect(asked.filter((u) => u.includes('/harcon.json'))).toHaveLength(1)
  })

  it('says so when a station has no constants', async () => {
    const fake = (async () => new Response(JSON.stringify({ HarmonicConstituents: [] }), { status: 200 })) as unknown as typeof fetch
    const s: TideStation = { id: '9', name: 'Nowhere', position: { lat: 0, lon: 0 } }
    await expect(stationTides(s, fake)).rejects.toThrow(/no harmonic constants for Nowhere/)
  })

  it('finds highs and lows twice a day in a semidiurnal tide, placed to the minute', () => {
    const k = [{ name: 'M2', amplitude: 1.4, phase: 100 }]
    const t0 = Date.UTC(2026, 8, 29)
    const turns = tideTurns(k, t0, t0 + 25 * 3_600_000)
    expect(turns.filter((x) => x.high)).toHaveLength(2)
    expect(turns.filter((x) => !x.high)).toHaveLength(2)
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i].high).not.toBe(turns[i - 1].high)
      // M2's half period is 6 h 12.6 min.
      expect(Math.abs((turns[i].t - turns[i - 1].t) / 60_000 - 372.6)).toBeLessThan(2)
    }
    for (const x of turns) expect(Math.abs(x.h)).toBeCloseTo(1.4 * 1, 0)
  })
})
