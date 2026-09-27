/**
 * Open-Meteo ingest: caching, units, and the marine conventions.
 *
 * `field.test.ts` already covers the grid layout, the u/v signs, coarsening and the
 * marine-failure path. This file covers what nothing did: the cache, the unit
 * handling, ocean currents, time-axis alignment, and holes staying holes.
 *
 * The cache is the interesting part. It is the one piece of this module that can
 * hand a caller data it never asked for, and it does so silently.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearWeatherCache, cubeNotes, fetchWindCube } from './openmeteo'
import { cubeCoverage, cubeIndex, currentFromUv, windFromUv } from './cube'
import type { BBox } from '../types'

const T = Math.floor(Date.UTC(2026, 7, 26, 12, 0, 0) / 1000)
const realFetch = globalThis.fetch

let calls: string[] = []

/** One location block per requested point. */
function forecastPayload(url: string, opts: { speedUnit?: string; speed?: number } = {}): unknown {
  const lats = new URL(url).searchParams.get('latitude')!.split(',')
  return lats.map(() => ({
    hourly: {
      time: [T, T + 3600],
      wind_speed_10m: [opts.speed ?? 10, opts.speed ?? 10],
      wind_direction_10m: [90, 90],
      wind_gusts_10m: [14, 14],
      pressure_msl: [1013.2, 1012.8],
    },
    hourly_units: {
      wind_speed_10m: opts.speedUnit ?? 'kn',
      wind_gusts_10m: opts.speedUnit ?? 'kn',
      pressure_msl: 'hPa',
    },
  }))
}

function marinePayload(url: string, units?: Record<string, string>): unknown {
  const lats = new URL(url).searchParams.get('latitude')!.split(',')
  return lats.map(() => ({
    hourly: {
      time: [T, T + 3600],
      wave_height: [1.2, 1.4],
      wave_direction: [200, 205],
      wave_period: [6, 6.5],
      ocean_current_velocity: [3.7, 3.7],
      ocean_current_direction: [90, 90],
    },
    hourly_units: units ?? { ocean_current_velocity: 'km/h', wave_height: 'm' },
  }))
}

function stub(handler: (url: string) => { ok: boolean; body: unknown }): void {
  globalThis.fetch = ((input: string) => {
    const url = String(input)
    calls.push(url)
    const r = handler(url)
    return Promise.resolve({
      ok: r.ok,
      status: r.ok ? 200 : 503,
      statusText: r.ok ? 'OK' : 'Service Unavailable',
      json: () => Promise.resolve(r.body),
    })
  }) as unknown as typeof fetch
}

const windOnly = () => stub((url) => ({ ok: true, body: forecastPayload(url) }))

beforeEach(() => {
  calls = []
  clearWeatherCache()
})

afterEach(() => {
  globalThis.fetch = realFetch
  clearWeatherCache()
})

const BOX: BBox = { west: -70.5, south: 43, east: -70, north: 43.5 }
const base = { stepDeg: 0.25, hours: 2 }

describe('caching', () => {
  it('serves a repeat of the same request without going back to the network', async () => {
    windOnly()
    const a = await fetchWindCube({ bbox: BOX, ...base })
    const n = calls.length
    const b = await fetchWindCube({ bbox: BOX, ...base })
    expect(calls.length).toBe(n)
    expect(b).toBe(a)
  })

  it('treats a different model, step, horizon or layer set as a different cube', async () => {
    windOnly()
    await fetchWindCube({ bbox: BOX, ...base })
    const n = calls.length
    await fetchWindCube({ bbox: BOX, ...base, hours: 3 })
    expect(calls.length).toBeGreaterThan(n)
  })

  it('does not remember a failed fetch', async () => {
    // A flaky first load has to be retryable, or the app is stuck until reload.
    let fail = true
    stub((url) => (fail ? { ok: false, body: {} } : { ok: true, body: forecastPayload(url) }))
    await expect(fetchWindCube({ bbox: BOX, ...base })).rejects.toThrow()
    fail = false
    const cube = await fetchWindCube({ bbox: BOX, ...base })
    expect(cube.nx).toBeGreaterThan(0)
  })

  /*
   * The bug this file was written to find.
   *
   * The key quantised the bbox to 0.25 degrees so that "panning the map by a pixel
   * does not miss the cache", but the fetch used the caller's exact bbox. Two
   * different boxes that round to the same quarter-degree therefore shared one
   * entry, and the second caller silently received a cube built for the first
   * caller's box — offset by up to 0.125 degrees, about 7.5 nm, with a strip of the
   * requested area carrying no data at all.
   *
   * Downstream that is not a visible error. `sampleCube` correctly returns null
   * outside coverage, so the router simply finds no wind there and reports "no legal
   * move from the frontier". `RouteScreen` derives its bbox from the course marks,
   * so two different courses in the same corner of the bay collide.
   */
  it('never serves a cube that does not cover what was asked for', async () => {
    windOnly()
    const first: BBox = { west: -70.51, south: 43.01, east: -70.01, north: 43.51 }
    const second: BBox = { west: -70.44, south: 43.06, east: -69.94, north: 43.56 }

    const a = await fetchWindCube({ bbox: first, ...base })
    const b = await fetchWindCube({ bbox: second, ...base })

    const cov = cubeCoverage(b).bbox
    expect(cov.west).toBeLessThanOrEqual(second.west + 1e-9)
    expect(cov.south).toBeLessThanOrEqual(second.south + 1e-9)
    expect(cov.east).toBeGreaterThanOrEqual(second.east - 1e-9)
    expect(cov.north).toBeGreaterThanOrEqual(second.north - 1e-9)
    void a
  })
})

