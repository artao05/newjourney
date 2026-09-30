/**
 * Single app store. Deliberately small: this app's complexity lives in
 * `src/lib`, which is pure and testable. The store holds only what the UI
 * needs to render and what must survive a reload.
 */

import type { ChartMotion, ChartOrientation } from '@/lib/chartView'
import type { ChartOffset } from '@/lib/charts/georef'
import { bearing, distance, midpoint } from '@/lib/geo'
import { angdiff, wrap360 } from '@/lib/angles'
import type { AdvanceMode } from '@/lib/legsOnChart'
import { DEFAULT_CHANNELS_OUT, type ChannelsOutSettings } from '@/lib/api/channelsOut'
import { create } from 'zustand'
import type { ColourMode } from '@/lib/maplayers/colormap'
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
import { DEFAULT_ROUTE_SETTINGS, nonDefaultLabels, type RouteSettings } from '@/lib/routing/settings'
import type { SailChart } from '@/lib/sailchart'
import { NO_WHAT_IF, type WhatIf } from '@/lib/whatif'
import type { HandicapSystem } from '@/lib/handicap'
import type { Reading } from '@/lib/instruments/nmea0183'
import { DEFAULT_SIGNALK_URL, type SignalKStatus } from '@/lib/instruments/signalk'
import { DEFAULT_PIPELINE, type Derived, type PipelineSettings } from '@/lib/instruments/pipeline'
import { NO_CALIBRATION, type Calibration } from '@/lib/instruments/calibration'
import type { PhoneOrientation } from '@/lib/instruments/orientation'
import type { AlarmRule, AlarmState } from '@/lib/alarms/engine'
import type { MemberRoute } from '@/lib/routing/ensemble'

export type Tab = 'start' | 'race' | 'weather' | 'route' | 'strip' | 'setup'
/** The nav station's two tab sets: panels on the left, charts in the middle. */
export type PanelTab = 'start' | 'race' | 'setup'
export type ChartTab = 'route' | 'weather' | 'strip'

/**
 * A configurable number box: one channel, or up to ten that alternate, as
 * Expedition's alternating boxes do.
 */
