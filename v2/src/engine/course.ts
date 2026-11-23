/**
 * Course geometry: the start line, legs, laylines and line distances.
 * Everything here is pure, so the UI, the simulator and the coach agree.
 */
import { angdiff, courseFor, twaFrom, wrap360 } from '@/lib/angles'
import { bearing, crossTrack, destination, distance, midpoint } from '@/lib/geo'
import type { PolarLattice } from '@/lib/types'
import type { Course, Gate, LatLon, LegKind, Mark } from './types'

let seq = 0
export function newId(prefix = 'm'): string {
  seq += 1
  return `${prefix}${Date.now().toString(36)}${seq}`
}

export function markById(marks: Mark[], id: string | null): Mark | null {
  if (!id) return null
  return marks.find((m) => m.id === id) ?? null
}

export interface Line {
  pin: LatLon
  committee: LatLon
}

export function startLine(marks: Mark[], course: Course): Line | null {
  const pin = markById(marks, course.pinId)
  const committee = markById(marks, course.committeeId)
  return pin && committee ? { pin, committee } : null
}

/**
 * The course in order, one entry per mark to round. A gate appears as a
 * stand-in at the middle of its two marks (with `gate` set), so planning,
 * routing, laylines and distances treat it as one mark.
 */
export function courseMarks(marks: Mark[], course: Course): Mark[] {
  return course.sequence.map((id) => markById(marks, id) ?? gateStandIn(marks, course, id)).filter((m): m is Mark => m !== null)
}

function gateStandIn(marks: Mark[], course: Course, id: string): Mark | null {
  const g = course.gates?.find((x) => x.id === id)
  if (!g) return null
  const a = markById(marks, g.aId)
  const b = markById(marks, g.bId)
  if (!a || !b) return null
  const mid = midpoint(a, b)
  return { id: g.id, name: g.name, role: 'mark', lat: mid.lat, lon: mid.lon, gate: { gateId: g.id, a, b, open: g.open } }
}

/** About ten boat lengths for a sportboat. */
export const GATE_WIDTH_NM = 0.04

/** Which gate mark to go for: the nearer one, once a boat is close enough to choose. */
export function pickGateMark(gate: NonNullable<Mark['gate']>, pos: LatLon): Mark {
  return distance(pos, gate.a) <= distance(pos, gate.b) ? gate.a : gate.b
}

/**
 * Where a boat aims to round one mark of a gate: just inside it for an open
 * gate (so it sails between the marks), just outside it for a closed one (so
 * it goes round the outside and never between them).
 */
export function gateAim(gate: NonNullable<Mark['gate']>, pick: Mark): LatLon {
  const other = pick.id === gate.a.id ? gate.b : gate.a
  const toOther = bearing(pick, other)
  return gate.open ? destination(pick, toOther, Math.min(0.012, distance(pick, other) * 0.3)) : destination(pick, wrap360(toOther + 180), 0.014)
}

/** Whether the segments p1-p2 and q1-q2 cross (flat, which is fine at racecourse scale). */
export function segmentsCross(p1: LatLon, p2: LatLon, q1: LatLon, q2: LatLon): boolean {
  const k = Math.cos((p1.lat * Math.PI) / 180)
  const xy = (p: LatLon): [number, number] => [p.lon * k, p.lat]
  const [a, b, c, d] = [xy(p1), xy(p2), xy(q1), xy(q2)]
  const orient = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return orient(a, b, c) !== orient(a, b, d) && orient(c, d, a) !== orient(c, d, b)
}

/**
 * Signed distance to the line, nm: positive on the pre-start side, negative
 * over the line (on the course side). The course side is where the first mark is.
 */
export function distToLine(p: LatLon, line: Line, firstMark: LatLon | null): number {
  const xt = crossTrack(p, line.pin, line.committee)
  const markSide = firstMark ? Math.sign(crossTrack(firstMark, line.pin, line.committee)) || -1 : -1
  return -xt * markSide
}

