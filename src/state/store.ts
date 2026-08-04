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

export type Tab = 'start' | 'race' | 'route' | 'setup'

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
          course: {
            ...get().course,
            marks: [
              ...get().course.marks,
              { id: `m${++markSeq}-${Date.now()}`, name, position: at, roundTo: 'port' },
            ],
          },
        }),
      removeMark: (id) =>
        set({
          course: {
            ...get().course,
            marks: get().course.marks.filter((m) => m.id !== id),
          },
        }),
      clearCourse: () => set({ course: EMPTY_COURSE, activeMarkIndex: 0 }),
      activeMarkIndex: 0,
      setActiveMark: (i) => set({ activeMarkIndex: i }),

      state: null,
      setBoatState: (s) => set({ state: s }),
      gpsError: null,
      setGpsError: (e) => set({ gpsError: e }),

      wind: null,
      setWind: (w) => set({ wind: w }),
      manualWind: { twd: 270, tws: 12 },
      setManualWind: (twd, tws) => set({ manualWind: { twd, tws } }),
      windMode: 'manual',
      setWindMode: (m) => set({ windMode: m }),
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
