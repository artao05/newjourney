/**
 * The simulated world: own boat, a fleet sending AIS, the wind they all sail
 * in, and the race clock. A virtual skipper drives each boat the way a crew
 * would: holds below the line, times the start, sails target angles, tacks on
 * headers and laylines, rounds marks. The learner profile on the own boat
 * makes scripted mistakes so the coach has something to talk about.
 *
 * Pure TypeScript with no React: the UI reads it, the tests drive it.
 */
import { angdiff, courseFor, twaFrom, wrap360 } from '@/lib/angles'
import { bearing, crossTrack, destination, distance } from '@/lib/geo'
import { trueToApparent } from '@/lib/wind'
import { boatModel } from './boats'
import { courseMarks, distToLine, fetches, legKind, pointOnLine, startLine, type Line } from './course'
import { localWind, type Forecast } from './forecast'
import type { Course, LapseKind, LatLon, LegKind, Mark, RaceEvent, Sample, SimBoat, Skill } from './types'

// ----------------------------------------------------------------- skills

const CLEAN: Omit<Skill, 'label' | 'lineSpot'> = {
  upwindTwaErr: 0,
  downwindTwaErr: 0,
  speedFactor: 1,
  headerTackDeg: 6,
  minTackIntervalS: 45,
  tackLossMult: 1,
  tackTimeMult: 1,
  overstandDeg: 1,
  startDelayS: 1,
  lapses: [],
}

export function proSkill(lineSpot: number, variation = 0): Skill {
  return {
    ...CLEAN,
    label: 'Pro',
    lineSpot,
    speedFactor: 0.99 - variation * 0.02,
    headerTackDeg: 6.5 + variation * 1.5,
    minTackIntervalS: 70,
    startDelayS: variation * 3,
  }
}

export function clubSkill(lineSpot: number, variation = 0): Skill {
  return {
    ...CLEAN,
    label: 'Club racer',
    lineSpot,
    upwindTwaErr: 2 + variation * 2,
    downwindTwaErr: -4 - variation * 4,
    speedFactor: 0.95 - variation * 0.02,
    headerTackDeg: 8,
    minTackIntervalS: 60,
    tackLossMult: 1.2,
    tackTimeMult: 1.15,
    overstandDeg: 3,
    startDelayS: 4 + variation * 4,
  }
}

/**
 * The learner: decent boat speed but a handful of habits a coach would spot.
 * Lapses are tied to legs (index into the course sequence) and seconds into
 * that leg, so they happen whatever the course length.
 */
export function learnerSkill(): Skill {
  return {
    ...CLEAN,
    label: 'Learner (makes mistakes)',
    lineSpot: 0.55,
    speedFactor: 0.97,
    headerTackDeg: 7,
    minTackIntervalS: 50,
    tackLossMult: 1.55,
    tackTimeMult: 1.35,
    overstandDeg: 1,
    startDelayS: 9,
    lapses: [
      { kind: 'foot', leg: 0, fromS: 40, toS: 260 },
      { kind: 'ignoreHeader', leg: 0, fromS: 260, toS: 99_999 },
      { kind: 'overstand', leg: 0, fromS: 0, toS: 99_999 },
      { kind: 'overtack', leg: 3, fromS: 20, toS: 400 },
      { kind: 'pinch', leg: 3, fromS: 400, toS: 560 },
    ],
  }
}

function lapseActive(b: SimBoat, kind: LapseKind, t: number): boolean {
  const s = (t - b.legStartT) / 1000
  return b.skill.lapses.some((l) => l.kind === kind && l.leg === b.leg && s >= l.fromS && s <= l.toS)
}

// ------------------------------------------------------------------ world

const FLEET: Array<{ name: string; color: string; pro: boolean; spot: number; v: number }> = [
  { name: 'Sea Smoke', color: '#f472b6', pro: true, spot: 0.12, v: 0 },
  { name: 'Blue Heron', color: '#60a5fa', pro: false, spot: 0.35, v: 0.3 },
  { name: 'Kestrel', color: '#fbbf24', pro: true, spot: 0.8, v: 0.5 },
  { name: 'Second Wind', color: '#a78bfa', pro: false, spot: 0.68, v: 0.8 },
  { name: 'Halcyon', color: '#34d399', pro: false, spot: 0.92, v: 0.1 },
  { name: 'Tern', color: '#fb923c', pro: true, spot: 0.25, v: 0.9 },
]

