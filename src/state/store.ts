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
  Mark,
  Millis,
  PolarTable,
  RouteResult,
  TrackPoint,
  WindEstimate,
  WindSource,
} from '@/lib/types'
import { DEFAULT_ROUTE_SETTINGS, type RouteSettings } from '@/lib/routing/settings'

export type Tab = 'start' | 'race' | 'weather' | 'route' | 'setup'
/** The nav station's two tab sets: panels on the left, charts in the middle. */
export type PanelTab = 'start' | 'race' | 'setup'
export type ChartTab = 'route' | 'weather'

/**
 * A configurable number box: one channel, or up to ten that alternate, as
 * Expedition's alternating boxes do.
 */
export interface NumberBox {
  id: string
  /** Channel ids from src/lib/channels/catalogue.ts. The first is shown alone. */
  channels: string[]
  size: 'sm' | 'md' | 'lg'
}

/**
 * A mark in the library: Expedition's marks database. Named marks, in folders,
 * kept apart from the course, so a season's buoys outlive any one race. The course
 * is built from them.
 */
export interface LibraryMark {
  id: string
  name: string
  position: LatLon
  folder: string
}

/** A course kept by name, to sail again: Expedition's route database. */
export interface SavedRoute {
  id: string
  name: string
  marks: Array<Pick<Mark, 'name' | 'position' | 'roundTo'>>
}

/** The most channels one box alternates between (Expedition's limit). */
export const MAX_ALTERNATING = 10

/**
 * What the boxes start as: things a navigator glances at that the fixed Race tiles
 * do not already show, so the defaults never repeat the screen they sit on.
 */
export const DEFAULT_NUMBER_BOXES: NumberBox[] = [
  { id: 'nb-1', channels: ['cog'], size: 'md' },
  { id: 'nb-2', channels: ['latitude', 'longtitude'], size: 'md' },
  { id: 'nb-3', channels: ['start-time-to-gun'], size: 'md' },
  { id: 'nb-4', channels: ['current-set', 'current-drift'], size: 'md' },
  { id: 'nb-5', channels: ['time'], size: 'md' },
  { id: 'nb-6', channels: ['magnetic-variation'], size: 'md' },
]

export interface Settings {
  /** Display units for lengths (depth, draft, line). Speeds stay in knots. */
  units: 'metric' | 'imperial'
  northRef: 'true' | 'magnetic'
  /** Simulation replaces the GPS feed. */
  simulate: boolean
  keepAwake: boolean
  /**
   * The first-launch not-for-navigation notice has been accepted. False by
   * default, so an install saved before the notice existed is asked once too.
   */
  acceptedNotForNavigation: boolean
}

interface AppState {
  tab: Tab
  setTab(t: Tab): void
  /** What the nav-station layout shows in its panel and its chart. */
  navPanel: PanelTab
  navChart: ChartTab
  setNav(patch: Partial<{ navPanel: PanelTab; navChart: ChartTab }>): void

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
  /** Rename, move, or change the rounding side of one mark. */
  updateMark(id: string, patch: Partial<Pick<Mark, 'name' | 'position' | 'roundTo'>>): void
  /** Move a mark one place earlier (-1) or later (+1) in the course. */
  moveMark(id: string, by: -1 | 1): void
  /**
   * Man overboard: a MOB mark at `at`, stamped with the time and made the active
   * mark, so every bearing and range on screen points back at the person.
   */
  dropMob(at: LatLon): void
  /** Remove every mark, keeping the pinged start line and the gun time. */
  clearMarks(): void
  /** Reset the whole course, start line and gun time included. */
  clearCourse(): void
  activeMarkIndex: number
  setActiveMark(i: number): void
  /**
   * Where Reset XTE was pressed, or null to measure from the previous mark (or
   * the line). It belongs to one leg, so changing the active mark or the marks
   * clears it.
   */
  xteOrigin: LatLon | null
  resetXte(at: LatLon | null): void

  state: BoatState | null
  setBoatState(s: BoatState | null): void
  gpsError: string | null
  setGpsError(e: string | null): void

