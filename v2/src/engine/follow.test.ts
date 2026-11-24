import { describe, expect, it } from 'vitest'
import { destination, distance } from '@/lib/geo'
import { routeIsochrone } from '@/lib/routing'
import type { LatLon, RouteResult } from '@/lib/types'
import { CubeField } from '@/lib/weather'
import { boatModel } from './boats'
import { layoutCourse, pointOnLine } from './course'
import { aheadOnRoute, followPieces, nearestStretch, toSegment, type RoutePoint } from './follow'
import { demoForecast, forecastWind } from './forecast'
import { routeRequest } from './plan'
import { World } from './world'

const CENTER = { lat: 43.585, lon: -70.16 }
const T0 = new Date(2026, 6, 15, 14, 0, 0).getTime()
const forecast = demoForecast(CENTER, T0)
const twd = forecastWind(forecast, CENTER, T0)!.twd

function routeFor(start: LatLon, marks: LatLon[], t0: number): RouteResult {
  return routeIsochrone(routeRequest({ start, marks, t0 }), { field: new CubeField(forecast.cube), lattice: boatModel('j70').lattice })
}

/** The nearest the polyline comes to `p`. */
function offRoute(pts: LatLon[], p: LatLon): number {
  let d = Infinity
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, toSegment(p, pts[i]!, pts[i + 1]!).d)
  return d
}

describe('route geometry', () => {
  const pts: RoutePoint[] = [
    { lat: 43.58, lon: -70.16, beat: false },
    { lat: 43.59, lon: -70.16, beat: false },
    { lat: 43.59, lon: -70.15, beat: false },
  ]
  it('finds the stretch a boat is beside, and only looks forward', () => {
    const p = destination(pts[1]!, 90, 0.1)
    expect(nearestStretch(pts, 0, p).seg).toBe(1)
    expect(nearestStretch(pts, 1, destination(pts[0]!, 0, 0.1)).seg).toBe(1)
  })
  it('looks ahead along the route, round its corners', () => {
    const a = aheadOnRoute(pts, 0, 0.9, 0.1)
    // 0.06 nm to the corner, then 0.04 nm east of it.
    expect(a.lat).toBeCloseTo(pts[1]!.lat, 5)
    expect(distance(pts[1]!, a)).toBeCloseTo(0.04, 3)
  })
})

describe('following the route', () => {
  it('splits a whole-course route by leg', () => {
    const { marks, course } = layoutCourse('triangle', CENTER, twd, 0.6)
    const w = new World({ forecast, marks, course, boatId: 'j70', ownPos: CENTER, t: T0 })
    const r = routeFor(pointOnLine(w.line!, 0.5), w.sequence, T0)
    expect(r.ok).toBe(true)
    const f = followPieces(r, w.sequence, 0)!
    expect([...f.legs.keys()]).toEqual(w.sequence.map((_, i) => i))
    // Each piece ends at its mark and the next starts there.
    for (let i = 0; i < w.sequence.length; i++) {
      const p = f.legs.get(i)!
      expect(distance(p[p.length - 1]!, w.sequence[i]!)).toBeLessThan(0.05)
      if (i > 0) expect(distance(p[0]!, f.legs.get(i - 1)!.at(-1)!)).toBeLessThan(1e-6)
    }
  })

  // The 0.9 nm beat at 14:00 found every way a follower got stuck: overshooting
  // a corner, oscillating at the edge of the route, tacking every ten seconds
  // on a zigzag a shift had made sailable.
  for (const layout of ['w2', 'w4', 'triangle', 'trapezoid'] as const) {
    it(`${layout}: the own boat sails the planned route, without the learner's mistakes`, () => {
      const { marks, course } = layoutCourse(layout, CENTER, twd, 0.9)
      const w = new World({ forecast, marks, course, boatId: 'j70', ownPos: destination(CENTER, twd + 180, 0.2), t: T0 })
      w.setMistakes(true)
      w.startSequence(3)
      const r = routeFor(pointOnLine(w.line!, 0.5), w.sequence, w.gunT!)
      w.setFollow(followPieces(r, w.sequence, 0)!)
      for (let i = 0; i < 3600 * 3 && w.own.phase !== 'finished'; i++) w.step(1)
      expect(w.own.phase).toBe('finished')

      const route = r.legs.map((l) => l.position)
      const nearMark = (p: LatLon) => w.sequence.some((m) => distance(p, m) < 0.12)
      const off = w.samples
        .filter((s) => s.t >= w.gunT! + 60_000 && !nearMark(s))
        .map((s) => offRoute(route, s))
        .sort((a, b) => a - b)
      expect(off[Math.floor(off.length / 2)]!, 'mostly on the line').toBeLessThan(0.05)
      expect(off[Math.floor(off.length * 0.95)]!, 'and within the lane around it').toBeLessThan(0.17)
      // No scripted lapses while following, and no tacking on the spot.
      const evs = w.events.filter((e) => e.boatId === 'own')
      expect(evs.filter((e) => e.kind === 'lapse')).toHaveLength(0)
      const turns = evs.filter((e) => e.kind === 'tack' || e.kind === 'gybe')
      expect(turns.length).toBeLessThan(40)
      expect(turns.filter((e) => /route/.test(e.detail)).length).toBeGreaterThan(turns.length / 2)
      // About as quick as the route said, give or take the time tacks cost.
      const sailedS = (w.own.finishedT! - w.gunT!) / 1000
      expect(sailedS / r.elapsedS!).toBeLessThan(1.12)
    })
  }
})
