/**
 * The app shell.
 *
 * `App.tsx` is 319 lines of wiring that nothing tested: it decides which polar
 * loads, assembles the wind estimate and its uncertainty, derives set and drift
 * from the instruments, and records the track. All of it lives in effects, so the
 * only way to check any of it is to mount the thing and watch the store.
 *
 * These are behaviour tests against the real store, not render snapshots. What
 * matters here is what ends up in state, because every screen reads from it.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

const { FakeMap, FakeLngLatBounds } = vi.hoisted(() => {
  class FakeLngLatBounds {
    extend() {
      return this
    }
  }
  class FakeMap {
    on() {
      return this
    }
    off() {
      return this
    }
    addSource() {}
    addLayer() {}
    removeLayer() {}
    removeSource() {}
    getSource() {
      return { setData: () => {} }
    }
    getLayer() {
      return undefined
    }
    setLayoutProperty() {}
    setPaintProperty() {}
    hasImage() {
      return false
    }
    addImage() {}
    triggerRepaint() {}
    jumpTo() {}
    fitBounds() {}
    getBounds() {
      return { getWest: () => -71, getSouth: () => 43, getEast: () => -70, getNorth: () => 44 }
    }
    getCanvas() {
      return { style: {} }
    }
    remove() {}
  }
  return { FakeMap, FakeLngLatBounds }
})

vi.mock('maplibre-gl', () => ({
  default: { Map: FakeMap, LngLatBounds: FakeLngLatBounds },
  Map: FakeMap,
  LngLatBounds: FakeLngLatBounds,
}))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))

import { App } from './App'
import { useStore } from '@/state/store'
import { TRACK_KEY, encodeTrack } from '@/state/trackPersistence'
import { findPolar } from '@/data/polars'
import type { BoatState } from '@/lib/types'

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const NOW = Date.now()
const AT = { lat: 43.6675, lon: -70.1735 }

/** A fix with a log and a compass, which is what set-and-drift needs. */
function instrumented(over: Partial<BoatState> = {}): BoatState {
  return {
    t: Date.now(),
    position: AT,
    cog: 50,
    sog: 6,
    accuracyM: 4,
    heading: 40,
    bsp: 5.4,
    heelDeg: 8,
    ...over,
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver
  globalThis.fetch = (() =>
    Promise.reject(new Error('network disabled in shell tests'))) as unknown as typeof fetch
  localStorage.clear()
  const s = useStore.getState()
  s.clearCourse()
  s.clearTrack()
  s.setBoatState(null)
  s.setWind(null)
  s.setCurrent(null)
  s.setPolar('j70', null)
  // Accepted, so the notice does not sit over what these tests look at; the
  // notice's own tests below set it back.
  s.updateSettings({ simulate: false, keepAwake: false, acceptedNotForNavigation: true })
  s.setWindMode('manual')
  // Nobody has set a wind yet, as on a fresh install. Reset here rather than left
  // to test order: a set timestamp leaking from one test hides the unset case.
  useStore.setState({
    manualWind: { twd: 270, tws: 12 },
    manualWindSetAt: null,
    windSheetOpen: false,
    windHistory: [],
  })
  if (s.recording) s.toggleRecording()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('polar loading', () => {
  it('loads the stored class on first paint', async () => {
    useStore.getState().setPolar('j105', null)
    render(<App />)
    await waitFor(() => expect(useStore.getState().polar).not.toBeNull())
    expect(useStore.getState().polarId).toBe('j105')
    expect(useStore.getState().polar?.name).toBe(findPolar('j105')!.polar.name)
  })

  it('falls back to the default class when the stored id is unknown', async () => {
    // A persisted id from an older build, or a library entry that was renamed.
    // Silently having no polar means no targets, no laylines and no route.
    useStore.getState().setPolar('a-class-that-no-longer-exists', null)
    render(<App />)
    await waitFor(() => expect(useStore.getState().polar).not.toBeNull())
    expect(useStore.getState().polarId).toBe('j70')
  })
})

describe('wind assembly', () => {
  it('publishes the manual wind with its own uncertainty, and logs the history', async () => {
    useStore.getState().setWindMode('manual')
    useStore.getState().setManualWind(235, 14)
    render(<App />)
    await waitFor(() => expect(useStore.getState().wind).not.toBeNull())

    const w = useStore.getState().wind!
    expect(w.twd).toBe(235)
    expect(w.tws).toBe(14)
    expect(w.source).toBe('manual')
    // A typed number is not a measurement; the layline band leans on this being
    // wider than an instrument's.
    expect(w.uncertaintyDeg).toBe(8)
    expect(useStore.getState().windHistory.length).toBeGreaterThan(0)
  })

  it('follows a change to the manual wind', async () => {
    useStore.getState().setManualWind(235, 14)
    render(<App />)
    await waitFor(() => expect(useStore.getState().wind).not.toBeNull())
    act(() => useStore.getState().setManualWind(10, 20))
    await waitFor(() => expect(useStore.getState().wind?.twd).toBe(10))
    expect(useStore.getState().wind?.tws).toBe(20)
  })

  it('publishes no wind at all from a manual wind nobody has set', async () => {
    // The placeholder in `manualWind` is not a reading. Published, it decided the
    // favoured end on a fresh install, with a chip showing it like any other wind.
    useStore.getState().setWind({ twd: 1, tws: 1, source: 'manual', uncertaintyDeg: 8, t: 0 })
    render(<App />)
    await waitFor(() => expect(useStore.getState().wind).toBeNull())
    expect(useStore.getState().windHistory).toEqual([])
    const chip = screen.getByRole('button', { name: /^Wind:/ })
    expect(chip.textContent).toBe('set wind')
    expect(chip.className).toContain('chip--warn')
  })
})

describe('the wind chip says what the wind rests on', () => {
  const chip = () => screen.getByRole('button', { name: /^Wind:/ })

  it('names a hand-set wind as manual', async () => {
    useStore.getState().setManualWind(235, 14)
    render(<App />)
    await waitFor(() => expect(chip().textContent).toBe('235° · 14 kn · manual'))
    expect(chip().className).not.toContain('chip--warn')
  })

  it('names a forecast as a forecast', async () => {
    useStore.getState().setWindMode('forecast')
    useStore.getState().setWind({ twd: 200, tws: 9, source: 'forecast', uncertaintyDeg: 18, t: Date.now() })
    render(<App />)
    expect(chip().textContent).toBe('200° · 9 kn · forecast')
  })

  it('shows the age of a hand-set wind once it is old enough to have shifted', async () => {
    useStore.getState().setManualWind(235, 14)
    useStore.setState({ manualWindSetAt: Date.now() - 45 * 60_000 })
    render(<App />)
    await waitFor(() => expect(chip().textContent).toBe('235° · 14 kn · manual · 45 min old'))
    expect(chip().className).toContain('chip--warn')
  })

  it('switches a forecast to manual when a wind is set by hand', () => {
    useStore.getState().setWindMode('forecast')
    render(<App />)
    act(() => chip().click())
    act(() => screen.getByRole('button', { name: /^SET WIND/ }).click())
    expect(useStore.getState().windMode).toBe('manual')
  })

  it('opens the wind sheet, where a wind set takes effect at once', async () => {
    render(<App />)
    act(() => chip().click())
    const sheet = screen.getByRole('dialog', { name: 'Set the wind' })
    expect(sheet).toBeTruthy()
    // Stepping from the placeholder: the sailor still has to confirm it.
    act(() => screen.getAllByRole('button', { name: '+5' })[0].click())
    act(() => screen.getAllByRole('button', { name: '+5' })[0].click())
    act(() => screen.getByRole('button', { name: /^SET WIND/ }).click())
    expect(screen.queryByRole('dialog', { name: 'Set the wind' })).toBeNull()
    expect(useStore.getState().manualWind).toEqual({ twd: 280, tws: 12 })
    expect(useStore.getState().manualWindSetAt).not.toBeNull()
    await waitFor(() => expect(useStore.getState().wind?.twd).toBe(280))
  })
})

describe('set and drift', () => {
  it('derives a current from a fix that has a log and a compass', async () => {
    render(<App />)
    // 10 degrees of leeway-ish difference between heading and COG with a speed
    // difference is enough for the triangle to resolve.
    act(() => useStore.getState().setBoatState(instrumented()))
    await waitFor(() => expect(useStore.getState().current).not.toBeNull())
    expect(useStore.getState().current?.source).toBe('measured')
  })

  /*
   * The bug this file was written to find.
   *
   * The estimate is produced by one effect that returns early when the fix has no
   * log or no compass - and the early return did not clear the previous value. So
   * a set and drift measured while the instruments were reporting stayed on screen
   * indefinitely after they stopped, labelled "measured".
   *
   * That is not cosmetic. `tactics.ts` corrects the laylines with the current, and
   * `startline.ts` uses it for time-to-line, so a stale estimate quietly bends
   * every tactical number toward a tide that is no longer there. The path is
   * ordinary: run the simulator, which supplies a boat speed, then switch to
   * phone GPS, which does not.
   */
  it('clears the estimate when the instruments stop reporting', async () => {
    render(<App />)
    act(() => useStore.getState().setBoatState(instrumented()))
    await waitFor(() => expect(useStore.getState().current).not.toBeNull())

    // Phone GPS: a position and a course, but no log.
    act(() => useStore.getState().setBoatState(instrumented({ bsp: null })))
    await waitFor(() => expect(useStore.getState().current).toBeNull())
  })

  it('clears the estimate when the compass stops reporting', async () => {
    render(<App />)
    act(() => useStore.getState().setBoatState(instrumented()))
    await waitFor(() => expect(useStore.getState().current).not.toBeNull())
    act(() => useStore.getState().setBoatState(instrumented({ heading: null })))
    await waitFor(() => expect(useStore.getState().current).toBeNull())
  })

  it('clears the estimate when the fix goes away entirely', async () => {
    render(<App />)
    act(() => useStore.getState().setBoatState(instrumented()))
    await waitFor(() => expect(useStore.getState().current).not.toBeNull())
    act(() => useStore.getState().setBoatState(null))
    await waitFor(() => expect(useStore.getState().current).toBeNull())
  })
})

describe('track recording', () => {
  it('records nothing until asked', async () => {
    render(<App />)
    act(() => useStore.getState().setBoatState(instrumented()))
    await new Promise((r) => setTimeout(r, 20))
    expect(useStore.getState().track).toHaveLength(0)
  })

  it('records a point per fix once recording', async () => {
    render(<App />)
    act(() => useStore.getState().toggleRecording())
    act(() => useStore.getState().setBoatState(instrumented({ t: NOW + 1000 })))
    await waitFor(() => expect(useStore.getState().track.length).toBeGreaterThan(0))

    const before = useStore.getState().track.length
    act(() => useStore.getState().setBoatState(instrumented({ t: NOW + 2000 })))
    await waitFor(() => expect(useStore.getState().track.length).toBeGreaterThan(before))

    const p = useStore.getState().track[0]
    expect(p.lat).toBeCloseTo(AT.lat, 9)
    expect(Number.isFinite(p.sog)).toBe(true)
  })

  it('stops recording when asked', async () => {
    render(<App />)
    act(() => useStore.getState().toggleRecording())
    act(() => useStore.getState().setBoatState(instrumented({ t: NOW + 1000 })))
    await waitFor(() => expect(useStore.getState().track.length).toBeGreaterThan(0))

    act(() => useStore.getState().toggleRecording())
    const frozen = useStore.getState().track.length
    act(() => useStore.getState().setBoatState(instrumented({ t: NOW + 3000 })))
    await new Promise((r) => setTimeout(r, 20))
    expect(useStore.getState().track.length).toBe(frozen)
  })
})

describe('not for navigation, before first use', () => {
  /*
   * The notice used to live only at the foot of Setup, so a sailor who never opened
   * Setup was never told, and the Start tab's numbers read as an instrument's do.
   */
  const dialog = () => screen.queryByRole('dialog', { name: /not for navigation/i })

  it('asks on first launch, over an app it keeps out of reach until answered', () => {
    useStore.getState().updateSettings({ acceptedNotForNavigation: false })
    const { container } = render(<App />)
    expect(dialog()).not.toBeNull()
    expect(container.querySelector('.app')?.hasAttribute('inert')).toBe(true)
  })

  it('remembers the answer in what survives a reload', () => {
    useStore.getState().updateSettings({ acceptedNotForNavigation: false })
    const { container } = render(<App />)
    act(() => screen.getByRole('button', { name: /i understand/i }).click())
    expect(dialog()).toBeNull()
    expect(container.querySelector('.app')?.hasAttribute('inert')).toBe(false)
    const saved = JSON.parse(localStorage.getItem('newjourney.v1') ?? '{}').state
    expect(saved.settings.acceptedNotForNavigation).toBe(true)
  })

  it('does not ask again once accepted', () => {
    render(<App />)
    expect(dialog()).toBeNull()
  })

  it('leaves the Setup copy in place, in the same words', () => {
    useStore.getState().setTab('setup')
    render(<App />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Not for navigation.')
    expect(text).toContain('Nothing here replaces official charts, official tide tables')
  })
})

describe('the recorded track survives a reload', () => {
  it('comes back when the app starts again', () => {
    const t0 = Date.UTC(2026, 8, 27, 14, 0)
    const saved = [0, 1].map((i) => ({ t: t0 + i * 1000, lat: 43.64, lon: -70.21, sog: 5, cog: 40 }))
    localStorage.setItem(TRACK_KEY, encodeTrack(saved))
    render(<App />)
    expect(useStore.getState().track.map((p) => p.t)).toEqual([t0, t0 + 1000])
  })
})