/** Nearest point on the line segment and the fraction along it (0 pin, 1 committee). */
export function nearestOnLine(p: LatLon, line: Line): { at: LatLon; f: number } {
  const len = distance(line.pin, line.committee)
  if (len < 1e-6) return { at: line.pin, f: 0 }
  const brg = bearing(line.pin, line.committee)
  const dp = distance(line.pin, p)
  const along = dp * Math.cos(((bearing(line.pin, p) - brg) * Math.PI) / 180)
  const f = Math.min(1, Math.max(0, along / len))
  return { at: destination(line.pin, brg, f * len), f }
}

export function pointOnLine(line: Line, f: number): LatLon {
  const len = distance(line.pin, line.committee)
  return destination(line.pin, bearing(line.pin, line.committee), f * len)
}

/**
 * Line bias, degrees: positive means the pin is favoured (it is further
 * upwind). The square line is perpendicular to the wind.
 */
export function lineBias(line: Line, twd: number): number {
  const brg = bearing(line.committee, line.pin)
  // For a square line the bearing committee->pin is twd - 90 (pin on the left looking upwind).
  return angdiff(twd - 90, brg) * -1
}

/** Upwind gain of starting at the favoured end, in boat lengths. */
export function biasGainM(line: Line, twd: number): number {
  const lenM = distance(line.pin, line.committee) * 1852
  return Math.abs(Math.sin((lineBias(line, twd) * Math.PI) / 180)) * lenM
}

export function legKind(from: LatLon, to: LatLon, twd: number, lattice: PolarLattice, tws: number): LegKind {
  const t = lattice.targetsAt(tws)
  const a = Math.abs(twaFrom(bearing(from, to), twd))
  if (a < t.upTwa + 4) return 'beat'
  if (a > t.downTwa - 6) return 'run'
  return 'reach'
}

export interface Laylines {
  /** Laylines through the mark, drawn back from it: starboard and port. */
  starboard: [LatLon, LatLon]
  port: [LatLon, LatLon]
  kind: 'beat' | 'run'
}

/**
 * Laylines to a mark for a beat or a run. The starboard layline is the line a
 * boat on starboard tack sails to fetch the mark.
 */
export function laylinesTo(mark: LatLon, twd: number, twaUp: number, kind: 'beat' | 'run', lengthNm = 1.2): Laylines {
  const stbdHdg = courseFor(twd, kind === 'beat' ? twaUp : twaUp)
  const portHdg = courseFor(twd, -twaUp)
  return {
    kind,
    starboard: [mark, destination(mark, wrap360(stbdHdg + 180), lengthNm)],
    port: [mark, destination(mark, wrap360(portHdg + 180), lengthNm)],
  }
}

/**
 * Can a boat at `pos` fetch `mark` on the tack (or gybe) `side` (+1 starboard,
 * -1 port), sailing at `angle` degrees off the wind? Upwind that means the mark
 * is no closer to the wind than `angle`; downwind, no deeper than `angle`.
 */
export function fetches(pos: LatLon, mark: LatLon, twd: number, angle: number, side: 1 | -1, kind: 'beat' | 'run'): boolean {
  const t = twaFrom(bearing(pos, mark), twd)
  if (Math.sign(t) !== side && t !== 0) return false
  return kind === 'beat' ? Math.abs(t) >= angle : Math.abs(t) <= angle
}

/**
 * Distance (nm) and time (s) along the current tack until the boat can fetch
 * the mark on the other tack, or null if it already can or never will.
 */
export function toLayline(o: { pos: LatLon; mark: LatLon; twd: number; angle: number; side: 1 | -1; bsp: number; kind: 'beat' | 'run' }): { nm: number; s: number | null } | null {
  const { pos, mark, twd, angle, side, kind } = o
  if (fetches(pos, mark, twd, angle, (-side) as 1 | -1, kind)) return null
  const hdg = courseFor(twd, side * angle)
  const maxNm = Math.max(0.2, distance(pos, mark) * 2)
  for (let nm = 0.005; nm <= maxNm; nm += 0.005) {
    const p = destination(pos, hdg, nm)
    if (fetches(p, mark, twd, angle, (-side) as 1 | -1, kind)) {
      return { nm, s: o.bsp > 0.3 ? (nm / o.bsp) * 3600 : null }
    }
  }
  return null
}

