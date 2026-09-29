import { describe, expect, it } from 'vitest'
import { fmtLength, lengthUnit, toLength } from './units'

describe('display lengths', () => {
  it('leaves metric as metres', () => {
    expect(lengthUnit('metric')).toBe('m')
    expect(fmtLength(12.34, 'metric')).toBe('12.3 m')
  })

  it('converts to feet at exactly 0.3048 m a foot', () => {
    expect(toLength(0.3048, 'imperial')).toBeCloseTo(1, 12)
    expect(fmtLength(3.048, 'imperial', 1)).toBe('10 ft')
    expect(fmtLength(12.34, 'imperial', 2)).toBe('40.5 ft')
  })

  it('shows nothing for a missing number, never a zero', () => {
    expect(fmtLength(null, 'metric')).toBeNull()
    expect(fmtLength(Number.NaN, 'imperial')).toBeNull()
  })
})
