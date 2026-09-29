/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useStore } from '@/state/store'
import { MemoryLogStore, type LogRow } from '@/lib/logging/logger'
import { setLogStore } from '@/lib/logging/idbStore'
import { currentFromRow, readingFromRow, rowAt, stateFromRow, windFromRow } from '@/lib/logging/playback'
import { PLAYBACK_TICK_MS, resetPlayback, startPlayback, usePlayback } from './usePlayback'
import { PlaybackBar } from '@/components/PlaybackBar'

const T0 = Date.UTC(2026, 8, 29, 10)
const rows: LogRow[] = Array.from({ length: 120 }, (_, i) => ({
  t: T0 + i * 1000,
  v: { latitude: 43.66 + i * 1e-5, longtitude: -70.25, sog: 5 + i / 100, cog: 200, twd: 250, tws: 12, awa: -30, depth: 8 },
}))

describe('finding and reading a row', () => {
  it('takes the last row at or before the time', () => {
    expect(rowAt(rows, T0 + 2500)!.t).toBe(T0 + 2000)
    expect(rowAt(rows, T0 - 5000)!.t).toBe(T0)
    expect(rowAt(rows, T0 + 10_000_000)!.t).toBe(T0 + 119_000)
    expect(rowAt([], T0)).toBeNull()
  })

  it('turns a row back into the boat, the wind, the instruments and the current', () => {
    const r = { t: T0, v: { latitude: 43.66, longtitude: -70.25, sog: 5, heading: 190, twd: 250, tws: 12, awa: -30, depth: 8, 'current-set': 45, 'current-drift': 0.6 } }
    expect(stateFromRow(r)).toMatchObject({ t: T0, position: { lat: 43.66, lon: -70.25 }, sog: 5, heading: 190, bsp: null })
    expect(Number.isNaN(stateFromRow(r)!.cog)).toBe(true)
    expect(windFromRow(r)).toMatchObject({ twd: 250, tws: 12, source: 'instrument' })
    expect(readingFromRow(r)).toEqual({ awa: -30, depthM: 8 })
    expect(currentFromRow(r)).toEqual({ set: 45, drift: 0.6, source: 'measured' })
    expect(stateFromRow({ t: T0, v: { sog: 5 } })).toBeNull()
  })
})

describe('replaying a day', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    resetPlayback()
    const store = new MemoryLogStore()
    await store.append('2026-09-29', rows)
    setLogStore(store)
    useStore.setState({ playback: null, state: null, wind: null, instrumentReading: null, current: null })
  })

  afterEach(() => {
    setLogStore(null)
    useStore.setState({ playback: null })
    vi.useRealTimers()
  })

  it('plays, pauses, seeks and stops at the end', async () => {
    expect(await startPlayback('2026-09-29')).toBe(true)
    renderHook(() => usePlayback())
    expect(useStore.getState().playback).toMatchObject({ start: T0, end: T0 + 119_000, t: T0, playing: true, speed: 1 })

    act(() => vi.advanceTimersByTime(2000))
    expect(useStore.getState().playback!.t).toBe(T0 + 2000)
    expect(useStore.getState().state!.sog).toBeCloseTo(5.02, 9)
    // Fresh as the replay, so no screen calls it stale.
    expect(Date.now() - useStore.getState().state!.t).toBeLessThan(PLAYBACK_TICK_MS + 1)
    expect(useStore.getState().wind).toMatchObject({ twd: 250, tws: 12 })
    expect(useStore.getState().instrumentReading).toEqual({ awa: -30, depthM: 8 })

    act(() => useStore.getState().setPlayback({ playing: false }))
    act(() => vi.advanceTimersByTime(5000))
    expect(useStore.getState().playback!.t).toBe(T0 + 2000)

    // Seeking while paused still moves the boat.
    act(() => useStore.getState().setPlayback({ t: T0 + 60_000 }))
    act(() => vi.advanceTimersByTime(PLAYBACK_TICK_MS))
    expect(useStore.getState().state!.sog).toBeCloseTo(5.6, 9)

    act(() => useStore.getState().setPlayback({ playing: true, speed: 60 }))
    act(() => vi.advanceTimersByTime(2000))
    expect(useStore.getState().playback).toMatchObject({ t: T0 + 119_000, playing: false })
  })

  it('will not start on a day with nothing in it', async () => {
    expect(await startPlayback('2020-01-01')).toBe(false)
    expect(useStore.getState().playback).toBeNull()
  })

  it('has controls to pause, jump, change speed and stop', async () => {
    await startPlayback('2026-09-29')
    render(<PlaybackBar />)
    fireEvent.click(screen.getByRole('button', { name: 'PAUSE' }))
    expect(useStore.getState().playback!.playing).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'A minute on' }))
    expect(useStore.getState().playback!.t).toBe(T0 + 60_000)
    fireEvent.click(screen.getByRole('button', { name: 'A minute on' }))
    // Held at the end of the log, not run off it.
    expect(useStore.getState().playback!.t).toBe(T0 + 119_000)
    fireEvent.change(screen.getByLabelText('Replay speed'), { target: { value: '10' } })
    expect(useStore.getState().playback!.speed).toBe(10)
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '30000' } })
    expect(useStore.getState().playback!.t).toBe(T0 + 30_000)
    fireEvent.click(screen.getByRole('button', { name: 'STOP' }))
    expect(useStore.getState().playback).toBeNull()
  })
})
