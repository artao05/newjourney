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
import { DEFAULT_PIPELINE } from '@/lib/instruments/pipeline'
import { NO_CALIBRATION } from '@/lib/instruments/calibration'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    /** `on(ev, fn)`, or MapLibre's layer-scoped `on(ev, layerId, fn)`, kept as "ev@layer". */
    on(ev: string, a: string | ((e: unknown) => void), b?: (e: unknown) => void) {
      const key = typeof a === 'string' ? `${ev}@${a}` : ev
      const fn = typeof a === 'string' ? b! : a
      const list = this.handlers.get(key) ?? []
      list.push(fn)
      this.handlers.set(key, list)
      return this
    }
    dragPan = { enabled: true, enable: () => (this.dragPan.enabled = true), disable: () => (this.dragPan.enabled = false) }
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
    canvas = { style: {} as Record<string, string> }
    getCanvas() {
      return this.canvas
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
import { DEFAULT_NUMBER_BOXES, useStore } from '@/state/store'
import { alternatingIndex } from '@/components/NumberBoxes'
import { findPolar } from '@/data/polars'
import { PILOT_VENUE } from '@/data/venues'
import { distance } from '@/lib/geo'
import { PORTLAND_DATUM } from '@/lib/tides/datum'
import { angdiff, wrap360 } from '@/lib/angles'
import { uvFromWind } from '@/lib/weather/cube'
import { DEFAULT_ROUTE_SETTINGS } from '@/lib/routing/settings'
import * as polarLib from '@/lib/polar'
import * as sailLib from '@/lib/sailchart'

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
  useStore.setState({
    manualWind: { twd: 270, tws: 12 },
    manualWindSetAt: null,
    windSheetOpen: false,
    routeSettings: { ...DEFAULT_ROUTE_SETTINGS },
    routeStart: null,
    xteOrigin: null,
    numberBoxes: DEFAULT_NUMBER_BOXES.map((b) => ({ ...b, channels: [...b.channels] })),
    library: [],
    routes: [],
    raceNotes: [],
    polarRoles: { performance: 'navigation', start: 'navigation' },
    sailChart: null,
    whatIf: { shiftDeg: 0, speedDeltaKn: 0, current: null },
    hold: { wind: false, current: false, releaseAtGun: true },
    startApproaches: { ends: true, gps: true, reach: true, port: true, starboard: true },
    fleet: [],
    handicap: { system: 'tot', distanceNm: 0 },
    timer: { rollMin: 5, classesBefore: 0, sound: true },
    instruments: { signalKUrl: 'ws://localhost:3000/signalk/v1/stream?subscribe=self', signalKOn: false, serialOn: false, serialBaud: 4800, serialFormat: 'nmea0183' },
    instrumentReading: null,
    instrumentDerived: null,
    pipeline: { ...DEFAULT_PIPELINE },
    calibration: { ...NO_CALIBRATION, offsets: { ...NO_CALIBRATION.offsets } },
    phoneSensors: { on: false, trustCompass: false },
    phoneOrientation: null,
    instrumentStatus: { status: 'off', detail: null, lastAt: null },
  })
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

describe('the Route screen keeps its controls on screen', () => {
  /*
   * MapLibre's stylesheet makes the map container position: relative, so a map
   * sitting directly in the screen took its full height and pushed the actions
   * row off the clipped bottom edge. The map has to live in its own flexing area,
   * with the actions as a sibling of that area. jsdom has no layout, so the
   * structure is what can be pinned here. The browser check is in the commit.
   */
  it('puts the map in a chart area and the actions beside it, not below it', () => {
    render(<RouteScreen />)
    const map = document.querySelector('.map')!
    const actions = screen.getByRole('button', { name: 'ROUTE' }).closest('.actions')!
    expect(map.parentElement?.classList.contains('chart-area')).toBe(true)
    expect(actions.parentElement).toBe(map.parentElement?.parentElement)
  })
})

describe('mast height scales the forecast when, and only when, the polar needs it', () => {
  const masthead = () => ({ ...findPolar('j70')!.polar, reference: 'masthead' as const })

  it('says a 10 m polar takes the forecast as it is, and Route shows no factor', () => {
    useStore.getState().setPolar('j70', findPolar('j70')!.polar)
    render(<SetupScreen />)
    expect(screen.getByTestId('mast-height-note').textContent).toMatch(/nothing is scaled/)
    cleanup()
    render(<RouteScreen />)
    expect(screen.queryByText(/masthead wind/)).toBeNull()
  })

  it('names the factor for a masthead polar, in Setup and on the Route chart', () => {
    useStore.getState().setPolar('custom', masthead())
    useStore.getState().updateBoat({ mastHeightMetres: 20 })
    render(<SetupScreen />)
    expect(screen.getByTestId('mast-height-note').textContent).toMatch(/×1\.09/)
    cleanup()
    render(<RouteScreen />)
    expect(screen.getByText('masthead wind ×1.09')).toBeTruthy()
    useStore.getState().updateBoat({ mastHeightMetres: 11 })
  })
})

describe('the Route chart can draw the reverse isochrones', () => {
  /*
   * The backward pass has always computed them, and nothing drew them. They are
   * the manual's way of reading how much the exact route matters.
   */
  function routeWithReverse(): RouteResult {
    const p = PILOT_VENUE.waterStart
    const leg = (dLat: number) => ({
      t: Date.now(),
      position: { lat: p.lat + dLat, lon: p.lon },
      twd: 90, tws: 12, twa: 90, bsp: 6, heading: 0,
      isBeating: false, tack: 'starboard' as const,
      currentSet: null, currentDrift: null, distanceNm: 0.6,
    })
    const curve = (t: number, dLat: number) => ({
      t,
      points: [
        { lat: p.lat + dLat, lon: p.lon - 0.01 },
        { lat: p.lat + dLat, lon: p.lon + 0.01 },
      ],
    })
    return {
      ok: true,
      legs: [leg(0), leg(0.01)],
      etaMs: Date.now() + 360_000,
      elapsedS: 360,
      directTimeS: 360,
      isochrones: [curve(1, 0.004)],
      reverseIsochrones: [curve(2, 0.006), curve(3, 0.008)],
      sensitivity: null,
      diagnostics: { nodesExplored: 1, timeStepS: 60, computeMs: 1, landAvoided: true, warnings: [] },
    }
  }

  it('adds a layer for them, empty until the legend toggle turns it on', () => {
    populatedStore()
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    const map = mapInstances[0]
    expect(map.layers.some((l) => l.id === 'riso-line')).toBe(true)
    const drawn = () =>
      ((map.data.get('riso') as GeoJSON.FeatureCollection | undefined)?.features ?? []).length

    act(() => useStore.getState().setRoute(routeWithReverse()))
    expect(drawn(), 'off by default').toBe(0)

    fireEvent.click(screen.getByRole('button', { name: /reverse isochrones off/ }))
    expect(drawn(), 'one line per reverse isochrone').toBe(2)
    expect(screen.getByText(/equal time/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /reverse isochrones on/ }))
    expect(drawn()).toBe(0)
  })
})

