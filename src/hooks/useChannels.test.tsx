/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useStore } from '@/state/store'
import { useChannelSnapshot } from './useChannels'

describe('useChannelSnapshot', () => {
  it('reads the boat from the store into channels, and nulls without a fix', () => {
    useStore.getState().setBoatState(null)
    const empty = renderHook(() => useChannelSnapshot())
    expect(empty.result.current['sog']).toBeNull()
    expect(empty.result.current['magnetic-variation']).toBeCloseTo(-14.5, 0)
    empty.unmount()

    useStore.getState().setBoatState({
      t: Date.now(),
      position: { lat: 43.65, lon: -70.2 },
      cog: 40,
      sog: 5.5,
      accuracyM: 4,
      heading: null,
      bsp: null,
      heelDeg: null,
    })
    const live = renderHook(() => useChannelSnapshot())
    expect(live.result.current['sog']).toBe(5.5)
    expect(live.result.current['latitude']).toBe(43.65)
    expect(live.result.current['gps-estimated-position-error']).toBe(4)
    live.unmount()
    useStore.getState().setBoatState(null)
  })
})