const TRACK_EVERY_MS = 4_000
const ROUND_NM = 0.028

export interface WorldInit {
  forecast: Forecast
  marks: Mark[]
  course: Course
  boatId: string
  ownPos: LatLon
  ownName?: string
  t?: number
}

function makeBoat(o: { id: string; name: string; mmsi: number; color: string; own: boolean; boatId: string; skill: Skill; pos: LatLon; hdg: number; t: number }): SimBoat {
  return {
    ...o,
    bsp: 0,
    twd: 0,
    tws: 0,
    twa: 0,
    aws: 0,
    awa: 0,
    targetBsp: 0,
    targetTwa: 0,
    polarBsp: 0,
    phase: 'free',
    leg: 0,
    manoeuvre: null,
    lastTackT: -1e12,
    meanTwd: NaN,
    helm: 'auto',
    intent: 'Waiting',
    crossedLineT: null,
    finishedT: null,
    ocs: false,
    tacks: 0,
    gybes: 0,
    track: [],
    sailedNm: 0,
    legStartT: o.t,
    legKind: null,
    committed: false,
    throttle: 0.3,
  }
}

export class World {
  t: number
  forecast: Forecast
  marks: Mark[]
  course: Course
  boatId: string
  boats: SimBoat[] = []
  events: RaceEvent[] = []
  samples: Sample[] = []
  gunT: number | null = null
  seqLenS = 300
  /** Whether the own boat makes the learner's mistakes. */
  mistakes = true
  private lastSampleT = -1e12
  private lastTrackT = new Map<string, number>()
  private prevLineNm = new Map<string, number>()

  constructor(init: WorldInit) {
    this.t = init.t ?? Date.now()
    this.forecast = init.forecast
    this.marks = init.marks
    this.course = init.course
    this.boatId = init.boatId
    this.boats.push(
      makeBoat({ id: 'own', name: init.ownName ?? 'My boat', mmsi: 0, color: '#22d3ee', own: true, boatId: init.boatId, skill: learnerSkill(), pos: init.ownPos, hdg: 0, t: this.t }),
    )
    this.prime()
  }

  get own(): SimBoat {
    return this.boats[0]!
  }

  get line(): Line | null {
    return startLine(this.marks, this.course)
  }

  get sequence(): Mark[] {
    return courseMarks(this.marks, this.course)
  }

  /** Fill each boat's wind so the instruments read something before the first step. */
  private prime(): void {
    for (const b of this.boats) this.sense(b)
  }

  setCourse(marks: Mark[], course: Course): void {
    this.marks = marks
    this.course = course
  }

  setForecast(f: Forecast): void {
    this.forecast = f
    this.prime()
  }

  setBoatClass(boatId: string): void {
    this.boatId = boatId
    for (const b of this.boats) b.boatId = boatId
  }

  setMistakes(on: boolean): void {
    this.mistakes = on
    this.own.skill = on ? learnerSkill() : { ...proSkill(0.55), label: 'Clean sailing' }
  }

  placeOwn(p: LatLon): void {
    const b = this.own
    b.pos = p
    b.track = []
    b.bsp = 0
    this.sense(b)
    b.hdg = courseFor(b.twd, 60)
  }

  /** Spawn the AIS fleet below the start line (or around the own boat). */
  spawnFleet(count = FLEET.length): void {
    this.boats = [this.own]
    const line = this.line
    const twd = this.own.twd || 200
    for (let i = 0; i < Math.min(count, FLEET.length); i++) {
      const f = FLEET[i]!
      const near = line ? pointOnLine(line, f.spot) : this.own.pos
      const skill = f.pro ? proSkill(f.spot, f.v) : clubSkill(f.spot, f.v)
      const b = makeBoat({ id: `ais${i}`, name: f.name, mmsi: 366_990_100 + i * 7, color: f.color, own: false, boatId: this.boatId, skill, pos: near, hdg: wrap360(twd + 90), t: this.t })
      this.sense(b)
      b.pos = destination(this.setupPoint(b), wrap360(twd + 180), 0.04 * (i % 3))
      b.hdg = courseFor(b.twd, 75)
      this.sense(b)
      this.boats.push(b)
    }
  }