  wind: WindEstimate | null
  setWind(w: WindEstimate | null): void
  windError: string | null
  setWindError(error: string | null): void
  manualWind: { twd: Degrees; tws: Knots }
  /**
   * When a person last set the manual wind. Null means nobody has, and then there
   * is no manual wind at all: `manualWind` holds a placeholder, and a placeholder
   * presented as the wind puts a confident favoured end on the Start tab that
   * nothing measured.
   */
  manualWindSetAt: Millis | null
  setManualWind(twd: Degrees, tws: Knots): void
  /** The wind sheet: opened from the top-bar chip on any tab, and from Start. */
  windSheetOpen: boolean
  setWindSheetOpen(open: boolean): void
  /**
   * Whether the screen is actually being kept awake. `unavailable` covers both a
   * browser with no Wake Lock API and a request it refused; either way a screen
   * that sleeps mid-sequence takes the countdown with it.
   */
  wakeLock: 'held' | 'unavailable' | 'off'
  setWakeLock(s: 'held' | 'unavailable' | 'off'): void
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

  /**
   * A planned start for routing, picked on the chart. Null routes from the live
   * fix. A route belongs to its start, so changing it drops the route.
   */
  routeStart: LatLon | null
  setRouteStart(at: LatLon | null): void

  routes: SavedRoute[]
  saveRoute(name: string): void
  /** Make a saved route the course: its marks, in order, the first one active. */
  loadRoute(id: string): void
  deleteRoute(id: string): void
  /** Sail the course the other way round: marks reversed, sides of rounding kept. */
  reverseCourse(): void

  library: LibraryMark[]
  /** File marks under a folder, e.g. from a GPX import or a course being saved. */
  addToLibrary(folder: string, marks: Array<{ name: string; position: LatLon }>): void
  removeFromLibrary(ids: string[]): void

  numberBoxes: NumberBox[]
  addNumberBox(channelId: string): void
  updateNumberBox(id: string, patch: Partial<Omit<NumberBox, 'id'>>): void
  removeNumberBox(id: string): void

  /** Expedition's optimal-routing options: corrections, limits and resolution. */
  routeSettings: RouteSettings
  updateRouteSettings(patch: Partial<RouteSettings>): void

  route: RouteResult | null
  routing: boolean
  routeError: string | null
  setRoute(r: RouteResult | null): void
  setRouting(b: boolean): void
  setRouteError(e: string | null): void

  settings: Settings
  updateSettings(patch: Partial<Settings>): void

  /**
   * Apply a configuration file (src/lib/config.ts). Nested objects merge the way a
   * reload merges them, so a file from an older version leaves newer fields alone.
   * Anything the file changes about the course drops the route.
   */
  applyConfig(cfg: Partial<Pick<AppState,
    'boat' | 'polarId' | 'polar' | 'course' | 'settings' | 'routeSettings' |
    'numberBoxes' | 'manualWind' | 'navPanel' | 'navChart'>>): void
}

/**
 * The most track points kept, oldest dropped first: about five and a half hours
 * at one fix a second. The saved copy for reloads is capped the same
 * (trackPersistence.ts).
 */
export const MAX_TRACK_POINTS = 20_000

export const DEFAULT_SETTINGS: Settings = {
  units: 'metric',
  northRef: 'true',
  simulate: false,
  keepAwake: true,
  acceptedNotForNavigation: false,
}