export interface NumberBox {
  id: string
  /** Channel ids from src/lib/channels/catalogue.ts. The first is shown alone. */
  channels: string[]
  size: 'sm' | 'md' | 'lg'
  /** Seconds to damp over (a mean, circular for angles); 0 or absent shows the value as it comes. */
  dampS?: number
  /** Decimal places for a plain number; absent for the channel's own. */
  decimals?: number | null
  /**
   * By situation: channels are then upwind, reaching, downwind and (if a fourth)
   * before the start, the one shown picked from the point of sail.
   */
  situation?: boolean
  /** Degrees past the target TWA at which the reaching channel takes over. */
  reachBandDeg?: number
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

/**
 * An optimised route kept for comparison: its track and times, and the settings
 * it was run with, but not its isochrones, which are most of its size.
 */
export interface KeptRoute {
  id: string
  at: Millis
  track: LatLon[]
  elapsedS: number | null
  etaMs: Millis | null
  settings: string[]
}

/** How many earlier routes are kept to compare with. */
export const MAX_KEPT_ROUTES = 5

/** Something that happened, on the log's timeline: a note, a sail change, a ping, the gun. */
export interface LogEvent {
  id: string
  t: Millis
  kind: 'note' | 'sail' | 'ping' | 'gun'
  text: string
}

/** A sail or speed test: a wanded span's means, with what was up and what was said. */
export interface SailTest {
  id: string
  day: string
  from: Millis
  to: Millis
  sails: string
  note: string
  means: Record<string, number>
}

/** The most events and tests kept; the oldest go first. */
export const MAX_EVENTS = 2000
export const MAX_TESTS = 500

/** Where a replay is: the day, the play time within it, and how it is running. */
export interface Playback {
  day: string
  t: Millis
  start: Millis
  end: Millis
  playing: boolean
  speed: number
}

/**
 * A boat in the fleet: Expedition's boats list, as the handicap calculator uses it.
 * One boat is the reference (normally us) that the others are compared with.
 */
export interface FleetBoat {
  id: string
  name: string
  /** TCF for time on time, seconds a mile for time on distance. */
  rating: number
  /** Her own start, for a staggered start; null means the gun. */
  startAt: Millis | null
  /** When she rounded or finished: the moment the calculator compares. */
  eventAt: Millis | null
  reference: boolean
  /** Her polar: a class from the library by id, 'navigation' for ours, or none. */
  polarId?: string | null
  /** How she is drawn on the chart and in the lists. */
  colour?: string
  lengthM?: number | null
  /** What AIS and the trackers know her by. */
  mmsi?: number | null
  sailNumber?: string
  trackerId?: string
}

/** Colours for the fleet, far enough apart to tell on a chart at night. */
export const FLEET_COLOURS = ['#ff8a65', '#4fc3f7', '#aed581', '#ba68c8', '#ffd54f', '#4db6ac', '#f06292', '#90a4ae', '#ffb74d', '#7986cb']

/**
 * A race note: text pinned to the chart as a point, a line or an area, as
 * Expedition's race notes are. An area can also be something the router must
 * avoid (a traffic scheme, a no-go zone in the sailing instructions), or water
 * where the boat is slower by a percentage (weed, a known foul tide).
 */
export interface RaceNote {
  id: string
  kind: 'point' | 'line' | 'area'
  points: LatLon[]
  text: string
  /** Areas only: routes must not enter it. */
  avoid: boolean
  /** Areas only: boat speed inside it, as a percentage of the polar. Null = unchanged. */
  speedPct: number | null
}

/** The fewest taps each kind of note needs. */
export const NOTE_MIN_POINTS: Record<RaceNote['kind'], number> = { point: 1, line: 2, area: 3 }

/** A course kept by name, to sail again: Expedition's route database. */
export interface SavedRoute {
  id: string
  name: string
  marks: Array<Pick<Mark, 'name' | 'position' | 'roundTo'>>
}

/** Which approaches count toward time to line: Expedition takes the quickest ticked. */
export interface StartApproaches {
  ends: boolean
  gps: boolean
  reach: boolean
  port: boolean
  starboard: boolean
}

export const DEFAULT_APPROACHES: StartApproaches = { ends: true, gps: true, reach: true, port: true, starboard: true }

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

/** One kind of contour on the Weather chart: whether it is drawn, its step and its bold level. */
export interface ContourSetting {
  on: boolean
  step: number
  bold: number | null
  /** Line width in pixels; the bold level is drawn at twice this. */
  width?: number
}
export type ContourKind = 'isobar' | 'isotach' | 'rain'

export const DEFAULT_CONTOURS: Record<ContourKind, ContourSetting> = {
  isobar: { on: false, step: 4, bold: 1012 },
  isotach: { on: false, step: 5, bold: 20 },
  rain: { on: false, step: 0.5, bold: null },
}

export interface Settings {
  /** Contour lines on the Weather chart. */
  contours: Record<ContourKind, ContourSetting>
  /** The timeline's ‹ › step in minutes, or null for the forecast's own steps. */
  weatherStepMin: number | null
  /** How each Weather layer is coloured, by layer id. Absent is the default ramp. */
  displayModes: Record<string, { mode: ColourMode; colour: string }>
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
  /** What is up on the Route chart: north, the active leg, or the boat's head. */
  chartOrientation: ChartOrientation
  /** What the Route chart keeps in view as the boat moves. */
  chartMotion: ChartMotion
  /** Our own charts (ENC, raster) moved to line up with GPS where a chart is off. */
  chartOffset: ChartOffset
  /** The channels sent out over a WebSocket (Setup → Channels out). */
  channelsOut: ChannelsOutSettings
  /** The whole app red on black at night, to keep night vision. */
  palette: 'normal' | 'night'
  /** Move to the next mark by itself: inside the mark's range, across its bisector, both, or not. */
  autoAdvance: AdvanceMode
  /** The optimal route's line and the course marks on the Route chart. */
  routeColour: string
  markColour: string
  /** How many earlier routes are kept to compare against. */
  keepRoutes: number
  /** The Weather chart's nine display presets; null for an empty slot. */
  weatherPresets: Array<WeatherPreset | null>
  /** Chart label size, as a multiple of the usual. */
  chartTextScale: number
  /** The layout locked: number boxes cannot be edited, added or removed by a stray tap. */
  layoutLocked: boolean
  /** Named layouts: the number boxes and the nav station's panes. */
  layouts: Array<{ name: string; numberBoxes: NumberBox[]; navPanel: PanelTab; navChart: ChartTab }>
}

/** What a Weather display preset keeps: the layer shown and how, and the overlays. */
export interface WeatherPreset {
  layerId: string
  mode: string
  windOverlay: boolean
  obsOn: boolean
  streamsOn: boolean
  radarOn: boolean
  satOn: boolean
  contours: Settings['contours']
  displayModes: Settings['displayModes']
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
  /**
   * Expedition's other polar roles. 'navigation' means the same table as the
   * navigation polar (`polar`), and anything else is a class id from the library.
   * The performance polar gives Polar BSP, Polar % and the targets. The start
   * polar drives the start numbers, and can be a de-powered one for downwind starts.
   */
  polarRoles: { performance: string; start: string }
  setPolarRole(role: 'performance' | 'start', id: string): void
  /** Which sail at which TWA and TWS (src/lib/sailchart.ts). */
  sailChart: SailChart | null
  setSailChart(chart: SailChart | null): void

