import { describe, expect, it } from 'vitest'
import { fmtDmm, formatChannel, isSignedAngle } from './format'
import { CHANNELS, channel } from './catalogue'

const f = (id: string, v: number | null, units: 'metric' | 'imperial' = 'metric') =>
  formatChannel(channel(id)!, v, units)

describe('channel formatting', () => {
  it('writes bearings as three digits, wrapped after rounding', () => {
    expect(f('twd', 5)).toEqual({ text: '005', unit: '°' })
    expect(f('mark-bearing', 359.6)).toEqual({ text: '000', unit: '°' })
    expect(f('cog', -10)).toEqual({ text: '350', unit: '°' })
  })

  it('keeps the sign on angles where the sign is the side', () => {
    expect(f('twa', -42.4)).toEqual({ text: '-42', unit: '°' })
    expect(f('twa', 42.4)).toEqual({ text: '+42', unit: '°' })
    expect(f('start-bias-angle', -3)).toEqual({ text: '-3', unit: '°' })
    expect(isSignedAngle('twd')).toBe(false)
    expect(isSignedAngle('heel-roll')).toBe(true)
  })

  it('gives speeds two places under ten knots and one above', () => {
    expect(f('sog', 6.456)?.text).toBe('6.46')
    expect(f('tws', 18.25)?.text).toBe('18.3')
  })

  it('follows the units setting for lengths only', () => {
    expect(f('start-distance-below-line', 12.34)).toEqual({ text: '12.3', unit: 'm' })
    expect(f('start-distance-below-line', 3.048, 'imperial')).toEqual({ text: '10.0', unit: 'ft' })
    expect(f('mark-range', 1.234, 'imperial')?.unit).toBe('nm')
  })

  it('writes times as a race clock, and long ones as a passage length', () => {
    expect(f('start-time-to-gun', 95)?.text).toBe('1:35')
    expect(f('start-time-to-burn', -12)?.text).toBe('-0:12')
    expect(f('mark-time', 5 * 3600 + 9 * 60)?.text).toBe('5h 09m')
  })

  it('writes positions in degrees and decimal minutes', () => {
    expect(fmtDmm(43.65, false)).toBe("43°39.000'N")
    expect(fmtDmm(-70.2, true)).toBe("070°12.000'W")
    expect(fmtDmm(43.99999999, false)).toBe("44°00.000'N")
    expect(f('longtitude', -70.2)?.text).toBe("070°12.000'W")
  })

  it('returns null for a missing value, never a zero', () => {
    expect(f('sog', null)).toBeNull()
    expect(f('sog', Number.NaN)).toBeNull()
  })

  it('formats every catalogued channel without throwing', () => {
    for (const c of CHANNELS) expect(() => formatChannel(c, 12.5)).not.toThrow()
  })
})
