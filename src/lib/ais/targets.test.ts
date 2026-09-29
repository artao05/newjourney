import { describe, expect, it } from 'vitest'
import { destination } from '../geo'
import { decodeAis } from './decode'
import { sentences, ll, type Field } from './fixtures/encode'
import { DEFAULT_AIS_FILTER, TRAIL_MIN, aisAlarmValues, alertOf, applyMessage, approach, closestApproach, cpaPoints, dangerOf, prune, shownTargets, targetsInAreas, type AisTarget } from './targets'
import { distance } from '../geo'

const at = (lat: number, lon: number) => ({ lat, lon })
const target = (mmsi: number, pos: { lat: number; lon: number } | null, sog: number, cog: number, over: Partial<AisTarget> = {}): AisTarget => ({
  mmsi, cls: 'A', position: pos, sog, cog, heading: null, status: 0, positionAt: 0, updated: 0, alert: alertOf(mmsi), ...over,
})

describe('AIS targets', () => {
  it('knows a distress beacon by its MMSI, or a SART by its status', () => {
    expect([alertOf(970123456), alertOf(972000001), alertOf(974111222), alertOf(338123456), alertOf(338123456, 14)]).toEqual(['SART', 'MOB', 'EPIRB', null, 'SART'])
  })

  it("builds a target up from its position and static data, and leaves our own ship's out", () => {
    const pos: Field[] = [[6, 1], [2, 0], [30, 338123456], [4, 0], [8, 0], [10, 55], [1, 1], [28, ll(-70.2)], [27, ll(43.6)], [12, 900], [9, 91], [6, 10], [2, 0], [3, 0], [1, 0], [19, 0]]
    const stat: Field[] = [[6, 5], [2, 0], [30, 338123456], [2, 0], [30, 0], [42, 'WDA1234'], [120, 'CASCO BAY FERRY'], [8, 60], [9, 30], [9, 8], [6, 5], [6, 5], [4, 1], [20, 0], [8, 30], [120, 'PEAKS ISLAND'], [1, 0], [1, 0]]
    const msgs = decodeAis([...sentences(pos), ...sentences(stat, { perSentence: 40 }), ...sentences(pos, { own: true })].join('\n'))
    const map = new Map<number, AisTarget>()
    for (const m of msgs) applyMessage(map, m, 1000)
    expect(map.size).toBe(1)
    expect(map.get(338123456)).toMatchObject({ name: 'CASCO BAY FERRY', callSign: 'WDA1234', destination: 'PEAKS ISLAND', shipType: 60, sog: 5.5, cog: 90, heading: 91, alert: null })
    prune(map, 1000 + 11 * 60_000)
    expect(map.size).toBe(0)
  })

  it('works out the closest approach of two boats holding their courses', () => {
    const own = { position: at(43.5, -70.2), sog: 6, cog: 0 }
    // Head on: 2 nm ahead, coming south at 6 kn, so we meet in 10 minutes.
    const a = approach(own, target(1, destination(own.position, 0, 2), 6, 180))!
    expect(a.cpaNm).toBeCloseTo(0, 3)
    expect(a.tcpaMin).toBeCloseTo(10, 1)
    // On the reciprocal course 1 nm to starboard: passes 1 nm off in 15 minutes.
    const b = approach(own, target(2, destination(destination(own.position, 0, 3), 90, 1), 6, 180))!
    expect(b.cpaNm).toBeCloseTo(1, 2)
    expect(b.tcpaMin).toBeCloseTo(15, 0)
    // Astern and slower: already past, the closest is now.
    const c = approach(own, target(3, destination(own.position, 180, 1), 3, 0))!
    expect(c.tcpaMin).toBeLessThan(0)
    expect(c.cpaNm).toBeCloseTo(1, 3)
  })

  it('gives the alarm the closest approach coming within the half hour, and the beacons heard', () => {
    const own = { position: at(43.5, -70.2), sog: 6, cog: 0 }
    const list = [
      target(1, destination(own.position, 0, 2), 6, 180),
      target(2, destination(own.position, 0, 10), 0, 0),
      target(970000001, destination(own.position, 90, 3), 0, 0),
    ]
    expect(closestApproach(list, own)).toBeCloseTo(0, 3)
    expect(closestApproach([list[1]], own)).toBeNull()
    expect(aisAlarmValues(list, own)).toEqual({ 'ais-cpa': expect.closeTo(0, 3), 'ais-alert': 1, 'ais-avoid': 0 })
    expect(aisAlarmValues(list, null)['ais-cpa']).toBeNull()
  })

  it('lists beacons first, then by closest approach, within the filter', () => {
    const own = { position: at(43.5, -70.2), sog: 6, cog: 0 }
    const list = [
      target(1, destination(own.position, 0, 5), 0, 0),
      target(2, destination(own.position, 0, 2), 6, 180),
      target(3, destination(own.position, 90, 1), 0, 0, { cls: 'B' }),
      target(4, destination(own.position, 90, 40), 0, 0),
      target(5, destination(own.position, 90, 2), 0, 0, { status: 5 }),
      target(972000009, destination(own.position, 270, 30), 0, 0),
    ]
    // Two that will come to 0 nm: the sooner first.
    expect(shownTargets(list, own, DEFAULT_AIS_FILTER).map((t) => t.mmsi)).toEqual([972000009, 2, 1, 3, 5])
    expect(shownTargets(list, own, { ...DEFAULT_AIS_FILTER, classB: false, hideMoored: true }).map((t) => t.mmsi)).toEqual([972000009, 2, 1])
  })
})

