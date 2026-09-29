/**
 * AIS targets: the vessels (and aids to navigation) heard, each built up from
 * its position reports and static data, with closest point of approach to us.
 */
import { bearing, distance } from '../geo'
import type { LatLon, Millis } from '../types'
import type { AisMessage } from './decode'

export type AisAlert = 'SART' | 'MOB' | 'EPIRB'

export interface AisTarget {
  mmsi: number
  cls: 'A' | 'B' | 'SAR' | 'LR' | 'AtoN' | 'base'
  name?: string
  callSign?: string
  shipType?: number
  destination?: string
  dims?: { bow: number; stern: number; port: number; starboard: number }
  position: LatLon | null
  sog: number | null
  cog: number | null
  heading: number | null
  status: number | null
  /** When a position last came, and when anything did. */
  positionAt: Millis | null
  updated: Millis
  alert: AisAlert | null
  virtual?: boolean
}

/**
 * The distress devices go by their MMSI: 970… an AIS-SART, 972… a man-overboard
 * beacon, 974… an EPIRB's AIS locator. A SART also sends navigational status 14.
 */
export function alertOf(mmsi: number, status: number | null = null): AisAlert | null {
  const p = Math.floor(mmsi / 1_000_000)
  if (p === 970 || status === 14) return 'SART'
  if (p === 972) return 'MOB'
  if (p === 974) return 'EPIRB'
  return null
}

/** Fold one message into the targets. Our own ship's (AIVDO) are left out. */
export function applyMessage(targets: Map<number, AisTarget>, m: AisMessage, now: Millis): AisTarget | null {
  if (m.own) return null
  const was = targets.get(m.mmsi)
  const t: AisTarget = was
    ? { ...was, updated: now }
    : { mmsi: m.mmsi, cls: 'A', position: null, sog: null, cog: null, heading: null, status: null, positionAt: null, updated: now, alert: alertOf(m.mmsi) }
  if (m.kind === 'position') {
    t.cls = m.cls
    if (m.lat != null && m.lon != null) {
      t.position = { lat: m.lat, lon: m.lon }
      t.positionAt = now
    }
    t.sog = m.sog
    t.cog = m.cog
    t.heading = m.heading
    if (m.status != null) t.status = m.status
    if (m.name) t.name = m.name
    if (m.shipType != null) t.shipType = m.shipType
    if (m.dims) t.dims = m.dims
  } else if (m.kind === 'static') {
    if (m.name) t.name = m.name
    if (m.callSign) t.callSign = m.callSign
    if (m.shipType != null) t.shipType = m.shipType
    if (m.dims) t.dims = m.dims
    if (m.destination) t.destination = m.destination
  } else if (m.kind === 'aton') {
    t.cls = 'AtoN'
    t.name = m.name
    t.virtual = m.virtual
    if (m.lat != null && m.lon != null) {
      t.position = { lat: m.lat, lon: m.lon }
      t.positionAt = now
    }
    t.sog = 0
    t.cog = null
  } else if (m.kind === 'base') {
    t.cls = 'base'
    if (m.lat != null && m.lon != null) {
      t.position = { lat: m.lat, lon: m.lon }
      t.positionAt = now
    }
  } else {
    return null
  }
  t.alert = alertOf(t.mmsi, t.status)
  targets.set(t.mmsi, t)
  return t
}

/** Drop what has not been heard for `maxAgeMs` (ten minutes; aids to navigation report every three). */
export function prune(targets: Map<number, AisTarget>, now: Millis, maxAgeMs = 10 * 60_000): void {
  for (const [k, t] of targets) if (now - t.updated > maxAgeMs) targets.delete(k)
}

export interface Own {
  position: LatLon
  sog: number
  cog: number
}

export interface Approach {
  rangeNm: number
  bearing: number
  /** Closest point of approach, nm, and minutes to it (negative: it is behind us). */
  cpaNm: number
  tcpaMin: number
}

/**
 * Closest approach, with both boats holding course and speed over the ground:
 * the relative position and velocity on a local flat frame, which is exact
 * enough over the few miles AIS matters at.
 */
