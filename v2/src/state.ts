/**
 * App state. The World (simulator) is a plain object that advances in an
 * animation-frame loop; React only re-renders on a ~8 Hz version tick. UI
 * choices live in a small zustand store.
 */
import { create } from 'zustand'
import { beep, primeAudio } from '@/lib/beep'
import { beepsBetween } from '@/lib/timer'
import { SignalKClient, type SignalKStatus } from '@/lib/instruments/signalk'
import type { Reading } from '@/lib/instruments/nmea0183'
import { courseFor, twaFrom } from '@/lib/angles'
import { destination, distance } from '@/lib/geo'
import type { BBox, RouteResult } from '@/lib/types'
import { analyze, type Analysis } from './coach/analyze'
import { aiStatus, chat, debrief, type AiStatus, type ChatTurn } from './coach/client'
import type { CoachContext, CoachDebrief } from './coach/debrief'
import { addAnswer, addNotes, learnFrom, loadProfile, saveProfile, type BoatProfile } from './coach/learn'
import { boatModel, BOATS } from './engine/boats'
import { defaultCourse, defaultCourseMarks, layoutCourse, lineBias, makeGate, newId, pointOnLine, removeGate, type LayoutId } from './engine/course'
import { demoForecast, demoForecastIn, forecastWind, liveForecast, type Forecast } from './engine/forecast'
import { planLegs, routeCourse, type LegPlan } from './engine/plan'
import type { Course, LatLon, Mark, MarkRole } from './engine/types'
import { World } from './engine/world'

export const HOME: LatLon = { lat: 43.585, lon: -70.16 } // off Cape Elizabeth, Casco Bay

export type Tab = 'plan' | 'course' | 'race' | 'sim' | 'coach'
export type Source = 'sim' | 'n2k' | 'gps'
export type ClickMode = null | 'addMark' | 'placeBoat'

/** What can go in the instrument panel: data boxes, plus the skipper's note and coach tips. */
export type FieldId = 'bsp' | 'twa' | 'tws' | 'twd' | 'hdg' | 'vmg' | 'awa' | 'polar' | 'intent' | 'tips'
export type FieldMode = 'setup' | 'race'

/**
 * What the optimal route is from and to:
 *  - course: the whole race, from the favoured end of the start line at the gun,
 *    around every mark to the finish (the plan before a race);
 *  - here: from the boat now, around the marks still to go (during a race, it
 *    recalculates every couple of minutes);
 *  - mark: from the boat now to one mark (a practice beat, a delivery).
 */
export type RouteMode = 'course' | 'here' | 'mark'
export interface RouteInfo {
  mode: RouteMode
  /** What the line on the map is, in words. */
  label: string
  from: string
  t0: number
  /** Each mark in the route with the time the route reaches it. */
  arrivals: Array<{ name: string; t: number | null }>
}
export type Fields = Record<FieldMode, FieldId[]>

export const ALL_FIELDS: FieldId[] = ['bsp', 'twa', 'tws', 'twd', 'hdg', 'vmg', 'awa', 'polar', 'intent', 'tips']
export const FIELD_PRESETS: Array<{ id: string; name: string; hint: string; fields: FieldId[] }> = [
  { id: 'beginner', name: 'Beginner', hint: "Speed, angle, wind and how you compare with the boat's best", fields: ['bsp', 'twa', 'tws', 'polar', 'tips'] },
  { id: 'start', name: 'Start', hint: 'What matters in the last minutes: speed, angle, wind direction and heading', fields: ['bsp', 'twa', 'twd', 'hdg'] },
  { id: 'upwind', name: 'Upwind', hint: 'Speed and angle against target, shifts and VMG', fields: ['bsp', 'twa', 'tws', 'twd', 'vmg', 'polar', 'tips'] },
  { id: 'all', name: 'Everything', hint: 'Every data box', fields: ['bsp', 'twa', 'tws', 'twd', 'hdg', 'vmg', 'awa', 'polar', 'intent', 'tips'] },
]
const DEFAULT_FIELDS: Fields = { setup: ALL_FIELDS, race: ['bsp', 'twa', 'tws', 'twd', 'vmg', 'polar', 'tips'] }
const FIELDS_KEY = 'nj2.fields'

