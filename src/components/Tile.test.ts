/**
 * The four time/duration formatters that appear on every screen.
 *
 * Every number a sailor reads on the Race, Start and Route screens comes through
 * one of these. They are pure functions with no test, and the edge cases — nulls,
 * NaN, negative seconds, boundary-crossing values — are exactly the inputs the
 * app feeds them when GPS drops out or the gun fires.
 */

import { describe, expect, it } from 'vitest'
import { fmtDuration, fmtClock, fmtAgo, fmtSigned } from './Tile'

describe('fmtDuration', () => {
  it('returns null for null, undefined, NaN, and Infinity', () => {
    expect(fmtDuration(null)).toBeNull()
    expect(fmtDuration(undefined)).toBeNull()
    expect(fmtDuration(NaN)).toBeNull()
    expect(fmtDuration(Infinity)).toBeNull()
    expect(fmtDuration(-Infinity)).toBeNull()
  })

  it('formats seconds below a minute', () => {
    expect(fmtDuration(0)).toBe('0s')
    expect(fmtDuration(1)).toBe('1s')
    expect(fmtDuration(59)).toBe('59s')
  })

  it('formats minutes below an hour', () => {
    expect(fmtDuration(60)).toBe('1m')
    expect(fmtDuration(90)).toBe('1m')
    expect(fmtDuration(3599)).toBe('59m')
  })

  it('formats hours below a day', () => {
    expect(fmtDuration(3600)).toBe('1h 00m')
    expect(fmtDuration(3660)).toBe('1h 01m')
    expect(fmtDuration(5 * 3600 + 9 * 60)).toBe('5h 09m')
  })

  it('formats days', () => {
    expect(fmtDuration(24 * 3600)).toBe('1d 00h')
    expect(fmtDuration(2 * 24 * 3600 + 3 * 3600)).toBe('2d 03h')
  })

  it('handles negative durations', () => {
    expect(fmtDuration(-30)).toBe('-30s')
    expect(fmtDuration(-90)).toBe('-1m')
    expect(fmtDuration(-3661)).toBe('-1h 01m')
    expect(fmtDuration(-86400)).toBe('-1d 00h')
  })

  it('rounds the input so a fractional second does not corrupt the display', () => {
    expect(fmtDuration(59.4)).toBe('59s')
    expect(fmtDuration(59.6)).toBe('1m')
  })
})

describe('fmtClock', () => {
  it('returns null for null, undefined, NaN, and Infinity', () => {
    expect(fmtClock(null)).toBeNull()
    expect(fmtClock(undefined)).toBeNull()
    expect(fmtClock(NaN)).toBeNull()
    expect(fmtClock(Infinity)).toBeNull()
  })

  it('formats as mm:ss', () => {
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(61)).toBe('1:01')
    expect(fmtClock(3599)).toBe('59:59')
    expect(fmtClock(3600)).toBe('60:00')
  })

  it('shows a minus for negative values (after-gun countdown)', () => {
    expect(fmtClock(-1)).toBe('-0:01')
    expect(fmtClock(-61)).toBe('-1:01')
  })

  it('floors rather than rounds, so a sub-second does not advance the display', () => {
    expect(fmtClock(0.9)).toBe('0:00')
    expect(fmtClock(59.9)).toBe('0:59')
  })
})

describe('fmtAgo', () => {
  it('returns null for null, undefined, NaN, and Infinity', () => {
    expect(fmtAgo(null)).toBeNull()
    expect(fmtAgo(undefined)).toBeNull()
    expect(fmtAgo(NaN)).toBeNull()
    expect(fmtAgo(Infinity)).toBeNull()
  })

  it('clamps negative to zero', () => {
    expect(fmtAgo(-10)).toBe('0s')
  })

  it('formats seconds below 90', () => {
    expect(fmtAgo(0)).toBe('0s')
    expect(fmtAgo(89)).toBe('89s')
  })

  it('switches to minutes at 90 seconds', () => {
    expect(fmtAgo(90)).toBe('2 min')
    expect(fmtAgo(89 * 60)).toBe('89 min')
  })

  it('switches to hours once Math.round(s/60) reaches 90', () => {
    expect(fmtAgo(5399)).toBe('1 h')
    expect(fmtAgo(5400)).toBe('2 h')
    expect(fmtAgo(23 * 3600)).toBe('23 h')
  })

  it('switches to days at 24 hours', () => {
    expect(fmtAgo(24 * 3600)).toBe('1 day')
    expect(fmtAgo(48 * 3600)).toBe('2 days')
  })

  it('pluralises days correctly', () => {
    expect(fmtAgo(24 * 3600)).toBe('1 day')
    expect(fmtAgo(2 * 24 * 3600)).toBe('2 days')
  })
})

describe('fmtSigned', () => {
  it('returns null for null, undefined, NaN, and Infinity', () => {
    expect(fmtSigned(null)).toBeNull()
    expect(fmtSigned(undefined)).toBeNull()
    expect(fmtSigned(NaN)).toBeNull()
    expect(fmtSigned(Infinity)).toBeNull()
  })

  it('shows + for positive, nothing for zero', () => {
    expect(fmtSigned(18)).toBe('+18s')
    expect(fmtSigned(0)).toBe('0s')
  })

  it('shows - for negative', () => {
    expect(fmtSigned(-4)).toBe('-4s')
  })

  it('switches to mm:ss above 60 seconds', () => {
    expect(fmtSigned(61)).toBe('+1:01')
    expect(fmtSigned(-90)).toBe('-1:30')
  })

  it('rounds the input', () => {
    expect(fmtSigned(59.6)).toBe('+1:00')
    expect(fmtSigned(-59.6)).toBe('-1:00')
  })
})
