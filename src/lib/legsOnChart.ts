/**
 * The course's legs on the chart, and when the boat has done with a mark.
 *
 * Each leg is labelled with its range and its initial bearing (true, or
 * magnetic with the variation given); the leg from the boat to the active
 * mark is drawn apart; marks with a range set get a circle of that radius.
 *
 * A mark is done (auto advance) when the boat comes inside its range, or
 * crosses the bisector of the legs either side of it: the line through the
 * mark square to the mean of the course in and the course out, which is the
 * line a boat crosses in rounding it whichever way the course turns.
 */
import { bearing, destination, distance } from './geo'
import { wrap360 } from './angles'
import type { LatLon, Mark } from './types'

type Feature = { type: 'Feature'; properties: Record<string, string | number | boolean>; geometry: { type: 'LineString' | 'Point'; coordinates: number[][] | number[] } }

const fmtBrg = (b: number) => String(Math.round(wrap360(b)) % 360).padStart(3, '0')

/** Points along a great circle from a to b, so a long leg draws as it is sailed. */
function along(a: LatLon, b: LatLon, n: number): number[][] {
  const d = distance(a, b)
  if (d < 1 || n < 2) return [[a.lon, a.lat], [b.lon, b.lat]]
  const out: number[][] = []
  let p = a
  for (let i = 0; i <= n; i++) {
    const q = i === 0 ? a : destination(p, bearing(p, b), d / n)
    out.push([q.lon, q.lat])
    p = q
  }
  out[out.length - 1] = [b.lon, b.lat]
  return out
}

function circle(c: LatLon, nm: number, n = 48): number[][] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const p = destination(c, (360 * i) / n, nm)
    return [p.lon, p.lat]
  })
}

export interface LegOptions {
  /** Degrees to take from true bearings for magnetic labels (the variation, east positive); 0 for true. */
  variationDeg?: number
  magnetic?: boolean
}

/** The legs, the current leg, and the range circles, as map features. */
export function legFeatures(marks: Mark[], boat: LatLon | null, active: number, o: LegOptions = {}): Feature[] {
  const out: Feature[] = []
  const label = (a: LatLon, b: LatLon) => {
    const brg = bearing(a, b) - (o.magnetic ? (o.variationDeg ?? 0) : 0)
    return `${distance(a, b).toFixed(2)} nm ${fmtBrg(brg)}°${o.magnetic ? 'M' : 'T'}`
  }
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1].position
    const b = marks[i].position
    const coords = along(a, b, 16)
    out.push({ type: 'Feature', properties: { kind: 'leg', active: i === active, label: label(a, b) }, geometry: { type: 'LineString', coordinates: coords } })
    // 40 % along, so a leg sailed back the other way (a W/L) labels in a different place.
    const mid = coords[Math.round((coords.length - 1) * 0.4)]
    out.push({ type: 'Feature', properties: { kind: 'leg-label', label: label(a, b) }, geometry: { type: 'Point', coordinates: mid } })
  }
  const target = marks[active]
  if (boat && target) {
    out.push({ type: 'Feature', properties: { kind: 'current', label: label(boat, target.position) }, geometry: { type: 'LineString', coordinates: along(boat, target.position, 16) } })
  }
  for (const m of marks) {
    if (m.rangeNm && m.rangeNm > 0) out.push({ type: 'Feature', properties: { kind: 'circle' }, geometry: { type: 'LineString', coordinates: circle(m.position, m.rangeNm) } })
  }
  return out
}

export type AdvanceMode = 'off' | 'range' | 'bisector' | 'both'

/** Local flat metres east and north of `o`, near enough over a mark's rounding. */
function enu(o: LatLon, p: LatLon): [number, number] {
  const k = Math.cos((o.lat * Math.PI) / 180)
  return [(p.lon - o.lon) * 60 * 1852 * k, (p.lat - o.lat) * 60 * 1852]
}

/** Which side of the mark's bisector a point lies: ≤ 0 before it, > 0 past it. */
function pastBisector(marks: Mark[], i: number, p: LatLon, from: LatLon | null): number {
  const m = marks[i].position
  const prev = marks[i - 1]?.position ?? from
  const next = marks[i + 1]?.position
  const unit = (v: [number, number]) => {
    const l = Math.hypot(v[0], v[1]) || 1
    return [v[0] / l, v[1] / l] as [number, number]
  }
  const u = prev ? unit(enu(prev, m)) : null
  const v = next ? unit(enu(m, next)) : null
  // The mean of the course in and the course out; with only one, that one.
  let n: [number, number] | null = u && v ? [u[0] + v[0], u[1] + v[1]] : u ?? v
  if (u && v && Math.hypot(n![0], n![1]) < 0.35) {
    // Nearly straight back (a windward mark on a W/L): the line to cross is the course
    // through the mark, from the side it is approached on to the side it is left on.
    const side = marks[i].roundTo
    n = side === 'port' ? [-u[1], u[0]] : side === 'starboard' ? [u[1], -u[0]] : u
  }
  if (!n) return -1
  const d = enu(m, p)
  return d[0] * n[0] + d[1] * n[1]
}

/**
 * Whether the boat, moving from `before` to `now`, has done with the active
 * mark: inside its range (or `defaultRangeNm`), or across its bisector
 * within `bisectorWithinNm` of it.
 */
export function shouldAdvance(marks: Mark[], active: number, before: LatLon, now: LatLon, mode: AdvanceMode, o: { defaultRangeNm?: number; bisectorWithinNm?: number; start?: LatLon | null } = {}): boolean {
  const m = marks[active]
  if (!m || mode === 'off' || active >= marks.length - 1) return false
  if (mode === 'range' || mode === 'both') {
    const r = m.rangeNm && m.rangeNm > 0 ? m.rangeNm : (o.defaultRangeNm ?? 0.05)
    if (distance(now, m.position) <= r) return true
  }
  if (mode === 'bisector' || mode === 'both') {
    if (distance(now, m.position) > (o.bisectorWithinNm ?? 0.5)) return false
    if (pastBisector(marks, active, before, o.start ?? null) <= 0 && pastBisector(marks, active, now, o.start ?? null) > 0) return true
  }
  return false
}
