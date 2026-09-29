import { describe, expect, it } from 'vitest'
import { gateAround, gateNumbers } from './gates'
import { bearing, destination, distance } from './geo'
import { angdiff } from './angles'
import { buildLattice } from './polar'
import { findPolar } from '@/data/polars'

const LATTICE = buildLattice(findPolar('j70')!.polar)
const CENTRE = { lat: 43.6, lon: -70.2 }
// A 100 m leeward gate on a northerly course: the left buoy west, the right east.
const { left, right } = gateAround(CENTRE, 0, 100)
const ABOVE = destination(CENTRE, 0, 1)

describe('gate numbers', () => {
  it('squares to the course axis and measures the gate', () => {
    const g = gateNumbers({ from: ABOVE, left, right, wind: null, lattice: null })
    expect(Math.abs(angdiff(g.squareWindDeg, 0))).toBeLessThan(0.01)
    expect(g.lengthM).toBeCloseTo(100, 1)
    expect(g.rangeNm).toBeCloseTo(1, 4)
    expect(Math.abs(angdiff(g.bearing, 180))).toBeLessThan(0.01)
    expect(g.biasAngleDeg).toBeNull()
  })

  it('favours the buoy further up the course, as a start line would', () => {
    // Wind veered 10° (from 010): the right-hand buoy is now further upwind.
    const veer = gateNumbers({ from: ABOVE, left, right, wind: { twd: 10, tws: 12 }, lattice: null })
    expect(veer.biasAngleDeg).toBeCloseTo(10, 1)
    expect(veer.favoured).toBe('right')
    expect(veer.biasLengthM).toBeCloseTo(100 * Math.sin((10 * Math.PI) / 180), 1)
    const back = gateNumbers({ from: ABOVE, left, right, wind: { twd: 350, tws: 12 }, lattice: null })
    expect(back.favoured).toBe('left')
    expect(gateNumbers({ from: ABOVE, left, right, wind: { twd: 1, tws: 12 }, lattice: null }).favoured).toBe('even')
  })

  it("puts the gate spot above a leeward gate, where the laylines to both buoys cross", () => {
    const g = gateNumbers({ from: ABOVE, left, right, wind: { twd: 0, tws: 12 }, lattice: LATTICE })
    expect(g.spot).not.toBeNull()
    // Square wind and a symmetrical polar: the spot is straight up the axis.
    expect(Math.abs(angdiff(bearing(CENTRE, g.spot!), 0))).toBeLessThan(0.5)
    // From the spot, each buoy lies on its gybe's downwind target course.
    const t = LATTICE.targetsAt(12)
    const down = Math.abs(t.downTwa)
    expect(Math.abs(angdiff(bearing(g.spot!, left), 0 - down))).toBeLessThan(0.5)
    expect(Math.abs(angdiff(bearing(g.spot!, right), 0 + down))).toBeLessThan(0.5)
    expect(g.spotRangeNm).toBeCloseTo(distance(ABOVE, g.spot!), 9)
    expect(g.spotTimeS).toBeGreaterThan(0)
  })
})
