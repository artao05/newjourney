import { describe, expect, it } from 'vitest'
import { parseLatLon } from './latlon'

const PORTLAND = { lat: 43 + 39.534 / 60, lon: -(70 + 12.306 / 60) }
const near = (p: { lat: number; lon: number } | null, want: { lat: number; lon: number }) => {
  expect(p).not.toBeNull()
  expect(p!.lat).toBeCloseTo(want.lat, 5)
  expect(p!.lon).toBeCloseTo(want.lon, 5)
}

describe('parseLatLon reads a position however it was written', () => {
  it('decimal degrees, signed or with hemispheres', () => {
    near(parseLatLon('43.6589, -70.2051'), { lat: 43.6589, lon: -70.2051 })
    near(parseLatLon('43.6589 -70.2051'), { lat: 43.6589, lon: -70.2051 })
    near(parseLatLon('43.6589N 70.2051W'), { lat: 43.6589, lon: -70.2051 })
  })

  it('degrees and decimal minutes, as a chart plotter writes them', () => {
    near(parseLatLon('43 39.534 N, 070 12.306 W'), PORTLAND)
    near(parseLatLon("43°39.534'N 070°12.306'W"), PORTLAND)
    near(parseLatLon('N 43 39.534 W 070 12.306'), PORTLAND)
    near(parseLatLon('43 39.534N 70 12.306W'), PORTLAND)
  })

  it('degrees, minutes and seconds', () => {
    near(parseLatLon('43°39\'32.04"N 70°12\'18.36"W'), PORTLAND)
    near(parseLatLon('43 39 32.04 N, 70 12 18.36 W'), PORTLAND)
  })

  it('the southern and eastern hemispheres', () => {
    near(parseLatLon('33 51.0 S, 151 12.5 E'), { lat: -33.85, lon: 151 + 12.5 / 60 })
  })

  it('longitude first, when the letters say so', () => {
    near(parseLatLon('070 12.306 W, 43 39.534 N'), PORTLAND)
  })

  it('refuses rather than guesses', () => {
    expect(parseLatLon('')).toBeNull()
    expect(parseLatLon('Portland')).toBeNull()
    expect(parseLatLon('91 00 N, 70 00 W')).toBeNull()
    expect(parseLatLon('43 60.0 N, 70 00 W')).toBeNull()
    expect(parseLatLon('-43 39.5 N, 70 12 W')).toBeNull()
    expect(parseLatLon('43 39.5 E, 70 12 W')).toBeNull()
    expect(parseLatLon('43.5 39.5 N, 70 12 W')).toBeNull()
    expect(parseLatLon('43.6589')).toBeNull()
  })
})