function loadFields(): Fields {
  try {
    const raw = JSON.parse(localStorage.getItem(FIELDS_KEY) ?? 'null') as Partial<Fields> | null
    const clean = (v: unknown, d: FieldId[]) => (Array.isArray(v) ? v.filter((x): x is FieldId => ALL_FIELDS.includes(x as FieldId)) : d)
    return { setup: clean(raw?.setup, DEFAULT_FIELDS.setup), race: clean(raw?.race, DEFAULT_FIELDS.race) }
  } catch {
    return DEFAULT_FIELDS
  }
}

// ------------------------------------------------------------ the world

function buildWorld(): World {
  const forecast = demoForecast(HOME)
  const twd = forecastWind(forecast, HOME, Date.now())?.twd ?? 220
  const { marks, course } = layoutCourse('w2', HOME, twd, 0.9)
  const w = new World({ forecast, marks, course, boatId: 'j70', ownPos: destination(HOME, twd + 180, 0.3) })
  w.placeOwn(destination(HOME, twd + 180, 0.3))
  w.spawnFleet()
  return w
}

export const world = buildWorld()

// ------------------------------------------------------------ the store

export interface UiState {
  tab: Tab
  version: number
  running: boolean
  speed: number
  source: Source
  n2kUrl: string
  n2kStatus: SignalKStatus
  n2kDetail: string | null
  gpsStatus: string | null
  followClock: boolean
  viewT: number
  arrows: boolean
  colors: boolean
  clickMode: ClickMode
  selectedMarkId: string | null
  route: RouteResult | null
  routeInfo: RouteInfo | null
  routeMode: RouteMode
  routeMarkId: string | null
  routeBusy: number | null
  routeError: string | null
  legPlan: LegPlan[]
  showLaylines: boolean
  highlight: { tFrom: number; tTo: number; at: LatLon } | null
  theme: 'night' | 'day'
  forecastBusy: boolean
  forecastError: string | null
  /** The map has settled on an area the forecast doesn't cover. */
  forecastOutside: boolean
  fleetSize: number
  seqMinutes: 10 | 5 | 3
  analysis: Analysis | null
  context: CoachContext | null
  debrief: CoachDebrief | null
  debriefBusy: boolean
  debriefNote: string | null
  chat: ChatTurn[]
  chatBusy: boolean
  ai: AiStatus | null
  profile: BoatProfile
  answers: Record<string, string>
  flyTo: { at: LatLon; zoom?: number; n: number } | null
  helpOpen: boolean
  /** Race view: only the instruments and race data, no panels. */
  raceView: boolean
  /** Switch to the race view at the start and back (to the coach) at the finish. */
  raceViewAuto: boolean
  fields: Fields
  customizeOpen: boolean
}

export const useUi = create<UiState>(() => ({
  tab: 'sim',
  version: 0,
  running: true,
  speed: 4,
  source: 'sim',
  n2kUrl: 'ws://localhost:3000/signalk/v1/stream?subscribe=self',
  n2kStatus: 'off',
  n2kDetail: null,
  gpsStatus: null,
  followClock: true,
  viewT: world.t,
  arrows: true,
  colors: true,
  clickMode: null,
  selectedMarkId: null,
  route: null,
  routeInfo: null,
  routeMode: 'course',
  routeMarkId: null,
  routeBusy: null,
  routeError: null,
  legPlan: [],
  showLaylines: true,
  highlight: null,
  theme: 'night',
  forecastBusy: false,
  forecastError: null,
  forecastOutside: false,
  fleetSize: 6,
  seqMinutes: 5,
  analysis: null,
  context: null,
  debrief: null,
  debriefBusy: false,
  debriefNote: null,
  chat: [],
  chatBusy: false,
  ai: null,
  profile: loadProfile('j70'),
  answers: {},
  flyTo: null,
  helpOpen: false,
  raceView: false,
  raceViewAuto: true,
  fields: loadFields(),
  customizeOpen: false,
}))

const set = useUi.setState
const get = useUi.getState

export function bump(): void {
  set((s) => ({ version: s.version + 1, ...(s.followClock ? { viewT: world.t } : {}) }))
}

// ------------------------------------------------------------ the loop