describe('AIS on the chart', () => {
  const own = { position: at(43.5, -70.2), sog: 6, cog: 0 }

  it('keeps a trail of where a vessel has been, the last twenty minutes', () => {
    const map = new Map<number, AisTarget>()
    const report = (lat: number, t: number) => applyMessage(map, { kind: 'position', mmsi: 338000001, cls: 'A', lat, lon: -70.2, sog: 6, cog: 0, heading: null, status: 0 } as never, t)
    for (let i = 0; i < 30; i++) report(43.5 + i * 0.001, i * 60_000)
    const trail = map.get(338000001)!.trail!
    expect(trail.at(-1)).toEqual([29 * 60_000, 43.529, -70.2])
    expect(trail[0][0]).toBe((29 - TRAIL_MIN) * 60_000)
  })

  it('finds where each boat will be at the closest approach, and how dangerous it is', () => {
    // Head on, 2 nm ahead, both at 6 kn: we meet 1 nm on, in ten minutes.
    const t = target(1, destination(own.position, 0, 2), 6, 180)
    const a = approach(own, t)!
    const p = cpaPoints(own, t, a)!
    expect(distance(p.us, destination(own.position, 0, 1))).toBeLessThan(0.001)
    expect(distance(p.us, p.them)).toBeLessThan(0.001)
    expect(dangerOf(a)).toBe('danger')
    expect(dangerOf({ ...a, cpaNm: 0.8 })).toBe('caution')
    expect(dangerOf({ ...a, cpaNm: 3 })).toBe('clear')
    expect(dangerOf({ ...a, tcpaMin: -5 })).toBe('clear')
    expect(cpaPoints(own, t, { ...a, tcpaMin: -1 })).toBeNull()
  })

  it('leaves out our own MMSI, and shows only the vessels asked for, beacons always', () => {
    const list = [target(338000001, at(43.51, -70.2), 5, 0), target(338000002, at(43.52, -70.2), 5, 0), target(970000009, at(43.53, -70.2), 0, 0)]
    const f = { ...DEFAULT_AIS_FILTER, ownMmsi: 338000001 }
    expect(shownTargets(list, own, f).map((x) => x.mmsi).sort()).toEqual([338000002, 970000009])
    expect(shownTargets(list, own, { ...DEFAULT_AIS_FILTER, only: [338000001] }).map((x) => x.mmsi).sort()).toEqual([338000001, 970000009])
  })

  it('finds the vessels inside an avoid area', () => {
    const area = [[-70.25, 43.505], [-70.15, 43.505], [-70.15, 43.515], [-70.25, 43.515], [-70.25, 43.505]]
    const list = [target(1, at(43.51, -70.2), 5, 0), target(2, at(43.52, -70.2), 5, 0), target(3, at(43.51, -70.2), 0, 0, { cls: 'AtoN' })]
    expect(targetsInAreas(list, [area]).map((t) => t.mmsi)).toEqual([1])
    expect(aisAlarmValues(list, { position: own.position, sog: 6, cog: 0 }, [area])['ais-avoid']).toBe(1)
  })
})
