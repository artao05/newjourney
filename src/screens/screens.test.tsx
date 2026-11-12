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
import { readFileSync } from 'node:fs'
import type { DepartureSweep } from '@/lib/routing/departure'
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
    /** The options of every `fitBounds` call, in order. */
    fitted: unknown[] = []
    fitBounds(_bounds?: unknown, opts?: unknown) {
      this.fitted.push(opts)
    }
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
// The router runs in a worker, which jsdom does not have. Only WHEN's answer is needed.
const { stubSweep } = vi.hoisted(() => ({
  stubSweep: { value: null as DepartureSweep | null },
}))
vi.mock('@/lib/routing/client', () => ({
  RoutingClient: class {
    sweep = () => Promise.resolve(stubSweep.value)
    dispose() {}
  },
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
import { RouteScreen, routeFramePadding } from './RouteScreen'
import { useStore } from '@/state/store'
import { findPolar } from '@/data/polars'
import { PILOT_VENUE } from '@/data/venues'
import { distance } from '@/lib/geo'
import { PORTLAND_DATUM } from '@/lib/tides/datum'
import { angdiff, wrap360 } from '@/lib/angles'
import { uvFromWind } from '@/lib/weather/cube'

// ------------------------------------------------------------------ fixtures

const SCREENS: Array<[string, () => React.JSX.Element]> = [
  ['Start', () => <StartScreen />],
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
  stubSweep.value = null
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

describe("the Route row's narrow-phone rule stays on the Route row", () => {
  /*
   * Whether four labels fit is a question of text widths, and jsdom has no layout,
   * so the fit at 320 px is measured in the browser and the numbers are in the commit.
   * These pin the two limits on the rule: it reaches nothing at 375 px or wider, and
   * no row but Route's.
   */
  const tightRule = () => {
    const style = document.createElement('style')
    style.textContent = readFileSync('src/styles.css', 'utf8')
    document.head.appendChild(style)
    const media = [...style.sheet!.cssRules].filter(
      (r): r is CSSMediaRule =>
        'media' in r && [...(r as CSSMediaRule).cssRules].some((i) => /actions--tight/.test((i as CSSStyleRule).selectorText)),
    )
    style.remove()
    return media
  }

  it('applies below 375 px and no wider', () => {
    expect(tightRule().map((m) => m.media.mediaText)).toEqual(['(max-width: 374.98px)'])
  })

  it("marks Route's row", () => {
    render(<RouteScreen />)
    const row = screen.getByRole('button', { name: 'RESULTS' }).closest('.actions')!
    expect(row.classList.contains('actions--tight')).toBe(true)
    expect(row.querySelectorAll('.btn--sm').length).toBe(4)
  })

  it("leaves Start's rows alone", () => {
    render(<StartScreen />)
    const rows = [...document.querySelectorAll('.actions')]
    expect(rows.length).toBe(2)
    expect(rows.filter((r) => r.classList.contains('actions--tight'))).toEqual([])
  })
})

describe("Route's notes stay readable over a drawn route", () => {
  /*
   * The legend and MapLibre's attribution are anchored to the chart's bottom edge, and
   * the attribution has a z-index of its own. Anything in the chart area's foot sits
   * under them, so the notes have to live outside that area. jsdom has no layout, so
   * that is what can be pinned; the measured geometry is in the commit.
   */
  const FAILED = 'marine data unavailable (Open-Meteo request failed: 503); wind only'

  async function routeDrawnWithANoteAndAnError() {
    stubForecast.cube = { ...windCube(Date.now(), [0, 0, 0]), notes: [FAILED] } as WeatherCube
    populatedStore()
    render(<RouteScreen />)
    act(() => screen.getByRole('button', { name: 'FORECAST' }).click())
    const note = await screen.findByText(FAILED)
    act(() => {
      useStore.getState().setRoute(routeLeavingAt(Date.now()))
      useStore.getState().setRouteError('No route found')
    })
    return { note, error: screen.getByText('No route found') }
  }

  it('keeps the legend in the chart and the notes out of it', async () => {
    const { note, error } = await routeDrawnWithANoteAndAnError()
    const chart = document.querySelector('.chart-area')!
    expect(chart.contains(document.querySelector('.legend'))).toBe(true)
    expect(chart.contains(note)).toBe(false)
    expect(chart.contains(error)).toBe(false)
  })

  it('puts them between the chart and the action row', async () => {
    const { note, error } = await routeDrawnWithANoteAndAnError()
    const strip = note.parentElement!
    // First in the strip, so a long list cannot scroll the thing that just went wrong
    // out of sight.
    expect(strip.firstElementChild).toBe(error)
    expect(strip.previousElementSibling?.classList.contains('chart-area')).toBe(true)
    expect(strip.nextElementSibling).toBe(screen.getByRole('button', { name: 'ROUTE' }).closest('.actions'))
  })

  it('lets a long list scroll rather than take the whole chart', async () => {
    const style = document.createElement('style')
    style.textContent = readFileSync('src/styles.css', 'utf8')
    document.head.appendChild(style)
    try {
      const { note } = await routeDrawnWithANoteAndAnError()
      const css = getComputedStyle(note.parentElement!)
      expect(css.overflowY).toBe('auto')
      expect(css.maxHeight).toMatch(/%$/)
    } finally {
      style.remove()
    }
  })

  it('takes no room from the chart when there is nothing to say', () => {
    populatedStore()
    render(<RouteScreen />)
    expect(document.querySelector('.route-notes')).toBeNull()
  })

  it('says so there when no polar is loaded', () => {
    render(<RouteScreen />)
    expect(screen.getByText(/No polar loaded/).parentElement?.className).toBe('route-notes')
  })
})

/** styles.css, applied for the length of `fn`. jsdom ignores its @media rules. */
function withStyles<T>(fn: () => T): T {
  const style = document.createElement('style')
  style.textContent = readFileSync('src/styles.css', 'utf8')
  document.head.appendChild(style)
  try {
    return fn()
  } finally {
    style.remove()
  }
}

/** The declarations of the top-level styles.css rule written exactly as `selector`. */
function ruleFor(selector: string): CSSStyleDeclaration {
  const style = document.createElement('style')
  style.textContent = readFileSync('src/styles.css', 'utf8')
  document.head.appendChild(style)
  const rule = [...style.sheet!.cssRules].find(
    (r): r is CSSStyleRule => (r as CSSStyleRule).selectorText === selector,
  )
  style.remove()
  if (!rule) throw new Error(`styles.css has no rule for ${selector}`)
  return rule.style
}

/** The text of the top-level styles.css rule written exactly as `selector`, as written. */
function blockFor(selector: string): string {
  const css = readFileSync('src/styles.css', 'utf8')
  const at = css.indexOf(`\n${selector} {`)
  if (at < 0) throw new Error(`styles.css has no rule for ${selector}`)
  return css.slice(at + 1, css.indexOf('}', at) + 1)
}

describe("Route's legend stays clear of the chips", () => {
  /*
   * Pinned to the chart's foot, the legend covered the min-depth chip at 320×568 and the
   * first row of chips on any phone on its side. In the overlay's flow, after the chips,
   * it cannot; on a chart too short for it, it wraps past the overlay's right edge and
   * the overlay clips it. jsdom has no layout, so the structure and the rules are what
   * can be pinned here; the measured geometry is in the commit.
   */
  function routeDrawn() {
    populatedStore()
    render(<RouteScreen />)
    act(() => useStore.getState().setRoute(routeLeavingAt(Date.now())))
    return document.querySelector('.chart-area > .canvas-overlay')!
  }

  it('puts the legend after the chips, in the flow of the overlay', () => {
    const overlay = routeDrawn()
    const legend = overlay.querySelector(':scope > .legend')!
    expect(legend).not.toBeNull()
    expect(legend.previousElementSibling?.classList.contains('chart-chips')).toBe(true)
    withStyles(() => {
      expect(getComputedStyle(legend).position).toBe('static')
      expect(getComputedStyle(overlay).flexWrap).toBe('wrap')
      // The chips take the overlay's full width, so a wrapped legend lands past its edge,
      // and the gap between the columns puts it past the overlay's padding too.
      expect(getComputedStyle(legend.previousElementSibling!).width).toBe('100%')
      // Where it was when pinned: with the overlay's 14 px padding, its margins put it
      // 34 px above the chart's foot, clear of the attribution, and at x 10; and it keeps
      // its own width rather than the overlay's.
      const lg = getComputedStyle(legend)
      expect(lg.marginBottom).toBe('20px')
      expect(lg.marginLeft).toBe('-4px')
      expect(lg.alignSelf).toBe('flex-start')
    })
    expect(ruleFor('.chart-area > .canvas-overlay').getPropertyValue('column-gap')).toBe(
      'calc(var(--pad) + 10px)',
    )
    // Clipped sideways, past which a wrapped legend sits; jsdom has no two-value overflow.
    expect(readFileSync('src/styles.css', 'utf8')).toMatch(
      /\.chart-area > \.canvas-overlay \{[^}]*overflow: hidden;\s*overflow: clip visible;/,
    )
  })

  it('has a shorter layout for a narrow or short chart', () => {
    // jsdom cannot evaluate @container, so the rule is read from the sheet as written.
    const css = readFileSync('src/styles.css', 'utf8')
    expect(css).toMatch(/\.chart-area \{\s*container: route-chart \/ size;/)
    expect(css).toMatch(
      /@container route-chart \(max-width: 374\.98px\) or \(max-height: 239\.98px\) \{\s*\.canvas-overlay > \.legend \{\s*display: flex;\s*flex-wrap: wrap;/,
    )
  })

  it('frames the route clear of the chips and the legend', () => {
    // A 400 px chart, chips down to 99 px, the legend from 300 px: 111 px above, 112 below.
    expect(routeFramePadding(400, 99, 300)).toEqual({ top: 111, bottom: 112, left: 56, right: 56 })
    // No legend painted: the old 56 px at the foot.
    expect(routeFramePadding(400, 30, null)).toEqual({ top: 56, bottom: 56, left: 56, right: 56 })
    // A 140 px chart cannot give 111 + 56: both shrink in proportion, leaving the route 61.
    const short = routeFramePadding(140, 99, 100)
    expect(short.top + short.bottom).toBeLessThanOrEqual(80)
    expect(short.top).toBeGreaterThan(0)
    // jsdom's empty boxes: nothing to frame against, and no padding top or bottom that the
    // canvas cannot hold.
    expect(routeFramePadding(0, 0, null)).toEqual({ top: 0, bottom: 0, left: 56, right: 56 })
  })

  it('frames the route from where the chips and the legend are on screen', () => {
    routeDrawn()
    const map = mapInstances[0]
    const box = (l: number, t: number, w: number, h: number) =>
      ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h, x: l, y: t, toJSON: () => ({}) }) as DOMRect
    let legendLeft = 10
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('chart-area')) return box(0, 0, 320, 400)
      if (this.classList.contains('chart-chips')) return box(14, 14, 292, 85)
      if (this.matches('.canvas-overlay > .legend')) return box(legendLeft, 300, 178, 66)
      return box(0, 0, 0, 0)
    })
    try {
      // The chart above: chips down to 99 px and the legend from 300 px of a 400 px chart.
      act(() => map.fire('load'))
      expect(map.fitted.at(-1)).toMatchObject({ padding: { top: 111, bottom: 112, left: 56, right: 56 } })
      // A legend that did not fit has wrapped out past the chart's right edge. It is not
      // painted, so the route may take the foot again.
      legendLeft = 330
      act(() => useStore.getState().setRoute(routeLeavingAt(Date.now())))
      expect(map.fitted.at(-1)).toMatchObject({ padding: { top: 111, bottom: 56, left: 56, right: 56 } })
    } finally {
      rects.mockRestore()
    }
  })
})

describe('a long sheet closes without scrolling', () => {
  /*
   * CLOSE sat at the end of the scrolling sheet, about 1,340 px below the sheet's
   * bottom edge on a 375 x 812 phone. jsdom has no layout, so this pins what keeps it in
   * view: the sheet does not scroll, only its body does, and the buttons are outside it.
   * The measured positions are in the commit.
   */
  const button = (name: string | RegExp) => screen.getByRole('button', { name })
  const styles = document.createElement('style')

  beforeEach(() => {
    styles.textContent = readFileSync('src/styles.css', 'utf8')
    document.head.appendChild(styles)
  })

  afterEach(() => styles.remove())

  function expectPinned(contents: Element | null) {
    const close = button('CLOSE')
    const sheet = close.closest('.sheet')!
    const body = sheet.querySelector('.sheet__body')!
    expect(contents && body.contains(contents), 'the long part scrolls').toBe(true)
    expect(body.contains(close), 'CLOSE does not').toBe(false)
    expect(getComputedStyle(body).overflowY).toBe('auto')
    expect(getComputedStyle(body).minHeight).toBe('0px')
    expect(getComputedStyle(sheet).overflowY).toBe('hidden')
    expect(getComputedStyle(close.closest('.actions')!).flexShrink).toBe('0')

    act(() => close.click())
    expect(document.querySelector('.sheet')).toBeNull()
  }

  it('the results sheet', () => {
    populatedStore()
    act(() => useStore.getState().setRoute(routeLeavingAt(Date.now())))
    render(<RouteScreen />)
    act(() => button('RESULTS').click())
    expect(button('GPX').closest('.sheet__body')).toBeNull()
    expect(button('CSV').closest('.sheet__body')).toBeNull()
    expectPinned(document.querySelector('.sheet table.results'))
  })

  it('the departure sheet, which is long enough to need the same', async () => {
    const t = Date.now()
    const option = (departAt: number, costS: number) => ({
      departAt,
      elapsedS: 3600 + costS,
      etaMs: departAt + (3600 + costS) * 1000,
      costS,
      timeStepS: 60,
    })
    const options = [option(t, 0), option(t + HOUR, 600)]
    stubSweep.value = {
      options,
      best: options[0],
      spreadS: 600,
      stepFloorS: 60,
      attempted: 2,
      succeeded: 2,
      warnings: [],
    }
    stubForecast.cube = windCube(t, [0, 0, 0, 0])
    populatedStore()
    render(<RouteScreen />)
    act(() => button('WHEN').click())
    const routeFrom = await screen.findByRole('button', { name: /^ROUTE FROM/ })
    expect(routeFrom.closest('.sheet__body')).toBeNull()
    // Advice that matters has the legend's look, and must not have its position:
    // absolute, or it floats over the table and the pinned buttons.
    const advice = screen.getByText(/^Departure dominates/)
    expect(getComputedStyle(advice).position).toBe('static')
    expect(advice.closest('.sheet__body')).not.toBeNull()
    expectPinned(document.querySelector('.sheet table.results'))
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

/** The @media rules of styles.css whose conditions mention `media` and that style `selector`. */
function mediaRulesFor(media: string, selector: RegExp): CSSMediaRule[] {
  const style = document.createElement('style')
  style.textContent = readFileSync('src/styles.css', 'utf8')
  document.head.appendChild(style)
  const rules = [...style.sheet!.cssRules].filter(
    (r): r is CSSMediaRule =>
      'media' in r &&
      (r as CSSMediaRule).media.mediaText.includes(media) &&
      [...(r as CSSMediaRule).cssRules].some((i) => selector.test((i as CSSStyleRule).selectorText)),
  )
  style.remove()
  return rules
}

describe("Weather's overlays share one column", () => {
  /*
   * Each was pinned to the screen at its own fixed height, as if the time axis were
   * 96 px tall, and wherever the screen was short they covered each other: at 568×320
   * with the location notice up, the time axis took every tap meant for the layer and
   * model controls. In one column none can reach another. jsdom has no layout, so the
   * order and the positioning are pinned here; the measured geometry is in the commit.
   */
  const column = () =>
    [...document.querySelector('.chart-surface')!.children].map((c) => c.classList[0])

  const NOTE = 'grid coarsened to keep the request small'

  it('stacks the controls, the notes, the legend and the time axis, with the map behind', async () => {
    stubForecast.cube = { ...windCube(Date.now(), [0, 0, 0]), notes: [NOTE] } as WeatherCube
    render(<WeatherScreen />)
    await screen.findByLabelText('Forecast time')
    expect(column()).toEqual(['map', 'wx-top', 'wx-notes', 'wx-mid', 'chart-surface__timeline'])
    expect(screen.getByText(NOTE).parentElement?.className).toBe('wx-notes')
    expect(document.querySelector('.wx-mid .wx-legend')).not.toBeNull()
    withStyles(() => {
      const css = (sel: string) => getComputedStyle(document.querySelector(sel)!)
      // MapLibre's stylesheet loads after ours and makes its container position: relative,
      // which would put the map in the column, first, and push the rest off the screen.
      const maplibre = document.createElement('style')
      maplibre.textContent = '.maplibregl-map { position: relative; }'
      document.head.appendChild(maplibre)
      document.querySelector('.chart-surface > .map')!.classList.add('maplibregl-map')
      try {
        expect(css('.chart-surface > .map').position).toBe('absolute')
      } finally {
        maplibre.remove()
      }
      // In the column, in front of the map.
      for (const sel of ['.wx-top', '.wx-notes', '.wx-mid', '.chart-surface__timeline']) {
        expect(css(sel).position).toBe('relative')
      }
      // Squeezed, the controls and the time axis keep their height; the notes scroll.
      expect(css('.wx-top').flexShrink).toBe('0')
      expect(css('.chart-surface__timeline').flexShrink).toBe('0')
      expect(css('.wx-notes').overflowY).toBe('auto')
      expect(css('.wx-notes').overflowX).toBe('hidden')
      // The notes give up height, and the middle gives up all of it (below its claim).
      expect(css('.wx-notes').flexShrink).toBe('1')
      expect(parseFloat(css('.wx-notes').minHeight)).toBe(0)
      expect(parseFloat(css('.wx-mid').minHeight)).toBe(0)
      // A box that gives up height has no padding to stop it at: two 8 px floors pushed
      // the time axis 11 px down at 568×320, under the map's attribution.
      for (const sel of ['.wx-notes', '.wx-mid']) {
        expect(parseFloat(css(sel).paddingTop)).toBe(0)
        expect(parseFloat(css(sel).paddingBottom)).toBe(0)
      }
      // The legend shows whole at its slot's foot, or wraps out of sight past the clipped
      // edge, 8 px under the box above: the gap is inside the slot, so it is no floor, and
      // a note cut off where the notes scroll is never flush against the legend.
      const slot = css('.wx-mid__slot')
      expect(slot.flexWrap).toBe('wrap')
      expect(slot.justifyContent).toBe('flex-end')
      expect(['hidden', 'clip']).toContain(slot.overflow)
      expect(slot.paddingTop).toBe('8px')
    })
    expect(ruleFor('.wx-mid__slot::before').width).toBe('100%')
    const sheet = readFileSync('src/styles.css', 'utf8')
    // The middle takes what the rest leave, from nothing; jsdom cannot parse `flex: 1 1 0`.
    expect(sheet).toMatch(/\.wx-mid \{\s*flex: 1 1 0;/)
    // jsdom drops a padding shorthand with var() in it, so the notes' is read as written:
    // side padding only, nothing top or bottom to stop them shrinking.
    expect(blockFor('.wx-notes')).toMatch(/\n {2}padding: 0 var\(--pad\);/)
    expect(blockFor('.wx-notes')).not.toMatch(/padding-(top|bottom)/)
    // A long word, such as a tile's address in a map error, breaks rather than widening it.
    expect(blockFor('.wx-notes > *')).toMatch(/overflow-wrap: anywhere;/)
    // Clipped, not hidden, so neither focus nor find-in-page can scroll a wrapped legend
    // back into view; jsdom may report either, so the sheet is read as written.
    expect(sheet).toMatch(/\.wx-mid__slot \{[^}]*overflow: hidden;\s*overflow: clip;/)
  })

  it('pins the readout beside the legend, never in its place', async () => {
    stubForecast.cube = windCube(Date.now(), [0, 0, 0])
    render(<WeatherScreen />)
    await screen.findByLabelText('Forecast time')
    const click = mapInstances[0].handlers.get('click')![0]
    act(() => click({ lngLat: { lat: PILOT_VENUE.waterStart.lat, lng: PILOT_VENUE.waterStart.lon } }))
    const readout = document.querySelector('.wx-readout')!
    const legend = document.querySelector('.wx-legend')!
    expect(readout.parentElement?.classList.contains('wx-mid__slot--readout')).toBe(true)
    expect(legend.parentElement?.classList.contains('wx-mid__slot')).toBe(true)
    expect(readout.parentElement).not.toBe(legend.parentElement)
    withStyles(() => {
      const css = getComputedStyle(readout)
      // In its slot's flow, scrolling inside the slot rather than growing past it.
      expect(css.position).toBe('static')
      expect(css.overflowY).toBe('auto')
      expect(css.maxHeight).toBe('100%')
      // Below its header and one line it wraps out of sight rather than show a sliver.
      expect(css.minHeight).toBe('48px')
    })
    // Its slot adds nothing to the legend's claim on the column.
    expect(ruleFor('.wx-mid__slot--readout').getPropertyValue('contain')).toBe('size')
    // And takes what the legend leaves of the row, rather than the legend's 178 px, which
    // at 320 px wide would put the readout past the screen's edge.
    expect(blockFor('.wx-mid__slot--readout')).toMatch(/\n {2}flex: 1 1 0;\s+width: auto;\s+min-width: 0;/)
  })

  it('gives the legend its height first where there is room for it', () => {
    // jsdom cannot evaluate @container, so the rule is read from the sheet as written.
    const css = readFileSync('src/styles.css', 'utf8')
    const rule = css.match(/@container chart \(min-height: (\d+)px\) \{\s*\.wx-mid \{\s*min-height: auto;/)
    expect(rule).not.toBeNull()
    // The controls, the time axis, and the legend with the 8 px above it, at their tallest
    // in Chrome, come to 420 px.
    expect(Number(rule![1])).toBeGreaterThanOrEqual(420)
    // With no time axis (no forecast), the controls, the legend and the 34 px it keeps
    // clear of the attribution come to 285: the depth chart keeps its scale there too.
    const bare = css.match(/@container chart \(min-height: (\d+)px\) \{\s*\.wx-mid:last-child \{\s*min-height: auto;/)
    expect(bare).not.toBeNull()
    expect(Number(bare![1])).toBeGreaterThanOrEqual(285)
    expect(css).toMatch(/\.chart-surface \{\s*container: chart \/ size;/)
  })

  it('puts the tide panel between the legend and the time axis', async () => {
    stubForecast.cube = windCube(Date.now(), [0, 0, 0])
    render(<WeatherScreen />)
    await screen.findByLabelText('Forecast time')
    act(() => screen.getByRole('button', { name: 'Current' }).click())
    // The tide request fails (no network in these tests), and the panel says so.
    await screen.findByText(/Tidal current prediction unavailable/)
    expect(column()).toEqual(['map', 'wx-top', 'wx-mid', 'wx-tide', 'chart-surface__timeline'])
    withStyles(() => {
      const tide = getComputedStyle(document.querySelector('.wx-tide')!)
      expect(tide.position).toBe('relative')
      // It shares a squeeze with the notes, in proportion, rather than going first, and
      // has no padding top or bottom to stop it shrinking.
      expect(tide.flexShrink).toBe('1')
      expect(tide.overflowY).toBe('auto')
      expect(parseFloat(tide.paddingTop)).toBe(0)
      expect(parseFloat(tide.paddingBottom)).toBe(0)
      // Its gap above is inside what scrolls instead, for the same reason as the legend's.
      const panel = document.querySelector('.wx-tide')!.firstElementChild!
      expect(getComputedStyle(panel).marginTop).toBe('8px')
    })
    // jsdom drops a padding shorthand with var() in it, so the declaration is read as written.
    expect(blockFor('.wx-tide')).toMatch(/\n {2}padding: 0 var\(--pad\);/)
    expect(blockFor('.wx-tide')).not.toMatch(/padding-(top|bottom)/)
  })

  it('gives a phone on its side one line of controls and a one-line time axis', () => {
    const media = mediaRulesFor('max-height: 499.98px', /\.timeline\b/)
    expect(media.length).toBe(1)
    const rules = new Map(
      [...media[0].cssRules].map((r) => [(r as CSSStyleRule).selectorText, (r as CSSStyleRule).style]),
    )
    expect(rules.get('.wx-controls')?.flexDirection).toBe('row')
    expect(rules.get('.wx-controls')?.overflowX).toBe('auto')
    expect(rules.get('.wx-controls__row')?.flexWrap).toBe('nowrap')
    // Its own touch target, so a drag in a gap between the groups scrolls it, not the map.
    expect(rules.get('.wx-controls')?.pointerEvents).toBe('auto')
    // "Downloading…" first, rather than past the end of the line.
    expect(rules.get('.wx-controls__row > .chip--warn')?.order).toBe('-1')
    expect(rules.get('.timeline')?.display).toBe('flex')
    expect(rules.get('.timeline__labels')?.flexDirection).toBe('column')
    // The two readings only: T+ and the model (which is in the select) are left out.
    expect(rules.get('.timeline__labels > .chip')?.display).toBe('none')
  })

  it('gives a narrow time axis less side padding and no model chip', () => {
    const media = mediaRulesFor('max-width: 374.98px', /\.timeline__run\b/)
    expect(media.length).toBe(1)
    const rules = new Map(
      [...media[0].cssRules].map((r) => [(r as CSSStyleRule).selectorText, (r as CSSStyleRule).style]),
    )
    expect(rules.get('.timeline__run')?.display).toBe('none')
    expect(rules.get('.chart-surface__timeline')?.paddingLeft).toBe('8px')
    expect(rules.get('.timeline')?.paddingLeft).toBe('10px')
  })

  it('keeps the legend and the tide panel clear of the attribution with no time axis', () => {
    // With no forecast there is no time axis at the foot, and the map's attribution is.
    expect(ruleFor('.wx-mid:last-child > .wx-mid__slot').paddingBottom).toBe('34px')
    expect(ruleFor('.wx-tide:last-child > :last-child').marginBottom).toBe('34px')
  })

  it('never leaves the slider without room', () => {
    stubForecast.cube = windCube(Date.now(), [0, 0, 0])
    render(<WeatherScreen />)
    return screen.findByLabelText('Forecast time').then((slider) =>
      withStyles(() => {
        // At 320 px it took what the buttons left, which was nothing; now the speeds wrap.
        expect(getComputedStyle(slider).minWidth).toBe('48px')
        expect(getComputedStyle(slider.parentElement!).flexWrap).toBe('wrap')
        // On a line of their own, the speeds stay at the right.
        const speeds = slider.parentElement!.querySelector('.timeline__speeds')!
        expect(getComputedStyle(speeds).marginLeft).toBe('auto')
      }),
    )
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

describe('the Setup note says what routing does with mast height', () => {
  /*
   * It used to say mast height scaled the forecast, and nothing read the field. A
   * polar's reference height decides whether that costs anything, so the note has
   * to say which case the loaded polar is in.
   */
  const note = () => screen.getByText(/Forecasts give wind at 10/).textContent ?? ''

  it('says routing does not use it, and claims no polar when none is loaded', () => {
    render(<SetupScreen />)
    expect(note()).toMatch(/does not use your\s+mast height/)
    expect(note()).not.toMatch(/This polar/)
  })

  it('says a 10 m polar already matches the forecast', () => {
    useStore.getState().setPolar('j70', findPolar('j70')!.polar)
    render(<SetupScreen />)
    expect(note()).toMatch(/referenced to 10\s*m, like the forecast/)
    expect(note()).not.toMatch(/×/)
  })

  it('names the factor a masthead polar needs, and says routing does not apply it', () => {
    useStore.getState().setPolar('custom', { ...findPolar('j70')!.polar, reference: 'masthead' })
    useStore.getState().updateBoat({ mastHeightMetres: 20 })
    render(<SetupScreen />)
    expect(note()).toMatch(/×1\.09/)
    expect(note()).toMatch(/Routing does not do that/)
    useStore.getState().updateBoat({ mastHeightMetres: 11 })
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