  course: Course
  setStartEnd(which: 'port' | 'starboard', at: LatLon | null): void
  setGunTime(t: Millis | null): void
  addMark(name: string, at: LatLon): void
  /** A new mark at `index` in the course; the active mark stays the same one unless `makeActive`. */
  insertMark(name: string, at: LatLon, index: number, makeActive?: boolean): void
  /** Replace marks without resetting a previously pinged start line. */
  replaceMarks(marks: Array<Pick<Mark, 'name' | 'position'> & Partial<Pick<Mark, 'roundTo' | 'gate'>>>): void
  removeMark(id: string): void
  /** Rename, move, lock, or change the rounding side of one mark. A locked mark does not move. */
  updateMark(id: string, patch: Partial<Pick<Mark, 'name' | 'position' | 'roundTo' | 'locked' | 'rangeNm'>>): void
  /** Put the marks back as they were (undo and redo). */
  restoreMarks(marks: Mark[], activeMarkIndex: number): void
  /**
   * Pair a mark with another into one gate: the other goes, and this one
   * becomes the gate between them, its buoys left and right looking up
   * `upwindT` (true).
   */
  makeGate(id: string, otherId: string, upwindT: number): void
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
  /** While the wind is held, this is ignored and the held wind stays. */
  setWind(w: WindEstimate | null): void
  /**
   * Expedition's Hold wind and Hold current: freeze them through the pre-start,
   * when they are at their noisiest, and let them go at the gun if asked.
   */
  hold: { wind: boolean; current: boolean; releaseAtGun: boolean }
  startApproaches: StartApproaches
  setStartApproaches(a: StartApproaches): void
  /**
   * The start sequence: minutes between class starts, how many classes go
   * before ours (the timer rolls at each of their guns), and whether it sounds.
   */
  timer: { rollMin: number; classesBefore: number; sound: boolean }
  setTimer(patch: Partial<{ rollMin: number; classesBefore: number; sound: boolean }>): void
  holdWind(on: boolean): void
  holdCurrent(on: boolean): void
  setReleaseAtGun(on: boolean): void
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

  /** Expedition's What-if, laid over wind and current everywhere. Never persisted. */
  whatIf: WhatIf
  setWhatIf(patch: Partial<WhatIf>): void

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

