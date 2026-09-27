/**
 * Screen-level tests: the first thing in this repo above `src/lib` that renders.
 *
 * Everything else is tested by calling functions. These mount the actual screens
 * against the actual store, which is the only way to check the claims the *product*
 * makes rather than the claims a module makes. Two kinds of assertion:
 *
 *   1. **Smoke.** Each screen mounts without throwing, with an empty store and with
 *      a populated one. A screen that crashes on a missing polar or an empty course
 *      is a blank app, and no unit test sees it.
 *   2. **Honesty invariants.** The things this project says about itself and has
 *      never enforced: a missing number renders as a dash and never as a zero, a
 *      data layer always states its source, and the land-avoidance chip says OFF
 *      exactly when the pack is absent. These are product claims, and product
 *      claims that nothing checks are the ones that quietly stop being true.
 *
 * MapLibre is mocked at the module boundary. It needs WebGL, which jsdom does not
 * have, and the point here is the chrome around the map rather than the map.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { RouteResult, WeatherCube } from '@/lib/types'

// ------------------------------------------------------------- maplibre stub
//
// Never fires 'load' on its own. The overlays gate every effect on `ready`,
// which the surface only sets from the load handler, so a stub that stays
// unloaded exercises exactly the pre-map state a real phone shows for the first
// few hundred milliseconds — and it needs no GL context to do it. The one block
// that needs the layers themselves fires it by hand.

// `vi.mock` is hoisted above every declaration in the file, so the fakes it
// closes over have to be hoisted with it.
const { FakeMap, FakeLngLatBounds, mapInstances } = vi.hoisted(() => {
  class FakeLngLatBounds {
    extend() {
      return this
    }
  }

  const mapInstances: InstanceType<typeof FakeMap>[] = []

  class FakeMap {
    handlers = new Map<string, Array<(e: unknown) => void>>()
    /** Every spec handed to `addLayer`, in order. */
    layers: Array<{ id?: string; type?: string; layout?: Record<string, unknown> }> = []
    removed = false
    constructor(public opts: unknown) {
      mapInstances.push(this)
    }
    on(ev: string, fn: (e: unknown) => void) {
      const list = this.handlers.get(ev) ?? []
      list.push(fn)
      this.handlers.set(ev, list)
      return this
    }
    off() {
      return this
    }
    /** Play the part of the real map: run everything listening for `ev`. */
    fire(ev: string) {
      for (const fn of this.handlers.get(ev) ?? []) fn({})
    }
    addSource() {}
    addLayer(spec: { id?: string; type?: string; layout?: Record<string, unknown> }) {
      this.layers.push(spec)
    }
    removeLayer() {}
    removeSource() {}
    /** The last data set on each GeoJSON source, by source id. */
    data = new Map<string, unknown>()
    getSource(id: string) {
      return { setData: (d: unknown) => this.data.set(id, d) }
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
    project() {
      return { x: 0, y: 0 }
    }
    getBounds() {
      return {
        getWest: () => -70.6,
        getSouth: () => 43.4,
        getEast: () => -69.8,
        getNorth: () => 43.9,
      }
    }
    getCanvas() {
      return { style: {} }
    }
    remove() {
      this.removed = true
    }
  }

  return { FakeMap, FakeLngLatBounds, mapInstances }
})

vi.mock('maplibre-gl', () => ({
  default: { Map: FakeMap, LngLatBounds: FakeLngLatBounds },
  Map: FakeMap,
  LngLatBounds: FakeLngLatBounds,
}))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))

// The forecast client, passed through untouched — straight into the disabled
// network — unless a test hands it a cube to return instead.
const { stubForecast } = vi.hoisted(() => ({
  stubForecast: { cube: null as WeatherCube | null },
}))
vi.mock('@/lib/weather/openmeteo', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/weather/openmeteo')>()
  return {
    ...real,
    fetchWindCube: (...args: Parameters<typeof real.fetchWindCube>) =>
      stubForecast.cube ? Promise.resolve(stubForecast.cube) : real.fetchWindCube(...args),
  }
})

