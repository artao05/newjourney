import { describe, expect, it } from 'vitest'
import { greatCirclePoint, rhumbPoint, routeGrid } from './grid'
import { defaultConstraints, defaultScalings, routeIsochrone } from './isochrone'
import { buildLattice } from '@/lib/polar'
import { findPolar } from '@/data/polars'
import { destination, distance } from '@/lib/geo'
import type { LatLon, RouteRequest, WeatherField } from '@/lib/types'

const DEG = Math.PI / 180
const LATTICE = buildLattice(findPolar('j70')!.polar)
const T0 = Date.UTC(2026, 8, 29, 12)

function uniform(twd: number, tws: number): WeatherField {
  return {
    wind: () => ({ u: -tws * Math.sin(twd * DEG), v: -tws * Math.cos(twd * DEG), source: 'test' }),
    gust: () => null,
    current: () => null,
    waves: () => null,
    coverage: () => ({ bbox: { west: -180, south: -85, east: 180, north: 85 }, t0: T0 - 3_600_000, t1: T0 + 96 * 3_600_000 }),
  }
}

const req = (start: LatLon, to: LatLon): RouteRequest => ({
  start,
  startTime: T0,
  marks: [to],
  constraints: { ...defaultConstraints(), tackPenaltyS: 0, gybePenaltyS: 0 },
  scalings: defaultScalings(),
  resolution: 'best',
  computeSensitivity: false,
})

describe('the grid router', () => {
  const start = { lat: 43, lon: -70 }

  it('sails a beam reach straight, in exactly the polar time', () => {
    const to = destination(start, 0, 10)
    const res = routeGrid(req(start, to), { field: uniform(90, 12), lattice: LATTICE })
    expect(res.ok, res.error).toBe(true)
    const expected = (distance(start, to) / LATTICE.speed(12, 90)) * 3600
    expect(res.elapsedS!).toBeCloseTo(expected, 0)
    expect(res.legs.every((l) => Math.abs(l.position.lon - start.lon) < 1e-6)).toBe(true)
  })

  it('agrees with the isochrone solver on open water, on a reach and on a beat', () => {
    for (const [brg, tol] of [[45, 0.03], [0, 0.08]] as const) {
      const to = destination(start, brg, 8)
      const field = uniform(0, 12)
      const grid = routeGrid(req(start, to), { field, lattice: LATTICE })
      const iso = routeIsochrone(req(start, to), { field, lattice: LATTICE })
      expect(grid.ok && iso.ok, grid.error ?? iso.error).toBe(true)
      const ratio = grid.elapsedS! / iso.elapsedS!
      console.log(`  · 9.9 grid vs isochrones, course ${brg}°: ${ratio.toFixed(3)}`)
      // The grid charges no tacks but cannot pick any angle: within a few per cent.
      expect(Math.abs(ratio - 1)).toBeLessThan(tol)
    }
  })

  it('lays its rows along the great circle when asked, poleward of the rhumb line', () => {
    const a = { lat: 45, lon: -60 }
    const b = { lat: 45, lon: -20 }
    expect(greatCirclePoint(a, b, 0.5).lat).toBeGreaterThan(45.5)
    // A narrow grid, so each keeps to the track it is laid along: a wide rhumb grid
    // finds the great circle for itself, which is right, and proves nothing here.
    const gc = routeGrid(req(a, b), { field: uniform(180, 14), lattice: LATTICE }, { greatCircle: true, rows: 40, widthFrac: 0.02 })
    const rl = routeGrid(req(a, b), { field: uniform(180, 14), lattice: LATTICE }, { rows: 40, widthFrac: 0.02 })
    expect(gc.ok && rl.ok).toBe(true)
    const mid = (r: typeof gc) => r.legs[Math.floor(r.legs.length / 2)].position.lat
    expect(mid(gc)).toBeGreaterThan(mid(rl))
    // Shorter water, though not always faster: the angle to the wind changes along it.
    const sailed = (r: typeof gc) => r.legs.reduce((d, l) => d + l.distanceNm, 0)
    expect(sailed(gc)).toBeLessThan(sailed(rl))
  })

  it('keeps a rhumb line on a constant latitude going east', () => {
    const p = rhumbPoint({ lat: 45, lon: -60 }, { lat: 45, lon: -20 }, 0.5)
    expect(p).toEqual({ lat: 45, lon: -40 })
    const q = rhumbPoint({ lat: 0, lon: 0 }, { lat: 60, lon: 10 }, 0.5)
    expect(q.lat).toBe(30)
    // Longitude is even in Mercator latitude, so the halfway longitude is short of 5°.
    expect(q.lon).toBeLessThan(5)
  })

  it('says so when there is no way through', () => {
    const res = routeGrid(req(start, destination(start, 0, 5)), { field: uniform(0, 0), lattice: LATTICE })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no way through/)
  })
})
