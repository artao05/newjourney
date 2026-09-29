/**
 * The sensor hooks.
 *
 * `useGeolocation` is the only place a real GPS fix enters the app, and it had no
 * test. Everything downstream — the start-line burn, the dead-reckoned position at
 * the gun, TWA, VMC, the bow offset — is arithmetic on the two numbers this hook
 * writes, so anything it invents here is invented everywhere at once and looks like
 * a measurement by the time it reaches a tile.
 *
 * The rule these tests exist to hold is the one `gpx.ts` already states: **NaN,
 * never 0, where the sensor cannot supply.** Zero is a real reading. A COG of zero
 * is due north.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useGeolocation, usePhoneOrientation, useSimulation, useTick } from './useSensors'
import { useStore } from '@/state/store'

// ------------------------------------------------------------- fake platform

type SuccessFn = (p: GeolocationPosition) => void
type ErrorFn = (e: GeolocationPositionError) => void

let success: SuccessFn | null = null
let failure: ErrorFn | null = null
let cleared: number[] = []
let watchId = 0

function installGeolocation() {
  success = null
  failure = null
  cleared = []
  watchId = 0
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      watchPosition: (ok: SuccessFn, err: ErrorFn) => {
        success = ok
        failure = err
        return ++watchId
      },
      clearWatch: (id: number) => cleared.push(id),
    },
  })
}

/** A fix with whatever the platform did or did not supply. */
function fix(over: Partial<GeolocationCoordinates> = {}): GeolocationPosition {
  return {
    timestamp: 1_700_000_000_000,
    coords: {
      latitude: 43.6675,
      longitude: -70.1735,
      accuracy: 4,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      ...over,
    },
  } as unknown as GeolocationPosition
}

beforeEach(() => {
  installGeolocation()
  useStore.setState({ state: null, gpsError: null })
})

afterEach(() => {
  vi.useRealTimers()
})

const boat = () => useStore.getState().state

// -------------------------------------------------------------------- tests

describe('a GPS fix that carries no course', () => {
  it('records NaN rather than a course of due north', () => {
    /*
     * The bug. `heading` is null whenever the device is not moving, which the
     * hook's own comment said and the code then contradicted: `: 0`.
     *
     * Zero is not a missing value here, it is a bearing. A boat drifting on the
     * line with no course would have had its bow drawn pointing north, its
     * position at the gun dead-reckoned northward, and its TWA and VMC computed
     * from that — every one of them a real-looking number derived from nothing.
     */
    renderHook(() => useGeolocation(true))
    success!(fix())
    expect(Number.isNaN(boat()!.cog)).toBe(true)
    expect(boat()!.cog).not.toBe(0)
  })

  it('records NaN speed rather than a confident zero', () => {
    renderHook(() => useGeolocation(true))
    success!(fix())
    expect(Number.isNaN(boat()!.sog)).toBe(true)
  })

  it('keeps a genuine zero, which is a reading and not an absence', () => {
    // A device that says "0 kt on 000°" has measured something, and must not be
    // flattened into the same state as one that says nothing.
    renderHook(() => useGeolocation(true))
    success!(fix({ speed: 0, heading: 0 }))
    expect(boat()!.sog).toBe(0)
    expect(boat()!.cog).toBe(0)
  })

  it('rejects a non-finite reading from the platform too', () => {
    renderHook(() => useGeolocation(true))
    success!(fix({ speed: Number.NaN, heading: Number.POSITIVE_INFINITY }))
    expect(Number.isFinite(boat()!.sog)).toBe(false)
    expect(Number.isFinite(boat()!.cog)).toBe(false)
  })
})

describe('a normal fix', () => {
  it('converts speed from metres per second to knots', () => {
    renderHook(() => useGeolocation(true))
    success!(fix({ speed: 5, heading: 217 }))
    expect(boat()!.sog).toBeCloseTo(9.7192, 3)
    expect(boat()!.cog).toBe(217)
  })

  it('carries position, timestamp and accuracy through unchanged', () => {
    renderHook(() => useGeolocation(true))
    success!(fix({ speed: 3, heading: 90 }))
    const s = boat()!
    expect(s.position).toEqual({ lat: 43.6675, lon: -70.1735 })
    expect(s.t).toBe(1_700_000_000_000)
    expect(s.accuracyM).toBe(4)
  })

  it('leaves compass heading null — the phone magnetometer is not trusted here', () => {
    // technical-spec.md §2: a phone in a pocket gives a useless magnetometer
    // reading, and COG from GPS is better once moving. The hook must not quietly
    // promote COG into the heading slot, because consumers prefer `heading` when
    // it is set and would then be preferring GPS course over an instrument.
    renderHook(() => useGeolocation(true))
    success!(fix({ speed: 3, heading: 90 }))
    expect(boat()!.heading).toBeNull()
  })

  it('clears a previous error once a fix arrives', () => {
    useStore.setState({ gpsError: 'Location unavailable' })
    renderHook(() => useGeolocation(true))
    success!(fix({ speed: 1, heading: 10 }))
    expect(useStore.getState().gpsError).toBeNull()
  })
})