/** The default course used to set up a race around a position, square to the wind. */
export function defaultCourseMarks(center: LatLon, twd: number, beatNm = 0.9): Mark[] {
  const lineLenNm = 0.13
  const lineMid = center
  const pin = destination(lineMid, wrap360(twd - 90), lineLenNm / 2)
  const committee = destination(lineMid, wrap360(twd + 90), lineLenNm / 2)
  const windward = destination(lineMid, twd, beatNm)
  const offset = destination(windward, wrap360(twd - 90), 0.05)
  const leeward = destination(lineMid, wrap360(twd + 180), 0.08)
  const finish = destination(lineMid, twd, beatNm * 0.6)
  return [
    { id: newId(), name: 'Pin', role: 'pin', ...pin },
    { id: newId(), name: 'Committee', role: 'committee', ...committee },
    { id: newId(), name: 'Windward', role: 'mark', ...windward },
    { id: newId(), name: 'Offset', role: 'mark', ...offset },
    { id: newId(), name: 'Leeward', role: 'mark', ...leeward },
    { id: newId(), name: 'Finish', role: 'mark', ...finish },
  ]
}

export function defaultCourse(marks: Mark[]): Course {
  const byName = (n: string) => marks.find((m) => m.name === n)?.id
  return {
    pinId: byName('Pin') ?? null,
    committeeId: byName('Committee') ?? null,
    sequence: ['Windward', 'Offset', 'Leeward', 'Windward', 'Finish'].map((n) => byName(n)).filter((x): x is string => !!x),
  }
}

export function lineMid(line: Line): LatLon {
  return midpoint(line.pin, line.committee)
}

// ------------------------------------------------------------ standard layouts

export type LayoutId = 'w2' | 'w4' | 'triangle' | 'trapezoid'

export const LAYOUTS: Array<{ id: LayoutId; name: string; order: string; hint: string }> = [
  { id: 'w2', name: 'W2', order: '1 – 1a – Gate 4 – 1 – 1a – Finish', hint: 'Windward-leeward: two beats and two runs, a leeward gate, a downwind finish.' },
  { id: 'w4', name: 'W4', order: '1 – 1a – Gate 4, three times, then 1 – 1a – Finish', hint: 'Windward-leeward: four beats, a leeward gate, a downwind finish.' },
  { id: 'triangle', name: 'Triangle', order: '1 – 2 – 3 – 1 – 3 – Finish', hint: 'A beat, a reach to the wing mark, a reach to leeward, then windward-leeward, finishing upwind.' },
  { id: 'trapezoid', name: 'Trapezoid', order: '1 – 2 – Gate 3 – 2 – Gate 3 – Finish', hint: 'Outer loop: a beat, a reach to 2, a run to the gate, a beat back to 2, a run to the gate, a reach to the finish.' },
]

/**
 * Lays one of the standard courses square to the wind. The start line is
 * centred on `center`, pin on the left looking upwind; distances scale with
 * the beat length.
 */