describe('a route can start anywhere, not only at the boat', () => {
  it('routes with no GPS fix once a start is picked on the chart, and can go back', () => {
    populatedStore()
    useStore.getState().setBoatState(null)
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    const routeBtn = () => screen.getByRole<HTMLButtonElement>('button', { name: 'ROUTE' })
    expect(routeBtn().disabled, 'no fix, no start').toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /pick a start/ }))
    expect(screen.getByText(/tap the chart for the start/)).toBeTruthy()
    const picked = { lat: 43.62, lon: -70.18 }
    act(() => {
      for (const fn of mapInstances[0].handlers.get('click') ?? []) {
        fn({ lngLat: { lat: picked.lat, lng: picked.lon } })
      }
    })
    expect(useStore.getState().routeStart).toEqual(picked)
    expect(routeBtn().disabled, 'a picked start is enough').toBe(false)
    expect(mapInstances[0].data.get('start')).toMatchObject({
      features: [{ geometry: { coordinates: [picked.lon, picked.lat] } }],
    })

    fireEvent.click(screen.getByRole('button', { name: /from planned start/ }))
    expect(useStore.getState().routeStart).toBeNull()
    expect(routeBtn().disabled).toBe(true)
  })

  it('ignores chart taps unless a start is being picked', () => {
    populatedStore()
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    act(() => {
      for (const fn of mapInstances[0].handlers.get('click') ?? []) fn({ lngLat: { lat: 43.6, lng: -70.2 } })
    })
    expect(useStore.getState().routeStart).toBeNull()
  })
})

describe('the Route screen reaches every routing setting', () => {
  it('opens the settings, keeps what is typed, and names it on the map', () => {
    render(<RouteScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'SETTINGS' }))
    fireEvent.change(screen.getByLabelText(/Wind direction/), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText(/Gusts above/), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Best' }))
    expect(useStore.getState().routeSettings).toMatchObject({
      windRotateDeg: 10,
      maxGust: 30,
      resolution: 'best',
    })
    fireEvent.click(screen.getByRole('button', { name: 'DONE' }))
    for (const chip of ['wind +10°', 'gust ≤ 30 kn', 'best']) {
      expect(screen.getByText(chip)).toBeTruthy()
    }
  })

  it('treats a cleared limit as no limit, not as zero', () => {
    useStore.getState().updateRouteSettings({ maxTws: 25 })
    render(<RouteScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'SETTINGS' }))
    fireEvent.change(screen.getByLabelText(/Wind above/), { target: { value: '' } })
    expect(useStore.getState().routeSettings.maxTws).toBeNull()
  })

  it('edits the tack and gybe costs the router and the mark times use', () => {
    render(<RouteScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'SETTINGS' }))
    fireEvent.change(screen.getByLabelText(/Tack costs/), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(/Gybe costs/), { target: { value: '-5' } })
    expect(useStore.getState().boat).toMatchObject({ tackPenaltyS: 20, gybePenaltyS: 0 })
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

describe('the below-line tile says how far the GPS lets it be trusted', () => {
  const tile = () => screen.getByText('below line').closest('.tile')!
  const withAccuracy = (accuracyM: number) => {
    populatedStore()
    useStore.getState().setBoatState({ ...useStore.getState().state!, accuracyM })
  }

  it('flags a fix vaguer than half a boat length, in boat lengths', () => {
    withAccuracy(6) // on a 6.93 m J/70, nearly a boat length
    render(<StartScreen />)
    // The fixture's boat is over early, so the tile keeps OCS red, which outranks
    // the GPS amber; the caveat still rides in the sub-line.
    expect(tile().textContent).toMatch(/GPS ±0\.9 BL/)
  })

  it('stays quiet when the fix is good enough for the number', () => {
    withAccuracy(2)
    render(<StartScreen />)
    expect(tile().textContent).not.toContain('GPS ±')
  })
})

describe('Start says when the screen may sleep', () => {
  it('warns when the screen is meant to stay awake and cannot', () => {
    useStore.getState().updateSettings({ keepAwake: true })
    useStore.getState().setWakeLock('unavailable')
    render(<StartScreen />)
    expect(document.body.textContent).toContain('The screen may sleep')
  })

  it('says nothing while the lock is held, or when staying awake was switched off', () => {
    useStore.getState().updateSettings({ keepAwake: true })
    useStore.getState().setWakeLock('held')
    const view = render(<StartScreen />)
    expect(document.body.textContent).not.toContain('The screen may sleep')
    view.unmount()
    useStore.getState().updateSettings({ keepAwake: false })
    useStore.getState().setWakeLock('unavailable')
    render(<StartScreen />)
    expect(document.body.textContent).not.toContain('The screen may sleep')
  })
})

describe('a recorded track can be exported, and reads back', () => {
  it('offers nothing to export before anything is recorded', () => {
    render(<SetupScreen />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'EXPORT TRACK (GPX)' }).disabled).toBe(true)
  })

  it('downloads GPX that parses back to the recorded fixes', async () => {
    const t0 = Date.UTC(2026, 8, 27, 14, 5)
    const fixes = [0, 1, 2].map((i) => ({
      t: t0 + i * 1000,
      lat: 43.6412345 + i * 1e-4,
      lon: -70.2123456 + i * 1e-4,
      sog: 5,
      cog: 40,
    }))
    for (const f of fixes) useStore.getState().pushTrack(f)

    let saved: { blob?: Blob; name?: string } = {}
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = (b: Blob) => ((saved.blob = b), 'blob:test')
    URL.revokeObjectURL = () => {}
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved = { ...saved, name: this.download }
    })
    try {
      render(<SetupScreen />)
      act(() => screen.getByRole('button', { name: 'EXPORT TRACK (GPX)' }).click())
      await waitFor(() => expect(saved.name).toBeDefined())
      expect(saved.name).toMatch(/^newjourney-track-\d{4}-\d{2}-\d{2}-\d{4}\.gpx$/)
      const { parseGpx } = await import('@/lib/gpx')
      const back = parseGpx(await saved.blob!.text()).trackPoints
      const six = (x: number) => Math.round(x * 1e6) / 1e6
      expect(back.map((p) => [p.t, p.lat, p.lon])).toEqual(fixes.map((f) => [f.t, six(f.lat), six(f.lon)]))
    } finally {
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
    }
  })
})

describe('Race shows every number the tactics already compute', () => {
  /*
   * XTE, distance to finish, polar BSP, VMG %, VMC, the layline bearings and the
   * next leg were all computed on every tick and shown nowhere.
   */
  it('gives each one a tile with a value, not a dash, on a populated course', () => {
    populatedStore()
    render(<RaceScreen />)
    const valueOf = (label: string) => {
      const tile = [...document.querySelectorAll('.tile')].find(
        (el) => el.querySelector('.tile__label')?.textContent === label,
      )
      expect(tile, label).toBeTruthy()
      return tile!.querySelector('.tile__value')!.textContent
    }
    for (const label of ['polar bsp', 'VMG %', 'port layline', 'stbd layline', 'VMC', 'XTE', 'to finish', 'next leg']) {
      expect(valueOf(label), label).not.toBe('—')
    }
  })
})