let lastFrame = performance.now()
let lastBump = 0
let prevTtg: number | null = null
let autoDebriefed = false

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastFrame) / 1000)
  lastFrame = now
  const s = get()
  if (s.running && s.source === 'sim') {
    world.step(dt * s.speed)
  } else if (s.source !== 'sim') {
    // Real time: the own boat comes from the feed; the simulated fleet still sails.
    world.tickLive(Date.now())
  }
  const ttg = world.timeToGunS()
  if (ttg !== null && prevTtg !== null && s.speed <= 2) for (const k of beepsBetween(prevTtg, ttg)) beep(k)
  prevTtg = ttg
  if (!autoDebriefed && world.gunT !== null && world.own.phase === 'finished') {
    autoDebriefed = true
    if (s.raceView) set({ raceView: false, tab: 'coach' })
    void runDebrief()
  }
  if (now - lastBump > 120) {
    lastBump = now
    refreshLiveRoute()
    bump()
  }
  requestAnimationFrame(frame)
}

export function startLoop(): void {
  requestAnimationFrame(frame)
  void aiStatus().then((ai) => set({ ai }))
  refreshPlan()
}

// ------------------------------------------------------------ actions

export const actions = {
  setTab(tab: Tab) {
    set({ tab, clickMode: null, raceView: false })
  },
  setRaceView(on: boolean) {
    set({ raceView: on, clickMode: null })
  },
  setRaceViewAuto(on: boolean) {
    set({ raceViewAuto: on })
  },
  setCustomize(open: boolean) {
    set({ customizeOpen: open })
  },
  setFields(mode: FieldMode, ids: FieldId[]) {
    const fields = { ...get().fields, [mode]: ids }
    set({ fields })
    try {
      localStorage.setItem(FIELDS_KEY, JSON.stringify(fields))
    } catch {
      // Private mode or storage full: the choice lasts for this visit.
    }
  },
  toggleRun() {
    primeAudio()
    set((s) => ({ running: !s.running }))
  },
  setSpeed(speed: number) {
    set({ speed })
  },
  setTheme(theme: 'night' | 'day') {
    set({ theme })
    document.documentElement.dataset.theme = theme
  },
  scrub(t: number) {
    set({ viewT: t, followClock: false })
  },
  follow() {
    set({ followClock: true, viewT: world.t })
  },
  setClickMode(m: ClickMode) {
    set((s) => ({ clickMode: s.clickMode === m ? null : m }))
  },
  mapClick(p: LatLon) {
    const m = get().clickMode
    if (m === 'addMark') actions.addMark(p, 'mark')
    if (m === 'placeBoat') {
      world.placeOwn(p)
      world.stopRace()
      set({ clickMode: null })
      bump()
    }
  },

  // ----- marks and course
  addMark(p: LatLon, role: MarkRole, name?: string) {
    const n = world.marks.filter((m) => m.role === 'mark').length + 1
    const mark: Mark = { id: newId(), name: name ?? `Mark ${n}`, role, lat: p.lat, lon: p.lon }
    const marks = [...world.marks, mark]
    const course: Course = { ...world.course }
    if (role === 'pin') course.pinId = mark.id
    else if (role === 'committee') course.committeeId = mark.id
    else course.sequence = [...course.sequence, mark.id]
    world.setCourse(marks, course)
    set({ selectedMarkId: mark.id })
    courseChanged()
  },
  moveMark(id: string, p: LatLon) {
    world.setCourse(
      world.marks.map((m) => (m.id === id ? { ...m, lat: p.lat, lon: p.lon } : m)),
      world.course,
    )
    courseChanged()
  },
  renameMark(id: string, name: string) {
    world.setCourse(world.marks.map((m) => (m.id === id ? { ...m, name } : m)), world.course)
    bump()
  },
  deleteMark(id: string) {
    // Deleting one mark of a gate turns the gate back into the other mark.
    const g = world.course.gates?.find((x) => x.aId === id || x.bId === id)
    if (g) {
      const keep = g.aId === id ? g.bId : g.aId
      const c = world.course
      world.setCourse(world.marks.filter((m) => m.id !== id), { ...c, sequence: c.sequence.map((x) => (x === g.id ? keep : x)), gates: (c.gates ?? []).filter((x) => x.id !== g.id) })
      courseChanged()
      return
    }
    const c = world.course
    world.setCourse(
      world.marks.filter((m) => m.id !== id),
      { ...c, pinId: c.pinId === id ? null : c.pinId, committeeId: c.committeeId === id ? null : c.committeeId, sequence: c.sequence.filter((x) => x !== id) },
    )
    courseChanged()
  },
  setSequence(sequence: string[]) {
    world.setCourse(world.marks, { ...world.course, sequence })
    courseChanged()
  },
  addToSequence(id: string) {
    actions.setSequence([...world.course.sequence, id])
  },
  removeFromSequence(i: number) {
    actions.setSequence(world.course.sequence.filter((_x, k) => k !== i))
  },
  moveInSequence(i: number, d: -1 | 1) {
    const s = [...world.course.sequence]
    const j = i + d
    if (j < 0 || j >= s.length) return
    ;[s[i], s[j]] = [s[j]!, s[i]!]
    actions.setSequence(s)
  },
  /** One of the standard courses (W2, W4, triangle, trapezoid), square to the wind, around a point. */
  layLayout(id: LayoutId, center: LatLon, beatNm: number) {
    const twd = forecastWind(world.forecast, center, world.t)?.twd ?? world.own.twd
    const { marks, course } = layoutCourse(id, center, twd, beatNm)
    world.setCourse(marks, course)
    courseChanged()
    set({ flyTo: { at: center, zoom: beatNm > 1 ? 12.4 : 13.2, n: Date.now() } })
  },
  /** Turns a course mark into a gate (a second mark alongside it, across the wind). */
  makeGate(markId: string) {
    const m = world.marks.find((x) => x.id === markId)
    if (!m) return
    const twd = forecastWind(world.forecast, m, world.t)?.twd ?? world.own.twd
    const r = makeGate(world.marks, world.course, markId, twd)
    if (!r) return
    world.setCourse(r.marks, r.course)
    courseChanged()
  },
  removeGate(gateId: string) {
    const r = removeGate(world.marks, world.course, gateId)
    if (!r) return
    world.setCourse(r.marks, r.course)
    courseChanged()
  },
  /** Open: boats sail between the marks and round either. Closed: no sailing between them. */
  setGateOpen(gateId: string, open: boolean) {
    const c = world.course
    world.setCourse(world.marks, { ...c, gates: (c.gates ?? []).map((g) => (g.id === gateId ? { ...g, open } : g)) })
    courseChanged()
  },
  /** A fresh windward-leeward course, square to the wind, around a point. */
  layCourse(center: LatLon, beatNm: number) {
    const twd = forecastWind(world.forecast, center, world.t)?.twd ?? world.own.twd
    const marks = defaultCourseMarks(center, twd, beatNm)
    world.setCourse(marks, defaultCourse(marks))
    courseChanged()
    set({ flyTo: { at: center, zoom: 13.2, n: Date.now() } })
  },
  /** Ping a line end at the own boat's position. */
  pingEnd(role: 'pin' | 'committee') {
    const p = world.own.pos
    const id = role === 'pin' ? world.course.pinId : world.course.committeeId
    if (id) actions.moveMark(id, p)
    else actions.addMark(p, role, role === 'pin' ? 'Pin' : 'Committee')
  },

  // ----- race
  startSequence(min: 10 | 5 | 3) {
    primeAudio()
    world.spawnFleet(get().fleetSize)
    world.startSequence(min)
    autoDebriefed = false
    set((s) => ({ seqMinutes: min, running: true, debrief: null, analysis: null, chat: [], highlight: null, raceView: s.raceViewAuto || s.raceView }))
    bump()
  },
  setSeqMinutes(m: 10 | 5 | 3) {
    set({ seqMinutes: m })
  },
  syncGun() {
    world.syncGun()
    bump()
  },
  stopRace() {
    world.stopRace()
    set({ raceView: false })
    bump()
  },
  sailCourse() {
    primeAudio()
    world.sailCourse()
    autoDebriefed = false
    set((s) => ({ running: true, debrief: null, analysis: null, chat: [], highlight: null, raceView: s.raceViewAuto || s.raceView }))
    bump()
  },
  setFleetSize(n: number) {
    set({ fleetSize: n })
  },
  setMistakes(on: boolean) {
    world.setMistakes(on)
    bump()
  },
  setBoat(id: string) {
    world.setBoatClass(id)
    set({ profile: loadProfile(id) })
    refreshPlan()
    bump()
  },
  helm(deg: number) {
    world.helmSteer(deg)
    bump()
  },
  tack() {
    world.helmTack()
    bump()
  },
  autopilot() {
    world.autopilot()
    bump()
  },

  // ----- forecast and routing
  async loadLiveForecast(center: LatLon) {
    const span = 0.6
    await actions.loadLiveForecastIn({ west: center.lon - span * 1.4, east: center.lon + span * 1.4, south: center.lat - span, north: center.lat + span })
  },
  async loadLiveForecastIn(area: BBox) {
    set({ forecastBusy: true, forecastError: null })
    try {
      const f = await liveForecast(area)
      setForecast(f)
    } catch (e) {
      set({ forecastError: `Live forecast failed: ${e instanceof Error ? e.message : String(e)}. Still using the previous one.` })
    } finally {
      set({ forecastBusy: false })
    }
  },
  demoForecastHere(center: LatLon) {
    setForecast(demoForecast(center, world.t))
  },
  /**
   * The map stopped moving. If most of the view is outside the forecast, load
   * one for where we are looking: live if live is in use, otherwise the demo
   * moved here. Not during a sequence or race, when swapping the wind under
   * the fleet would be a surprise; the map shows a button instead.
   */
  viewSettled(view: BBox) {
    lastView = view
    clearTimeout(viewTimer)
    const outside = coveredShare(view, world.forecast.field.coverage().bbox) < 0.5
    if (outside !== get().forecastOutside) set({ forecastOutside: outside })
    if (!outside || get().forecastBusy) return
    const racing = world.own.phase === 'prestart' || world.own.phase === 'racing'
    if (racing) return
    viewTimer = setTimeout(() => actions.forecastForView(), 700)
  },
  forecastForView() {
    if (!lastView) return
    const area = forecastArea(lastView)
    set({ forecastOutside: false })
    if (world.forecast.source === 'live') void actions.loadLiveForecastIn(area)
    else setForecast(demoForecastIn(area, world.t))
  },
  setRouteMode(routeMode: RouteMode) {
    set({ routeMode, route: null, routeInfo: null, routeError: null })
  },
  setRouteMark(routeMarkId: string) {
    set({ routeMarkId, route: null, routeInfo: null })
  },
  async calculateRoute() {
    const s = get()
    const plan = routePlan(s.routeMode, s.routeMarkId, s.viewT)
    if (typeof plan === 'string') {
      set({ routeError: plan })
      return
    }
    set({ routeBusy: 0, routeError: null })
    const r = await routeCourse({ forecast: world.forecast, boat: boatModel(world.boatId), start: plan.start, marks: plan.marks, t0: plan.t0, onProgress: (f) => set({ routeBusy: f }) })
    lastRouteAt = performance.now()
    lastRouteLeg = world.own.leg
    set({
      route: r.ok ? r : null,
      routeInfo: r.ok ? { mode: s.routeMode, label: plan.label, from: plan.from, t0: plan.t0, arrivals: arrivals(r, plan.marks) } : null,
      routeBusy: null,
      routeError: r.ok ? null : (r.error ?? 'No route found'),
    })
  },
  clearRoute() {
    set({ route: null, routeInfo: null })
  },
  toggle(key: 'arrows' | 'colors' | 'showLaylines') {
    set((s) => ({ [key]: !s[key] }) as Partial<UiState>)
  },
  setHelp(open: boolean) {
    set({ helpOpen: open })
  },

  // ----- instruments (N2K via Signal K, or the phone's GPS)
  setSource(source: Source) {
    stopFeeds()
    set({ source })
    if (source === 'n2k') startSignalK()
    if (source === 'gps') startGps()
    if (source === 'sim') world.autopilot()
  },
  setN2kUrl(url: string) {
    set({ n2kUrl: url })
  },
  locateMe() {
    if (!navigator.geolocation) {
      set({ gpsStatus: 'This browser has no location service.' })
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) => set({ flyTo: { at: { lat: p.coords.latitude, lon: p.coords.longitude }, zoom: 13, n: Date.now() }, gpsStatus: null }),
      (e) => set({ gpsStatus: `Location unavailable: ${e.message}` }),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  },

  // ----- coach
  runDebrief: () => runDebrief(),
  focusFinding(tFrom: number, tTo: number, at: LatLon) {
    set({ highlight: { tFrom, tTo, at }, flyTo: { at, zoom: 14.5, n: Date.now() } })
  },
  answer(qid: string, text: string) {
    set((s) => ({ answers: { ...s.answers, [qid]: text } }))
  },
  async submitAnswers() {
    const s = get()
    const d = s.debrief
    if (!d) return
    let p = s.profile
    const turns: string[] = []
    for (const q of d.questions) {
      const a = s.answers[q.id]?.trim()
      if (!a) continue
      p = addAnswer(p, q.question, a)
      turns.push(`Q: ${q.question}\nA: ${a}`)
    }
    if (!turns.length) return
    saveProfile(p)
    set({ profile: p, answers: {} })
    await actions.ask(`Here are my answers to your questions:\n\n${turns.join('\n\n')}\n\nWhat does that change in your advice?`)
  },
  async ask(question: string) {
    const s = get()
    const history = [...s.chat, { role: 'user' as const, text: question }]
    set({ chat: history, chatBusy: true })
    const reply = await chat({ question, history: s.chat, context: s.context ? { ...s.context, profile: profileSlice(get().profile) } : null, analysis: s.analysis, useAi: !!s.ai?.ai })
    set({ chat: [...history, { role: 'assistant', text: reply }], chatBusy: false })
  },
  forgetBoat() {
    const p = { ...loadProfile(world.boatId), sessions: [], polarFactor: {}, tackLossM: null, tendencies: {}, answers: [], notes: [] }
    saveProfile(p)
    set({ profile: p })
  },
}

