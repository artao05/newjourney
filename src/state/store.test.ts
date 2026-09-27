/**
 * Store invariants.
 *
 * The store is deliberately thin — the real work lives in `src/lib`, which is
 * pure and tested. What it does own is a handful of invariants *between* fields,
 * and those are exactly what nothing else can check: `src/lib` is handed a course
 * and an index and correctly refuses to trust them, so an index that has drifted
 * out of range produces silence rather than a failure.
 *
 * Needs `localStorage` for the persist middleware.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergePersistedState, useStore } from './store'
import type { LatLon, RouteResult } from '@/lib/types'

const at = (lat: number, lon: number): LatLon => ({ lat, lon })

/** Fresh course with `n` marks, active mark reset to 0. */
function courseOf(n: number) {
  useStore.getState().clearCourse()
  for (let i = 0; i < n; i++) useStore.getState().addMark(`M${i + 1}`, at(43.6 + i * 0.01, -70.2))
  return useStore.getState().course.marks
}

const active = () => useStore.getState().activeMarkIndex
const names = () => useStore.getState().course.marks.map((m) => m.name)

beforeEach(() => {
  useStore.getState().clearCourse()
  localStorage.clear()
})

describe('marks', () => {
  it('gives every mark a distinct id, including same-named ones', () => {
    useStore.getState().addMark('Windward', at(43.6, -70.2))
    useStore.getState().addMark('Windward', at(43.6, -70.2))
    const [a, b] = useStore.getState().course.marks
    expect(a.id).not.toBe(b.id)
  })

  it('ignores a remove for an id that is not there', () => {
    courseOf(2)
    useStore.getState().removeMark('nope')
    expect(names()).toEqual(['M1', 'M2'])
  })
})

describe('removeMark keeps the active-mark pointer in range', () => {
  it('keeps the same mark active when an earlier one is removed', () => {
    const marks = courseOf(3)
    useStore.getState().setActiveMark(2) // M3
    useStore.getState().removeMark(marks[0].id)
    expect(names()).toEqual(['M2', 'M3'])
    // Still M3, now at index 1 — the boat is sailing to the same buoy.
    expect(active()).toBe(1)
    expect(useStore.getState().course.marks[active()].name).toBe('M3')
  })

  it('never leaves the index past the end — the "Leg 3/2" bug', () => {
    const marks = courseOf(3)
    useStore.getState().setActiveMark(2)
    useStore.getState().removeMark(marks[0].id)
    useStore.getState().removeMark(marks[1].id)
    expect(names()).toEqual(['M3'])
    expect(active()).toBeLessThan(useStore.getState().course.marks.length)
  })

  it('lands on the next mark when the active one is removed', () => {
    const marks = courseOf(3)
    useStore.getState().setActiveMark(1) // M2
    useStore.getState().removeMark(marks[1].id)
    expect(names()).toEqual(['M1', 'M3'])
    // Index 1 now points at M3, which is the next mark of the course.
    expect(active()).toBe(1)
    expect(useStore.getState().course.marks[active()].name).toBe('M3')
  })

  it('clamps to the last mark when the active one was the last', () => {
    const marks = courseOf(2)
    useStore.getState().setActiveMark(1)
    useStore.getState().removeMark(marks[1].id)
    expect(active()).toBe(0)
  })

  it('falls back to 0 when the last mark goes', () => {
    const marks = courseOf(1)
    useStore.getState().setActiveMark(0)
    useStore.getState().removeMark(marks[0].id)
    expect(names()).toEqual([])
    expect(active()).toBe(0)
  })

  it('leaves an earlier active mark alone when a later one is removed', () => {
    const marks = courseOf(3)
    useStore.getState().setActiveMark(0)
    useStore.getState().removeMark(marks[2].id)
    expect(active()).toBe(0)
  })
})