  /** Start sequence: gun in `minutes`. Puts every boat in pre-start. */
  startSequence(minutes: number): void {
    this.seqLenS = minutes * 60
    this.gunT = this.t + minutes * 60_000
    this.events = []
    this.samples = []
    for (const b of this.boats) {
      b.phase = 'prestart'
      b.leg = 0
      b.committed = false
      b.crossedLineT = null
      b.finishedT = null
      b.ocs = false
      b.tacks = 0
      b.gybes = 0
      b.sailedNm = 0
      b.track = []
      b.intent = 'Pre-start'
    }
  }

  /** Skip the pre-start: sail the course from where the own boat is now. */
  sailCourse(): void {
    this.gunT = null
    this.events = []
    this.samples = []
    const b = this.own
    b.phase = 'racing'
    b.leg = 0
    b.legStartT = this.t
    b.crossedLineT = this.t
    b.finishedT = null
    b.tacks = 0
    b.gybes = 0
    b.sailedNm = 0
    b.track = []
    b.legKind = null
    this.boats = [b]
  }

  syncGun(): void {
    if (this.gunT === null) return
    // Round the time to gun to the nearest minute, as a crew does on a signal.
    const left = (this.gunT - this.t) / 60_000
    this.gunT = this.t + Math.max(1, Math.round(left)) * 60_000
  }

  stopRace(): void {
    this.gunT = null
    for (const b of this.boats) {
      b.phase = 'free'
      b.intent = 'Free sailing'
    }
  }

  timeToGunS(): number | null {
    return this.gunT === null ? null : (this.gunT - this.t) / 1000
  }

  // ------------------------------------------------------------ the step

  /** Advance the world by `dtS` seconds of sim time. */
  step(dtS: number): void {
    const sub = 0.5
    let left = dtS
    while (left > 1e-9) {
      const h = Math.min(sub, left)
      this.substep(h)
      left -= h
    }
  }

  private substep(h: number): void {
    const prevT = this.t
    this.t += h * 1000
    const gunNow = this.gunT !== null && prevT < this.gunT && this.t >= this.gunT
    for (const b of this.boats) {
      this.sense(b)
      if (gunNow && b.phase === 'prestart') this.gun(b)
      if (b.helm === 'auto' || !b.own) this.skipper(b)
      this.move(b, h)
      this.referee(b)
      const last = this.lastTrackT.get(b.id) ?? -1e12
      if (this.t - last >= TRACK_EVERY_MS) {
        b.track.push({ t: this.t, lat: b.pos.lat, lon: b.pos.lon })
        if (b.track.length > 3000) b.track.shift()
        this.lastTrackT.set(b.id, this.t)
      }
    }
    if (this.t - this.lastSampleT >= 1000) {
      this.lastSampleT = this.t
      this.record()
    }
  }

  /** Read the wind and the polar for a boat. */
  private sense(b: SimBoat): void {
    const w = localWind(this.forecast, b.pos, this.t, 1)
    if (!w) return
    b.twd = w.twd
    b.tws = w.tws
    b.meanTwd = Number.isNaN(b.meanTwd) ? w.twd : wrap360(b.meanTwd + angdiff(w.twd, b.meanTwd) * 0.004)
    b.twa = twaFrom(b.hdg, b.twd)
    const lattice = boatModel(b.boatId).lattice
    b.polarBsp = lattice.speed(b.tws, b.twa)
    const tg = lattice.targetsAt(b.tws)
    const upwind = Math.abs(b.twa) < 90
    b.targetTwa = upwind ? tg.upTwa : tg.downTwa
    b.targetBsp = upwind ? tg.upBsp : tg.downBsp
    const app = trueToApparent({ twa: b.twa, tws: b.tws, bsp: b.bsp })
    b.awa = app.awa
    b.aws = app.aws
  }

  private gun(b: SimBoat): void {
    const line = this.line
    const first = this.sequence[0] ?? null
    b.phase = 'racing'
    b.leg = 0
    b.legStartT = this.t
    if (line && distToLine(b.pos, line, first) < 0) {
      b.ocs = true
      this.event(b, 'ocs', 'Over the line early at the gun')
    }
  }

  private event(b: SimBoat, kind: RaceEvent['kind'], detail: string): void {
    this.events.push({ t: this.t, boatId: b.id, kind, detail, lat: b.pos.lat, lon: b.pos.lon })
  }