export function approach(own: Own, t: AisTarget): Approach | null {
  if (!t.position) return null
  const rangeNm = distance(own.position, t.position)
  const brg = bearing(own.position, t.position)
  const rx = rangeNm * Math.sin((brg * Math.PI) / 180)
  const ry = rangeNm * Math.cos((brg * Math.PI) / 180)
  const vel = (sog: number | null, cog: number | null) =>
    sog != null && cog != null ? [sog * Math.sin((cog * Math.PI) / 180), sog * Math.cos((cog * Math.PI) / 180)] : [0, 0]
  const [ox, oy] = vel(own.sog, own.cog)
  const [tx, ty] = vel(t.sog, t.cog)
  const vx = tx - ox
  const vy = ty - oy
  const v2 = vx * vx + vy * vy
  if (v2 < 1e-9) return { rangeNm, bearing: brg, cpaNm: rangeNm, tcpaMin: 0 }
  const tcpaH = -(rx * vx + ry * vy) / v2
  const cx = rx + vx * tcpaH
  const cy = ry + vy * tcpaH
  return { rangeNm, bearing: brg, cpaNm: tcpaH > 0 ? Math.hypot(cx, cy) : rangeNm, tcpaMin: tcpaH * 60 }
}

/** The closest approach any vessel will make within `withinMin`, nm, for the CPA alarm. */
export function closestApproach(targets: Iterable<AisTarget>, own: Own | null, withinMin = 30): number | null {
  if (!own) return null
  let best: number | null = null
  for (const t of targets) {
    if (t.cls === 'AtoN' || t.cls === 'base') continue
    const a = approach(own, t)
    if (!a || a.tcpaMin < 0 || a.tcpaMin > withinMin) continue
    if (best == null || a.cpaNm < best) best = a.cpaNm
  }
  return best
}

/** The AIS values the alarms read: the closest approach coming, and how many distress beacons are heard. */
export function aisAlarmValues(
  targets: readonly AisTarget[],
  state: { position: LatLon; sog: number | null; cog: number | null } | null,
): { 'ais-cpa': number | null; 'ais-alert': number } {
  const own = state && state.sog != null && state.cog != null ? { position: state.position, sog: state.sog, cog: state.cog } : null
  return { 'ais-cpa': closestApproach(targets, own), 'ais-alert': targets.filter((t) => t.alert).length }
}

export interface AisFilter {
  maxRangeNm: number
  classB: boolean
  aton: boolean
  /** Leave out vessels moored or at anchor (status 1 and 5). */
  hideMoored: boolean
}

export const DEFAULT_AIS_FILTER: AisFilter = { maxRangeNm: 24, classB: true, aton: true, hideMoored: false }

/** The targets to show, alerts first, then by closest approach, then range. */
export function shownTargets(targets: Iterable<AisTarget>, own: Own | null, f: AisFilter): Array<AisTarget & { a: Approach | null }> {
  const out: Array<AisTarget & { a: Approach | null }> = []
  for (const t of targets) {
    const a = own ? approach(own, t) : null
    if (!t.alert) {
      if (a && a.rangeNm > f.maxRangeNm) continue
      if (!f.classB && t.cls === 'B') continue
      if (!f.aton && (t.cls === 'AtoN' || t.cls === 'base')) continue
      if (f.hideMoored && (t.status === 1 || t.status === 5)) continue
    }
    out.push({ ...t, a })
  }
  // Beacons, then the closest approach to a hundredth of a mile, the sooner first, then range.
  const key = (x: AisTarget & { a: Approach | null }) => {
    const closing = x.a && x.a.tcpaMin >= 0
    return [x.alert ? 0 : 1, closing ? Math.round(x.a!.cpaNm * 100) : Infinity, closing ? x.a!.tcpaMin : Infinity, x.a?.rangeNm ?? Infinity]
  }
  return out.sort((x, y) => {
    const a = key(x)
    const b = key(y)
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]
  })
}
