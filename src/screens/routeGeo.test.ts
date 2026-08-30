/**
 * Beat-segment extraction: the dashed overlay on the route map.
 *
 * `isBeating` on leg i means the segment FROM leg[i] TO leg[i+1] is a beat.
 * The LineString for a contiguous beat run must include the terminal endpoint
 * (the first non-beating position after the run), otherwise the last tacking
 * segment disappears from the map.
 */

import { describe, expect, it } from 'vitest'
import { extractBeatSegments } from './RouteScreen'

const leg = (lon: number, lat: number, isBeating: boolean) => ({
  position: { lon, lat },
  isBeating,
})

describe('extractBeatSegments', () => {
  it('returns [] for all-free-sailing legs', () => {
    const legs = [leg(0, 0, false), leg(1, 1, false), leg(2, 2, false)]
    expect(extractBeatSegments(legs)).toEqual([])
  })

  it('returns [] for an empty array', () => {
    expect(extractBeatSegments([])).toEqual([])
  })

  it('includes the terminal endpoint of a beat run', () => {
    // legs 0-2 are beating, leg 3 is free sailing.
    // Segments 0→1, 1→2, 2→3 are beats. The line must be [pos0, pos1, pos2, pos3].
    const legs = [leg(0, 0, true), leg(1, 1, true), leg(2, 2, true), leg(3, 3, false)]
    const segs = extractBeatSegments(legs)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3], // terminal endpoint — must be present
    ])
  })

  it('handles a single beating leg followed by free sailing', () => {
    // Leg 0 is beating → segment 0→1 is a beat. Line must be [pos0, pos1].
    const legs = [leg(0, 0, true), leg(1, 1, false)]
    const segs = extractBeatSegments(legs)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual([
      [0, 0],
      [1, 1],
    ])
  })

  it('handles two disjoint beat runs', () => {
    const legs = [
      leg(0, 0, true),  // beat 0→1
      leg(1, 1, false), // free 1→2
      leg(2, 2, true),  // beat 2→3
      leg(3, 3, true),  // beat 3→4
      leg(4, 4, false), // free 4→5
      leg(5, 5, false),
    ]
    const segs = extractBeatSegments(legs)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual([[0, 0], [1, 1]])
    expect(segs[1]).toEqual([[2, 2], [3, 3], [4, 4]])
  })

  it('handles route ending while still beating', () => {
    // All legs beat, no trailing non-beating leg. Last leg has isBeating from
    // P.beat[here] and distanceNm=0, so no terminal to add.
    const legs = [leg(0, 0, true), leg(1, 1, true), leg(2, 2, true)]
    const segs = extractBeatSegments(legs)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual([[0, 0], [1, 1], [2, 2]])
  })

  it('dead-upwind pattern: all legs beating except last', () => {
    // Matches isochrone test §10.2: legs.slice(0, -1).every(l => l.isBeating)
    const legs = [
      leg(-70, 40, true),
      leg(-70, 41, true),
      leg(-70, 42, true),
      leg(-70, 43, false), // final arrival
    ]
    const segs = extractBeatSegments(legs)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toHaveLength(4) // must include the arrival point
    expect(segs[0][3]).toEqual([-70, 43])
  })
})
