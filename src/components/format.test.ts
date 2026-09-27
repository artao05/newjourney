/**
 * Tests for the display formatters in Tile.tsx.
 *
 * These are pure functions that decide what a number looks like on the one screen
 * a sailor stares at during a start, so they are worth pinning. `fmtSigned` in
 * particular carries the time-to-burn sign convention, which has already been
 * wrong once (see the note in StartScreen.tsx).
 */

import { describe, expect, it } from 'vitest'
import { fmtAgo, fmtClock, fmtDuration, fmtFixed, fmtSigned } from './Tile'

describe('fmtDuration', () => {
  it('carries units at every scale, so no reader has to guess the convention', () => {
    expect(fmtDuration(45)).toBe('45s')
    expect(fmtDuration(2880)).toBe('48m')
    expect(fmtDuration(18_554)).toBe('5h 09m')
    expect(fmtDuration(180_000)).toBe('2d 02h')
  })

  it('is the fix for a passage rendered as a race clock', () => {
    /*
     * The bug that motivated it: the departure sheet showed a 5 h 09 min passage
     * as "309:14" because it reused `fmtClock`, the start-timer formatter. Pinned
     * side by side so the difference is impossible to reintroduce by accident.
     */
    expect(fmtClock(18_554)).toBe('309:14')
    expect(fmtDuration(18_554)).toBe('5h 09m')
  })

  it('keeps the minutes that a coarse phrase would round away', () => {
    // `fmtAgo` is right for "how stale is this" and wrong for "how long is this":
    // the minutes are the whole comparison when ranking departures.
    expect(fmtAgo(18_554)).toBe('5 h')
    expect(fmtDuration(18_554)).toBe('5h 09m')
  })

  it('pads so a column of them lines up', () => {
    expect(fmtDuration(3600 + 5 * 60)).toBe('1h 05m')
    expect(fmtDuration(3600 + 55 * 60)).toBe('1h 55m')
  })

  it('signs a negative rather than dropping it', () => {
    expect(fmtDuration(-600)).toBe('-10m')
    expect(fmtDuration(-7200)).toBe('-2h 00m')
  })

  it('drops the sign when the magnitude rounds to zero', () => {
    // At the gun the timer crosses zero; -0.4 rounds to 0, and the sailor
    // should see "0s", not the nonsensical "-0s".
    expect(fmtDuration(-0.4)).toBe('0s')
    expect(fmtDuration(-0.1)).toBe('0s')
    expect(fmtDuration(-0.499)).toBe('0s')
  })

  it('is null for unknown rather than guessing zero', () => {
    expect(fmtDuration(null)).toBeNull()
    expect(fmtDuration(undefined)).toBeNull()
    expect(fmtDuration(NaN)).toBeNull()
  })
})

describe('fmtClock', () => {
  it('renders m:ss', () => {
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(65)).toBe('1:05')
    expect(fmtClock(600)).toBe('10:00')
  })

  it('keeps counting past the gun with a leading minus', () => {
    expect(fmtClock(-5)).toBe('-0:05')
    expect(fmtClock(-125)).toBe('-2:05')
  })

  it('drops the sign when the magnitude floors to zero', () => {
    // Sub-second negatives at the gun crossing: -0.9 floors to 0 total seconds,
    // and showing "-0:00" is wrong — the gun has not meaningfully fired yet.
    expect(fmtClock(-0.9)).toBe('0:00')
    expect(fmtClock(-0.01)).toBe('0:00')
    expect(fmtClock(-0.999)).toBe('0:00')
  })

  it('is null for unknown rather than guessing zero', () => {
    expect(fmtClock(null)).toBeNull()
    expect(fmtClock(undefined)).toBeNull()
    expect(fmtClock(NaN)).toBeNull()
  })
})

describe('fmtSigned', () => {
  it('shows the sign explicitly, because the sign is the message', () => {
    expect(fmtSigned(18)).toBe('+18s')
    expect(fmtSigned(-4)).toBe('-4s')
  })

  it('keeps zero unsigned', () => {
    expect(fmtSigned(0)).toBe('0s')
  })

  it('switches to m:ss past a minute, keeping the sign', () => {
    expect(fmtSigned(105)).toBe('+1:45')
    expect(fmtSigned(-105)).toBe('-1:45')
  })

  it('is null for unknown', () => {
    expect(fmtSigned(null)).toBeNull()
    expect(fmtSigned(NaN)).toBeNull()
  })
})

describe('fmtFixed', () => {
  it('never shows negative zero — the sign carries no information at zero', () => {
    // toFixed alone produces "-0", "-0.0", "-0.00" for small negatives that
    // round to zero. A sailor should never see a minus sign on a zero reading.
    expect(fmtFixed(-0.4, 0)).toBe('0')
    expect(fmtFixed(-0.04, 1)).toBe('0.0')
    expect(fmtFixed(-0.004, 2)).toBe('0.00')
    expect(fmtFixed(-0.001, 0)).toBe('0')
    expect(fmtFixed(-0.3, 0)).toBe('0')
    expect(fmtFixed(-0.49, 0)).toBe('0')
  })

  it('preserves the sign on genuine negatives', () => {
    expect(fmtFixed(-0.5, 0)).toBe('-1')
    expect(fmtFixed(-1.2, 1)).toBe('-1.2')
    expect(fmtFixed(-10, 0)).toBe('-10')
  })

  it('passes through zero and positive values unchanged', () => {
    expect(fmtFixed(0, 1)).toBe('0.0')
    expect(fmtFixed(0, 0)).toBe('0')
    expect(fmtFixed(3.14, 1)).toBe('3.1')
    expect(fmtFixed(99, 0)).toBe('99')
  })

  it('handles literal negative zero', () => {
    expect(fmtFixed(-0, 1)).toBe('0.0')
    expect(fmtFixed(-0, 0)).toBe('0')
  })
})

describe('fmtAgo', () => {
  /*
   * Exists because a gun time left running from yesterday rendered through
   * `fmtClock` as "-1323:38" — technically minutes and seconds, practically
   * meaningless, and the largest thing on the screen.
   */
  it('uses seconds under a minute and a half', () => {
    expect(fmtAgo(0)).toBe('0s')
    expect(fmtAgo(45)).toBe('45s')
  })

  it('uses whole minutes up to an hour and a half', () => {
    expect(fmtAgo(600)).toBe('10 min')
    expect(fmtAgo(3600)).toBe('60 min')
  })

  it('uses hours beyond that, up to a day', () => {
    expect(fmtAgo(2 * 3600)).toBe('2 h')
    expect(fmtAgo(22 * 3600)).toBe('22 h')
  })

  it('uses days from 24 h, and gets the plural right', () => {
    /*
     * The singular matters: with the cutoff at 36 h it was unreachable, because
     * Math.round(36/24) is already 2. A test that only checked "2 days" would have
     * been perfectly green over dead code.
     */
    expect(fmtAgo(24 * 3600)).toBe('1 day')
    expect(fmtAgo(30 * 3600)).toBe('1 day')
    expect(fmtAgo(48 * 3600)).toBe('2 days')
  })

  it('renders the case that motivated it as something readable', () => {
    // 1323 min 38 s — the actual observed stale timer.
    expect(fmtAgo(1323 * 60 + 38)).toBe('22 h')
  })

  it('clamps negatives rather than printing "-5s ago"', () => {
    expect(fmtAgo(-5)).toBe('0s')
  })

  it('is null for unknown', () => {
    expect(fmtAgo(null)).toBeNull()
    expect(fmtAgo(NaN)).toBeNull()
  })
})