let lastView: BBox | null = null
let viewTimer: ReturnType<typeof setTimeout> | undefined

/**
 * What a reloaded forecast should cover: the view with a margin, plus the
 * course and your boat so the simulator never ends up with no wind. If they
 * are far apart (more than a few degrees), just the view.
 */
function forecastArea(view: BBox): BBox {
  const padX = Math.max(0.15, (view.east - view.west) * 0.25)
  const padY = Math.max(0.1, (view.north - view.south) * 0.25)
  const v = { west: view.west - padX, east: view.east + padX, south: view.south - padY, north: view.north + padY }
  const pts = [...world.marks, world.own.pos]
  const u = {
    west: Math.min(v.west, ...pts.map((p) => p.lon - 0.15)),
    east: Math.max(v.east, ...pts.map((p) => p.lon + 0.15)),
    south: Math.min(v.south, ...pts.map((p) => p.lat - 0.1)),
    north: Math.max(v.north, ...pts.map((p) => p.lat + 0.1)),
  }
  return u.east - u.west > 6 || u.north - u.south > 4 ? v : u
}

/** Share of the view's area (in degrees, near enough at racecourse scale) inside `cov`. */
function coveredShare(view: BBox, cov: BBox): number {
  const w = Math.max(0, Math.min(view.east, cov.east) - Math.max(view.west, cov.west))
  const h = Math.max(0, Math.min(view.north, cov.north) - Math.max(view.south, cov.south))
  const area = (view.east - view.west) * (view.north - view.south)
  return area > 0 ? (w * h) / area : 1
}

