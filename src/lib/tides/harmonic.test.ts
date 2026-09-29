import { describe, expect, it } from 'vitest'
import { CONSTITUENTS, argument, astro, missingConstituents, nodeTime, parseHarcon, predictTide, speed } from './harmonic'

// NOAA's constituent speeds, degrees per hour, as its harmonic constants list them.
const NOAA_SPEEDS: Record<string, number> = {
  M2: 28.984104, S2: 30.0, N2: 28.43973, K1: 15.041069, M4: 57.96821, O1: 13.943035, M6: 86.95232, MK3: 44.025173,
  S4: 60.0, MN4: 57.423832, NU2: 28.512583, S6: 90.0, MU2: 27.968208, '2N2': 27.895355, OO1: 16.139101, LAM2: 29.455626,
  S1: 15.0, M1: 14.496694, J1: 15.585443, MM: 0.544375, SSA: 0.082137, SA: 0.041069, MSF: 1.015896, MF: 1.098033,
  RHO: 13.471515, Q1: 13.398661, T2: 29.958933, R2: 30.041067, '2Q1': 12.854286, P1: 14.958931, '2SM2': 31.015896,
  M3: 43.47616, L2: 29.528479, '2MK3': 42.92714, K2: 30.082138, M8: 115.93642, MS4: 58.984104,
}

describe('harmonic tides', () => {
  it("knows all 37 of NOAA's constituents, each at NOAA's speed", () => {
    expect(Object.keys(CONSTITUENTS).sort()).toEqual(Object.keys(NOAA_SPEEDS).sort())
    for (const [name, v] of Object.entries(NOAA_SPEEDS)) expect(speed(CONSTITUENTS[name]), name).toBeCloseTo(v, 4)
  })

  it('moves each argument at its speed, hour to hour', () => {
    const t = Date.UTC(2026, 8, 29, 6)
    for (const [name, k] of Object.entries(CONSTITUENTS)) {
      const d = argument(k, astro(t + 3_600_000)) - argument(k, astro(t))
      const step = ((d % 360) + 360) % 360
      expect(step, name).toBeCloseTo(speed(k) % 360, 2)
    }
  })

  it('puts the node factors in their ranges over the 18.6-year cycle', () => {
    const years = Array.from({ length: 20 }, (_, i) => Date.UTC(2006 + i, 6, 1))
    const range = (name: string) => {
      const f = years.map((t) => CONSTITUENTS[name].f(astro(t)))
      return [Math.min(...f), Math.max(...f)]
    }
    const [m2lo, m2hi] = range('M2')
    expect(m2lo).toBeCloseTo(0.963, 2)
    expect(m2hi).toBeCloseTo(1.038, 2)
    const [k1lo, k1hi] = range('K1')
    expect(k1lo).toBeGreaterThan(0.87)
    expect(k1hi).toBeLessThan(1.13)
    const [o1lo, o1hi] = range('O1')
    expect(o1lo).toBeGreaterThan(0.79)
    expect(o1hi).toBeLessThan(1.2)
    // The lunar node passes 0° in 2006 and 2024: the Moon's orbit is most inclined, M2 weakest.
    expect(astro(Date.UTC(2006, 2, 20)).N).toBeLessThan(5)
    expect(astro(Date.UTC(2006, 2, 20)).I).toBeCloseTo(28.6, 0)
  })

  it('predicts a pure M2 tide peaking where its phase says', () => {
    const t0 = Date.UTC(2026, 8, 29)
    const k = [{ name: 'M2', amplitude: 1, phase: 120 }]
    let best = { t: 0, h: -Infinity }
    for (let m = 0; m < 13 * 60; m += 1) {
      const t = t0 + m * 60_000
      const h = predictTide(k, t)
      if (h > best.h) best = { t, h }
    }
    // At the peak, V + u − κ is a whole turn, with f and u taken for mid-year as NOAA does.
    const a = astro(best.t)
    const b = astro(nodeTime(best.t))
    const [cT, cs, ch, cp, cp1, c0] = CONSTITUENTS.M2.v
    const phase = cT * a.T + cs * a.s + ch * a.h + cp * a.p + cp1 * a.p1 + c0 + CONSTITUENTS.M2.u(b) - 120
    expect(Math.cos((phase * Math.PI) / 180)).toBeCloseTo(1, 4)
    expect(best.h).toBeCloseTo(CONSTITUENTS.M2.f(b), 3)
    expect(nodeTime(Date.UTC(2026, 11, 31))).toBe(Date.UTC(2026, 6, 2))
  })

  it("reads NOAA's harmonic constants, and says which it cannot use", () => {
    const json = { units: 'meters', HarmonicConstituents: [{ number: 1, name: 'M2', amplitude: 1.35, phase_GMT: 107.3, speed: 28.984104 }, { number: 99, name: 'XX9', amplitude: 0.01, phase_GMT: 3, speed: 1 }, { name: 'S2', amplitude: 'x' }] }
    const k = parseHarcon(json)
    expect(k).toEqual([{ name: 'M2', amplitude: 1.35, phase: 107.3 }, { name: 'XX9', amplitude: 0.01, phase: 3 }])
    expect(missingConstituents(k)).toEqual(['XX9'])
    expect(parseHarcon({})).toEqual([])
  })
})