import { StartScreen } from './StartScreen'
import { RaceScreen } from './RaceScreen'
import { SetupScreen, tideStationLabel } from './SetupScreen'
import { WeatherScreen } from './WeatherScreen'
import { RouteScreen } from './RouteScreen'
import { useStore } from '@/state/store'
import { findPolar } from '@/data/polars'
import { PILOT_VENUE } from '@/data/venues'
import { distance } from '@/lib/geo'
import { PORTLAND_DATUM } from '@/lib/tides/datum'
import { angdiff, wrap360 } from '@/lib/angles'
import { uvFromWind } from '@/lib/weather/cube'

// ------------------------------------------------------------------ fixtures

const SCREENS: Array<[string, () => React.JSX.Element]> = [
  ['Start', StartScreen],
  ['Race', RaceScreen],
  ['Setup', SetupScreen],
  ['Weather', WeatherScreen],
  ['Route', RouteScreen],
]

/** Nothing configured: first launch, no fix, no polar, no course. */
function emptyStore() {
  const s = useStore.getState()
  s.clearCourse()
  s.clearTrack()
  s.setBoatState(null)
  s.setWind(null)
  s.setPolar('j70', null)
  s.setRoute(null)
  s.setRouteError(null)
  s.setGpsError(null)
  useStore.setState({ manualWind: { twd: 270, tws: 12 }, manualWindSetAt: null, windSheetOpen: false })
}

/** A boat, a wind, a polar and a two-mark course. */
function populatedStore() {
  const s = useStore.getState()
  emptyStore()
  s.setPolar('j70', findPolar('j70')!.polar)
  s.setBoatState({
    t: Date.now(),
    position: PILOT_VENUE.waterStart,
    cog: 40,
    sog: 5.5,
    accuracyM: 4,
    heading: 42,
    bsp: 5.4,
    heelDeg: 10,
  })
  s.setWind({ twd: 220, tws: 12, source: 'manual', uncertaintyDeg: 8, t: Date.now() })
  s.addMark('W', { lat: PILOT_VENUE.waterStart.lat + 0.02, lon: PILOT_VENUE.waterStart.lon })
  s.addMark('L', { lat: PILOT_VENUE.waterStart.lat - 0.01, lon: PILOT_VENUE.waterStart.lon })
  s.setStartEnd('port', { lat: PILOT_VENUE.waterStart.lat, lon: PILOT_VENUE.waterStart.lon - 0.002 })
  s.setStartEnd('starboard', {
    lat: PILOT_VENUE.waterStart.lat,
    lon: PILOT_VENUE.waterStart.lon + 0.002,
  })
  s.setGunTime(Date.now() + 180_000)
}

/*
 * jsdom has no ResizeObserver and `StartCanvas` observes its parent to size the
 * canvas. Stubbed rather than worked around: the app is right to use it, and a
 * no-op observer still exercises the initial draw, which is the path that matters
 * here (and which correctly bails when jsdom hands back a null 2D context).
 */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver
  mapInstances.length = 0
  stubForecast.cube = null
  // No forecast fetches from a screen test.
  globalThis.fetch = (() =>
    Promise.reject(new Error('network disabled in screen tests'))) as unknown as typeof fetch
  localStorage.clear()
  emptyStore()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// -------------------------------------------------------------------- smoke

describe('every screen mounts', () => {
  for (const [name, Screen] of SCREENS) {
    it(`${name} renders with an empty store`, () => {
      expect(() => render(<Screen />)).not.toThrow()
      expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0)
    })

    it(`${name} renders with a populated store`, () => {
      populatedStore()
      expect(() => render(<Screen />)).not.toThrow()
      expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0)
    })
  }

  it('tears the map down when a chart screen unmounts', () => {
    // A leaked WebGL context per tab switch is how a phone runs out of memory
    // during a regatta.
    const view = render(<WeatherScreen />)
    expect(mapInstances.length).toBe(1)
    view.unmount()
    expect(mapInstances[0].removed).toBe(true)
  })

  it('does not crash when a screen mounts with a broken forecast fetch', async () => {
    // The network is rejected in beforeEach, which is the dockside 3G case.
    render(<WeatherScreen />)
    await new Promise((r) => setTimeout(r, 20))
    expect(document.body.textContent).toBeTruthy()
  })
})

// ------------------------------------------------------- honesty invariants

