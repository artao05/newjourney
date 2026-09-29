import { describe, expect, it } from 'vitest'
import { beepsBetween, parseClockTime, parseCountdown, rollGun } from './timer'

describe('the start timer', () => {
  it('reads minutes and seconds, or minutes', () => {
    expect(parseCountdown('4:30')).toBe(270)
    expect(parseCountdown('10')).toBe(600)
    expect(parseCountdown('2.5')).toBe(150)
    expect(parseCountdown('4:75')).toBeNull()
    expect(parseCountdown('soon')).toBeNull()
  })

  it('sets the gun at a clock time, today or else tomorrow', () => {
    const now = new Date(2026, 8, 29, 13, 50, 0).getTime()
    expect(parseClockTime('14:05', now)).toBe(new Date(2026, 8, 29, 14, 5, 0).getTime())
    expect(parseClockTime('13:00:30', now)).toBe(new Date(2026, 8, 30, 13, 0, 30).getTime())
    expect(parseClockTime('25:00', now)).toBeNull()
  })

  it('rolls to the next start in the sequence, even after a missed one', () => {
    const gun = 1_000_000
    expect(rollGun(gun, gun - 1, 5)).toBe(gun)
    expect(rollGun(gun, gun, 5)).toBe(gun + 300_000)
    expect(rollGun(gun, gun + 301_000, 5)).toBe(gun + 600_000)
  })

  it('sounds on the minutes, at thirty seconds, and for the last ten', () => {
    expect(beepsBetween(60.4, 59.6)).toEqual(['long'])
    expect(beepsBetween(31, 29.9)).toEqual(['short'])
    expect(beepsBetween(45, 44)).toEqual([])
    expect(beepsBetween(3.5, 0)).toEqual(['short', 'short', 'short', 'long'])
    expect(beepsBetween(0, -1)).toEqual([])
  })

  it('stays quiet over a jump, which is a timer being set rather than counting', () => {
    expect(beepsBetween(300, 120)).toEqual([])
    expect(beepsBetween(120, 300)).toEqual([])
  })
})