  raceNotes: RaceNote[]
  /** Adds a note and returns its id, so the caller can open it for editing. */
  addRaceNote(note: Omit<RaceNote, 'id'>): string
  updateRaceNote(id: string, patch: Partial<Omit<RaceNote, 'id'>>): void
  removeRaceNote(id: string): void

  routes: SavedRoute[]
  saveRoute(name: string): void
  /** Make a saved route the course: its marks, in order, the first one active. */
  loadRoute(id: string): void
  deleteRoute(id: string): void
  /** Sail the course the other way round: marks reversed, sides of rounding kept. */
  reverseCourse(): void

  /** Where the instruments come from. Off, the phone's GPS is the source. */
  instruments: {
    signalKUrl: string
    signalKOn: boolean
    serialOn: boolean
    serialBaud: number
    serialFormat: 'nmea0183' | 'n2k'
  }
  /** Signal K and serial are one source or the other: turning one on turns the other off. */
  setInstruments(patch: Partial<AppState['instruments']>): void
  /** The latest instrument values, whatever sent them. Not persisted. */
  instrumentReading: Reading | null
  setInstrumentReading(r: Reading | null): void
  /** The pipeline's output: damped, corrected, true wind worked out. Not persisted. */
  instrumentDerived: Derived | null
  setInstrumentDerived(d: Derived | null): void
  pipeline: PipelineSettings
  setPipeline(patch: Partial<PipelineSettings>): void
  calibration: Calibration
  setCalibration(patch: Partial<Calibration>): void
  /** The port-tack polar, for a boat whose tacks differ; null when one polar does both. */
  polarPort: PolarTable | null
  setPolarPort(p: PolarTable | null): void
  /**
   * The phone's own tilt and compass. Heel is used whenever this is on; the
   * compass only with `trustCompass`, and only while the phone calls it good.
   */
  phoneSensors: { on: boolean; trustCompass: boolean }
  setPhoneSensors(patch: Partial<{ on: boolean; trustCompass: boolean }>): void
  phoneOrientation: PhoneOrientation | null
  setPhoneOrientation(p: PhoneOrientation | null): void
  /**
   * A logged day replaying: while it is set, the log is the boat, and the live
   * sources (GPS, simulator, instruments, the wind modes) stand aside.
   */
  playback: Playback | null
  setPlayback(p: Partial<Playback> | null): void
  /** The stripchart's panes, one channel each, and the minutes it shows. */
  strip: {
    panes: string[]
    spanMin: number
    /** Display rate, samples a second. */
    rateHz?: number
    /** A second channel drawn in a pane, by pane channel. */
    second?: Record<string, string>
    /** How each pane's value axis follows the data, by pane channel. */
    axes?: Record<string, 'auto' | 'roll' | 'shift'>
  }
  setStrip(patch: Partial<AppState['strip']>): void
  /** Alarm rules, kept; their states are this session's only. */
  alarms: AlarmRule[]
  addAlarm(rule: Omit<AlarmRule, 'id'>): void
  updateAlarm(id: string, patch: Partial<Omit<AlarmRule, 'id'>>): void
  removeAlarm(id: string): void
  /** Where the anchor went down, for the anchor-drag alarm. */
  anchor: LatLon | null
  setAnchor(at: LatLon | null): void
  alarmStates: Record<string, AlarmState>
  setAlarmStates(s: Record<string, AlarmState>): void
  acknowledgeAlarms(ids?: string[]): void
  events: LogEvent[]
  addEvent(kind: LogEvent['kind'], text: string, t?: Millis): void
  removeEvent(id: string): void
  sailTests: SailTest[]
  addSailTest(test: Omit<SailTest, 'id'>): void
  removeSailTest(id: string): void
  instrumentStatus: { status: SignalKStatus; detail: string | null; lastAt: Millis | null }
  setInstrumentStatus(s: Partial<{ status: SignalKStatus; detail: string | null; lastAt: Millis | null }>): void