  // ------------------------------------------------------------ physics

  private move(b: SimBoat, h: number): void {
    const preset = boatModel(b.boatId).preset
    if (b.manoeuvre) {
      const m = b.manoeuvre
      const turn = angdiff(m.toHdg, b.hdg)
      const rate = Math.abs(turn) / Math.max(h, m.leftS)
      b.hdg = wrap360(b.hdg + Math.sign(turn) * Math.min(Math.abs(turn), rate * h))
      const keep = m.kind === 'tack' ? Math.pow(preset.tackKeep, b.skill.tackLossMult) : 0.88
      // Speed falls through the manoeuvre to `keep` of the entry speed.
      const progress = 1 - Math.max(0, m.leftS - h) / m.totalS
      b.bsp = m.startBsp * (1 - (1 - keep) * progress)
      m.leftS -= h
      if (m.leftS <= 0) {
        b.hdg = m.toHdg
        b.manoeuvre = null
      }
    } else {
      const target = b.polarBsp * b.skill.speedFactor * b.throttle
      const slowTacks = b.skill.tackTimeMult > 1.2
      const tau = target > b.bsp ? (slowTacks ? 12 : 8) : 4
      b.bsp += (target - b.bsp) * (1 - Math.exp(-h / tau))
    }
    const nm = (b.bsp * h) / 3600
    b.pos = destination(b.pos, b.hdg, nm)
    b.sailedNm += nm
  }

  private startManoeuvre(b: SimBoat, kind: 'tack' | 'gybe', toHdg: number, why: string): void {
    const preset = boatModel(b.boatId).preset
    const base = kind === 'tack' ? preset.tackS : preset.tackS * 0.8
    const total = base * b.skill.tackTimeMult
    b.manoeuvre = { kind, toHdg, leftS: total, totalS: total, startBsp: b.bsp }
    b.lastTackT = this.t
    if (kind === 'tack') b.tacks += 1
    else b.gybes += 1
    this.event(b, kind, why)
  }

  /**
   * Point the boat at `hdg`. A heading on the other tack or gybe is never
   * a jump: it starts a tack or gybe, which costs time and speed.
   */
  private setHeading(b: SimBoat, hdg: number, why: string): void {
    const newTwa = twaFrom(hdg, b.twd)
    const crosses = Math.sign(newTwa) !== Math.sign(b.twa) && Math.abs(newTwa) > 0.5 && Math.abs(b.twa) > 0.5
    if (!crosses) {
      b.hdg = hdg
      return
    }
    if (this.t - b.lastTackT < 6000) return
    const kind = Math.abs(newTwa) + Math.abs(b.twa) < 180 ? 'tack' : 'gybe'
    this.startManoeuvre(b, kind, hdg, why)
  }

  /** Manual helm: steer by `deg`, or tack/gybe onto the other side at the same angle. */
  helmSteer(deg: number): void {
    const b = this.own
    b.helm = 'manual'
    b.throttle = 1
    if (!b.manoeuvre) b.hdg = wrap360(b.hdg + deg)
  }

  helmTack(): void {
    const b = this.own
    b.helm = 'manual'
    if (b.manoeuvre) return
    const kind = Math.abs(b.twa) < 90 ? 'tack' : 'gybe'
    this.startManoeuvre(b, kind, courseFor(b.twd, -b.twa), 'Helm called it')
  }

  autopilot(): void {
    this.own.helm = 'auto'
  }

  // ------------------------------------------------------------ the skipper

  private skipper(b: SimBoat): void {
    if (b.manoeuvre) return
    switch (b.phase) {
      case 'free':
        b.throttle = 0.25
        b.intent = b.own ? 'Drifting; start a sequence or sail the course' : 'Waiting'
        return
      case 'prestart':
        return this.prestart(b)
      case 'racing':
        if (b.ocs) return this.returnToLine(b)
        return this.race(b)
      case 'finished':
        b.throttle = 0.2
        this.setHeading(b, courseFor(b.twd, b.twa >= 0 ? 80 : -80), 'Turned away after finishing')
        b.intent = 'Finished'
        return
    }
  }

