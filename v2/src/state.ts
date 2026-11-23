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
import { destination } from '@/lib/geo'
import type { RouteResult } from '@/lib/types'
import { analyze, type Analysis } from './coach/analyze'
import { aiStatus, chat, debrief, type AiStatus, type ChatTurn } from './coach/client'
import type { CoachContext, CoachDebrief } from './coach/debrief'
import { addAnswer, addNotes, learnFrom, loadProfile, saveProfile, type BoatProfile } from './coach/learn'
import { boatModel, BOATS } from './engine/boats'
import { defaultCourse, defaultCourseMarks, newId } from './engine/course'
import { demoForecast, forecastWind, liveForecast, type Forecast } from './engine/forecast'
import { planLegs, routeCourse, type LegPlan } from './engine/plan'
import type { Course, LatLon, Mark, MarkRole } from './engine/types'
import { World } from './engine/world'

export const HOME: LatLon = { lat: 43.585, lon: -70.16 } // off Cape Elizabeth, Casco Bay

export type Tab = 'plan' | 'course' | 'race' | 'sim' | 'coach'
export type Source = 'sim' | 'n2k' | 'gps'
export type ClickMode = null | 'addMark' | 'placeBoat'

// ------------------------------------------------------------ the world

function buildWorld(): World {
  const forecast = demoForecast(HOME)
  const twd = forecastWind(forecast, HOME, Date.now())?.twd ?? 220
  const marks = defaultCourseMarks(HOME, twd, 0.9)
  const course = defaultCourse(marks)
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
  routeBusy: number | null
  routeError: string | null
  legPlan: LegPlan[]
  showLaylines: boolean
  highlight: { tFrom: number; tTo: number; at: LatLon } | null
  theme: 'night' | 'day'
  forecastBusy: boolean
  forecastError: string | null
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
  routeBusy: null,
  routeError: null,
  legPlan: [],
  showLaylines: true,
  highlight: null,
  theme: 'night',
  forecastBusy: false,
  forecastError: null,
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
    void runDebrief()
  }
  if (now - lastBump > 120) {
    lastBump = now
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
    set({ tab, clickMode: null })
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
    const c = world.course
    world.setCourse(
      world.marks.filter((m) => m.id !== id),
      { pinId: c.pinId === id ? null : c.pinId, committeeId: c.committeeId === id ? null : c.committeeId, sequence: c.sequence.filter((x) => x !== id) },
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
    set({ seqMinutes: min, running: true, debrief: null, analysis: null, chat: [], highlight: null })
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
    bump()
  },
  sailCourse() {
    primeAudio()
    world.sailCourse()
    autoDebriefed = false
    set({ running: true, debrief: null, analysis: null, chat: [], highlight: null })
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
    set({ forecastBusy: true, forecastError: null })
    try {
      const span = 0.6
      const f = await liveForecast({ west: center.lon - span * 1.4, east: center.lon + span * 1.4, south: center.lat - span, north: center.lat + span })
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
  async calculateRoute() {
    const marks = world.sequence
    if (!marks.length) {
      set({ routeError: 'Add marks to the course first.' })
      return
    }
    set({ routeBusy: 0, routeError: null })
    const r = await routeCourse({ forecast: world.forecast, boat: boatModel(world.boatId), start: world.own.pos, marks, t0: world.t, onProgress: (f) => set({ routeBusy: f }) })
    set({ route: r.ok ? r : null, routeBusy: null, routeError: r.ok ? null : (r.error ?? 'No route found') })
  },
  clearRoute() {
    set({ route: null })
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

function setForecast(f: Forecast): void {
  world.setForecast(f)
  set({ forecastError: null })
  refreshPlan()
  bump()
}

function courseChanged(): void {
  set({ route: null })
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
