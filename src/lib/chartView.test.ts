import { describe, expect, it } from 'vitest'
import { bearing, distance } from './geo'
import { motionTarget, shouldReframe, steadyBearing, upBearing } from './chartView'

const boat = { position: { lat: 43.65, lon: -70.2 }, cog: 100, sog: 6, heading: 92 }
const windward = { lat: 43.7, lon: -70.2 }
const leeward = { lat: 43.62, lon: -70.21 }

describe('chart orientation', () => {
  it('puts north, the active leg or the head up', () => {
    expect(upBearing('north', boat, null)).toBe(0)
    expect(upBearing('head', boat, null)).toBe(92)
    // Course up is the leg, from the last mark to the active one, wherever the boat is.
    expect(upBearing('course', boat, { from: leeward, to: windward })).toBeCloseTo(bearing(leeward, windward), 9)
    // On the first leg there is no last mark: from the boat.
    expect(upBearing('course', boat, { from: null, to: windward })).toBeCloseTo(bearing(boat.position, windward), 9)
  })

  it('falls back to the COG when there is no heading or no course, and to nothing when stopped', () => {
    expect(upBearing('head', { ...boat, heading: null }, null)).toBe(100)
    expect(upBearing('course', boat, null)).toBe(100)
    expect(upBearing('head', { ...boat, heading: null, sog: 0.2 }, null)).toBeNull()
    expect(upBearing('head', null, null)).toBeNull()
  })

  it('turns head up only past its dead band', () => {
    expect(steadyBearing(90, 93)).toBe(90)
    expect(steadyBearing(90, 96)).toBe(96)
    expect(steadyBearing(358, 2)).toBe(358)
    expect(steadyBearing(358, 364)).toBe(4)
  })
})

describe('chart motion', () => {
  it('follows the boat, frames ten minutes ahead, or frames the boat and the mark', () => {
    expect(motionTarget('free', boat, windward)).toBeNull()
    expect(motionTarget('follow', boat, windward)).toEqual({ center: boat.position })
    const ahead = motionTarget('ahead', boat, windward) as { frame: Array<{ lat: number; lon: number }> }
    expect(ahead.frame[0]).toEqual(boat.position)
    expect(distance(boat.position, ahead.frame[1])).toBeCloseTo(1, 6)
    expect(bearing(boat.position, ahead.frame[1])).toBeCloseTo(100, 3)
    expect(motionTarget('mark', boat, windward)).toEqual({ frame: [boat.position, windward] })
    // No mark: follow the boat. No fix: nothing to follow.
    expect(motionTarget('mark', boat, null)).toEqual({ center: boat.position })
    expect(motionTarget('follow', null, windward)).toBeNull()
  })

  it('looks at least a mile ahead, so a slow boat still sees something', () => {
    const slow = motionTarget('ahead', { ...boat, sog: 1 }, null) as { frame: Array<{ lat: number; lon: number }> }
    expect(distance(boat.position, slow.frame[1])).toBeCloseTo(1, 6)
    const fast = motionTarget('ahead', { ...boat, sog: 12 }, null) as { frame: Array<{ lat: number; lon: number }> }
    expect(distance(boat.position, fast.frame[1])).toBeCloseTo(2, 6)
  })

  it('reframes only when a framed point leaves the view or the zoom is well off', () => {
    const inside = [{ x: 100, y: 100 }, { x: 300, y: 200 }]
    expect(shouldReframe(inside, 400, 300, 12, 12.3)).toBe(false)
    expect(shouldReframe(inside, 400, 300, 12, 13)).toBe(true)
    expect(shouldReframe([{ x: 390, y: 100 }], 400, 300, 12, 12)).toBe(true)
    // A map not laid out yet: frame it.
    expect(shouldReframe(inside, 0, 0, 12, 12)).toBe(true)
  })
})
