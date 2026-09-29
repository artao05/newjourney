/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useStore } from '@/state/store'
import { useInstruments } from './useInstruments'

class FakeWebSocket {
  static last: FakeWebSocket | null = null
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeWebSocket.last = this
  }
  close() {
    this.closed = true
  }
}

const delta = (values: Array<{ path: string; value: unknown }>) => JSON.stringify({ updates: [{ values }] })

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  useStore.setState({ state: null, wind: null, windMode: 'instrument', instrumentReading: null })
  useStore.getState().setInstrumentStatus({ status: 'off', detail: null, lastAt: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  useStore.setState({ windMode: 'manual', instrumentReading: null })
})

describe('useInstruments', () => {
  it('puts the feed into the boat state and the wind once a second, and stops cleanly', () => {
    const hook = renderHook(() => useInstruments({ kind: 'signalk', url: 'ws://pi.local:3000/signalk/v1/stream' }))
    const ws = FakeWebSocket.last!
    expect(ws.url).toBe('ws://pi.local:3000/signalk/v1/stream')
    act(() => ws.onopen?.({}))
    expect(useStore.getState().instrumentStatus.status).toBe('connected')

    act(() => {
      ws.onmessage?.({ data: delta([
        { path: 'navigation.position', value: { latitude: 43.66, longitude: -70.25 } },
        { path: 'navigation.headingTrue', value: Math.PI },
        { path: 'environment.wind.directionTrue', value: (250 * Math.PI) / 180 },
        { path: 'environment.wind.speedTrue', value: 6.1733 },
        { path: 'environment.depth.belowTransducer', value: 8.2 },
      ]) })
    })
    // Nothing reaches the store until the next second.
    expect(useStore.getState().state).toBeNull()
    act(() => vi.advanceTimersByTime(1000))
    const s = useStore.getState()
    expect(s.state?.position).toEqual({ lat: 43.66, lon: -70.25 })
    expect(s.state?.heading).toBeCloseTo(180, 6)
    expect(s.wind).toMatchObject({ source: 'instrument' })
    expect(s.wind!.twd).toBeCloseTo(250, 6)
    expect(s.wind!.tws).toBeCloseTo(12, 2)
    expect(s.instrumentReading?.depthM).toBe(8.2)

    hook.unmount()
    expect(ws.closed).toBe(true)
    expect(useStore.getState().instrumentReading).toBeNull()
    expect(useStore.getState().instrumentStatus.status).toBe('off')
  })

  it('leaves the wind alone when the wind mode is not instruments', () => {
    useStore.setState({ windMode: 'manual' })
    const hook = renderHook(() => useInstruments({ kind: 'signalk', url: 'ws://x' }))
    act(() => {
      FakeWebSocket.last!.onmessage?.({ data: delta([
        { path: 'navigation.position', value: { latitude: 43.66, longitude: -70.25 } },
        { path: 'environment.wind.directionTrue', value: 1 },
        { path: 'environment.wind.speedTrue', value: 5 },
      ]) })
      vi.advanceTimersByTime(1000)
    })
    expect(useStore.getState().state).not.toBeNull()
    expect(useStore.getState().wind).toBeNull()
    hook.unmount()
  })

  it('opens nothing when it is off', () => {
    FakeWebSocket.last = null
    const hook = renderHook(() => useInstruments(null))
    expect(FakeWebSocket.last).toBeNull()
    hook.unmount()
  })
})