  fleet: FleetBoat[]
  addFleetBoat(name: string, rating: number): void
  updateFleetBoat(id: string, patch: Partial<Omit<FleetBoat, 'id' | 'reference'>>): void
  removeFleetBoat(id: string): void
  /** Make one boat the reference; there is only ever one. */
  setReferenceBoat(id: string): void
  handicap: { system: HandicapSystem; distanceNm: number }
  setHandicap(h: Partial<{ system: HandicapSystem; distanceNm: number }>): void

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
  /** The settings the current route was run with, so a kept route says what it was. */
  routeSettingsAtLastRoute: RouteSettings | null

  route: RouteResult | null
  /** The course routed through each member of an ensemble forecast. Not persisted. */
  ensembleRoutes: MemberRoute[] | null
  setEnsembleRoutes(r: MemberRoute[] | null): void
  /** Earlier optimised routes, newest first: the first is "the previous one". */
  keptRoutes: KeptRoute[]
  clearKeptRoutes(): void
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
    'boat' | 'polarId' | 'polar' | 'polarRoles' | 'course' | 'settings' | 'routeSettings' |
    'numberBoxes' | 'manualWind' | 'navPanel' | 'navChart'>>): void
}

/**
 * The most track points kept, oldest dropped first: about five and a half hours
 * at one fix a second. The saved copy for reloads is capped the same
 * (trackPersistence.ts).
 */
export const MAX_TRACK_POINTS = 20_000