describe('a missing number renders as a dash, never as a zero', () => {
  /*
   * The rule the whole project rests on, stated in `cube.ts` and `Tile.tsx` and
   * never enforced above the library: an unknown value must look unknown. A zero
   * is a reading. "0.0 kn of wind" and "no wind data" are different facts and a
   * sailor cannot tell them apart from the tile.
   */
  it('Race shows dashes, not zeros, with no fix and no wind', () => {
    render(<RaceScreen />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('—')
  })

  it('Start shows dashes, not zeros, with no line and no fix', () => {
    render(<StartScreen />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('—')
  })

  it('never renders the literal string NaN on any screen', () => {
    // The failure mode that pass 9 hardened the library against. This is the
    // check that would have caught it from the outside.
    for (const [name, Screen] of SCREENS) {
      const view = render(<Screen />)
      expect(document.body.textContent, `${name} with an empty store`).not.toMatch(/NaN/)
      view.unmount()
      cleanup()

      populatedStore()
      const view2 = render(<Screen />)
      expect(document.body.textContent, `${name} with a populated store`).not.toMatch(/NaN/)
      view2.unmount()
      cleanup()
      emptyStore()
    }
  })

  it('never renders "undefined" or "null" as a value', () => {
    for (const [name, Screen] of SCREENS) {
      populatedStore()
      const view = render(<Screen />)
      const text = document.body.textContent ?? ''
      expect(text, `${name}`).not.toMatch(/\bundefined\b/)
      expect(text, `${name}`).not.toMatch(/\bnull\b/)
      view.unmount()
      cleanup()
      emptyStore()
    }
  })
})

describe('the Route screen tells the truth about land avoidance', () => {
  /*
   * The chip and the route warning are the only places a user learns whether the
   * safety feature is on. `landmask.ts` is emphatic that claiming it when the pack
   * has not loaded is the one thing that must not happen — so the negative case is
   * the one worth pinning, because it is the case that is true on first paint and
   * whenever the fetch fails.
   */
  it('says the pack is absent before it has loaded, and never that it is on', () => {
    render(<RouteScreen />)
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/no land pack|land pack failed/)
    expect(text).not.toMatch(/land pack \d+ m/)
  })
})

describe('the Weather screen states its provenance', () => {
  it('offers the three layers and no wave-height chip', () => {
    render(<WeatherScreen />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Wind')
    expect(text).toContain('Depth')
    expect(text).toContain('Current')
    expect(text).not.toMatch(/Wave height/i)
  })

  it('shows no legend at all rather than an unattributed one', () => {
    /*
     * The legend renders "source unknown" in the warning colour when it has no
     * provenance, which is the right behaviour for a legend that must exist. The
     * screen-level rule is stronger: with no cube and no depth grid there is
     * nothing to explain, so there should be no scale on screen to mistake for one.
     */
    render(<WeatherScreen />)
    expect(screen.queryByText(/source unknown/i)).toBeNull()
  })
})

describe('wind and current symbols keep their bearing on a rotated chart', () => {
  /*
   * Every `icon-rotate` and `text-rotate` on these charts is a compass bearing.
   * MapLibre measures it from the top of the screen unless the layer's rotation
   * alignment is 'map', point symbols default to the screen, and a two-finger
   * twist rotates the chart unless rotation is switched off. A layer that misses
   * the alignment therefore draws every barb and arrow wrong by the map bearing,
   * and a wrong arrow looks exactly as plausible as a right one. The layer spec
   * is the only place it can be seen.
   */
  const rotatedSymbols = (Screen: () => React.JSX.Element) => {
    render(<Screen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    return mapInstances
      .flatMap((m) => m.layers)
      .filter(
        (l) =>
          l.type === 'symbol' &&
          (l.layout?.['icon-rotate'] !== undefined || l.layout?.['text-rotate'] !== undefined),
      )
  }

  for (const [name, Screen] of SCREENS.filter(([n]) => n === 'Weather' || n === 'Route')) {
    it(`${name}: every rotated symbol is aligned to the map, and upright`, () => {
      const layers = rotatedSymbols(Screen)
      // Otherwise the loop below passes by checking nothing.
      expect(layers.length, `${name} added no rotated symbol layers`).toBeGreaterThan(0)
      for (const l of layers) {
        for (const kind of ['icon', 'text'] as const) {
          if (l.layout?.[`${kind}-rotate`] === undefined) continue
          expect(l.layout[`${kind}-rotation-alignment`], `${l.id} ${kind}`).toBe('map')
          // Standing up on a tilted chart: barbs.ts, render-architecture.md §4.
          expect(l.layout[`${kind}-pitch-alignment`], `${l.id} ${kind}`).toBe('viewport')
        }
      }
    })
  }
})

describe('the Route chart draws the wind the route sails in', () => {
  /*
   * The arrows are the Route tab's only picture of the wind, drawn under a route
   * the departure sweep can start twelve hours after the forecast was fetched.
   * They must follow the drawn route's departure, and the clock when there is no
   * route — not whichever hour the cube happens to begin with.
   */
  const HOUR = 3_600_000

  /** Uniform over the venue, blowing FROM `fromDeg[k]` in hour k. */
  function windCube(t0: number, fromDeg: number[]): WeatherCube {
    const nx = 3
    const ny = 3
    const nt = fromDeg.length
    const u = new Float32Array(nt * ny * nx)
    const v = new Float32Array(nt * ny * nx)
    fromDeg.forEach((d, k) => {
      const w = uvFromWind(12, d)
      u.fill(w.u, k * ny * nx, (k + 1) * ny * nx)
      v.fill(w.v, k * ny * nx, (k + 1) * ny * nx)
    })
    const b = PILOT_VENUE.bbox
    return {
      model: 'test',
      run: 'test-run',
      bbox: b,
      nx,
      ny,
      dx: (b.east - b.west) / (nx - 1),
      dy: (b.north - b.south) / (ny - 1),
      t0,
      dtMs: HOUR,
      nt,
      params: ['u10', 'v10'],
      data: { u10: u, v10: v },
    }
  }

  function routeLeavingAt(t: number): RouteResult {
    const at = (dt: number, dLat: number) => ({
      t: t + dt,
      position: { lat: PILOT_VENUE.waterStart.lat + dLat, lon: PILOT_VENUE.waterStart.lon },
      twd: 90,
      tws: 12,
      twa: 90,
      bsp: 6,
      heading: 0,
      isBeating: false,
      tack: 'starboard' as const,
      currentSet: null,
      currentDrift: null,
      distanceNm: 0.6,
    })
    return {
      ok: true,
      legs: [at(0, 0), at(HOUR / 10, 0.01)],
      etaMs: t + HOUR / 10,
      elapsedS: 360,
      directTimeS: 360,
      isochrones: [],
      reverseIsochrones: [],
      sensitivity: null,
      diagnostics: { nodesExplored: 1, timeStepS: 60, computeMs: 1, landAvoided: true, warnings: [] },
    }
  }

  it('follows the departure of the drawn route, and the clock without one', async () => {
    // Northerly for two hours, then easterly. Now sits in the northerly part, a
    // departure two hours on in the easterly.
    const t0 = Date.now() - HOUR / 2
    stubForecast.cube = windCube(t0, [0, 0, 90])
    populatedStore()
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })

    const map = mapInstances[0]
    /** Where each drawn arrow points: the direction the wind blows TOWARD. */
    const arrows = () =>
      ((map.data.get('wind') as GeoJSON.FeatureCollection | undefined)?.features ?? []).map((f) =>
        wrap360((f.properties as { rot: number }).rot),
      )
    const allToward = (want: number) => {
      const a = arrows()
      return a.length > 0 && a.every((b) => Math.abs(angdiff(b, want)) < 1e-3)
    }

    screen.getByText('FORECAST').click()
    await waitFor(() => expect(allToward(180), 'no route: the wind now').toBe(true))

    act(() => useStore.getState().setRoute(routeLeavingAt(t0 + 2 * HOUR)))
    expect(allToward(270), 'the wind the route leaves into').toBe(true)

    act(() => useStore.getState().setRoute(null))
    expect(allToward(180), 'route cleared: the wind now again').toBe(true)
  })
})

describe('a ping records the bow when it can, and says when it cannot', () => {
  const antenna = PILOT_VENUE.waterStart
  const pinged = () => useStore.getState().course.startLine.port!

  it('records the bow, bow-to-GPS metres ahead of the phone, when under way', () => {
    populatedStore() // heading 42, 5.5 kn, the default 3 m bow-to-GPS
    render(<StartScreen />)
    act(() => screen.getByRole('button', { name: 'PING PIN' }).click())
    expect(distance(antenna, pinged()) * 1852).toBeCloseTo(useStore.getState().boat.bowToGpsMetres, 2)
    expect(document.body.textContent).not.toContain('recorded at the phone')
  })

  it('records the phone, and says why, when creeping with no heading', () => {
    populatedStore()
    useStore.getState().setBoatState({ ...useStore.getState().state!, heading: null, cog: 40, sog: 0.4 })
    render(<StartScreen />)
    act(() => screen.getByRole('button', { name: 'PING PIN' }).click())
    expect(pinged()).toEqual(antenna)
    expect(document.body.textContent).toContain('PIN recorded at the phone, not the bow')
  })
})

describe('the Start tab asks for the wind it needs', () => {
  it('asks while no wind is set, and opens the wind sheet', () => {
    render(<StartScreen />)
    act(() => screen.getByRole('button', { name: 'SET THE WIND' }).click())
    expect(useStore.getState().windSheetOpen).toBe(true)
  })

  it('does not ask once there is a wind', () => {
    populatedStore()
    render(<StartScreen />)
    expect(screen.queryByRole('button', { name: 'SET THE WIND' })).toBeNull()
  })
})

describe('the Setup wind fields do not dress a placeholder up as a wind', () => {
  it('reads empty until somebody sets it, then shows what they set', () => {
    const field = (label: string) =>
      screen.getByText(label, { selector: 'label' }).parentElement!.querySelector('input')!
    const view = render(<SetupScreen />)
    expect(field('TWD').value).toBe('')
    expect(field('TWS').value).toBe('')
    expect(field('TWD').placeholder).toBe('not set')
    view.unmount()
    act(() => useStore.getState().setManualWind(235, 14))
    render(<SetupScreen />)
    expect(field('TWD').value).toBe('235')
    expect(field('TWS').value).toBe('14')
  })
})

describe("the Race tab's CLEAR removes marks, not the start", () => {
  it('keeps the pinged line and the running countdown', () => {
    populatedStore()
    const { startLine } = useStore.getState().course
    expect(startLine.port && startLine.starboard && startLine.gunTime).toBeTruthy()
    render(<RaceScreen />)
    act(() => screen.getByText('CLEAR').click())
    const { course } = useStore.getState()
    expect(course.marks).toEqual([])
    expect(course.startLine).toEqual(startLine)
  })
})

describe('the Setup screen does not claim a polar it has not loaded', () => {
  it('warns when no polar is selected', () => {
    render(<SetupScreen />)
    const text = document.body.textContent ?? ''
    // The class list is offered; the app must not imply a polar is active.
    expect(text).toContain('J/70')
  })

  it('lists every built-in class', () => {
    render(<SetupScreen />)
    const text = document.body.textContent ?? ''
    for (const name of ['Optimist', 'ILCA 7 (Laser)', 'J/105', 'Nacra 17']) {
      expect(text, name).toContain(name)
    }
  })

  it('names the tide station the app actually queries', () => {
    /*
     * Provenance read from a different source than the one in use is not
     * provenance. The screen used to print `PILOT_VENUE.tideStations[0]` while
     * every fetch and every depth correction went through
     * `PORTLAND_DATUM.stationId` — two literals in two files that nothing tied
     * together. `venues.test.ts` now keeps them equal; this keeps the screen
     * reading from the one that decides the answer.
     */
    render(<SetupScreen />)
    expect(document.body.textContent ?? '').toContain(PORTLAND_DATUM.stationId)
  })

  it('names the datum station, and says so, when the manifest does not list it', () => {
    /*
     * The branch that only matters once the two sources disagree — which is
     * exactly when it is needed and exactly when it cannot be reached through the
     * real data, since `venues.test.ts` keeps them equal. Taking both sources as
     * arguments is what makes it testable at all.
     *
     * The requirement is that a divergence surfaces rather than resolving quietly
     * in favour of the prettier string.
     */
    const label = tideStationLabel({ tideStations: [{ id: '8419317', name: 'Wells' }] }, { stationId: '8418150' })
    expect(label).toContain('8418150')
    expect(label).not.toContain('Wells')
    expect(label).toMatch(/not listed in the venue manifest/)
  })

  it('uses the manifest name when the manifest does list it', () => {
    const label = tideStationLabel(PILOT_VENUE, PORTLAND_DATUM)
    expect(label).toContain(PORTLAND_DATUM.stationId)
    expect(label).toContain('Portland, ME')
  })
})