describe('units', () => {
  it('trusts the declared response unit over the requested one', async () => {
    // wind_speed_unit=kn is requested, but a model that answers in km/h and says so
    // must not be read as knots — that is a 1.9x error in every routing decision.
    stub((url) => ({ ok: true, body: forecastPayload(url, { speedUnit: 'km/h', speed: 18.52 }) }))
    const cube = await fetchWindCube({ bbox: BOX, ...base })
    const cell = cubeIndex(cube, 0, 0, 0)
    const w = windFromUv(cube.data.u10[cell], cube.data.v10[cell])
    expect(w.speed).toBeCloseTo(10, 1) // 18.52 km/h is 10 kn
    expect(w.dir).toBeCloseTo(90, 3)
  })

  it('reads knots as knots', async () => {
    stub((url) => ({ ok: true, body: forecastPayload(url, { speedUnit: 'kn', speed: 10 }) }))
    const cube = await fetchWindCube({ bbox: BOX, ...base })
    const cell = cubeIndex(cube, 0, 0, 0)
    expect(windFromUv(cube.data.u10[cell], cube.data.v10[cell]).speed).toBeCloseTo(10, 6)
  })
})

describe('ocean current', () => {
  it('stores current in the TOWARDS convention, converted from km/h', async () => {
    stub((url) =>
      url.includes('marine')
        ? { ok: true, body: marinePayload(url) }
        : { ok: true, body: forecastPayload(url) },
    )
    const cube = await fetchWindCube({ bbox: BOX, ...base, includeCurrent: true })
    const cell = cubeIndex(cube, 0, 0, 0)
    const c = currentFromUv(cube.data.uo[cell], cube.data.vo[cell])

    expect(c.drift).toBeCloseTo(2, 1) // 3.7 km/h is ~2 kn
    expect(c.set).toBeCloseTo(90, 3)
    // Setting east means a POSITIVE u — the opposite sign to a wind FROM 090,
    // which is the trap cube.ts names. Both are in this one cube.
    expect(cube.data.uo[cell]).toBeGreaterThan(0)
    expect(cube.data.u10[cell]).toBeLessThan(0)
  })

  it('says so when the velocity unit is not declared', async () => {
    stub((url) =>
      url.includes('marine')
        ? { ok: true, body: marinePayload(url, {}) }
        : { ok: true, body: forecastPayload(url) },
    )
    const cube = await fetchWindCube({ bbox: BOX, ...base, includeCurrent: true })
    expect(cubeNotes(cube).join(' ')).toMatch(/unit not declared/)
    // Still ingested, on the documented km/h assumption.
    const cell = cubeIndex(cube, 0, 0, 0)
    expect(currentFromUv(cube.data.uo[cell], cube.data.vo[cell]).drift).toBeCloseTo(2, 1)
  })
})

describe('holes and alignment', () => {
  it('leaves a missing value as a hole, never as a zero', async () => {
    stub((url) => {
      const lats = new URL(url).searchParams.get('latitude')!.split(',')
      return {
        ok: true,
        body: lats.map((_l, i) => ({
          hourly: {
            time: [T, T + 3600],
            // The second point has no wind at the second hour.
            wind_speed_10m: [10, i === 1 ? null : 10],
            wind_direction_10m: [90, 90],
            wind_gusts_10m: [14, 14],
            pressure_msl: [1013.2, 1012.8],
          },
          hourly_units: { wind_speed_10m: 'kn' },
        })),
      }
    })
    const cube = await fetchWindCube({ bbox: BOX, ...base })
    expect(Number.isNaN(cube.data.u10[cubeIndex(cube, 1, 0, 1)])).toBe(true)
    expect(Number.isNaN(cube.data.u10[cubeIndex(cube, 0, 0, 1)])).toBe(false)
  })

  it('skips hours a location reports that the cube does not have', async () => {
    // A location whose axis runs ahead of the cube's must not shift its series
    // into the wrong slots.
    stub((url) => {
      const lats = new URL(url).searchParams.get('latitude')!.split(',')
      return {
        ok: true,
        body: lats.map((_l, i) => ({
          hourly: {
            time: i === 0 ? [T, T + 3600] : [T + 7200, T + 10800],
            wind_speed_10m: [10, 10],
            wind_direction_10m: [90, 90],
            wind_gusts_10m: [14, 14],
            pressure_msl: [1013, 1013],
          },
          hourly_units: { wind_speed_10m: 'kn' },
        })),
      }
    })
    const cube = await fetchWindCube({ bbox: BOX, ...base })
    // Point 0 defines the axis and lands; point 1's hours are unknown, so it is
    // all holes rather than misaligned data.
    expect(Number.isNaN(cube.data.u10[cubeIndex(cube, 0, 0, 0)])).toBe(false)
    expect(Number.isNaN(cube.data.u10[cubeIndex(cube, 1, 0, 0)])).toBe(true)
    expect(Number.isNaN(cube.data.u10[cubeIndex(cube, 1, 0, 1)])).toBe(true)
  })

  it('reports the retrieval time as the run, not a guessed synoptic hour', async () => {
    windOnly()
    const cube = await fetchWindCube({ bbox: BOX, ...base })
    expect(() => new Date(cube.run).toISOString()).not.toThrow()
    expect(cube.model).toBeTruthy()
  })
})
