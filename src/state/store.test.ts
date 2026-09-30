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
import { DEFAULT_SETTINGS, MAX_EVENTS, mergePersistedState, useStore } from './store'
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

  it('clearMarks keeps the line and the gun time', () => {
    // What CLEAR on the Race tab calls, possibly mid-sequence, where losing the
    // line or the countdown running on it costs the start.
    courseOf(3)
    useStore.getState().setStartEnd('port', at(43.6, -70.21))
    useStore.getState().setStartEnd('starboard', at(43.6, -70.19))
    useStore.getState().setGunTime(1_900_000_000_000)
    useStore.getState().setActiveMark(2)
    useStore.getState().clearMarks()
    const { course } = useStore.getState()
    expect(course.marks).toEqual([])
    expect(course.startLine).toEqual({
      port: at(43.6, -70.21),
      starboard: at(43.6, -70.19),
      gunTime: 1_900_000_000_000,
    })
    expect(active()).toBe(0)
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

  it('keeps a recording switched on across a reload', () => {
    // The track itself is saved on its own (trackPersistence.ts); the switch
    // rides here, so a phone that drops the app mid-race comes back recording.
    if (!useStore.getState().recording) useStore.getState().toggleRecording()
    try {
      const persisted = JSON.parse(localStorage.getItem('newjourney.v1') as string).state
      expect(persisted.recording).toBe(true)
    } finally {
      useStore.getState().toggleRecording()
    }
  })
})

describe('saved routes and reversing the course', () => {
  it('saves the course by name, and sails it again later', () => {
    courseOf(3)
    const s = useStore.getState
    s().saveRoute('Wednesday')
    s().clearMarks()
    expect(s().course.marks).toHaveLength(0)
    s().loadRoute(s().routes[0].id)
    expect(names()).toEqual(['M1', 'M2', 'M3'])
    expect(s().course.name).toBe('Wednesday')
    expect(active()).toBe(0)
    s().deleteRoute(s().routes[0].id)
    expect(s().routes).toHaveLength(0)
  })

  it('reverses the course and starts it from the new first mark', () => {
    courseOf(3)
    useStore.getState().setActiveMark(2)
    useStore.getState().reverseCourse()
    expect(names()).toEqual(['M3', 'M2', 'M1'])
    expect(active()).toBe(0)
  })
})

describe('editing marks', () => {
  it('moves a mark and drops the route, but a rename keeps it', () => {
    const [m] = courseOf(2)
    const s = useStore.getState
    s().setRoute({ ok: true } as RouteResult)
    s().updateMark(m.id, { name: 'Windward' })
    expect(s().route).not.toBeNull()
    s().updateMark(m.id, { position: at(43.7, -70.1) })
    expect(s().route).toBeNull()
    expect(s().course.marks[0]).toMatchObject({ name: 'Windward', position: at(43.7, -70.1) })
  })

  it('reorders marks, and the active pointer stays on its mark', () => {
    const [a, b, c] = courseOf(3)
    const s = useStore.getState
    s().setActiveMark(2)
    s().moveMark(c.id, -1)
    expect(names()).toEqual(['M1', 'M3', 'M2'])
    expect(s().course.marks[active()].id).toBe(c.id)
    s().moveMark(a.id, -1)
    expect(names()).toEqual(['M1', 'M3', 'M2'])
    s().moveMark(b.id, 1)
    expect(names()).toEqual(['M1', 'M3', 'M2'])
  })
})

describe('hold wind and hold current', () => {
  const w = (twd: number) => ({ twd, tws: 12, source: 'manual' as const, uncertaintyDeg: 8, t: 1 })

  it('freezes the wind as held, ignores updates, and takes the next one once let go', () => {
    const s = useStore.getState
    s().setWind(w(270))
    s().holdWind(true)
    expect(s().wind).toMatchObject({ twd: 270, source: 'held' })
    s().setWind(w(300))
    expect(s().wind!.twd).toBe(270)
    s().holdWind(false)
    s().setWind(w(300))
    expect(s().wind).toMatchObject({ twd: 300, source: 'manual' })
  })

  it('holds the current the same way, and will not hold what is not there', () => {
    const s = useStore.getState
    s().setCurrent(null)
    s().holdCurrent(true)
    expect(s().hold.current).toBe(false)
    s().setCurrent({ set: 45, drift: 0.6, source: 'sim' })
    s().holdCurrent(true)
    s().setCurrent({ set: 200, drift: 2, source: 'sim' })
    expect(s().current).toMatchObject({ set: 45, drift: 0.6 })
    s().holdCurrent(false)
  })
})