  private prestart(b: SimBoat): void {
    const line = this.line
    const ttg = this.timeToGunS() ?? 0
    const lattice = boatModel(b.boatId).lattice
    const tg = lattice.targetsAt(b.tws)
    if (!line) {
      b.throttle = 0.4
      b.intent = 'No start line set'
      return
    }
    const spot = pointOnLine(line, b.skill.lineSpot)
    const setup = this.setupPoint(b)
    const stbdHdg = courseFor(b.twd, tg.upTwa)
    const approach = tg.upBsp * 0.9
    const first = this.sequence[0] ?? null
    const lineNm = distToLine(b.pos, line, first)
    const toSpot = distance(b.pos, spot)
    // Allow time to accelerate out of a luff.
    const ttl = (toSpot / approach) * 3600 + 10

    if (!b.committed && ttg > ttl + b.skill.startDelayS) {
      const d = distance(b.pos, setup)
      if (d > 0.025) {
        this.steerTo(b, setup, tg.upTwa, 25, 'Tacked to hold near the set-up spot')
        b.throttle = 0.6
        b.intent = 'Sailing to the set-up spot'
      } else {
        this.setHeading(b, courseFor(b.twd, 75), 'Turned onto starboard to hold')
        b.throttle = 0.1
        b.intent = 'Holding on starboard, luffing'
      }
      return
    }
    b.committed = true
    // The classic starboard approach: close-hauled at the spot, or straight at
    // it when it is lower than close-hauled.
    const twaSpot = twaFrom(bearing(b.pos, spot), b.twd)
    const hdg = twaSpot >= tg.upTwa ? bearing(b.pos, spot) : stbdHdg
    this.setHeading(b, lineNm < 0.01 ? stbdHdg : hdg, 'Tacked onto starboard for the start')
    // Time on distance: the speed that reaches the line at the gun, with the
    // last few seconds left to build to full speed.
    const need = ttg > 6 ? toSpot / ((ttg - 5) / 3600) : Infinity
    const late = b.skill.startDelayS > 3 && ttg < b.skill.startDelayS
    b.throttle = late || ttg <= 6 ? 1 : Math.min(1, Math.max(0.15, need / Math.max(0.5, b.polarBsp)))
    if (lineNm < 0.008 && ttg > 5) b.throttle = 0.12
    b.intent =
      ttg <= 0 ? 'Accelerating off the line' : b.throttle < 0.6 ? `Burning time, ${Math.round(ttg)} s to go` : `Final approach, ${Math.round(ttg)} s to go`
  }

  /** Where a boat waits before its run at the line: on the starboard layline to its spot. */
  setupPoint(b: SimBoat): LatLon {
    const line = this.line
    if (!line) return b.pos
    const tg = boatModel(b.boatId).lattice.targetsAt(b.tws || 10)
    const spot = pointOnLine(line, b.skill.lineSpot)
    const nm = b.own && this.mistakes ? 0.2 : 0.14
    return destination(spot, wrap360(courseFor(b.twd, tg.upTwa) + 180), nm)
  }

  private returnToLine(b: SimBoat): void {
    const line = this.line
    if (!line) {
      b.ocs = false
      return
    }
    const first = this.sequence[0] ?? null
    const lineNm = distToLine(b.pos, line, first)
    if (lineNm > 0.004) {
      b.ocs = false
      b.intent = 'Cleared, restarting'
      return
    }
    const spot = pointOnLine(line, b.skill.lineSpot)
    this.steerTo(b, destination(spot, wrap360(b.twd + 180), 0.03), 45, 25, 'Turned back to restart')
    b.throttle = 0.7
    b.intent = 'OCS: returning to restart'
  }

  /** Steer straight at a point, or close-hauled on the nearer tack if it is upwind. */
  private steerTo(b: SimBoat, to: LatLon, upTwa: number, hysteresisDeg: number, why: string): void {
    const brg = bearing(b.pos, to)
    const twa = twaFrom(brg, b.twd)
    if (Math.abs(twa) >= upTwa) {
      this.setHeading(b, brg, why)
      return
    }
    const side = b.twa >= 0 ? 1 : -1
    const want = courseFor(b.twd, side * upTwa)
    // Stay on this tack unless the other one points much closer.
    const other = courseFor(b.twd, -side * upTwa)
    if (Math.abs(angdiff(other, brg)) + hysteresisDeg < Math.abs(angdiff(want, brg)) && this.t - b.lastTackT > 20_000) {
      this.startManoeuvre(b, 'tack', other, why)
      return
    }
    b.hdg = want
  }