export const DEFAULT_SETTINGS: Settings = {
  contours: DEFAULT_CONTOURS,
  displayModes: {},
  weatherStepMin: null,
  units: 'metric',
  northRef: 'true',
  simulate: false,
  keepAwake: true,
  acceptedNotForNavigation: false,
  chartOrientation: 'north',
  chartMotion: 'free',
  chartOffset: { northM: 0, eastM: 0 },
  channelsOut: DEFAULT_CHANNELS_OUT,
  palette: 'normal',
  autoAdvance: 'off',
  routeColour: '#ff3ea5',
  markColour: '#ffd54a',
  keepRoutes: MAX_KEPT_ROUTES,
  weatherPresets: Array(9).fill(null),
  chartTextScale: 1,
  layoutLocked: false,
  layouts: [],
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
    settings: { ...c.settings, ...p.settings, contours: { ...c.settings.contours, ...p.settings?.contours } },
    routeSettings: { ...c.routeSettings, ...p.routeSettings },
    // Kept field by field, so a setting added later gets its default on an older save.
    instruments: { ...c.instruments, ...p.instruments },
    pipeline: { ...c.pipeline, ...p.pipeline },
    phoneSensors: { ...c.phoneSensors, ...p.phoneSensors },
    strip: { ...c.strip, ...p.strip },
    calibration: {
      ...c.calibration,
      ...p.calibration,
      offsets: { ...c.calibration.offsets, ...p.calibration?.offsets },
    },
    timer: { ...c.timer, ...p.timer },
    handicap: { ...c.handicap, ...p.handicap },
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
// Earlier routes go too: a route for other marks is no comparison.
const COURSE_CHANGED = {
  route: null,
  routeError: null,
  xteOrigin: null,
  keptRoutes: [] as KeptRoute[],
  ensembleRoutes: null,
} satisfies Partial<AppState>

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
      polarRoles: { performance: 'navigation', start: 'navigation' },
      setPolarRole: (role, id) => set({ polarRoles: { ...get().polarRoles, [role]: id } }),
      sailChart: null,
      setSailChart: (chart) => set({ sailChart: chart }),

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
      insertMark: (name, at, index, makeActive = false) => {
        const { course, activeMarkIndex } = get()
        const i = Math.max(0, Math.min(course.marks.length, Math.round(index)))
        const marks = [...course.marks.slice(0, i), { id: `m${++markSeq}-${Date.now()}`, name, position: at, roundTo: 'port' as const }, ...course.marks.slice(i)]
        const active = makeActive ? i : course.marks.length && i <= activeMarkIndex ? activeMarkIndex + 1 : activeMarkIndex
        set({ ...COURSE_CHANGED, course: { ...course, marks }, activeMarkIndex: active })
      },
      replaceMarks: (marks) =>
        set({
          ...COURSE_CHANGED,
          course: {
            ...get().course,
            marks: marks.map((m) => ({
              id: `m${++markSeq}-${Date.now()}`,
              name: m.name,
              position: m.position,
              roundTo: m.roundTo ?? 'port',
              ...(m.gate ? { gate: m.gate } : {}),
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
        if (at < 0 || course.marks[at].locked) return
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
        const m = course.marks.find((x) => x.id === id)
        // A locked mark stays put until it is unlocked.
        if (m?.locked && patch.position && patch.locked !== false) {
          const { position: _, ...rest } = patch
          patch = rest
          if (!Object.keys(patch).length) return
        }
        set({
          // A mark that moved is a different course; a rename is not.
          ...(patch.position ? COURSE_CHANGED : {}),
          course: {
            ...course,
            marks: course.marks.map((m) => (m.id === id ? { ...m, ...patch } : m)),
          },
        })
      },
      makeGate: (id, otherId, upwindT) => {
        const { course, activeMarkIndex } = get()
        const a = course.marks.find((m) => m.id === id)
        const b = course.marks.find((m) => m.id === otherId)
        if (!a || !b || a === b || a.gate || b.gate) return
        const mid = midpoint(a.position, b.position)
        // Looking upwind, the left buoy lies toward upwind − 90°.
        const leftIsA = Math.abs(angdiff(bearing(mid, a.position), wrap360(upwindT - 90))) < 90
        const gate = { widthM: distance(a.position, b.position) * 1852, left: leftIsA ? a.position : b.position, right: leftIsA ? b.position : a.position }
        const at = course.marks.indexOf(b)
        const marks = course.marks.filter((m) => m !== b).map((m) => (m === a ? { ...m, position: mid, roundTo: 'either' as const, gate } : m))
        set({ ...COURSE_CHANGED, course: { ...course, marks }, activeMarkIndex: at < activeMarkIndex ? activeMarkIndex - 1 : Math.min(activeMarkIndex, Math.max(0, marks.length - 1)) })
      },
      restoreMarks: (marks, active) =>
        set({
          ...COURSE_CHANGED,
          course: { ...get().course, marks },
          activeMarkIndex: marks.length ? Math.min(Math.max(0, active), marks.length - 1) : 0,
        }),
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
      setWind: (w) => {
        if (get().hold.wind) return
        set({ wind: w })
      },
      hold: { wind: false, current: false, releaseAtGun: true },
      startApproaches: { ...DEFAULT_APPROACHES },
      setStartApproaches: (a) => set({ startApproaches: a }),
      timer: { rollMin: 5, classesBefore: 0, sound: true },
      setTimer: (patch) => set({ timer: { ...get().timer, ...patch } }),
      holdWind: (on) => {
        const w = get().wind
        // Nothing to hold without a wind; letting go takes the next estimate.
        if (on && !w) return
        set({
          hold: { ...get().hold, wind: on },
          ...(on && w ? { wind: { ...w, source: 'held' as const } } : {}),
        })
      },
      holdCurrent: (on) => set({ hold: { ...get().hold, current: on && get().current != null } }),
      setReleaseAtGun: (on) => set({ hold: { ...get().hold, releaseAtGun: on } }),
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
      setCurrent: (c) => {
        if (get().hold.current) return
        set({ current: c })
      },

      whatIf: { ...NO_WHAT_IF },
      setWhatIf: (patch) => set({ whatIf: { ...get().whatIf, ...patch } }),

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

      raceNotes: [],
      addRaceNote: (note) => {
        const id = `note-${Date.now()}-${++markSeq}`
        // A note that can change a route drops the one computed without it.
        const steers = note.kind === 'area' && (note.avoid || note.speedPct != null)
        set({ ...(steers ? COURSE_CHANGED : {}), raceNotes: [...get().raceNotes, { ...note, id }] })
        return id
      },
      updateRaceNote: (id, patch) => {
        const steers = 'avoid' in patch || 'speedPct' in patch || 'points' in patch
        set({
          ...(steers ? COURSE_CHANGED : {}),
          raceNotes: get().raceNotes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
        })
      },
      removeRaceNote: (id) =>
        set({ ...COURSE_CHANGED, raceNotes: get().raceNotes.filter((n) => n.id !== id) }),

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

      instruments: { signalKUrl: DEFAULT_SIGNALK_URL, signalKOn: false, serialOn: false, serialBaud: 4800, serialFormat: 'nmea0183' },
      setInstruments: (patch) => {
        const next = { ...get().instruments, ...patch }
        if (patch.signalKOn) next.serialOn = false
        if (patch.serialOn) next.signalKOn = false
        set({ instruments: next })
      },
      instrumentReading: null,
      setInstrumentReading: (r) => set({ instrumentReading: r }),
      instrumentDerived: null,
      setInstrumentDerived: (d) => set({ instrumentDerived: d }),
      pipeline: { ...DEFAULT_PIPELINE },
      setPipeline: (patch) => set({ pipeline: { ...get().pipeline, ...patch } }),
      calibration: { ...NO_CALIBRATION, offsets: { ...NO_CALIBRATION.offsets } },
      polarPort: null,
      setPolarPort: (p) => set({ polarPort: p }),
      setCalibration: (patch) => set({ calibration: { ...get().calibration, ...patch } }),
      phoneSensors: { on: false, trustCompass: false },
      setPhoneSensors: (patch) => set({ phoneSensors: { ...get().phoneSensors, ...patch } }),
      phoneOrientation: null,
      setPhoneOrientation: (p) => set({ phoneOrientation: p }),
      strip: { panes: ['bsp', 'tws', 'twd', 'sog'], spanMin: 15 },
      setStrip: (patch) => set({ strip: { ...get().strip, ...patch } }),
      alarms: [],
      addAlarm: (rule) => set({ alarms: [...get().alarms, { ...rule, id: `alarm-${Date.now()}-${++markSeq}` }] }),
      updateAlarm: (id, patch) => set({ alarms: get().alarms.map((a) => (a.id === id ? { ...a, ...patch } : a)) }),
      removeAlarm: (id) => {
        const { [id]: _gone, ...rest } = get().alarmStates
        set({ alarms: get().alarms.filter((a) => a.id !== id), alarmStates: rest })
      },
      anchor: null,
      setAnchor: (at) => set({ anchor: at }),
      alarmStates: {},
      setAlarmStates: (s) => set({ alarmStates: s }),
      acknowledgeAlarms: (ids) => {
        const next = { ...get().alarmStates }
        for (const [id, st] of Object.entries(next)) if (st.active && (!ids || ids.includes(id))) next[id] = { ...st, acknowledged: true }
        set({ alarmStates: next })
      },
      events: [],
      addEvent: (kind, text, t = Date.now()) =>
        set({
          events: [...get().events, { id: `ev-${t}-${++markSeq}`, t, kind, text: text.trim() }]
            .sort((a, b) => a.t - b.t)
            .slice(-MAX_EVENTS),
        }),
      removeEvent: (id) => set({ events: get().events.filter((e) => e.id !== id) }),
      sailTests: [],
      addSailTest: (test) =>
        set({ sailTests: [...get().sailTests, { ...test, id: `test-${Date.now()}-${++markSeq}` }].slice(-MAX_TESTS) }),
      removeSailTest: (id) => set({ sailTests: get().sailTests.filter((x) => x.id !== id) }),
      playback: null,
      setPlayback: (p) => {
        if (p === null) return set({ playback: null })
        const cur = get().playback
        const next = { ...(cur ?? { day: '', t: 0, start: 0, end: 0, playing: false, speed: 1 }), ...p }
        set({ playback: { ...next, t: Math.max(next.start, Math.min(next.end, next.t)) } })
      },
      instrumentStatus: { status: 'off', detail: null, lastAt: null },
      setInstrumentStatus: (s) => set({ instrumentStatus: { ...get().instrumentStatus, ...s } }),

      fleet: [],
      addFleetBoat: (name, rating) => {
        const fleet = get().fleet
        set({
          fleet: [
            ...fleet,
            {
              id: `boat-${Date.now()}-${++markSeq}`,
              name: name.trim() || `Boat ${fleet.length + 1}`,
              rating,
              startAt: null,
              eventAt: null,
              reference: fleet.length === 0,
              colour: FLEET_COLOURS[fleet.length % FLEET_COLOURS.length],
              polarId: null,
            },
          ],
        })
      },
      updateFleetBoat: (id, patch) =>
        set({ fleet: get().fleet.map((b) => (b.id === id ? { ...b, ...patch } : b)) }),
      removeFleetBoat: (id) => {
        const fleet = get().fleet.filter((b) => b.id !== id)
        // Removing the reference hands it to the first boat left, so there is one.
        if (fleet.length && !fleet.some((b) => b.reference)) fleet[0] = { ...fleet[0], reference: true }
        set({ fleet })
      },
      setReferenceBoat: (id) => set({ fleet: get().fleet.map((b) => ({ ...b, reference: b.id === id })) }),
      handicap: { system: 'tot', distanceNm: 0 },
      setHandicap: (h) => set({ handicap: { ...get().handicap, ...h } }),

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
      setRoute: (r) => {
        const prev = get().route
        // A new optimised route keeps the one it replaces, to compare with.
        if (r?.ok && prev?.ok && prev !== r && prev.legs.length > 1) {
          const kept: KeptRoute = {
            id: `route-${Date.now()}-${++markSeq}`,
            at: Date.now(),
            track: prev.legs.map((l) => l.position),
            elapsedS: prev.elapsedS,
            etaMs: prev.etaMs,
            settings: nonDefaultLabels(get().routeSettingsAtLastRoute ?? get().routeSettings),
          }
          set({ route: r, keptRoutes: [kept, ...get().keptRoutes].slice(0, Math.max(1, get().settings.keepRoutes ?? MAX_KEPT_ROUTES)), routeSettingsAtLastRoute: get().routeSettings })
          return
        }
        set({ route: r, ...(r?.ok ? { routeSettingsAtLastRoute: get().routeSettings } : {}) })
      },
      keptRoutes: [],
      clearKeptRoutes: () => set({ keptRoutes: [] }),
      ensembleRoutes: null,
      setEnsembleRoutes: (r) => set({ ensembleRoutes: r }),
      routeSettingsAtLastRoute: null,
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
          ...(cfg.polarRoles ? { polarRoles: { ...get().polarRoles, ...cfg.polarRoles } } : {}),
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
        polarRoles: s.polarRoles,
        sailChart: s.sailChart,
        startApproaches: s.startApproaches,
        timer: s.timer,
        course: s.course,
        manualWind: s.manualWind,
        manualWindSetAt: s.manualWindSetAt,
        windMode: s.windMode,
        settings: s.settings,
        routeSettings: s.routeSettings,
        routeStart: s.routeStart,
        numberBoxes: s.numberBoxes,
        library: s.library,
        fleet: s.fleet,
        handicap: s.handicap,
        instruments: s.instruments,
        pipeline: s.pipeline,
        calibration: s.calibration,
        polarPort: s.polarPort,
        phoneSensors: s.phoneSensors,
        strip: s.strip,
        events: s.events,
        alarms: s.alarms,
        anchor: s.anchor,
        sailTests: s.sailTests,
        routes: s.routes,
        raceNotes: s.raceNotes,
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