function setForecast(f: Forecast): void {
  world.setForecast(f)
  set({ forecastError: null })
  refreshPlan()
  bump()
}

// ------------------------------------------------------------ routes

let lastRouteAt = 0
let lastRouteLeg = -1

/** Where a route of each kind starts, when and through which marks; or why it can't. */
function routePlan(mode: RouteMode, markId: string | null, viewT: number): { start: LatLon; t0: number; marks: Mark[]; label: string; from: string } | string {
  const seq = world.sequence
  const own = world.own
  if (mode === 'mark') {
    // The list shows the first mark of the course until one is picked.
    const m = world.marks.find((x) => x.id === (markId ?? seq[0]?.id ?? world.marks[0]?.id))
    if (!m) return 'Choose the mark to route to.'
    return { start: own.pos, t0: world.t, marks: [m], label: `Route to ${m.name}`, from: 'your boat, now' }
  }
  if (!seq.length) return 'Add marks to the course first (Course tab).'
  if (mode === 'here') {
    const left = own.phase === 'racing' ? seq.slice(own.leg) : seq
    if (!left.length) return 'No marks left to sail: the race is over.'
    return { start: own.pos, t0: world.t, marks: left, label: 'Route from here to the finish', from: 'your boat, now' }
  }
  // Whole course: from the line at the gun. Before a sequence starts, the gun
  // is the time on the time bar, so a later start can be planned by dragging it.
  const t0 = world.gunT ?? viewT
  const ln = world.line
  if (!ln) return { start: own.pos, t0, marks: seq, label: 'Route for the whole course', from: 'your boat (no start line set)' }
  const mid = pointOnLine(ln, 0.5)
  const twd = forecastWind(world.forecast, mid, t0)?.twd ?? own.twd
  const bias = lineBias(ln, twd)
  // A boat length or two in from the favoured end, where a good start would be.
  const f = Math.abs(bias) < 2 ? 0.5 : bias > 0 ? 0.12 : 0.88
  const end = Math.abs(bias) < 2 ? 'the middle of the line (it is square)' : bias > 0 ? 'the pin end (favoured)' : 'the committee end (favoured)'
  return { start: pointOnLine(ln, f), t0, marks: seq, label: 'Route for the whole course', from: end }
}

