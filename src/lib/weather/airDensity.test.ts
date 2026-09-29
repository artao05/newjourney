import { describe, expect, it } from 'vitest'
import { RHO_REF, airDensity, densityWindFactor, saturationHpa } from './airDensity'

describe('air density', () => {
  it("puts Expedition's reference air at about 1.219 kg/m³, and dry standard air at 1.225", () => {
    expect(RHO_REF).toBeCloseTo(1.219, 3)
    expect(airDensity(1013.25, 15)).toBeCloseTo(1.225, 3)
    expect(saturationHpa(15)).toBeCloseTo(17.04, 1)
  })

  it('is thinner warm, humid and low, thicker cold and high', () => {
    expect(airDensity(995, 30, 90)).toBeLessThan(1.15)
    expect(airDensity(1035, -5, 70)).toBeGreaterThan(1.33)
    // Moist air is lighter than dry air at the same pressure and temperature.
    expect(airDensity(1013.25, 25, 100)).toBeLessThan(airDensity(1013.25, 25, 0))
  })

  it('scales the wind by the square root of the density ratio, within bounds', () => {
    expect(densityWindFactor(RHO_REF)).toBeCloseTo(1, 12)
    expect(densityWindFactor(RHO_REF * 1.1)).toBeCloseTo(Math.sqrt(1.1), 9)
    expect(densityWindFactor(0.5)).toBe(0.85)
    expect(densityWindFactor(NaN)).toBe(1)
  })
})