describe('a planned route start', () => {
  it('drops the route it no longer describes, and survives a reload', () => {
    const s = useStore.getState
    s().setRoute({ ok: true } as RouteResult)
    s().setRouteStart(at(43.62, -70.18))
    expect(s().route).toBeNull()
    expect(JSON.parse(localStorage.getItem('newjourney.v1') as string).state.routeStart).toEqual(
      at(43.62, -70.18),
    )
    s().setRouteStart(null)
  })
})

describe('a reset XTE belongs to one leg', () => {
  it('is kept while the same mark is active, and dropped when the leg or the marks change', () => {
    courseOf(3)
    const s = useStore.getState
    s().resetXte(at(43.61, -70.21))
    s().setActiveMark(0)
    expect(s().xteOrigin).toEqual(at(43.61, -70.21))
    s().setActiveMark(1)
    expect(s().xteOrigin).toBeNull()
    s().resetXte(at(43.61, -70.21))
    s().addMark('M4', at(43.7, -70.2))
    expect(s().xteOrigin).toBeNull()
  })
})

describe('an imported polar survives a reload', () => {
  const imported = {
    name: 'My tuned polar',
    tws: [6, 12],
    rows: [
      { twa: [45, 90, 150], bsp: [4.1, 5.6, 4.8] },
      { twa: [40, 90, 150], bsp: [5.9, 7.2, 7.4] },
    ],
    reference: 'masthead' as const,
  }
  const saved = () => JSON.parse(localStorage.getItem('newjourney.v1') as string).state

  it('keeps the whole table when it was imported', () => {
    useStore.getState().setPolar('custom', imported)
    expect(saved().polarId).toBe('custom')
    expect(saved().polar).toEqual(imported)
  })

  it('comes back from storage as the same table, not the J/70', async () => {
    useStore.getState().setPolar('custom', imported)
    const stored = localStorage.getItem('newjourney.v1')
    useStore.getState().setPolar('j70', null)
    localStorage.setItem('newjourney.v1', stored as string)
    await useStore.persist.rehydrate()
    expect(useStore.getState().polarId).toBe('custom')
    expect(useStore.getState().polar).toEqual(imported)
  })

  it('does not store a built-in polar, which reloads from the library by id', () => {
    useStore.getState().setPolar('j70', imported)
    expect(saved().polarId).toBe('j70')
    expect(saved().polar).toBeNull()
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

  it('clears when the marks alone are cleared', () => {
    useStore.getState().clearMarks()
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

  it("takes the old 'normal' palette, the only one that was not night, to the new day default", () => {
    expect(mergePersistedState({ settings: { palette: 'normal' } } as never, defaults).settings.palette).toBe('day')
    expect(mergePersistedState({ settings: { palette: 'night' } } as never, defaults).settings.palette).toBe('night')
    expect(mergePersistedState({ settings: { palette: 'dusk' } } as never, defaults).settings.palette).toBe('dusk')
    expect(mergePersistedState({}, defaults).settings.palette).toBe('day')
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

describe('the not-for-navigation notice', () => {
  it('is asked of an install saved before the notice existed', () => {
    // An old save has no such field; the deep merge must fill in false, not
    // leave it undefined, and certainly not carry the old save past the notice.
    const old = { settings: { units: 'metric' as const, northRef: 'true' as const, simulate: false } }
    const merged = mergePersistedState(old, useStore.getState())
    expect(merged.settings.acceptedNotForNavigation).toBe(false)
    expect(DEFAULT_SETTINGS.acceptedNotForNavigation).toBe(false)
  })
})

describe('a manual wind knows whether anybody set it', () => {
  it('stamps the time it was set', () => {
    const before = Date.now()
    useStore.getState().setManualWind(235, 14)
    expect(useStore.getState().manualWindSetAt).toBeGreaterThanOrEqual(before)
  })

  it('treats a save from before the stamp as never set', () => {
    // Its 270/12 may be the placeholder or a real choice; asking once is honest,
    // silently trusting it is not.
    const merged = mergePersistedState({ manualWind: { twd: 270, tws: 12 } }, {
      ...useStore.getState(),
      manualWindSetAt: null,
    })
    expect(merged.manualWindSetAt).toBeNull()
  })
})

describe('events and sail tests', () => {
  it('keeps events in time order, trimmed, and caps them', () => {
    useStore.setState({ events: [] })
    const s = useStore.getState()
    s.addEvent('note', '  second  ', 2000)
    s.addEvent('gun', 'Gun', 1000)
    expect(useStore.getState().events.map((e) => [e.kind, e.text])).toEqual([['gun', 'Gun'], ['note', 'second']])
    for (let i = 0; i < MAX_EVENTS + 5; i++) s.addEvent('note', 'x', 10_000 + i)
    expect(useStore.getState().events).toHaveLength(MAX_EVENTS)
    s.removeEvent(useStore.getState().events[0].id)
    expect(useStore.getState().events).toHaveLength(MAX_EVENTS - 1)
    useStore.setState({ events: [] })
  })
})