export function mergePersistedState(
  persisted: unknown,
  current: AppState,
): AppState {
  const p = (persisted ?? {}) as Partial<AppState>
  const c = current
  return {
    ...c,
    ...p,
    boat: { ...c.boat, ...p.boat },
    course: {
      ...c.course,
      ...p.course,
      startLine: { ...c.course.startLine, ...p.course?.startLine },
    },
    settings: { ...c.settings, ...p.settings },
    routeSettings: { ...c.routeSettings, ...p.routeSettings },
  }
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
const COURSE_CHANGED = { route: null, routeError: null, xteOrigin: null } as const

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      tab: 'start',
      setTab: (t) => set({ tab: t }),
      navPanel: 'race',
      navChart: 'route',
      setNav: (patch) => set(patch),

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
      updateMark: (id, patch) => {
        const { course } = get()
        set({
          // A mark that moved is a different course; a rename is not.
          ...(patch.position ? COURSE_CHANGED : {}),
          course: {
            ...course,
            marks: course.marks.map((m) => (m.id === id ? { ...m, ...patch } : m)),
          },
        })
      },
      moveMark: (id, by) => {
        const { course, activeMarkIndex } = get()
        const at = course.marks.findIndex((m) => m.id === id)
        const to = at + by
        if (at < 0 || to < 0 || to >= course.marks.length) return
        const marks = course.marks.slice()
        ;[marks[at], marks[to]] = [marks[to], marks[at]]
        // The active pointer follows the mark it was on.
        const active =
          activeMarkIndex === at ? to : activeMarkIndex === to ? at : activeMarkIndex
        set({ ...COURSE_CHANGED, course: { ...course, marks }, activeMarkIndex: active })
      },
      /*
       * What CLEAR on the Race tab does. The start line and the gun time belong to
       * the start, not to the marks: a sailor clearing old marks mid-sequence must
       * keep the line they pinged and the countdown running on it.
       */
      dropMob: (at) => {
        const marks = get().course.marks
        set({
          ...COURSE_CHANGED,
          course: {
            ...get().course,
            marks: [
              ...marks,
              {
                id: `mob-${Date.now()}-${++markSeq}`,
                name: 'MOB',
                position: at,
                roundTo: 'port',
                mobAt: Date.now(),
              },
            ],
          },
          activeMarkIndex: marks.length,
        })
      },
      clearMarks: () =>
        set({ ...COURSE_CHANGED, course: { ...get().course, marks: [] }, activeMarkIndex: 0 }),
      clearCourse: () => set({ ...COURSE_CHANGED, course: EMPTY_COURSE, activeMarkIndex: 0 }),
      activeMarkIndex: 0,
      setActiveMark: (i) =>
        set(i === get().activeMarkIndex ? { activeMarkIndex: i } : { activeMarkIndex: i, xteOrigin: null }),
      xteOrigin: null,
      resetXte: (at) => set({ xteOrigin: at }),

      state: null,
      setBoatState: (s) => set({ state: s }),
      gpsError: null,
      setGpsError: (e) => set({ gpsError: e }),

      wind: null,
      setWind: (w) => set({ wind: w }),
      windError: null,
      setWindError: (windError) => set({ windError }),
      manualWind: { twd: 270, tws: 12 },
      manualWindSetAt: null,
      setManualWind: (twd, tws) => set({ manualWind: { twd, tws }, manualWindSetAt: Date.now() }),
      windSheetOpen: false,
      setWindSheetOpen: (open) => set({ windSheetOpen: open }),
      wakeLock: 'off',
      setWakeLock: (s) => set({ wakeLock: s }),
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
        const next = t.length >= MAX_TRACK_POINTS ? t.slice(1) : t.slice()
        next.push(p)
        set({ track: next })
      },
      clearTrack: () => set({ track: [] }),

      routes: [],
      saveRoute: (name) =>
        set({
          routes: [
            ...get().routes,
            {
              id: `rt-${Date.now()}-${++markSeq}`,
              name: name.trim() || `Route ${get().routes.length + 1}`,
              marks: get().course.marks.map((m) => ({ name: m.name, position: m.position, roundTo: m.roundTo })),
            },
          ],
        }),
      loadRoute: (id) => {
        const r = get().routes.find((x) => x.id === id)
        if (!r) return
        set({
          ...COURSE_CHANGED,
          course: {
            ...get().course,
            name: r.name,
            marks: r.marks.map((m) => ({ ...m, id: `m${++markSeq}-${Date.now()}` })),
          },
          activeMarkIndex: 0,
        })
      },
      deleteRoute: (id) => set({ routes: get().routes.filter((r) => r.id !== id) }),
      reverseCourse: () => {
        const { course } = get()
        if (course.marks.length < 2) return
        set({ ...COURSE_CHANGED, course: { ...course, marks: [...course.marks].reverse() }, activeMarkIndex: 0 })
      },

      library: [],
      addToLibrary: (folder, marks) =>
        set({
          library: [
            ...get().library,
            ...marks.map((m) => ({
              id: `lib-${Date.now()}-${++markSeq}`,
              name: m.name,
              position: m.position,
              folder: folder.trim() || 'Marks',
            })),
          ],
        }),
      removeFromLibrary: (ids) => {
        const drop = new Set(ids)
        set({ library: get().library.filter((m) => !drop.has(m.id)) })
      },

      numberBoxes: DEFAULT_NUMBER_BOXES.map((b) => ({ ...b, channels: [...b.channels] })),
      addNumberBox: (channelId) =>
        set({
          numberBoxes: [
            ...get().numberBoxes,
            { id: `nb-${Date.now()}-${++markSeq}`, channels: [channelId], size: 'md' },
          ],
        }),
      updateNumberBox: (id, patch) =>
        set({
          numberBoxes: get().numberBoxes.map((b) =>
            b.id !== id
              ? b
              : {
                  ...b,
                  ...patch,
                  // Never empty, never more than Expedition allows.
                  channels: (patch.channels ?? b.channels).slice(0, MAX_ALTERNATING).length
                    ? (patch.channels ?? b.channels).slice(0, MAX_ALTERNATING)
                    : b.channels,
                },
          ),
        }),
      removeNumberBox: (id) => set({ numberBoxes: get().numberBoxes.filter((b) => b.id !== id) }),

      routeStart: null,
      setRouteStart: (at) => set({ routeStart: at, route: null, routeError: null }),

      routeSettings: { ...DEFAULT_ROUTE_SETTINGS },
      updateRouteSettings: (patch) =>
        set({ routeSettings: { ...get().routeSettings, ...patch } }),

      route: null,
      routing: false,
      routeError: null,
      setRoute: (r) => set({ route: r }),
      setRouting: (b) => set({ routing: b }),
      setRouteError: (e) => set({ routeError: e }),

      settings: { ...DEFAULT_SETTINGS },
      updateSettings: (patch) =>
        set({ settings: { ...get().settings, ...patch } }),

      applyConfig: (cfg) => {
        const merged = mergePersistedState(cfg, get())
        set({
          boat: merged.boat,
          course: merged.course,
          settings: merged.settings,
          routeSettings: merged.routeSettings,
          ...(cfg.polarId != null ? { polarId: cfg.polarId, polar: cfg.polar ?? null } : {}),
          ...(cfg.numberBoxes ? { numberBoxes: cfg.numberBoxes } : {}),
          ...(cfg.manualWind ? { manualWind: cfg.manualWind, manualWindSetAt: Date.now() } : {}),
          ...(cfg.navPanel ? { navPanel: cfg.navPanel } : {}),
          ...(cfg.navChart ? { navChart: cfg.navChart } : {}),
          ...(cfg.course ? { ...COURSE_CHANGED, activeMarkIndex: 0 } : {}),
        })
      },
    }),
    {
      name: 'newjourney.v1',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Live sensor data and computed results are deliberately not persisted.
      partialize: (s) => ({
        boat: s.boat,
        polarId: s.polarId,
        /*
         * An imported polar is the only copy there is, so it is kept. A built-in
         * one is not: it reloads from the library by id (App.tsx), so a corrected
         * class polar reaches everyone who picked it. Without this, a reload found
         * `polarId: 'custom'` with no table, and App quietly swapped in the J/70.
         */
        polar: s.polarId === 'custom' ? s.polar : null,
        course: s.course,
        manualWind: s.manualWind,
        manualWindSetAt: s.manualWindSetAt,
        windMode: s.windMode,
        settings: s.settings,
        routeSettings: s.routeSettings,
        routeStart: s.routeStart,
        numberBoxes: s.numberBoxes,
        library: s.library,
        routes: s.routes,
        navPanel: s.navPanel,
        navChart: s.navChart,
        activeMarkIndex: s.activeMarkIndex,
        xteOrigin: s.xteOrigin,
        // A recording that was on survives a reload too: a phone that drops the app
        // mid-race must not come back with the track stopped and nothing said.
        recording: s.recording,
      }),
      merge: mergePersistedState,
    },
  ),
)