describe('Reset XTE re-zeroes cross-track at the boat', () => {
  it('reads zero from the reset line, says so, and can go back to the leg', () => {
    populatedStore()
    render(<RaceScreen />)
    const xte = () =>
      [...document.querySelectorAll('.tile')].find(
        (el) => el.querySelector('.tile__label')?.textContent === 'XTE',
      )!
    fireEvent.click(screen.getByRole('button', { name: 'RESET XTE' }))
    expect(xte().querySelector('.tile__value')!.textContent).toMatch(/^0\.00/)
    expect(xte().textContent).toMatch(/reset line/)
    fireEvent.click(screen.getByRole('button', { name: 'XTE FROM LEG' }))
    expect(useStore.getState().xteOrigin).toBeNull()
    expect(xte().textContent).toMatch(/of the leg/)
  })
})

describe('the units setting changes the lengths on screen', () => {
  const lineTile = () =>
    [...document.querySelectorAll('.tile')].find(
      (el) => el.querySelector('.tile__label')?.textContent === 'line',
    )!
  it('shows the start line in feet once Setup is switched to feet, and back', () => {
    populatedStore()
    render(<SetupScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Feet' }))
    expect(useStore.getState().settings.units).toBe('imperial')
    cleanup()
    render(<StartScreen />)
    const len = useStore.getState().course.startLine
    expect(len.port && len.starboard).toBeTruthy()
    const metres = distance(len.port!, len.starboard!) * 1852
    expect(lineTile().textContent).toContain('ft')
    expect(lineTile().querySelector('.tile__value')!.textContent).toContain(
      (metres / 0.3048).toFixed(0),
    )
    act(() => useStore.getState().updateSettings({ units: 'metric' }))
    expect(lineTile().textContent).not.toContain('ft')
  })
})

describe('number boxes show any channel, alternate, and persist', () => {
  const box = (name: RegExp) => screen.getByRole('listitem', { name })

  it('shows the live value of the channel a box is set to', () => {
    populatedStore()
    render(<RaceScreen />)
    // The default layout starts with COG, and the populated COG is 40°.
    expect(box(/^Cog:/).textContent).toContain('040')
  })

  it('switches a box to another channel, and keeps the layout across a reload', () => {
    populatedStore()
    render(<RaceScreen />)
    fireEvent.click(box(/^Cog:/))
    fireEvent.change(screen.getByLabelText('Channel 1'), { target: { value: 'twd' } })
    fireEvent.click(screen.getByRole('button', { name: 'DONE' }))
    // The populated wind is from 220°.
    expect(box(/^Twd:/).textContent).toContain('220')
    const saved = JSON.parse(localStorage.getItem('newjourney.v1') as string).state.numberBoxes
    expect(saved[0].channels).toEqual(['twd'])
  })

  it('alternates a box between channels', () => {
    populatedStore()
    render(<RaceScreen />)
    fireEvent.click(box(/^Cog:/))
    fireEvent.click(screen.getByRole('button', { name: /ALTERNATE WITH ANOTHER/ }))
    fireEvent.change(screen.getByLabelText('Channel 2'), { target: { value: 'sog' } })
    expect(useStore.getState().numberBoxes[0].channels).toEqual(['cog', 'sog'])
    expect([0, 2000, 4000].map((t) => alternatingIndex(2, t))).toEqual([0, 1, 0])
    expect(alternatingIndex(1, 123_456)).toBe(0)
  })

  it('adds and removes boxes', () => {
    render(<RaceScreen />)
    const before = useStore.getState().numberBoxes.length
    fireEvent.click(screen.getByRole('button', { name: 'Add a number box' }))
    expect(useStore.getState().numberBoxes).toHaveLength(before + 1)
    fireEvent.click(screen.getAllByRole('listitem').at(-1)!)
    fireEvent.click(screen.getByRole('button', { name: 'REMOVE BOX' }))
    expect(useStore.getState().numberBoxes).toHaveLength(before)
  })
})

describe('Setup connects to the instruments', () => {
  it('keeps the Signal K address, connects and disconnects, and says what it is doing', () => {
    emptyStore()
    render(<SetupScreen />)
    const section = screen.getByRole('region', { name: 'Instruments' })
    fireEvent.change(within(section).getByLabelText('Signal K server'), { target: { value: ' ws://pi.local:3000/signalk/v1/stream ' } })
    expect(useStore.getState().instruments.signalKUrl).toBe('ws://pi.local:3000/signalk/v1/stream')
    expect(within(section).getByRole('status').textContent).toBe('Off')
    fireEvent.click(within(section).getByRole('button', { name: 'CONNECT' }))
    expect(useStore.getState().instruments.signalKOn).toBe(true)
    act(() => useStore.getState().setInstrumentStatus({ status: 'connected' }))
    expect(within(section).getByRole('status').textContent).toMatch(/^Connected · no data yet/)
    expect(JSON.parse(localStorage.getItem('newjourney.v1') as string).state.instruments.signalKOn).toBe(true)
    fireEvent.click(within(section).getByRole('button', { name: 'DISCONNECT' }))
    expect(useStore.getState().instruments.signalKOn).toBe(false)
  })

  it('says a serial port needs Chrome or Edge, where there is no Web Serial', () => {
    emptyStore()
    render(<SetupScreen />)
    const section = screen.getByRole('region', { name: 'Instruments' })
    expect((within(section).getByRole('button', { name: 'CONNECT SERIAL' }) as HTMLButtonElement).disabled).toBe(true)
    expect(section.textContent).toMatch(/needs Chrome or Edge/)
    fireEvent.change(within(section).getByLabelText('Serial NMEA 0183 speed'), { target: { value: '38400' } })
    expect(useStore.getState().instruments.serialBaud).toBe(38400)
  })

  it('runs one instrument source at a time', () => {
    emptyStore()
    const s = useStore.getState()
    s.setInstruments({ serialOn: true })
    s.setInstruments({ signalKOn: true })
    expect(useStore.getState().instruments).toMatchObject({ signalKOn: true, serialOn: false })
    s.setInstruments({ serialOn: true })
    expect(useStore.getState().instruments).toMatchObject({ signalKOn: false, serialOn: true })
  })

  it('sets how the instruments are processed, and keeps it', () => {
    emptyStore()
    render(<SetupScreen />)
    const section = screen.getByRole('region', { name: 'Instruments' })
    fireEvent.click(within(section).getByRole('button', { name: "Instruments' true wind" }))
    fireEvent.change(within(section).getByLabelText(/^Damping, angles/), { target: { value: '6' } })
    fireEvent.change(within(section).getByLabelText(/^Leeway coefficient/), { target: { value: '8.5' } })
    fireEvent.click(within(section).getByLabelText('Correct apparent wind for heel'))
    expect(useStore.getState().pipeline).toMatchObject({ trueWind: 'instrument', dampAngleS: 6, leewayK: 8.5, heelCorrect: true })
    expect(JSON.parse(localStorage.getItem('newjourney.v1') as string).state.pipeline.leewayK).toBe(8.5)
  })

  it('loads a correction table from a file, says why a bad one will not load, and clears it', async () => {
    emptyStore()
    render(<SetupScreen />)
    const section = screen.getByRole('region', { name: 'Calibration' })
    const good = new File(['tws, 30, 60\n10, 2, 1\n20, 2, 1'], 'twa.csv', { type: 'text/csv' })
    fireEvent.change(within(section).getByLabelText('Import the true angle (upwash) table'), { target: { files: [good] } })
    await waitFor(() => expect(useStore.getState().calibration.twa?.cols).toEqual([30, 60]))
    expect(within(section).getByText('2×2')).toBeTruthy()
    const bad = new File(['4, 8'], 'bsp.csv', { type: 'text/csv' })
    fireEvent.change(within(section).getByLabelText('Import the boat speed table'), { target: { files: [bad] } })
    await waitFor(() => expect(within(section).getByRole('alert').textContent).toMatch(/header line/))
    expect(useStore.getState().calibration.bsp).toBeNull()
    fireEvent.click(within(section).getByRole('button', { name: 'CLEAR' }))
    expect(useStore.getState().calibration.twa).toBeNull()
    fireEvent.change(within(section).getByLabelText(/^Compass offset/), { target: { value: '-2.5' } })
    expect(useStore.getState().calibration.offsets.compass).toBe(-2.5)
    expect(JSON.parse(localStorage.getItem('newjourney.v1') as string).state.calibration.offsets.compass).toBe(-2.5)
  })

  it('turns on the phone’s tilt where the browser shares it, and says so where it will not', async () => {
    emptyStore()
    render(<SetupScreen />)
    const section = screen.getByRole('region', { name: 'Instruments' })
    const tilt = within(section).getByLabelText("Use the phone's tilt as heel")
    expect((within(section).getByLabelText("Trust the phone's compass for heading") as HTMLInputElement).disabled).toBe(true)
    vi.stubGlobal('DeviceOrientationEvent', undefined)
    fireEvent.click(tilt)
    await waitFor(() => expect(within(section).getByRole('alert').textContent).toMatch(/will not share/))
    expect(useStore.getState().phoneSensors.on).toBe(false)
    vi.stubGlobal('DeviceOrientationEvent', class {})
    fireEvent.click(tilt)
    await waitFor(() => expect(useStore.getState().phoneSensors.on).toBe(true))
    vi.unstubAllGlobals()
    fireEvent.click(within(section).getByLabelText("Trust the phone's compass for heading"))
    expect(useStore.getState().phoneSensors.trustCompass).toBe(true)
    expect(within(section).getByLabelText('Phone sensors').textContent).toMatch(/No orientation/)
  })

  it('shows the GPS: only an accuracy from a phone, the fix, satellites and HDOP from NMEA', () => {
    emptyStore()
    useStore.getState().setBoatState({
      t: Date.now(), position: { lat: 43.66, lon: -70.25 }, cog: 90, sog: 5, accuracyM: 6, heading: null, bsp: null, heelDeg: null,
    })
    const { unmount } = render(<SetupScreen />)
    const phone = screen.getByRole('table', { name: 'GPS status' }).textContent!
    expect(phone).toMatch(/This device's GPS/)
    expect(phone).toMatch(/Estimated error6 m/)
    expect(phone).not.toMatch(/HDOP/)
    unmount()
    useStore.setState({
      instruments: { ...useStore.getState().instruments, signalKOn: true },
      instrumentReading: { fixQuality: 2, satellites: 9, hdop: 1.1, altitudeM: 4 },
    })
    render(<SetupScreen />)
    const nmea = screen.getByRole('table', { name: 'GPS status' }).textContent!
    expect(nmea).toMatch(/SourceSignal K/)
    expect(nmea).toMatch(/Fixdifferential \(DGPS\)/)
    expect(nmea).toMatch(/Satellites9/)
    expect(nmea).toMatch(/HDOP1\.1/)
  })

  it('offers the instruments as a wind source', () => {
    emptyStore()
    render(<SetupScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Instruments' }))
    expect(useStore.getState().windMode).toBe('instrument')
  })
})

describe('Setup exports and imports the whole configuration', () => {
  it('reads a settings file back into the boat and the layout', async () => {
    const file = new File(
      [
        JSON.stringify({
          format: 'newjourney-config',
          version: 1,
          boat: { name: 'Imported boat' },
          settings: { units: 'imperial' },
          numberBoxes: [{ id: 'x', channels: ['vmg'], size: 'lg' }],
        }),
      ],
      'boat.json',
      { type: 'application/json' },
    )
    render(<SetupScreen />)
    fireEvent.change(screen.getByLabelText('Import settings file'), { target: { files: [file] } })
    await waitFor(() => expect(useStore.getState().boat.name).toBe('Imported boat'))
    expect(useStore.getState().settings.units).toBe('imperial')
    expect(useStore.getState().numberBoxes).toEqual([{ id: 'x', channels: ['vmg'], size: 'lg' }])
    act(() => useStore.getState().updateSettings({ units: 'metric' }))
    act(() => useStore.getState().updateBoat({ name: 'My boat' }))
  })
})

describe('marks can be edited, and placed on the chart', () => {
  it('moves a mark to a typed position, in chart-plotter format', () => {
    populatedStore()
    render(<RaceScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit mark W' }))
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '43 40.000 N, 070 10.000 W' } })
    const w = useStore.getState().course.marks[0]
    expect(w.position.lat).toBeCloseTo(43 + 40 / 60, 9)
    expect(w.position.lon).toBeCloseTo(-(70 + 10 / 60), 9)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Windward' } })
    expect(useStore.getState().course.marks[0].name).toBe('Windward')
  })

  it('leaves the mark where it was when the position cannot be read, and says so', () => {
    populatedStore()
    const before = useStore.getState().course.marks[0].position
    render(<RaceScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit mark W' }))
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '43 61 N 70 W' } })
    expect(useStore.getState().course.marks[0].position).toEqual(before)
    expect(screen.getByText(/Cannot read that as a position/)).toBeTruthy()
  })

  it('adds a mark where the chart is tapped after + mark', () => {
    populatedStore()
    const n = useStore.getState().course.marks.length
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    fireEvent.click(screen.getByRole('button', { name: /\+ mark/ }))
    act(() => {
      for (const fn of mapInstances[0].handlers.get('click') ?? []) fn({ lngLat: { lat: 43.61, lng: -70.15 } })
    })
    const marks = useStore.getState().course.marks
    expect(marks).toHaveLength(n + 1)
    expect(marks.at(-1)!.position).toEqual({ lat: 43.61, lon: -70.15 })
    expect(useStore.getState().routeStart).toBeNull()
  })
})

