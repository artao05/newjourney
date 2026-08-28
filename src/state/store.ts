/**
 * Single app store. Deliberately small: this app's complexity lives in
 * `src/lib`, which is pure and testable. The store holds only what the UI
 * needs to render and what must survive a reload.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  Boat,
  BoatState,
  Course,
  CurrentEstimate,
  Degrees,
  Knots,
  LatLon,
  Millis,
  PolarTable,
  RouteResult,
  TrackPoint,
  WindEstimate,
  WindSource,
} from '@/lib/types'

export type Tab = 'start' | 'race' | 'weather' | 'route' | 'setup'

export interface Settings {
  units: 'metric' | 'imperial'
  northRef: 'true' | 'magnetic'
  /** Simulation replaces the GPS feed. */
  simulate: boolean
  keepAwake: boolean
}

interface AppState {
  tab: Tab
  setTab(t: Tab): void

  boat: Boat
  updateBoat(patch: Partial<Boat>): void

  polarId: string
  polar: PolarTable | null
  setPolar(id: string, p: PolarTable | null): void

  course: Course
  setStartEnd(which: 'port' | 'starboard', at: LatLon | null): void
  setGunTime(t: Millis | null): void
  addMark(name: string, at: LatLon): void
  /** Replace marks without resetting a previously pinged start line. */
  replaceMarks(marks: Array<{ name: string; position: LatLon }>): void
  removeMark(id: string): void
  clearCourse(): void
  activeMarkIndex: number
  setActiveMark(i: number): void

  state: BoatState | null
  setBoatState(s: BoatState | null): void
  gpsError: string | null
  setGpsError(e: string | null): void

  wind: WindEstimate | null
  setWind(w: WindEstimate | null): void
  windError: string | null
  setWindError(error: string | null): void
  manualWind: { twd: Degrees; tws: Knots }
  setManualWind(twd: Degrees, tws: Knots): void
  windMode: WindSource
  setWindMode(m: WindSource): void
  windHistory: Array<{ t: Millis; twd: Degrees; tws: Knots }>
  pushWind(s: { t: Millis; twd: Degrees; tws: Knots }): void

  current: CurrentEstimate | null
  setCurrent(c: CurrentEstimate | null): void

  track: TrackPoint[]
  recording: boolean
  toggleRecording(): void
  pushTrack(p: TrackPoint): void
  clearTrack(): void

  route: RouteResult | null
  routing: boolean
  routeError: string | null
  setRoute(r: RouteResult | null): void
  setRouting(b: boolean): void
  setRouteError(e: string | null): void

  settings: Settings
  updateSettings(patch: Partial<Settings>): void
}

const DEFAULT_BOAT: Boat = {
  id: 'me',
  name: 'My boat',
  className: 'J/70',
  loaMetres: 6.93,
  bowToGpsMetres: 3,
  mastHeightMetres: 11,
  polarPct: 100,
  polarPctNight: 96,
  tackPenaltyS: 12,
  gybePenaltyS: 8,
}

const EMPTY_COURSE: Course = {
  id: 'course',
  name: 'Course',
  marks: [],
  startLine: { port: null, starboard: null, gunTime: null },
}

let markSeq = 0

/**
 * What a course change invalidates.
 *
 * A route is computed *for* a set of marks. Change them and the drawn magenta line,
 * its isochrones, its confidence band and the RESULTS sheet are all describing a
 * course that no longer exists — and the Route screen draws the marks from a
 * different effect, so it will happily show the new marks and the old route to a
 * deleted one at the same time.
 *
 * Spread into every mutator that changes which marks exist. Deliberately NOT applied
 * to the start line or the active-mark pointer: the router starts from the boat, so
 * pinging an end or switching the active leg changes the tactical numbers and
 * nothing the router computed.
 */
