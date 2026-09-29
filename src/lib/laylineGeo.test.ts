import { describe, expect, it } from 'vitest'
import { laylineLines } from './laylineGeo'
import { bearing, destination } from './geo'
import { angdiff } from './angles'
import { buildLattice } from './polar'
import { findPolar } from '@/data/polars'

const LATTICE = buildLattice(findPolar('j70')!.polar)
const MARK = { lat: 43.7, lon: -70.2 }
const near = (a: number, b: number) => expect(Math.abs(angdiff(a, b))).toBeLessThan(0.05)

describe('laylines on the chart', () => {
  it('runs each layline back from the mark along its tack, at the upwind target angle', () => {
    const below = destination(MARK, 180, 1)
    const l = laylineLines({ mark: MARK, from: below, wind: { twd: 0, tws: 12 }, lattice: LATTICE, boundsDeg: 0 })
    const up = Math.abs(LATTICE.targetsAt(12).upTwa)
    expect(l.upwind).toBe(true)
    near(l.starboardCourse, -up)
    near(l.portCourse, up)
    // Drawn from the mark, pointing back down the course the boat sails up.
    near(bearing(l.starboard[0], l.starboard[1]), 180 - up)
    near(bearing(l.port[0], l.port[1]), 180 + up)
    expect(l.bounds).toEqual([])
  })

  it('uses the downwind target when the mark is below the boat', () => {
    const above = destination(MARK, 0, 1)
    const l = laylineLines({ mark: MARK, from: above, wind: { twd: 0, tws: 12 }, lattice: LATTICE, boundsDeg: 0 })
    expect(l.upwind).toBe(false)
    near(l.starboardCourse, -Math.abs(LATTICE.targetsAt(12).downTwa))
  })

  it('draws the oscillation bounds either side of both laylines', () => {
    const l = laylineLines({ mark: MARK, from: null, wind: { twd: 0, tws: 12 }, lattice: LATTICE, boundsDeg: 8 })
    expect(l.bounds).toHaveLength(4)
    const ports = l.bounds.filter((b) => b.side === 'port').map((b) => bearing(b.line[0], b.line[1]))
    const centre = bearing(l.port[0], l.port[1])
    expect(ports.map((p) => Math.round(angdiff(p, centre))).sort((a, b) => a - b)).toEqual([-8, 8])
  })
})