  private race(b: SimBoat): void {
    const seq = this.sequence
    const mark = seq[b.leg]
    if (!mark) return
    const lattice = boatModel(b.boatId).lattice
    const tg = lattice.targetsAt(b.tws)
    const dist = distance(b.pos, mark)

    if (dist < ROUND_NM) {
      this.event(b, b.leg === seq.length - 1 ? 'finish' : 'rounding', b.leg === seq.length - 1 ? 'Finished' : `Rounded ${mark.name}`)
      b.leg += 1
      b.legStartT = this.t
      b.legKind = null
      if (b.leg >= seq.length) {
        b.phase = 'finished'
        b.finishedT = this.t
        return
      }
      return
    }

    const from = b.leg === 0 ? (this.line ? pointOnLine(this.line, 0.5) : b.pos) : seq[b.leg - 1]!
    b.legKind ??= legKind(from, mark, b.twd, lattice, b.tws)
    const brg = bearing(b.pos, mark)
    const twaMark = twaFrom(brg, b.twd)
    const side: 1 | -1 = b.twa >= 0 ? 1 : -1
    b.throttle = 1
    const own = b.own && this.mistakes
    const sinceTack = (this.t - b.lastTackT) / 1000

    const over = own && lapseActive(b, 'overstand', this.t) ? 9 : b.skill.overstandDeg
    const markOtherSide = Math.sign(twaMark) !== side
    if (Math.abs(twaMark) < tg.upTwa + 2 || (markOtherSide && Math.abs(twaMark) < tg.upTwa + over + 2)) {
      // ---- beat
      let angle = tg.upTwa + b.skill.upwindTwaErr
      if (own && lapseActive(b, 'foot', this.t)) angle += 7
      if (own && lapseActive(b, 'pinch', this.t)) angle -= 6
      if (fetches(b.pos, mark, b.twd, tg.upTwa + over, (-side) as 1 | -1, 'beat') && sinceTack > 8) {
        return this.startManoeuvre(b, 'tack', courseFor(b.twd, -side * angle), 'Tacked on the layline')
      }
      const shift = angdiff(b.twd, b.meanTwd)
      const headed = side > 0 ? shift < 0 : shift > 0
      const overtack = own && lapseActive(b, 'overtack', this.t)
      const thr = overtack ? 0.5 : b.skill.headerTackDeg
      const minInt = overtack ? 40 : b.skill.minTackIntervalS
      const ignore = own && lapseActive(b, 'ignoreHeader', this.t)
      const layable = fetches(b.pos, mark, b.twd, tg.upTwa, side, 'beat')
      // Over-tacking: reacting to every wiggle of the wind, real or not.
      const wantsTack = overtack ? Math.abs(shift) > thr : headed && Math.abs(shift) > thr
      if (wantsTack && sinceTack > minInt && !ignore && !layable && dist > 0.1) {
        return this.startManoeuvre(b, 'tack', courseFor(b.twd, -side * angle), headed ? `Tacked on a ${Math.abs(shift).toFixed(0)}° header` : 'Tacked (no real header)')
      }
      // Keep within a corridor around the rhumb line.
      const xt = crossTrack(b.pos, from, mark)
      const legNm = distance(from, mark)
      const hdgNow = courseFor(b.twd, side * angle)
      const away = Math.sign(xt) === Math.sign(angdiff(hdgNow, bearing(from, mark)))
      if (Math.abs(xt) > Math.max(0.45, legNm * 0.8) && away && sinceTack > 20) {
        return this.startManoeuvre(b, 'tack', courseFor(b.twd, -side * angle), 'Tacked back towards the middle')
      }
      this.setHeading(b, layable && Math.abs(twaMark) > angle ? brg : hdgNow, 'Tacked')
      b.intent = ignore
        ? 'Sailing on in a header'
        : layable
          ? `Laying ${mark.name}`
          : `Beating to ${mark.name}, ${side > 0 ? 'starboard' : 'port'} tack`
      return
    }

    if (Math.abs(twaMark) > tg.downTwa - 6) {
      // ---- run
      let angle = tg.downTwa + b.skill.downwindTwaErr
      if (own && b.legKind === 'run') angle -= 10
      if (fetches(b.pos, mark, b.twd, tg.downTwa - b.skill.overstandDeg, (-side) as 1 | -1, 'run') && sinceTack > 8) {
        return this.startManoeuvre(b, 'gybe', courseFor(b.twd, -side * angle), 'Gybed on the layline')
      }
      const xt = crossTrack(b.pos, from, mark)
      const legNm = distance(from, mark)
      const hdgNow = courseFor(b.twd, side * angle)
      const away = Math.sign(xt) === Math.sign(angdiff(hdgNow, bearing(from, mark)))
      if (Math.abs(xt) > Math.max(0.45, legNm * 0.8) && away && sinceTack > 20) {
        return this.startManoeuvre(b, 'gybe', courseFor(b.twd, -side * angle), 'Gybed back towards the middle')
      }
      const layable = fetches(b.pos, mark, b.twd, tg.downTwa, side, 'run')
      this.setHeading(b, layable && Math.abs(twaMark) < angle ? brg : hdgNow, 'Gybed')
      b.intent = `Running to ${mark.name}, ${side > 0 ? 'starboard' : 'port'} gybe`
      return
    }

    // ---- reach: straight at it
    this.setHeading(b, brg, `Turned for ${mark.name}`)
    b.intent = `Reaching to ${mark.name}`
  }