describe("the W/L wizard builds Expedition's course", () => {
  it('lays a gate above the line and laps, with every mark rounded on the chosen side', () => {
    populatedStore()
    render(<RaceScreen />)
    fireEvent.change(screen.getByLabelText(/Leeward gate/), { target: { value: '60' } })
    fireEvent.change(screen.getByLabelText('Laps'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Leave to starboard' }))
    fireEvent.click(screen.getByRole('button', { name: 'BUILD COURSE' }))
    const marks = useStore.getState().course.marks
    expect(marks.map((m) => m.name)).toEqual(['Windward 1', 'Leeward gate 1', 'Windward 2', 'Leeward gate 2'])
    expect(marks[0].roundTo).toBe('starboard')
    expect(distance(marks[1].gate!.left, marks[1].gate!.right) * 1852).toBeCloseTo(60, 0)
    // Above the line, as Expedition means a positive leeward distance.
    const { port, starboard } = useStore.getState().course.startLine
    expect(marks[1].position.lat).toBeGreaterThan(Math.max(port!.lat, starboard!.lat))
  })

  it('reads the axis in magnetic when the app is set to magnetic', () => {
    populatedStore()
    useStore.getState().updateSettings({ northRef: 'magnetic' })
    render(<RaceScreen />)
    fireEvent.change(screen.getByLabelText(/^Axis/), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'BUILD COURSE' }))
    const { port, starboard } = useStore.getState().course.startLine
    const mid = { lat: (port!.lat + starboard!.lat) / 2, lon: (port!.lon + starboard!.lon) / 2 }
    const w = useStore.getState().course.marks[0].position
    // 000°M is about 345.5°T in Portland (variation 14.5° W).
    const brg = (Math.atan2((w.lon - mid.lon) * Math.cos((mid.lat * Math.PI) / 180), w.lat - mid.lat) * 180) / Math.PI
    expect(wrap360(brg)).toBeCloseTo(345.5, 0)
    useStore.getState().updateSettings({ northRef: 'true' })
  })
})