/** When the route reaches each mark: the closest route point to it, in order. */
function arrivals(r: RouteResult, marks: Mark[]): RouteInfo['arrivals'] {
  let from = 0
  return marks.map((m) => {
    let best = -1
    let bestD = Infinity
    for (let i = from; i < r.legs.length; i++) {
      const d = distance(r.legs[i]!.position, m)
      if (d < bestD) {
        bestD = d
        best = i
      }
      // Once well past a close approach, this mark is done.
      if (bestD < 0.05 && d > bestD + 0.3) break
    }
    if (best < 0 || bestD > 0.25) return { name: m.name, t: null }
    from = best + 1
    return { name: m.name, t: r.legs[best]!.t }
  })
}

/** During a race, keep a "from here" route fresh: every 2 minutes and at each mark. */
function refreshLiveRoute(): void {
  const s = get()
  if (s.routeMode !== 'here' || !s.route || s.routeBusy !== null || world.own.phase !== 'racing') return
  const now = performance.now()
  const due = world.own.leg !== lastRouteLeg || (world.t - (s.routeInfo?.t0 ?? 0) > 120_000 && now - lastRouteAt > 3000)
  if (due) void actions.calculateRoute()
}

function courseChanged(): void {
  set({ route: null, routeInfo: null })
  refreshPlan()
  bump()
}

