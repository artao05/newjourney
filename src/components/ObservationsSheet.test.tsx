/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ObservationsSheet, hourly, type ObsStation } from './ObservationsSheet'
import { uvFromWind } from '@/lib/weather/cube'
import type { Observation } from '@/lib/weather/observations'
import type { WeatherCube } from '@/lib/types'

afterEach(cleanup)

const H = 3_600_000
const T = Date.UTC(2026, 8, 29, 12)
const ob = (t: number, tws: number, twd = 200): Observation => ({ source: 'coops', station: '8418150', t, twd, tws, gust: tws + 3, pres: 1015, airTemp: null, dewPoint: null, seaTemp: null, hs: null, period: null, visNm: null })

describe('observations against the forecast', () => {
  it('keeps the report nearest each whole hour, newest first', () => {
    const list = [ob(T - 8 * 60_000, 8), ob(T + 6 * 60_000, 9), ob(T + H - 30 * 60_000 + 60_000, 10), ob(T + H + 2 * 60_000, 11)]
    expect(hourly(list).map((o) => o.tws)).toEqual([11, 9])
  })

  it('lists each station\'s reports with the forecast for the same place and hour', () => {
    const stations: ObsStation[] = [
      { id: '8418150', name: 'Portland, ME', position: { lat: 43.6583, lon: -70.2433 }, kind: 'coops' },
      { id: '44007', name: 'East Hue and Cry Rock', position: { lat: 43.525, lon: -70.14 }, kind: 'ndbc' },
    ]
    const w = uvFromWind(10, 190)
    const cube: WeatherCube = {
      model: 'm', run: '', bbox: { west: -71, south: 43, east: -70, north: 44 }, nx: 2, ny: 2, dx: 1, dy: 1, t0: T - H, dtMs: H, nt: 4,
      params: ['u10', 'v10'], data: { u10: new Float32Array(16).fill(w.u), v10: new Float32Array(16).fill(w.v) },
    }
    render(<ObservationsSheet stations={stations} obs={{ '8418150': [ob(T, 8), ob(T + H, 12, 210)] }} errors={{}} cube={cube} onClose={() => {}} />)
    const s = screen.getByRole('region', { name: 'Station 8418150' })
    expect(s.textContent).toContain('Latest 13:00Z: 210° 12.0 kn, gust 15.0 kn, 1015.0 hPa')
    const rows = within(s).getAllByRole('row').map((r) => r.textContent)
    expect(rows).toEqual(['TimeSeenGustForecastTWS diff', '13:00Z210° 12.015.0190° 10.0+2.0', '12:00Z200° 8.011.0190° 10.0-2.0'])
    expect(screen.getByRole('region', { name: 'Station 44007' }).textContent).toMatch(/proxy \(D1\)/)
  })
})