describe('the watch itself', () => {
  it('reports a platform error without touching the boat state', () => {
    renderHook(() => useGeolocation(true))
    success!(fix({ speed: 2, heading: 30 }))
    const before = boat()
    failure!({ message: 'User denied Geolocation' } as GeolocationPositionError)
    expect(useStore.getState().gpsError).toBe('User denied Geolocation')
    // A denied permission does not make the last known fix untrue.
    expect(boat()).toBe(before)
  })

  it('falls back to a message when the platform error has none', () => {
    renderHook(() => useGeolocation(true))
    failure!({ message: '' } as GeolocationPositionError)
    expect(useStore.getState().gpsError).toBe('Location unavailable')
  })

  it('does not start a watch when disabled', () => {
    renderHook(() => useGeolocation(false))
    expect(success).toBeNull()
  })

  it('clears the watch on unmount, so a backgrounded screen stops the radio', () => {
    const view = renderHook(() => useGeolocation(true))
    expect(watchId).toBe(1)
    view.unmount()
    expect(cleared).toEqual([1])
  })

  it('says so when the device has no geolocation API at all', () => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined })
    renderHook(() => useGeolocation(true))
    expect(useStore.getState().gpsError).toMatch(/no geolocation API/)
  })
})

describe('useSimulation wind update', () => {
  it('forwards manual wind changes to the running sim', () => {
    vi.useFakeTimers()
    const origin = { lat: 43.6675, lon: -70.1735 }
    useStore.setState({ manualWind: { twd: 270, tws: 12 } })

    const view = renderHook(() => useSimulation(true, origin))
    const sim = view.result.current

    expect(sim.current).not.toBeNull()
    const before = sim.current!.wind()
    expect(before.tws).toBeCloseTo(12, 0)

    act(() => {
      useStore.setState({ manualWind: { twd: 180, tws: 8 } })
    })
    view.rerender()

    const after = sim.current!.wind()
    expect(after.tws).toBeCloseTo(8, 0)
  })
})

describe('the simulator keeps real time', () => {
  it('catches up when its timer was held back, as a hidden tab holds it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    useStore.setState({ state: null, settings: { ...useStore.getState().settings, simulate: true } })
    const view = renderHook(() => useSimulation(true, { lat: 43.6675, lon: -70.1735 }))
    act(() => vi.advanceTimersByTime(500))
    expect(Date.now() - boat()!.t).toBeLessThan(10)
    // Forty seconds pass with no tick at all, then one tick.
    vi.setSystemTime(Date.now() + 40_000)
    act(() => vi.advanceTimersByTime(500))
    expect(Date.now() - boat()!.t).toBeLessThan(10)
    // An hour away: the boat waited, and the clock still reads now.
    vi.setSystemTime(Date.now() + 3_600_000)
    act(() => vi.advanceTimersByTime(500))
    expect(Date.now() - boat()!.t).toBeLessThan(10)
    view.unmount()
  })
})

describe('useTick', () => {
  it('advances on its own interval', () => {
    vi.useFakeTimers()
    const view = renderHook(() => useTick(2))
    const first = view.result.current
    vi.advanceTimersByTime(600)
    view.rerender()
    expect(view.result.current).toBeGreaterThan(first)
  })

  it('stops ticking once unmounted', () => {
    vi.useFakeTimers()
    const view = renderHook(() => useTick(2))
    view.unmount()
    // No timer left behind to wake a backgrounded screen.
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the phone’s own tilt and compass', () => {
  afterEach(() => {
    useStore.setState({ phoneSensors: { on: false, trustCompass: false }, phoneOrientation: null })
  })

  it('reads orientation events into the store, a few times a second, and stops', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const hook = renderHook(() => usePhoneOrientation(true))
    const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
    const fire = (props: Record<string, unknown>) => {
      const e = new Event(type)
      Object.assign(e, props)
      act(() => {
        window.dispatchEvent(e)
      })
    }
    fire({ alpha: 90, beta: 2, gamma: -12, webkitCompassHeading: 270, webkitCompassAccuracy: 5 })
    expect(useStore.getState().phoneOrientation).toMatchObject({ headingMag: 270, heel: -12, pitch: 2, quality: 'good' })
    // Within a quarter second: throttled.
    fire({ alpha: 0, beta: 0, gamma: 30, webkitCompassHeading: 10, webkitCompassAccuracy: 5 })
    expect(useStore.getState().phoneOrientation!.heel).toBe(-12)
    vi.setSystemTime(10_300)
    fire({ alpha: 0, beta: 0, gamma: 30, webkitCompassHeading: 10, webkitCompassAccuracy: 5 })
    expect(useStore.getState().phoneOrientation!.heel).toBe(30)
    hook.unmount()
    expect(useStore.getState().phoneOrientation).toBeNull()
  })

  it('joins the heel to a GPS fix, and the compass only when trusted and good', () => {
    const t = Date.now()
    useStore.setState({
      phoneSensors: { on: true, trustCompass: false },
      phoneOrientation: { headingMag: 100, heel: 8, pitch: 1, accuracyDeg: 5, quality: 'good', t },
    })
    renderHook(() => useGeolocation(true))
    act(() => success!(fix()))
    expect(boat()).toMatchObject({ heelDeg: 8, heading: null })
    useStore.setState({ phoneSensors: { on: true, trustCompass: true } })
    act(() => success!(fix()))
    // Magnetic 100 plus the venue's variation, about 14.5° W.
    expect(boat()!.heading).toBeCloseTo(100 - 14.5, 0)
    useStore.setState({ phoneOrientation: { headingMag: 100, heel: 8, pitch: 1, accuracyDeg: 25, quality: 'poor', t } })
    act(() => success!(fix()))
    expect(boat()!.heading).toBeNull()
  })

  it('leaves heel and heading unknown with phone sensors off', () => {
    useStore.setState({
      phoneSensors: { on: false, trustCompass: true },
      phoneOrientation: { headingMag: 100, heel: 8, pitch: 1, accuracyDeg: 5, quality: 'good', t: Date.now() },
    })
    renderHook(() => useGeolocation(true))
    act(() => success!(fix()))
    expect(boat()).toMatchObject({ heelDeg: null, heading: null })
  })
})