export function refreshPlan(): void {
  const line = world.line
  const start = line ? { lat: (line.pin.lat + line.committee.lat) / 2, lon: (line.pin.lon + line.committee.lon) / 2 } : world.own.pos
  set({ legPlan: planLegs({ forecast: world.forecast, boat: boatModel(world.boatId), start, marks: world.sequence, t0: world.gunT ?? world.t }) })
}

// ------------------------------------------------------------ coach

function profileSlice(p: BoatProfile): CoachContext['profile'] {
  const L = boatModel(world.boatId).preset.dims.loaM
  return {
    sessions: p.sessions.length,
    learnedPolarPct: Object.fromEntries(Object.entries(p.polarFactor).map(([k, v]) => [k, { up: Math.round(v.up * 100), down: Math.round(v.down * 100) }])),
    avgTackLossBoatLengths: p.tackLossM ? Math.round((p.tackLossM.mean / L) * 10) / 10 : null,
    recurringIssues: Object.entries(p.tendencies)
      .filter(([, n]) => (n ?? 0) >= 2)
      .map(([c]) => c as keyof typeof p.tendencies),
    previousAnswers: p.answers.slice(-10).map((a) => ({ question: a.question, answer: a.answer })),
    notes: p.notes.slice(-15),
  }
}

async function runDebrief(): Promise<void> {
  const model = boatModel(world.boatId)
  const L = model.preset.dims.loaM
  const fleet = world.boats.filter((b) => !b.own)
  const beats = Math.max(1, world.sequence.filter((_m, i) => i === 0 || world.sequence[i - 1]?.name === 'Leeward').length)
  const perBeat = fleet.map((b) => b.tacks / beats).sort((a, b) => a - b)
  const a = analyze({
    samples: world.samples,
    sequence: world.sequence,
    gunT: world.gunT,
    boatLengthM: L,
    fleetTacksPerBeat: perBeat.length ? perBeat[Math.floor(perBeat.length / 2)]! : null,
  })
  if (a.stats.durationS < 60) {
    set({ debriefNote: 'Not enough sailing logged yet: sail for at least a minute, then ask again.' })
    return
  }
  const standings = world.standings()
  const place = standings.findIndex((b) => b.own) + 1
  const gun = world.gunT
  const result = world.gunT !== null && fleet.length ? `Finished ${ordinal(place)} of ${standings.length}` : null
  const profileBefore = get().profile
  const context: CoachContext = {
    boat: { name: model.preset.name, lengthM: L, type: model.preset.dims.type },
    conditions: { avgTwsKn: round1(a.stats.avgTws), avgTwdDeg: Math.round(a.stats.avgTwd), forecast: world.forecast.label },
    race: {
      mode: gun !== null ? 'race' : world.own.crossedLineT !== null ? 'course' : 'free',
      sequenceMinutes: gun !== null ? world.seqLenS / 60 : null,
      legs: world.sequence.map((m) => m.name),
      durationMin: round1(a.stats.durationS / 60),
      result,
      fleet: fleet.map((b) => ({
        name: b.name,
        skill: b.skill.label,
        finishMin: b.finishedT && gun ? round1((b.finishedT - gun) / 60000) : null,
        tacks: b.tacks,
        startLateS: b.crossedLineT && gun ? Math.round((b.crossedLineT - gun) / 1000) : null,
      })),
    },
    analysis: {
      stats: a.stats,
      estimatedSecondsLost: Math.round(a.lostS),
      findings: a.findings.map((f) => ({ id: f.id, category: f.category, title: f.title, detail: f.detail, metric: f.metric, costS: Math.round(f.costS), atRaceMinute: round1((f.tFrom - (gun ?? world.samples[0]?.t ?? 0)) / 60000) })),
      manoeuvres: a.manoeuvres.map((m) => ({ kind: m.kind, atRaceMinute: round1((m.t - (gun ?? 0)) / 60000), lossBoatLengths: round1(m.lossM / L), recoverS: m.recoverS })),
    },
    profile: profileSlice(profileBefore),
  }
  const p = learnFrom(profileBefore, a, result ?? undefined)
  saveProfile(p)
  set({ analysis: a, context, profile: p, debriefBusy: true, debriefNote: null, tab: 'coach' })
  const r = await debrief({ analysis: a, context, profile: p, useAi: !!get().ai?.ai })
  const p2 = addNotes(get().profile, r.debrief.boat_notes)
  saveProfile(p2)
  set({ debrief: r.debrief, debriefNote: r.note, debriefBusy: false, profile: p2 })
}

