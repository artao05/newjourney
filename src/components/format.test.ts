/**
 * Tests for the display formatters in Tile.tsx.
 *
 * These are pure functions that decide what a number looks like on the one screen
 * a sailor stares at during a start, so they are worth pinning. `fmtSigned` in
 * particular carries the time-to-burn sign convention, which has already been
 * wrong once (see the note in StartScreen.tsx).
 */

import { describe, expect, it } from 'vitest'
import { fmtAgo, fmtClock, fmtSigned } from './Tile'

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