describe('course edits do not disturb a pinged start line', () => {
  it('replaceMarks keeps the line and resets the active mark', () => {
    // Set the line after building the course: `courseOf` clears first, which is
    // the whole point of `clearCourse` and would otherwise wipe the line here.
    courseOf(3)
    useStore.getState().setStartEnd('port', at(43.6, -70.21))
    useStore.getState().setStartEnd('starboard', at(43.6, -70.19))
    useStore.getState().setActiveMark(2)
    useStore.getState().replaceMarks([{ name: 'A', position: at(43.7, -70.2) }])
    expect(useStore.getState().course.startLine.port).toEqual(at(43.6, -70.21))
    expect(active()).toBe(0)
  })

  it('removeMark keeps the line', () => {
    const marks = courseOf(2)
    useStore.getState().setStartEnd('starboard', at(43.6, -70.19))
    useStore.getState().removeMark(marks[0].id)
    expect(useStore.getState().course.startLine.starboard).toEqual(at(43.6, -70.19))
  })
})

describe('bounded histories', () => {
  it('caps wind history at 900 samples and keeps the newest', () => {
    // ~15 minutes at 1 Hz. The cap must drop the oldest, not the newest — a
    // history that discards the last minute is worse than no history.
    for (let i = 0; i < 950; i++) {
      useStore.getState().pushWind({ t: i, twd: 270, tws: 12 })
    }
    const h = useStore.getState().windHistory
    expect(h.length).toBe(900)
    expect(h[h.length - 1].t).toBe(949)
    expect(h[0].t).toBe(50)
  })

  it('clearCourse does not clear the track', () => {
    useStore.getState().pushTrack({ t: 1, lat: 43.6, lon: -70.2, sog: 5, cog: 10 })
    useStore.getState().clearCourse()
    expect(useStore.getState().track).toHaveLength(1)
    useStore.getState().clearTrack()
  })
})

describe('persistence', () => {
  it('does not persist live sensor state', () => {
    /*
     * A reload must not resurrect a boat position, a wind reading or a route as
     * though they were current. Only the things a user configured survive.
     */
    useStore
      .getState()
      .setBoatState({ t: 1, position: at(43.6, -70.2), cog: 90, sog: 5, accuracyM: 4, heading: null, bsp: null, heelDeg: null })
    useStore.getState().setWind({ twd: 270, tws: 12, source: 'manual', uncertaintyDeg: 5, t: 1 })
    useStore.getState().addMark('Keep me', at(43.6, -70.2))

    const raw = localStorage.getItem('newjourney.v1')
    expect(raw).toBeTruthy()
    const persisted = JSON.parse(raw as string).state
    expect(persisted.course.marks[0].name).toBe('Keep me')
    expect(persisted.state).toBeUndefined()
    expect(persisted.wind).toBeUndefined()
    expect(persisted.route).toBeUndefined()
    expect(persisted.track).toBeUndefined()
  })
})

describe('a computed route does not outlive the course it was computed for', () => {
  /*
   * `setRoute` is called from exactly one place - RouteScreen, on a successful
   * solve - and used to be called with null from nowhere at all. So changing the
   * course left the drawn magenta line, the isochrones, the confidence band and the
   * RESULTS sheet on screen, all describing a course that no longer existed. The
   * marks layer updates on its own effect, so the screen would show new marks and
   * an old route to a deleted one at the same time.
   *
   * Same family as the stale set-and-drift in App.tsx and the dangling
   * activeMarkIndex above: state that outlives the thing that justified it.
   */
  const fakeRoute = (): RouteResult => ({
    ok: true,
    legs: [
      {
        t: 1,
        position: at(43.6, -70.2),
        twd: 220,
        tws: 12,
        twa: 45,
        bsp: 6,
        heading: 265,
        isBeating: false,
        tack: 'starboard',
        currentSet: null,
        currentDrift: null,
        distanceNm: 0.5,
      },
    ],
    etaMs: 2,
    elapsedS: 1,
    directTimeS: 1,
    isochrones: [],
    reverseIsochrones: [],
    sensitivity: null,
    diagnostics: { nodesExplored: 1, timeStepS: 60, computeMs: 1, landAvoided: false, warnings: [] },
  })

  beforeEach(() => {
    courseOf(2)
    useStore.getState().setRoute(fakeRoute())
    useStore.getState().setRouteError('stale error')
    expect(useStore.getState().route).not.toBeNull()
  })

  it('clears when a mark is added', () => {
    useStore.getState().addMark('new', at(43.7, -70.1))
    expect(useStore.getState().route).toBeNull()
    expect(useStore.getState().routeError).toBeNull()
  })

  it('clears when a mark is removed', () => {
    const marks = useStore.getState().course.marks
    useStore.getState().removeMark(marks[0].id)
    expect(useStore.getState().route).toBeNull()
  })

  it('clears when the marks are replaced wholesale, as a GPX import does', () => {
    useStore.getState().replaceMarks([{ name: 'A', position: at(43.9, -70.3) }])
    expect(useStore.getState().route).toBeNull()
  })

  it('clears when the course is cleared', () => {
    useStore.getState().clearCourse()
    expect(useStore.getState().route).toBeNull()
  })

  it('survives a remove that matched nothing, because the course did not change', () => {
    useStore.getState().removeMark('no-such-id')
    expect(useStore.getState().route).not.toBeNull()
  })

  it('survives a start-line ping, which does not invalidate a route', () => {
    // The route starts from the boat, not from the line: pinging an end changes
    // the start numbers and nothing the router computed.
    useStore.getState().setStartEnd('port', at(43.6, -70.21))
    useStore.getState().setGunTime(Date.now() + 60_000)
    useStore.getState().setActiveMark(1)
    expect(useStore.getState().route).not.toBeNull()
  })
})