const round1 = (x: number) => Math.round(x * 10) / 10
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!)
}

// ------------------------------------------------------------ feeds

let sk: SignalKClient | null = null
let gpsWatch: number | null = null

function stopFeeds(): void {
  sk?.stop()
  sk = null
  if (gpsWatch !== null) navigator.geolocation?.clearWatch(gpsWatch)
  gpsWatch = null
}

/** Apply an instrument reading to the own boat (NMEA 2000 through a Signal K server). */
function applyReading(r: Partial<Reading>): void {
  const b = world.own
  b.helm = 'manual'
  if (r.lat !== undefined && r.lon !== undefined) b.pos = { lat: r.lat, lon: r.lon }
  const hdg = r.headingTrue ?? r.cog
  if (hdg !== undefined) b.hdg = hdg
  const bsp = r.bsp ?? r.sog
  if (bsp !== undefined) b.bsp = bsp
  if (r.tws !== undefined) b.tws = r.tws
  if (r.twd !== undefined) b.twd = r.twd
  else if (r.twa !== undefined) b.twd = courseFor(b.hdg, -r.twa)
  if (r.awa !== undefined) b.awa = r.awa
  if (r.aws !== undefined) b.aws = r.aws
  b.twa = r.twa ?? twaFrom(b.hdg, b.twd)
  const tg = boatModel(b.boatId).lattice.targetsAt(b.tws)
  const upwind = Math.abs(b.twa) < 90
  b.targetTwa = upwind ? tg.upTwa : tg.downTwa
  b.targetBsp = upwind ? tg.upBsp : tg.downBsp
  b.polarBsp = boatModel(b.boatId).lattice.speed(b.tws, b.twa)
}

function startSignalK(): void {
  const url = get().n2kUrl
  sk = new SignalKClient(url, {
    onReading: applyReading,
    onStatus: (s, detail) => set({ n2kStatus: s, n2kDetail: detail ?? null }),
  })
  sk.start()
}

function startGps(): void {
  if (!navigator.geolocation) {
    set({ gpsStatus: 'This browser has no location service.' })
    return
  }
  gpsWatch = navigator.geolocation.watchPosition(
    (p) => {
      applyReading({
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        ...(p.coords.heading !== null && !Number.isNaN(p.coords.heading) ? { cog: p.coords.heading } : {}),
        ...(p.coords.speed !== null ? { sog: p.coords.speed * 1.94384 } : {}),
      })
      set({ gpsStatus: `GPS ±${Math.round(p.coords.accuracy)} m` })
    },
    (e) => set({ gpsStatus: `GPS: ${e.message}` }),
    { enableHighAccuracy: true },
  )
}

export { BOATS }