describe('a gate as the active mark', () => {
  it('shows the favoured buoy, the square wind and the gate spot on Race', () => {
    populatedStore()
    render(<RaceScreen />)
    fireEvent.change(screen.getByLabelText(/Leeward gate/), { target: { value: '80' } })
    fireEvent.change(screen.getByLabelText('Laps'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'BUILD COURSE' }))
    act(() => useStore.getState().setActiveMark(1))
    const text = document.body.textContent ?? ''
    expect(text).toContain('favoured buoy')
    expect(text).toMatch(/gate 80 m wide/)
    expect(text).toContain('gate spot')
  })

  it('has no gate section when the active mark is a plain mark', () => {
    populatedStore()
    render(<RaceScreen />)
    expect(screen.queryByText('favoured buoy')).toBeNull()
  })
})

describe('the start line can be adjusted without re-pinging', () => {
  it('sets the pin at a range and bearing from the RC end', () => {
    populatedStore()
    render(<StartScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'LINE' }))
    fireEvent.change(screen.getByLabelText(/^Range/), { target: { value: '300' } })
    fireEvent.change(screen.getByLabelText(/^Bearing/), { target: { value: '270' } })
    fireEvent.click(screen.getByRole('button', { name: 'SET PIN END' }))
    const { port, starboard } = useStore.getState().course.startLine
    expect(distance(starboard!, port!) * 1852).toBeCloseTo(300, 1)
    expect(port!.lon).toBeLessThan(starboard!.lon)
  })

  it('nudges an end up the wind, and swaps the ends', () => {
    populatedStore()
    const before = useStore.getState().course.startLine
    render(<StartScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'LINE' }))
    fireEvent.change(screen.getByLabelText(/^Metres/), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'NUDGE PIN' }))
    const nudged = useStore.getState().course.startLine.port!
    expect(distance(before.port!, nudged) * 1852).toBeCloseTo(20, 1)
    fireEvent.click(screen.getByRole('button', { name: 'SWAP ENDS' }))
    const after = useStore.getState().course.startLine
    expect(after.port).toEqual(before.starboard)
    expect(after.starboard).toEqual(nudged)
  })

  it('keeps the approach choice across a reload (the start maths reads it; startline tests cover the effect)', () => {
    populatedStore()
    render(<StartScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'LINE' }))
    for (const name of ['Line ends', 'Reaching to the line', 'Port layline', 'Starboard layline']) {
      fireEvent.click(screen.getByLabelText(name))
    }
    expect(useStore.getState().startApproaches).toEqual({ ends: false, gps: true, reach: false, port: false, starboard: false })
    expect(JSON.parse(localStorage.getItem('newjourney.v1') as string).state.startApproaches.gps).toBe(true)
  })
})

describe('the start timer sheet', () => {
  it('sets the gun by minutes and seconds, or by the clock', () => {
    populatedStore()
    render(<StartScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'TIMER' }))
    fireEvent.change(screen.getByLabelText(/^Time to the gun/), { target: { value: '4:30' } })
    const before = Date.now()
    fireEvent.click(screen.getByRole('button', { name: 'START COUNTDOWN' }))
    const gun = useStore.getState().course.startLine.gunTime!
    expect(gun - before).toBeGreaterThanOrEqual(270_000)
    expect(gun - before).toBeLessThan(271_000)

    fireEvent.change(screen.getByLabelText(/^Gun at/), { target: { value: 'soon' } })
    fireEvent.click(screen.getByRole('button', { name: 'SET GUN TIME' }))
    expect(screen.getByRole('alert').textContent).toMatch(/not a clock time/)
    expect(useStore.getState().course.startLine.gunTime).toBe(gun)
    fireEvent.change(screen.getByLabelText(/^Gun at/), { target: { value: '23:59:59' } })
    fireEvent.click(screen.getByRole('button', { name: 'SET GUN TIME' }))
    expect(new Date(useStore.getState().course.startLine.gunTime!).getSeconds()).toBe(59)
  })

  it('keeps the class-start roll and the sound setting', () => {
    populatedStore()
    render(<StartScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'TIMER' }))
    fireEvent.change(screen.getByLabelText('Minutes between starts'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Classes starting before ours'), { target: { value: '2' } })
    fireEvent.click(screen.getByLabelText('Sound the countdown'))
    expect(useStore.getState().timer).toEqual({ rollMin: 3, classesBefore: 2, sound: false })
    expect(JSON.parse(localStorage.getItem('newjourney.v1') as string).state.timer.classesBefore).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'RESTART AT 3 MIN' }))
    expect(useStore.getState().course.startLine.gunTime! - Date.now()).toBeGreaterThan(179_000)
  })
})

describe('Start holds the wind for the pre-start', () => {
  it('holds and lets go from the Start buttons', () => {
    populatedStore()
    render(<StartScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'HOLD WIND' }))
    expect(useStore.getState().wind?.source).toBe('held')
    fireEvent.click(screen.getByRole('button', { name: 'WIND HELD' }))
    expect(useStore.getState().hold.wind).toBe(false)
  })
})