const COURSE_CHANGED = { route: null, routeError: null } as const

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      tab: 'start',
      setTab: (t) => set({ tab: t }),

      boat: DEFAULT_BOAT,
      updateBoat: (patch) => set({ boat: { ...get().boat, ...patch } }),

      polarId: 'j70',
      polar: null,
      setPolar: (id, p) => set({ polarId: id, polar: p }),

      course: EMPTY_COURSE,
      setStartEnd: (which, at) =>
        set({
          course: {
            ...get().course,
            startLine: { ...get().course.startLine, [which]: at },
          },
        }),
      setGunTime: (t) =>
        set({
          course: {
            ...get().course,
            startLine: { ...get().course.startLine, gunTime: t },
          },
        }),
      addMark: (name, at) =>
        set({
          ...COURSE_CHANGED,
          course: {
            ...get().course,
            marks: [
              ...get().course.marks,
              { id: `m${++markSeq}-${Date.now()}`, name, position: at, roundTo: 'port' },
            ],
          },
        }),
      replaceMarks: (marks) =>
        set({
          ...COURSE_CHANGED,
          course: {
            ...get().course,
            marks: marks.map((m) => ({
              id: `m${++markSeq}-${Date.now()}`,
              name: m.name,
              position: m.position,
              roundTo: 'port',
            })),
          },
          activeMarkIndex: 0,
        }),
      /*
       * Removing a mark has to move the active-mark pointer with it.
       *
       * `replaceMarks` and `clearCourse` both reset it and this did not, so
       * deleting mark 1 of 3 while mark 3 was active left the index past the end:
       * the Race header read "Leg 3/2" with a blank mark name, and every tactical
       * number went quiet — `tactics.ts` returns null for an out-of-range index,
       * which is the right thing for a library to do and invisible in a UI.
       *
       * Removing an earlier mark keeps the same mark active (the index shifts
       * down with it); removing the active mark itself lands on the next one, or
       * the last one if that was the end.
       */
      removeMark: (id) => {
        const { course, activeMarkIndex } = get()
        const at = course.marks.findIndex((m) => m.id === id)
        if (at < 0) return
        const marks = course.marks.filter((m) => m.id !== id)
        const shifted = at < activeMarkIndex ? activeMarkIndex - 1 : activeMarkIndex
        set({
          ...COURSE_CHANGED,
          course: { ...course, marks },
          activeMarkIndex: marks.length === 0 ? 0 : Math.min(Math.max(0, shifted), marks.length - 1),
        })
      },
      clearCourse: () => set({ ...COURSE_CHANGED, course: EMPTY_COURSE, activeMarkIndex: 0 }),
      activeMarkIndex: 0,
      setActiveMark: (i) => set({ activeMarkIndex: i }),

      state: null,
      setBoatState: (s) => set({ state: s }),
      gpsError: null,
      setGpsError: (e) => set({ gpsError: e }),

      wind: null,
      setWind: (w) => set({ wind: w }),
      windError: null,
      setWindError: (windError) => set({ windError }),
      manualWind: { twd: 270, tws: 12 },
      setManualWind: (twd, tws) => set({ manualWind: { twd, tws } }),
      windMode: 'manual',
      /*
       * Changing the wind source empties the history, because the history is
       * evidence about one measurement process and the new source is a different
       * one.
       *
       * `tactics.boundsFrom` decides how far to trust the observed oscillation from
       * `wind.source` — the source of the *latest* estimate — while reading the
       * spread from a history that may have been filled by something else entirely.
       * Sit in manual for fifteen minutes, which fills 900 samples of one typed
       * number with a standard deviation of exactly zero, then switch to a source
       * in MEASURED_SOURCES, and the layline band would be trusted at 0 degrees:
       * perfect knowledge of the wind, inferred from a number somebody guessed.
       *
       * Latent today — nothing in the app yet produces an 'instrument' or
       * 'estimated' wind, so the max-with-nominal branch always applies. Guarded
       * now because it is invisible when it does bite, and because Signal K ingest
       * is on the roadmap that would make it bite.
       */
      setWindMode: (m) =>
        set(m === get().windMode ? { windMode: m } : { windMode: m, windHistory: [] }),
      windHistory: [],
      pushWind: (s) => {
        const h = get().windHistory
        // Keep ~15 minutes at 1 Hz — enough to resolve an oscillation period.
        const next = h.length >= 900 ? h.slice(h.length - 899) : h.slice()
        next.push(s)
        set({ windHistory: next })
      },

      current: null,
      setCurrent: (c) => set({ current: c }),

      track: [],
      recording: false,
      toggleRecording: () => set({ recording: !get().recording }),
      pushTrack: (p) => {
        const t = get().track
        const next = t.length >= 20000 ? t.slice(1) : t.slice()
        next.push(p)
        set({ track: next })
      },
      clearTrack: () => set({ track: [] }),

      route: null,
      routing: false,
      routeError: null,
      setRoute: (r) => set({ route: r }),
      setRouting: (b) => set({ routing: b }),
      setRouteError: (e) => set({ routeError: e }),

      settings: {
        units: 'metric',
        northRef: 'true',
        simulate: false,
        keepAwake: true,
      },
      updateSettings: (patch) =>
        set({ settings: { ...get().settings, ...patch } }),
    }),
    {
      name: 'newjourney.v1',
      storage: createJSONStorage(() => localStorage),
      // Live sensor data and computed results are deliberately not persisted.
      partialize: (s) => ({
        boat: s.boat,
        polarId: s.polarId,
        course: s.course,
        manualWind: s.manualWind,
        windMode: s.windMode,
        settings: s.settings,
        activeMarkIndex: s.activeMarkIndex,
      }),
    },
  ),
)
