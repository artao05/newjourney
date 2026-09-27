/**
 * The recorded track across a reload.
 *
 * A pilot's whole data flywheel is the track: it is what gets sent back and
 * replayed against the start-line maths. Losing it to a reload - a phone that
 * dropped the backgrounded app mid-race - loses the one thing the day produced.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { MAX_TRACK_POINTS, useStore } from './store'
import { TRACK_KEY, TRACK_SAVE_MS, decodeTrack, encodeTrack, useTrackPersistence } from './trackPersistence'
import type { TrackPoint } from '@/lib/types'

const T0 = Date.UTC(2026, 8, 27, 14, 0)

/** A second-by-second track heading north-east from Portland harbour. */
function trackOf(n: number): TrackPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    t: T0 + i * 1000,
    lat: 43.6412345 + i * 1e-5,
    lon: -70.2123456 + i * 1e-5,
    sog: 5 + (i % 7) * 0.13,
    cog: (40 + i * 0.37) % 360,
  }))
}

function Harness() {
  useTrackPersistence()
  return null
}

beforeEach(() => {
  localStorage.clear()
  useStore.getState().clearTrack()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the saved form', () => {
  it('round-trips positions to 1e-6 degrees and times exactly', () => {
    const track = trackOf(50)
    const back = decodeTrack(encodeTrack(track))!
    expect(back).toHaveLength(50)
    back.forEach((p, i) => {
      expect(p.t).toBe(track[i].t)
      expect(Math.abs(p.lat - track[i].lat)).toBeLessThanOrEqual(5e-7)
      expect(Math.abs(p.lon - track[i].lon)).toBeLessThanOrEqual(5e-7)
      expect(Math.abs(p.sog - track[i].sog)).toBeLessThanOrEqual(0.05)
    })
  })

  it('keeps "no reading" as NaN, never as a zero', () => {
    // JSON has no NaN. Saved naively it becomes null and loads back as 0: a
    // stationary fix would come back as a boat doing zero knots due north.
    const [p] = decodeTrack(encodeTrack([{ t: T0, lat: 43.6, lon: -70.2, sog: NaN, cog: NaN }]))!
    expect(p.sog).toBeNaN()
    expect(p.cog).toBeNaN()
  })

  it('refuses what is not a saved track, and drops malformed points', () => {
    expect(decodeTrack('not json')).toBeNull()
    expect(decodeTrack(JSON.stringify({ v: 2, t0: T0, p: [] }))).toBeNull()
    const mixed = JSON.stringify({ v: 1, t0: T0, p: [[0, 43.6, -70.2, 5, 40], ['x'], [1, 99, 0, 5, 40]] })
    expect(decodeTrack(mixed)).toHaveLength(1)
  })

  it('holds the full cap in well under a megabyte', () => {
    // The stated cap has to fit beside everything else in localStorage.
    expect(encodeTrack(trackOf(MAX_TRACK_POINTS)).length).toBeLessThan(1_000_000)
  })
})

describe('useTrackPersistence', () => {
  it('restores a saved track on mount', () => {
    localStorage.setItem(TRACK_KEY, encodeTrack(trackOf(30)))
    render(<Harness />)
    expect(useStore.getState().track).toHaveLength(30)
    expect(useStore.getState().track[29].t).toBe(T0 + 29_000)
  })

  it('saves on a timer, not on every fix', () => {
    vi.useFakeTimers()
    render(<Harness />)
    act(() => {
      for (const p of trackOf(5)) useStore.getState().pushTrack(p)
    })
    expect(localStorage.getItem(TRACK_KEY)).toBeNull()
    act(() => vi.advanceTimersByTime(TRACK_SAVE_MS))
    expect(decodeTrack(localStorage.getItem(TRACK_KEY)!)).toHaveLength(5)
  })

  it('saves at once when the page is hidden, before a phone drops it', () => {
    render(<Harness />)
    act(() => {
      for (const p of trackOf(3)) useStore.getState().pushTrack(p)
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    try {
      act(() => void document.dispatchEvent(new Event('visibilitychange')))
      expect(decodeTrack(localStorage.getItem(TRACK_KEY)!)).toHaveLength(3)
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    }
  })

  it('forgets the saved copy the moment the track is cleared', () => {
    localStorage.setItem(TRACK_KEY, encodeTrack(trackOf(10)))
    render(<Harness />)
    act(() => useStore.getState().clearTrack())
    expect(localStorage.getItem(TRACK_KEY)).toBeNull()
  })
})