describe('what-if reaches every screen', () => {
  const tile = (label: string) =>
    [...document.querySelectorAll('.tile')].find((el) => el.querySelector('.tile__label')?.textContent === label)!
      .querySelector('.tile__value')!.textContent

  it('shifts the start line bias on Start, and says so there, not only on Race', () => {
    populatedStore()
    render(<StartScreen />)
    const before = screen.queryByText(/What-if active/)
    expect(before).toBeNull()
    cleanup()
    act(() => useStore.getState().setWhatIf({ shiftDeg: 30 }))
    render(<StartScreen />)
    expect(screen.getByText(/What-if active/).closest('.warnbox')!.textContent).toMatch(/\+30° shift/)
  })

  it('uses a what-if current on Race, where the steer allows for it', () => {
    populatedStore()
    render(<RaceScreen />)
    const plain = tile('steer')
    fireEvent.click(screen.getByLabelText('What-if current'))
    fireEvent.change(document.getElementById('wi-drift')!, { target: { value: '1.5' } })
    fireEvent.change(document.getElementById('wi-set')!, { target: { value: '90' } })
    expect(useStore.getState().whatIf.current).toEqual({ set: 90, drift: 1.5 })
    expect(tile('steer')).not.toBe(plain)
    fireEvent.click(screen.getByRole('button', { name: 'RESET WHAT-IF' }))
    expect(useStore.getState().whatIf).toEqual({ shiftDeg: 0, speedDeltaKn: 0, current: null })
  })

  it('is never saved, so a what-if cannot survive into tomorrow', () => {
    act(() => useStore.getState().setWhatIf({ shiftDeg: 12 }))
    const saved = JSON.parse(localStorage.getItem('newjourney.v1') ?? '{}').state ?? {}
    expect(saved.whatIf).toBeUndefined()
  })
})

describe('the course as legs, and saved routes', () => {
  it('lists each leg from the boat with bearing, distance, angle off the wind and time', () => {
    populatedStore()
    render(<RaceScreen />)
    const rows = within(screen.getByRole('table', { name: 'Legs' })).getAllByRole('row')
    expect(rows).toHaveLength(3) // two legs and the total
    expect(rows[0].textContent).toMatch(/1\. Boat → W/)
    expect(rows[0].textContent).toMatch(/nm · \d+° off · \d/)
    expect(rows[2].textContent).toMatch(/Total/)
  })

  it('saves the course as a route and sails it again after a clear', () => {
    populatedStore()
    render(<RaceScreen />)
    fireEvent.change(screen.getByLabelText('Save course as'), { target: { value: 'Harbour race' } })
    fireEvent.click(screen.getByRole('button', { name: 'SAVE ROUTE' }))
    act(() => useStore.getState().clearMarks())
    fireEvent.click(screen.getByRole('button', { name: 'Sail Harbour race' }))
    expect(useStore.getState().course.marks.map((m) => m.name)).toEqual(['W', 'L'])
  })
})

describe('the handicap calculator on Race', () => {
  it('adds boats, stamps them as they finish, and gives corrected times and what is owed', () => {
    populatedStore()
    const gun = Date.UTC(2026, 8, 29, 12)
    useStore.setState({ course: { ...useStore.getState().course, startLine: { ...useStore.getState().course.startLine, gunTime: gun } } })
    render(<RaceScreen />)
    const add = (name: string, rating: string) => {
      fireEvent.change(screen.getByLabelText('New boat name'), { target: { value: name } })
      fireEvent.change(screen.getByLabelText('New boat rating'), { target: { value: rating } })
      fireEvent.click(screen.getByRole('button', { name: 'ADD BOAT' }))
    }
    add('Us', '1')
    add('Her', '1.1')
    expect(useStore.getState().fleet.map((b) => [b.name, b.reference])).toEqual([['Us', true], ['Her', false]])

    const now = vi.spyOn(Date, 'now').mockReturnValue(gun + 7200_000)
    fireEvent.click(screen.getByRole('button', { name: 'Stamp Her' }))
    now.mockReturnValue(gun + 7900_000)
    fireEvent.click(screen.getByRole('button', { name: 'Stamp Us' }))
    now.mockRestore()

    const table = screen.getByRole('table', { name: 'Handicap results' })
    const her = within(table).getByRole('button', { name: 'Stamp Her' }).closest('tr')!
    // 2:00:00 at TCF 1.1 corrects to 2:12:00; we took 2:11:40, so she is 20 s behind.
    expect(her.textContent).toContain('2:12:00')
    expect(her.textContent).toContain('+0:00:20')
    expect(her.textContent).toContain('+0:12:00')
    expect(JSON.parse(localStorage.getItem('newjourney.v1') as string).state.fleet).toHaveLength(2)
  })

  it('switches to time on distance, and moves the reference boat', () => {
    populatedStore()
    render(<RaceScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'ADD BOAT' }))
    fireEvent.click(screen.getByRole('button', { name: 'ADD BOAT' }))
    fireEvent.click(screen.getByRole('button', { name: 'Time on distance' }))
    fireEvent.change(screen.getByLabelText(/^Course distance/), { target: { value: '12.5' } })
    expect(useStore.getState().handicap).toEqual({ system: 'tod', distanceNm: 12.5 })
    fireEvent.click(screen.getByLabelText('Boat 2 is the reference boat'))
    expect(useStore.getState().fleet.map((b) => b.reference)).toEqual([false, true])
    fireEvent.click(screen.getByRole('button', { name: 'Remove Boat 2' }))
    expect(useStore.getState().fleet.map((b) => b.reference)).toEqual([true])
  })
})

