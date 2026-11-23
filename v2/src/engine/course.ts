/**
 * Course geometry: the start line, legs, laylines and line distances.
 * Everything here is pure, so the UI, the simulator and the coach agree.
 */
import { angdiff, courseFor, twaFrom, wrap360 } from '@/lib/angles'
import { bearing, crossTrack, destination, distance, midpoint } from '@/lib/geo'
import type { PolarLattice } from '@/lib/types'
import type { Course, LatLon, LegKind, Mark } from './types'

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

export function courseMarks(marks: Mark[], course: Course): Mark[] {
  return course.sequence.map((id) => markById(marks, id)).filter((m): m is Mark => m !== null)
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
