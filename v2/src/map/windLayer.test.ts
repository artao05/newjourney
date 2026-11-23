import { describe, expect, it } from 'vitest'
import { demoForecast } from '../engine/forecast'
import { windArrows } from './windLayer'

const HOME = { lat: 43.585, lon: -70.16 }
const f = demoForecast(HOME, Date.UTC(2026, 6, 1, 16))
const t = f.cube.t0 + 3 * 3_600_000

const key = (c: number[]) => `${c[0]!.toFixed(9)},${c[1]!.toFixed(9)}`
const coords = (fc: GeoJSON.FeatureCollection) => new Set(fc.features.map((x) => key((x.geometry as GeoJSON.Point).coordinates)))

describe('wind arrows', () => {
  it('stay on the same water when the view pans', () => {
    const view = { west: -70.2, east: -70.12, south: 43.56, north: 43.61 }
    const panned = { west: view.west + 0.031, east: view.east + 0.031, south: view.south - 0.017, north: view.north - 0.017 }
    const a = coords(windArrows(f.field, t, view, 12.6))
    const b = coords(windArrows(f.field, t, panned, 12.6))
    // Every arrow in the area both views cover is at exactly the same spot.
    const overlap = [...a].filter((k) => {
      const [lon, lat] = k.split(',').map(Number) as [number, number]
      return lon > panned.west && lon < view.east && lat > view.south && lat < panned.north
    })
    expect(overlap.length).toBeGreaterThan(10)
    for (const k of overlap) expect(b.has(k)).toBe(true)
  })

  it('keep about the same screen spacing at any zoom', () => {
    const near = windArrows(f.field, t, { west: -70.2, east: -70.12, south: 43.56, north: 43.61 }, 12.6).features.length
    const far = windArrows(f.field, t, { west: -70.52, east: -69.88, south: 43.36, north: 43.76 }, 9.6).features.length
    // Eight times the area at three zoom levels out: a similar number of arrows.
    expect(far / near).toBeGreaterThan(0.6)
    expect(far / near).toBeLessThan(1.6)
  })

  it('point the way the wind blows and stop at the forecast edge', () => {
    const fc = windArrows(f.field, t, { west: -72, east: -71.2, south: 43.4, north: 43.8 }, 11)
    const cov = f.field.coverage().bbox
    for (const x of fc.features) expect((x.geometry as GeoJSON.Point).coordinates[0]).toBeGreaterThanOrEqual(cov.west)
    const one = windArrows(f.field, t, { west: -70.2, east: -70.12, south: 43.56, north: 43.61 }, 12.6).features[0]!
    const w = f.field.wind(43.585, -70.16, t)!
    const from = (Math.atan2(-w.u, -w.v) * 180) / Math.PI
    expect(Math.abs((((one.properties!.to as number) - (from + 180)) % 360 + 540) % 360 - 180)).toBeLessThan(15)
  })
})
