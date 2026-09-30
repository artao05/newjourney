import { afterEach, describe, expect, it } from 'vitest'
import { PILOT_VENUE } from '@/data/venues'
import { decimalYear, variationAt } from '@/lib/magnetic'
import { magneticField } from '@/lib/wmm'
import { useStore } from '@/state/store'
import { variationHere, variationPlace } from './useVariation'

describe('variation where the boat is', () => {
  afterEach(() => useStore.setState({ state: null }))

  it("is the venue centre's before there is a fix", () => {
    useStore.setState({ state: null })
    expect(variationPlace()).toEqual(PILOT_VENUE.center)
    const t = Date.UTC(2026, 8, 27)
    expect(variationHere(t)).toBeCloseTo(magneticField(PILOT_VENUE.center.lat, PILOT_VENUE.center.lon, 0, decimalYear(t)).decl, 9)
  })

  it("follows the boat: off Newport it is 14° W, off Plymouth 1° W, in the Solent all but nil", () => {
    const t = Date.UTC(2026, 6, 1)
    const at = (lat: number, lon: number) => {
      useStore.setState({ state: { t, position: { lat, lon }, cog: 0, sog: 0 } as never })
      return variationHere(t)
    }
    expect(at(41.45, -71.33)).toBeCloseTo(variationAt({ lat: 41.45, lon: -71.33 }, t), 9)
    expect(at(41.45, -71.33)).toBeLessThan(-13)
    expect(Math.abs(at(50.35, -4.14))).toBeLessThan(2)
    expect(Math.abs(at(50.77, -1.3))).toBeLessThan(1.5)
  })
})