describe('the marks library', () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="t">
    <wpt lat="43.60" lon="-70.20"><name>Bell 1</name></wpt>
    <wpt lat="43.62" lon="-70.18"><name>Can 3</name></wpt></gpx>`

  it('files a GPX import under its own folder, not straight onto the course', async () => {
    render(<RaceScreen />)
    const file = new File([gpx], 'Casco Bay.gpx', { type: 'application/gpx+xml' })
    fireEvent.change(screen.getByLabelText('Import marks into the library'), { target: { files: [file] } })
    await waitFor(() => expect(useStore.getState().library).toHaveLength(2))
    expect(useStore.getState().library.map((m) => [m.folder, m.name])).toEqual([
      ['Casco Bay', 'Bell 1'],
      ['Casco Bay', 'Can 3'],
    ])
    expect(useStore.getState().course.marks).toHaveLength(0)
  })

  it("files Expedition's marks CSV by its group column", async () => {
    render(<RaceScreen />)
    const csv = ['North Head,50 42.69n,01 35.52w,Solent', 'Bell 1,43.6,-70.2,Casco Bay'].join('\n')
    const file = new File([csv], 'marks.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('Import marks into the library'), { target: { files: [file] } })
    await waitFor(() => expect(useStore.getState().library).toHaveLength(2))
    expect(useStore.getState().library.map((m) => m.folder)).toEqual(['Solent', 'Casco Bay'])
  })

  it('builds the course from it, a mark at a time or a folder at once', () => {
    useStore.getState().addToLibrary('Casco Bay', [
      { name: 'Bell 1', position: { lat: 43.6, lon: -70.2 } },
      { name: 'Can 3', position: { lat: 43.62, lon: -70.18 } },
    ])
    render(<RaceScreen />)
    fireEvent.click(screen.getByRole('button', { name: /Casco Bay/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add Can 3 to the course' }))
    expect(useStore.getState().course.marks.map((m) => m.name)).toEqual(['Can 3'])
    fireEvent.click(screen.getByRole('button', { name: 'USE AS COURSE' }))
    expect(useStore.getState().course.marks.map((m) => m.name)).toEqual(['Bell 1', 'Can 3'])
    // The library keeps its marks whatever happens to the course.
    act(() => useStore.getState().clearMarks())
    expect(useStore.getState().library).toHaveLength(2)
  })

  it('saves the course into a folder, and deletes a folder', () => {
    populatedStore()
    render(<RaceScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'SAVE COURSE HERE' }))
    const lib = useStore.getState().library
    expect(lib.map((m) => m.name)).toEqual(['W', 'L'])
    expect(JSON.parse(localStorage.getItem('newjourney.v1') as string).state.library).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'DELETE FOLDER' }))
    expect(useStore.getState().library).toHaveLength(0)
  })
})

describe('race notes are drawn on the chart and edited', () => {
  const tap = (lat: number, lng: number) =>
    act(() => {
      for (const fn of mapInstances[0].handlers.get('click') ?? []) fn({ lngLat: { lat, lng } })
    })

  it('draws an area in three taps, then opens it for its text and routing effect', () => {
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    fireEvent.click(screen.getByRole('button', { name: '+ note' }))
    tap(43.6, -70.2)
    tap(43.61, -70.2)
    expect(screen.getByText('tap 1 more')).toBeTruthy()
    tap(43.61, -70.19)
    fireEvent.click(screen.getByText('finish (3)'))
    const [note] = useStore.getState().raceNotes
    expect(note).toMatchObject({ kind: 'area', text: '', avoid: false, speedPct: null })
    expect(note.points).toHaveLength(3)
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'TSS' } })
    fireEvent.click(screen.getByLabelText('Routes keep out of this area'))
    expect(useStore.getState().raceNotes[0]).toMatchObject({ text: 'TSS', avoid: true })
    const drawn = mapInstances[0].data.get('notes') as GeoJSON.FeatureCollection
    expect(drawn.features[0].geometry.type).toBe('Polygon')
    expect(drawn.features[0].properties).toMatchObject({ text: 'TSS', avoid: true })
  })

  it('draws a point note in one tap', () => {
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    fireEvent.click(screen.getByRole('button', { name: '+ note' }))
    fireEvent.click(screen.getByRole('button', { name: 'point' }))
    tap(43.6, -70.2)
    fireEvent.click(screen.getByText('finish (1)'))
    expect(useStore.getState().raceNotes[0]).toMatchObject({ kind: 'point', points: [{ lat: 43.6, lon: -70.2 }] })
  })

  it('lists notes on Race, says what each does, and deletes them', () => {
    useStore.getState().addRaceNote({
      kind: 'area',
      points: [{ lat: 43.6, lon: -70.2 }, { lat: 43.61, lon: -70.2 }, { lat: 43.61, lon: -70.19 }],
      text: 'Weed',
      avoid: false,
      speedPct: 80,
    })
    render(<RaceScreen />)
    const section = screen.getByRole('region', { name: 'Race notes' })
    expect(section.textContent).toContain('Weed')
    expect(section.textContent).toContain('80% speed')
    fireEvent.click(screen.getByRole('button', { name: 'Edit note Weed' }))
    fireEvent.click(screen.getByRole('button', { name: 'DELETE NOTE' }))
    expect(useStore.getState().raceNotes).toHaveLength(0)
  })
})

describe('laylines on the Route chart', () => {
  it('draws both laylines to the active mark, with bounds, once there is a wind', () => {
    populatedStore()
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    const fc = mapInstances[0].data.get('laylines') as GeoJSON.FeatureCollection
    const main = fc.features.filter((f) => !(f.properties as { bound: boolean }).bound)
    expect(main.map((f) => (f.properties as { side: string }).side).sort()).toEqual(['port', 'starboard'])
    // A manual wind asserts 8° of uncertainty, so there are bounds either side.
    expect(fc.features.length).toBe(6)
    const w = useStore.getState().course.marks[0].position
    for (const f of main) {
      expect((f.geometry as GeoJSON.LineString).coordinates[0]).toEqual([w.lon, w.lat])
    }
  })

  it('draws none without a wind', () => {
    populatedStore()
    useStore.getState().setWind(null)
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    expect(mapInstances[0].data.get('laylines')).toMatchObject({ features: [] })
  })
})

describe('range and bearing on the Route chart', () => {
  const tap = (lat: number, lng: number) =>
    act(() => {
      for (const fn of mapInstances[0].handlers.get('click') ?? []) fn({ lngLat: { lat, lng } })
    })

  it('reads out a tapped point: position, then range, bearing and time from the boat', () => {
    populatedStore()
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    const boat = useStore.getState().state!.position
    tap(boat.lat + 1 / 60, boat.lon)
    const readout = screen.getByLabelText('Pointer readout').textContent ?? ''
    expect(readout).toMatch(/°.*'N .*'W/)
    expect(readout).toMatch(/1\.00 nm 0°T/)
    // A wind and a polar are set in the populated store, so there is a time.
    expect(readout).toMatch(/nm 0°T · \d/)
  })

  it('measures between two tapped points with the dividers', () => {
    populatedStore()
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    fireEvent.click(screen.getByRole('button', { name: 'measure' }))
    // Measuring is its own mode: the start chip must not claim the tap.
    expect(screen.queryByText(/tap the chart for the/)).toBeNull()
    tap(43.6, -70.2)
    expect(screen.getByText(/tap the second point/)).toBeTruthy()
    tap(43.6, -70.2 + 1 / 60 / Math.cos((43.6 * Math.PI) / 180))
    expect(screen.getByText(/1\.00 nm 90°T · done/)).toBeTruthy()
    expect(mapInstances[0].data.get('measure')).toMatchObject({ features: [{}, {}, { geometry: { type: 'LineString' } }] })
    fireEvent.click(screen.getByText(/nm 90°T · done/))
    expect(mapInstances[0].data.get('measure')).toMatchObject({ features: [] })
  })
})

describe('a mark can be dragged on the Route chart', () => {
  function drag(map: InstanceType<typeof FakeMap>, id: string, path: Array<[number, number]>) {
    const call = (key: string, e: unknown) => {
      for (const fn of map.handlers.get(key) ?? []) fn(e)
    }
    act(() => {
      call('mousedown@marks-pt', { features: [{ properties: { id } }], preventDefault() {} })
      for (const [lat, lng] of path) call('mousemove', { lngLat: { lat, lng } })
      const [lat, lng] = path.at(-1) ?? [0, 0]
      call('mouseup', { lngLat: { lat, lng } })
    })
  }

  it('moves the mark where it is let go, and holds the map still meanwhile', () => {
    populatedStore()
    render(<RouteScreen />)
    act(() => {
      for (const m of mapInstances) m.fire('load')
    })
    const map = mapInstances[0]
    const w = useStore.getState().course.marks[0]
    let panWhileHeld: boolean | null = null
    act(() => {
      for (const fn of map.handlers.get('mousedown@marks-pt') ?? []) {
        fn({ features: [{ properties: { id: w.id } }], preventDefault() {} })
      }
      panWhileHeld = map.dragPan.enabled
      for (const fn of map.handlers.get('mouseup') ?? []) fn({ lngLat: { lat: 0, lng: 0 } })
    })
    expect(panWhileHeld).toBe(false)
    // A press with no movement is a tap: nothing moved.
    expect(useStore.getState().course.marks[0].position).toEqual(w.position)

    drag(map, w.id, [[43.70, -70.10], [43.71, -70.11]])
    expect(useStore.getState().course.marks[0].position).toEqual({ lat: 43.71, lon: -70.11 })
    expect(map.dragPan.enabled).toBe(true)
  })
})

describe('man overboard', () => {
  it('drops a MOB mark at the boat, makes it active, and says so in red', () => {
    populatedStore()
    render(<RaceScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'MOB' }))
    const { course, activeMarkIndex, state } = useStore.getState()
    const mob = course.marks[activeMarkIndex]
    expect(mob.name).toBe('MOB')
    expect(mob.position).toEqual(state!.position)
    expect(mob.mobAt).toBeTypeOf('number')
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/MAN OVERBOARD · 0:0\d ago/)
  })
})

describe('the polar editor', () => {
  it('edits a speed, re-derives the targets, and saves the table as my polar', () => {
    useStore.getState().setPolar('j70', findPolar('j70')!.polar)
    render(<SetupScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'EDIT POLAR' }))
    const before = screen.getByLabelText('Row targets').textContent
    const first = screen.getAllByLabelText(/^BSP at /)[0] as HTMLInputElement
    fireEvent.change(first, { target: { value: String(Number(first.value) + 1.5) } })
    expect(screen.getByLabelText('Row targets').textContent).not.toBe(before)
    fireEvent.click(screen.getByRole('button', { name: 'SAVE AS MY POLAR' }))
    const { polarId, polar } = useStore.getState()
    expect(polarId).toBe('custom')
    expect(polar!.name).toMatch(/\(edited\)$/)
    expect(polar!.rows[0].bsp[0]).toBeCloseTo(findPolar('j70')!.polar.rows[0].bsp[0] + 1.5, 9)
    // The library's own J/70 is untouched.
    expect(findPolar('j70')!.polar.rows[0].bsp[0]).not.toBeCloseTo(polar!.rows[0].bsp[0], 3)
  })

  it('will not save a table it cannot use, and says why', () => {
    useStore.getState().setPolar('j70', findPolar('j70')!.polar)
    render(<SetupScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'EDIT POLAR' }))
    fireEvent.change(screen.getAllByLabelText(/^BSP at /)[0], { target: { value: '-3' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'SAVE AS MY POLAR' }).disabled).toBe(true)
    expect(document.querySelector('.sheet .errbox')).not.toBeNull()
  })
})

describe('the targets table', () => {
  it("lists a target for every wind speed in the polar, at the boat's polar %", () => {
    const polar = findPolar('j70')!.polar
    useStore.getState().setPolar('j70', polar)
    useStore.getState().updateBoat({ polarPct: 90 })
    render(<SetupScreen />)
    const rows = within(screen.getByRole('table', { name: 'Targets' })).getAllByRole('row')
    expect(rows).toHaveLength(polar.tws.length + 1)
    const { deriveTargets } = polarLib
    const t = deriveTargets(polar, polar.tws[2])
    expect(rows[3].textContent).toContain((t.upBsp * 0.9).toFixed(2))
    useStore.getState().updateBoat({ polarPct: 100 })
  })
})

describe('the sail chart', () => {
  const CHART = ['TWS\\TWA\t40\t90\t150', '8\tJ1\tC0\tA2', '14\tJ2\tC0\tA4'].join('\n')

  it('loads in Setup, shows each sail by colour, and marks the wind now', async () => {
    populatedStore()
    render(<SetupScreen />)
    const file = new File([CHART], 'sails.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('Load a sail chart'), { target: { files: [file] } })
    await waitFor(() => expect(useStore.getState().sailChart).not.toBeNull())
    const table = screen.getByRole('table', { name: 'Sails by TWA and TWS' })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    // The populated boat heads 042° with the wind from 220°: a dead run in 12 kn,
    // nearest the 150° and 14 kn cell, so the A4.
    expect(table.querySelector('[aria-current="true"]')?.textContent).toBe('A4')
  })

  it('gives Race a sail tile and each leg its sail', () => {
    populatedStore()
    const { parseSailChart } = sailLib
    useStore.getState().setSailChart(parseSailChart(CHART))
    render(<RaceScreen />)
    const tile = [...document.querySelectorAll('.tile')].find((el) => el.querySelector('.tile__label')?.textContent === 'sail')!
    expect(tile.querySelector('.tile__value')!.textContent).toBe('A4')
    const legs = within(screen.getByRole('table', { name: 'Legs' })).getAllByRole('row')
    expect(legs[0].textContent).toMatch(/· (J1|J2|C0|A2|A4)$/)
  })
})

describe('polar roles', () => {
  const targetBsp = () =>
    [...document.querySelectorAll('.tile')]
      .find((el) => el.querySelector('.tile__label')?.textContent === 'target bsp')!
      .querySelector('.tile__value')!.textContent

  it('lets Race take its targets from a separate performance polar, chosen in Setup', () => {
    populatedStore()
    render(<RaceScreen />)
    const onNavigation = targetBsp()
    cleanup()
    render(<SetupScreen />)
    fireEvent.change(screen.getByLabelText('Performance polar'), { target: { value: 'j105' } })
    expect(useStore.getState().polarRoles.performance).toBe('j105')
    expect(JSON.parse(localStorage.getItem('newjourney.v1') as string).state.polarRoles.performance).toBe('j105')
    cleanup()
    render(<RaceScreen />)
    expect(targetBsp()).not.toBe(onNavigation)
    // The navigation polar itself is untouched: routing still uses the J/70.
    expect(useStore.getState().polarId).toBe('j70')
  })
})

describe('the loaded polar can be saved in the format it was read in', () => {
  it('downloads an Expedition .txt that parses back to the same speeds', async () => {
    const polar = findPolar('j70')!.polar
    useStore.getState().setPolar('j70', polar)
    let saved: { blob?: Blob; name?: string } = {}
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = (b: Blob) => ((saved.blob = b), 'blob:test')
    URL.revokeObjectURL = () => {}
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved = { ...saved, name: this.download }
    })
    try {
      render(<SetupScreen />)
      act(() => screen.getByRole('button', { name: 'EXPORT POLAR (.TXT)' }).click())
      await waitFor(() => expect(saved.name).toBeDefined())
      expect(saved.name).toMatch(/\.txt$/)
      const { parsePolar } = await import('@/lib/polar')
      const back = parsePolar(await saved.blob!.text(), 'back')
      expect(back.tws).toEqual(polar.tws)
      expect(back.rows.map((r) => r.bsp)).toEqual(polar.rows.map((r) => r.bsp))
      expect(back.rows.map((r) => r.twa)).toEqual(polar.rows.map((r) => r.twa))
    } finally {
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
    }
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