describe('mergePersistedState deep-merges nested objects', () => {
  const defaults = useStore.getState()

  it('preserves new settings fields when old localStorage lacks them', () => {
    const old = { settings: { units: 'imperial' as const, northRef: 'true' as const, simulate: false } }
    const result = mergePersistedState(old, defaults)
    expect(result.settings.units).toBe('imperial')
    expect(result.settings.keepAwake).toBe(DEFAULT_SETTINGS.keepAwake)
  })

  it('preserves new boat fields when old localStorage lacks them', () => {
    const old = { boat: { id: 'me', name: 'Old name' } }
    const result = mergePersistedState(old, defaults)
    expect(result.boat.name).toBe('Old name')
    expect(result.boat.loaMetres).toBe(defaults.boat.loaMetres)
  })

  it('preserves startLine defaults when course has no startLine', () => {
    const old = { course: { id: 'x', name: 'Old', marks: [] } }
    const result = mergePersistedState(old, defaults)
    expect(result.course.startLine.port).toBeNull()
    expect(result.course.name).toBe('Old')
  })

  it('deep-merges startLine so a pinged port does not erase starboard default', () => {
    const old = { course: { id: 'x', name: 'C', marks: [],
      startLine: { port: at(43.6, -70.21) } } }
    const result = mergePersistedState(old, defaults)
    expect(result.course.startLine.port).toEqual(at(43.6, -70.21))
    expect(result.course.startLine.starboard).toBeNull()
    expect(result.course.startLine.gunTime).toBeNull()
  })

  it('handles null persisted state without crashing', () => {
    const result = mergePersistedState(null, defaults)
    expect(result.settings.keepAwake).toBe(true)
    expect(result.settings.units).toBe('metric')
  })
})

describe('wind history belongs to one wind source', () => {
  /*
   * `tactics.boundsFrom` reads the observed oscillation from the history but
   * decides whether to trust it from `wind.source` - the source of the latest
   * estimate. If the two disagree, a spread measured from typed numbers can be
   * trusted as though it were measured from a masthead unit, and 900 samples of one
   * typed number have a standard deviation of exactly zero.
   */
  /** No action empties the history directly, so a source change is the reset. */
  function freshHistory() {
    useStore.getState().setWindMode('forecast')
    useStore.getState().setWindMode('manual')
    expect(useStore.getState().windHistory).toEqual([])
  }

  it('clears the history when the source changes', () => {
    freshHistory()
    for (let i = 0; i < 20; i++) useStore.getState().pushWind({ t: i, twd: 270, tws: 12 })
    expect(useStore.getState().windHistory.length).toBe(20)
    useStore.getState().setWindMode('forecast')
    expect(useStore.getState().windHistory).toEqual([])
  })

  it('keeps the history when the same source is set again', () => {
    // Re-selecting the current mode is a no-op a UI does constantly; it must not
    // throw away fifteen minutes of breeze.
    freshHistory()
    for (let i = 0; i < 20; i++) useStore.getState().pushWind({ t: i, twd: 270, tws: 12 })
    useStore.getState().setWindMode('manual')
    expect(useStore.getState().windHistory.length).toBe(20)
  })
})
