import { describe, expect, it } from 'vitest'
import { legFeatures, shouldAdvance } from './legsOnChart'
import { distance } from './geo'
import type { Mark } from './types'

const mk = (name: string, lat: number, lon: number, extra: Partial<Mark> = {}): Mark => ({ id: name, name, position: { lat, lon }, roundTo: 'port', ...extra })
// A windward-leeward: start south, windward a mile north, leeward back south.
const W = mk('W', 43.7, -70.2)
const L = mk('L', 43.6833, -70.2)
const course = [mk('S', 43.6833, -70.2005), W, L]

describe('the legs on the chart', () => {
  it('labels each leg with range and bearing, true or magnetic', () => {
    const f = legFeatures(course, null, 1)
    const labels = f.filter((x) => x.properties.kind === 'leg-label').map((x) => x.properties.label)
    expect(labels).toHaveLength(2)
    expect(labels[1]).toMatch(/^1\.00 nm 180°T$/)
    const m = legFeatures(course, null, 1, { magnetic: true, variationDeg: -15 })
    expect(m.find((x) => x.properties.kind === 'leg-label')!.properties.label).toMatch(/°M$/)
    expect(m.filter((x) => x.properties.kind === 'leg-label')[1].properties.label).toBe('1.00 nm 195°M')
    // The active leg is marked.
    expect(f.filter((x) => x.properties.kind === 'leg').map((x) => x.properties.active)).toEqual([true, false])
  })

  it('draws the boat to the active mark, and range circles where set', () => {
    const boat = { lat: 43.69, lon: -70.21 }
    const f = legFeatures([course[0], { ...W, rangeNm: 0.1 }, L], boat, 1)
    const cur = f.find((x) => x.properties.kind === 'current')!
    const c = cur.geometry.coordinates as number[][]
    expect(c[0]).toEqual([boat.lon, boat.lat])
    expect(c.at(-1)).toEqual([W.position.lon, W.position.lat])
    const ring = f.find((x) => x.properties.kind === 'circle')!.geometry.coordinates as number[][]
    expect(distance(W.position, { lat: ring[5][1], lon: ring[5][0] })).toBeCloseTo(0.1, 6)
    expect(legFeatures(course, null, 1).some((x) => x.properties.kind === 'current')).toBe(false)
  })
})

describe('auto mark advance', () => {
  it('advances inside the mark range, and not before', () => {
    const near = { lat: 43.6996, lon: -70.2 }
    expect(shouldAdvance(course, 1, { lat: 43.69, lon: -70.2 }, near, 'range')).toBe(true)
    expect(shouldAdvance(course, 1, { lat: 43.68, lon: -70.2 }, { lat: 43.69, lon: -70.2 }, 'range')).toBe(false)
    // Its own range, where set.
    const wide = [course[0], { ...W, rangeNm: 0.2 }, L]
    expect(shouldAdvance(wide, 1, { lat: 43.68, lon: -70.2 }, { lat: 43.6975, lon: -70.2 }, 'range')).toBe(true)
    expect(shouldAdvance(course, 1, near, near, 'off')).toBe(false)
  })

  it('advances on crossing the bisector at a windward mark, rounded to port', () => {
    // In from the south and straight back: rounded to port, the boat comes up the east side
    // and leaves on the west, crossing the course line through the mark just above it.
    const upEast = { lat: 43.6995, lon: -70.1997 }
    const aboveEast = { lat: 43.7003, lon: -70.1997 }
    const aboveWest = { lat: 43.7003, lon: -70.2003 }
    expect(shouldAdvance(course, 1, upEast, aboveEast, 'bisector')).toBe(false)
    expect(shouldAdvance(course, 1, aboveEast, aboveWest, 'bisector')).toBe(true)
    // Rounded to starboard, the same crossing is the wrong way.
    const stbd = [course[0], { ...W, roundTo: 'starboard' as const }, L]
    expect(shouldAdvance(stbd, 1, aboveEast, aboveWest, 'bisector')).toBe(false)
    // Too far off to count as rounding it.
    expect(shouldAdvance(course, 1, { lat: 43.7003, lon: -70.24 }, { lat: 43.7003, lon: -70.25 }, 'bisector')).toBe(false)
  })

  it('advances on crossing the bisector of a turn', () => {
    // North to the mark, then west: the bisector runs south-west to north-east through it.
    const turn = [mk('A', 43.68, -70.2), mk('B', 43.7, -70.2), mk('C', 43.7, -70.25)]
    expect(shouldAdvance(turn, 1, { lat: 43.6997, lon: -70.1998 }, { lat: 43.7002, lon: -70.2002 }, 'bisector')).toBe(true)
    expect(shouldAdvance(turn, 1, { lat: 43.699, lon: -70.1998 }, { lat: 43.6995, lon: -70.1998 }, 'bisector')).toBe(false)
  })

  it('does not advance past the last mark', () => {
    expect(shouldAdvance(course, 2, L.position, L.position, 'both')).toBe(false)
  })
})