export function layoutCourse(id: LayoutId, center: LatLon, twd: number, beatNm = 0.9): { marks: Mark[]; course: Course } {
  // x: across the wind, positive to the right looking upwind; y: upwind.
  const at = (x: number, y: number): LatLon => {
    const up = destination(center, y >= 0 ? twd : wrap360(twd + 180), Math.abs(y))
    return destination(up, x >= 0 ? wrap360(twd + 90) : wrap360(twd - 90), Math.abs(x))
  }
  const L = beatNm
  const marks: Mark[] = []
  const add = (name: string, x: number, y: number, role: Mark['role'] = 'mark'): string => {
    const id = newId()
    marks.push({ id, name, role, ...at(x, y) })
    return id
  }
  const gates: Gate[] = []
  const gate = (n: string, x: number, y: number): string => {
    // "s" is left to starboard: the left mark looking upwind.
    const aId = add(`Gate ${n}s`, x - GATE_WIDTH_NM / 2, y)
    const bId = add(`Gate ${n}p`, x + GATE_WIDTH_NM / 2, y)
    const id = newId('g')
    gates.push({ id, name: `Gate ${n}`, aId, bId, open: true })
    return id
  }
  const pinId = add('Pin', -0.065, 0, 'pin')
  const committeeId = add('Committee', 0.065, 0, 'committee')
  let sequence: string[]

  if (id === 'w2' || id === 'w4') {
    const w = add('Windward 1', 0, L)
    const o = add('Offset 1a', -0.05, L)
    const g = gate('4', 0, -0.08)
    const f = add('Finish', 0, L * 0.6)
    const laps = id === 'w2' ? 2 : 4
    sequence = []
    for (let i = 0; i < laps; i++) sequence.push(w, o, ...(i < laps - 1 ? [g] : []))
    sequence.push(f)
  } else if (id === 'triangle') {
    const w = add('Windward 1', 0, L)
    const wing = add('Wing 2', -0.58 * L, 0.5 * L)
    const lee = add('Leeward 3', 0, -0.08)
    const f = add('Finish', 0, L * 0.6)
    sequence = [w, wing, lee, w, lee, f]
  } else {
    const w = add('Windward 1', 0, L)
    const two = add('Mark 2', -0.6 * L, 0.75 * L)
    const g = gate('3', -0.6 * L, 0)
    const f = add('Finish', 0.22, 0.04)
    sequence = [w, two, g, two, g, f]
  }
  return { marks, course: { pinId, committeeId, sequence, gates, layout: id } }
}

/**
 * Turns a mark of the course into a gate: a partner mark goes alongside it,
 * across the wind, and the course rounds either. Null if `markId` isn't a
 * plain mark of the course.
 */
export function makeGate(marks: Mark[], course: Course, markId: string, twd: number): { marks: Mark[]; course: Course } | null {
  const m = markById(marks, markId)
  if (!m || m.role !== 'mark' || !course.sequence.includes(markId)) return null
  const base = m.name.replace(/^Gate\s+/, '')
  const left: Mark = { ...m, name: `${base} s`, ...destination(m, wrap360(twd - 90), GATE_WIDTH_NM / 2) }
  const right: Mark = { id: newId(), name: `${base} p`, role: 'mark', ...destination(m, wrap360(twd + 90), GATE_WIDTH_NM / 2) }
  const g: Gate = { id: newId('g'), name: `Gate ${base}`, aId: left.id, bId: right.id, open: true }
  return {
    marks: [...marks.map((x) => (x.id === m.id ? left : x)), right],
    course: { ...course, sequence: course.sequence.map((id) => (id === markId ? g.id : id)), gates: [...(course.gates ?? []), g] },
  }
}

/** Undoes `makeGate`: the gate becomes one mark at its middle again. */
export function removeGate(marks: Mark[], course: Course, gateId: string): { marks: Mark[]; course: Course } | null {
  const g = course.gates?.find((x) => x.id === gateId)
  if (!g) return null
  const a = markById(marks, g.aId)
  const b = markById(marks, g.bId)
  if (!a || !b) return null
  const mid = midpoint(a, b)
  const single: Mark = { ...a, name: g.name.replace(/^Gate\s+/, ''), lat: mid.lat, lon: mid.lon }
  return {
    marks: marks.filter((x) => x.id !== b.id).map((x) => (x.id === a.id ? single : x)),
    course: { ...course, sequence: course.sequence.map((id) => (id === gateId ? a.id : id)), gates: (course.gates ?? []).filter((x) => x.id !== gateId) },
  }
}