  /** Line crossings: record the start. */
  private referee(b: SimBoat): void {
    const line = this.line
    if (!line) return
    const first = this.sequence[0] ?? null
    const now = distToLine(b.pos, line, first)
    const prev = this.prevLineNm.get(b.id) ?? now
    this.prevLineNm.set(b.id, now)
    if (b.phase !== 'racing' || b.crossedLineT !== null || b.ocs) return
    if (prev > 0 && now <= 0) {
      b.crossedLineT = this.t
      const late = this.gunT !== null ? (this.t - this.gunT) / 1000 : 0
      this.event(b, 'start', `Crossed the line ${late.toFixed(0)} s after the gun`)
    }
  }

  /**
   * Live instruments drive the own boat: advance the clock to `now`, log it
   * like the simulator does, and keep the track. The fleet keeps sailing.
   */
  tickLive(now: number): void {
    const dt = Math.max(0, Math.min(2, (now - this.t) / 1000))
    this.t = now
    for (const b of this.boats) {
      if (b.own) continue
      this.sense(b)
      this.skipper(b)
      this.move(b, dt)
    }
    const b = this.own
    const last = this.lastTrackT.get(b.id) ?? -1e12
    if (now - last >= TRACK_EVERY_MS) {
      b.track.push({ t: now, lat: b.pos.lat, lon: b.pos.lon })
      this.lastTrackT.set(b.id, now)
    }
    if (now - this.lastSampleT >= 1000) {
      this.lastSampleT = now
      this.record()
    }
  }

  // ------------------------------------------------------------ the log

  private record(): void {
    const b = this.own
    const line = this.line
    const seq = this.sequence
    const mark = seq[b.leg]
    let vmg = b.bsp * Math.cos((b.twa * Math.PI) / 180)
    if (mark && b.phase === 'racing') {
      vmg = b.bsp * Math.cos(((angdiff(bearing(b.pos, mark), b.hdg)) * Math.PI) / 180)
    }
    this.samples.push({
      t: this.t,
      lat: b.pos.lat,
      lon: b.pos.lon,
      hdg: b.hdg,
      bsp: b.bsp,
      twd: b.twd,
      tws: b.tws,
      twa: b.twa,
      targetBsp: b.targetBsp,
      targetTwa: b.targetTwa,
      polarBsp: b.polarBsp,
      phase: b.phase,
      leg: b.leg,
      legKind: b.legKind,
      inManoeuvre: b.manoeuvre !== null,
      lineNm: line ? distToLine(b.pos, line, seq[0] ?? null) : null,
      vmg,
    })
    if (this.samples.length > 20_000) this.samples.shift()
  }

  /** Progress through the course for ranking: legs done, then distance to the next mark. */
  progress(b: SimBoat): number {
    if (b.phase === 'finished') return 1e6 - (b.finishedT ?? 0) / 1e9
    const mark = this.sequence[b.leg]
    return b.leg * 100 - (mark ? distance(b.pos, mark) : 0)
  }

  standings(): SimBoat[] {
    return [...this.boats].sort((a, c) => this.progress(c) - this.progress(a))
  }
}

export type { LegKind }
