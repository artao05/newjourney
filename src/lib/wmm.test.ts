import { describe, expect, it } from 'vitest'
import { WMM2025 } from '@/data/wmm2025'
import { realText } from '../realFiles'
import { magneticField, parseCof } from './wmm'

/** NCEI's WMM2025 test values: year, height (km), lat, lon, D, I, H, X, Y, Z, F, then each one's change a year. */
const cases = realText('WMM2025_TestValues.txt')
  .split(/\r?\n/)
  .filter((l) => /^\s*\d{4}\.\d+/.test(l))
  .map((l) => l.trim().split(/\s+/).map(Number))

describe('the World Magnetic Model', () => {
  it("carries NOAA's coefficients exactly as its WMM.COF gives them", () => {
    const cof = parseCof(realText('WMM2025.COF'))
    expect([cof.name, cof.epoch, cof.rows.length]).toEqual(['WMM-2025', 2025, 90])
    expect(WMM2025.rows).toEqual(cof.rows)
  })

  it("matches every one of NCEI's WMM2025 test values", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20)
    for (const [year, alt, lat, lon, D, I, H, X, Y, Z, F, Dd, Id, Hd, Xd, Yd, Zd, Fd] of cases) {
      const m = magneticField(lat, lon, alt, year)
      const at = `${year} ${alt} km ${lat} ${lon}`
      // Angles are given to 0.01°; the field to a millionth of a nanotesla.
      expect(Math.abs(m.decl - D), `D ${at}`).toBeLessThan(0.006)
      expect(Math.abs(m.incl - I), `I ${at}`).toBeLessThan(0.006)
      for (const [got, want, name] of [
        [m.h, H, 'H'],
        [m.x, X, 'X'],
        [m.y, Y, 'Y'],
        [m.z, Z, 'Z'],
        [m.f, F, 'F'],
      ] as const)
        expect(Math.abs(got - want), `${name} ${at}`).toBeLessThan(0.01)
      for (const [got, want, name] of [
        [m.declDot, Dd, 'dD'],
        [m.inclDot, Id, 'dI'],
      ] as const)
        expect(Math.abs(got - want), `${name} ${at}`).toBeLessThan(1e-4)
      for (const [got, want, name] of [
        [m.hDot, Hd, 'dH'],
        [m.xDot, Xd, 'dX'],
        [m.yDot, Yd, 'dY'],
        [m.zDot, Zd, 'dZ'],
        [m.fDot, Fd, 'dF'],
      ] as const)
        expect(Math.abs(got - want), `${name} ${at}`).toBeLessThan(0.01)
    }
  })

  it("gives Portland the variation NOAA's calculator gave, 14.46° W on 27 September 2026", () => {
    const m = magneticField(43.66, -70.25, 0, 2026.7369)
    expect(m.decl).toBeCloseTo(-14.45669, 3)
    expect(m.declDot).toBeCloseTo(0.08658, 3)
    expect(m.valid).toBe(true)
    expect(magneticField(43.66, -70.25, 0, 2031).valid).toBe(false)
  })
})
