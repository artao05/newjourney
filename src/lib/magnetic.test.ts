/**
 * The sign of the magnetic conversion is the thing to pin: get it backwards and
 * every hand-entered wind in Maine is 29 degrees out, not 14.5, and looks fine.
 */

import { describe, expect, it } from 'vitest'
import { decimalYear, declinationAt, magneticToTrue, trueToMagnetic } from './magnetic'
import { PILOT_VENUE } from '@/data/venues'

const PORTLAND = -14.45669 // east positive: 14.46 W

describe('true and magnetic', () => {
  it('variation west, magnetic best: the magnetic number is the larger', () => {
    expect(trueToMagnetic(270, PORTLAND)).toBeCloseTo(284.457, 3)
    expect(magneticToTrue(284.457, PORTLAND)).toBeCloseTo(270, 3)
  })

  it('wraps through north both ways', () => {
    expect(trueToMagnetic(350, PORTLAND)).toBeCloseTo(4.457, 3)
    expect(magneticToTrue(5, PORTLAND)).toBeCloseTo(350.543, 3)
  })

  it('round-trips every bearing', () => {
    for (let b = 0; b < 360; b += 7.5) {
      expect(magneticToTrue(trueToMagnetic(b, PORTLAND), PORTLAND)).toBeCloseTo(b, 9)
    }
  })
})

describe('declination over time', () => {
  it('states dates the way NOAA does', () => {
    // NOAA prints 2026.7369, truncated; the day starts at 269/365 = 2026.73699.
    expect(decimalYear(Date.UTC(2026, 8, 27))).toBeCloseTo(2026.7369, 3)
  })

  it('carries the venue value forward by its annual change', () => {
    const d = PILOT_VENUE.declination
    const atEpoch = Date.UTC(2026, 8, 27)
    expect(declinationAt(d, atEpoch)).toBeCloseTo(d.deg, 3)
    expect(declinationAt(d, Date.UTC(2027, 8, 27)) - declinationAt(d, atEpoch)).toBeCloseTo(d.perYearDeg, 4)
  })

  it('has Portland westerly, where every chart of Casco Bay puts it', () => {
    expect(PILOT_VENUE.declination.deg).toBeLessThan(-13)
    expect(PILOT_VENUE.declination.deg).toBeGreaterThan(-16)
    expect(PILOT_VENUE.sources.some((s) => s.href.includes('ngdc.noaa.gov'))).toBe(true)
  })
})
