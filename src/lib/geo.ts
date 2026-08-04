/**
 * Spherical geodesy. See docs/03-algorithms/navigation-math.md §2.
 *
 * We use a sphere, not the ellipsoid: at buoy-racing scale the difference is
 * centimetres, and at ocean scale it is a few miles of ETA — irrelevant to
 * tactics and not worth the cost in the routing inner loop.
 */

import { DEG, RAD, clampUnit, wrap180, wrap360 } from './angles'
import type { Degrees, LatLon, NauticalMiles, Metres, XY } from './types'

/** Earth radius in nautical miles. */
export const R_NM = 3440.065
export const NM_TO_M = 1852
export const M_TO_NM = 1 / 1852

export const nmToM = (nm: NauticalMiles): Metres => nm * NM_TO_M
export const mToNm = (m: Metres): NauticalMiles => m * M_TO_NM

/** Great-circle distance, nautical miles (haversine). */
export function distance(a: LatLon, b: LatLon): NauticalMiles {
  const φ1 = a.lat * DEG
  const φ2 = b.lat * DEG
  const dφ = (b.lat - a.lat) * DEG
  const dλ = wrap180(b.lon - a.lon) * DEG
  const s =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * R_NM * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))
}

/** Initial great-circle bearing from a to b, degrees true. */
export function bearing(a: LatLon, b: LatLon): Degrees {
  const φ1 = a.lat * DEG
  const φ2 = b.lat * DEG
  const dλ = wrap180(b.lon - a.lon) * DEG
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return wrap360(Math.atan2(y, x) * RAD)
}

/** Point reached from `from` on `brg` after `dist` nautical miles. */
export function destination(
  from: LatLon,
  brg: Degrees,
  dist: NauticalMiles,
): LatLon {
  const δ = dist / R_NM
  const θ = brg * DEG
  const φ1 = from.lat * DEG
  const λ1 = from.lon * DEG
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  const φ2 = Math.asin(clampUnit(sinφ2))
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * sinφ2,
    )
  return { lat: φ2 * RAD, lon: wrap180(λ2 * RAD) }
}

/** Midpoint of the great circle between two points. */
export function midpoint(a: LatLon, b: LatLon): LatLon {
  return destination(a, bearing(a, b), distance(a, b) / 2)
}

/**
 * Signed cross-track distance of `p` from the great circle a→b.
 * Positive = right of track. Nautical miles.
 */
export function crossTrack(p: LatLon, a: LatLon, b: LatLon): NauticalMiles {
  const δ13 = distance(a, p) / R_NM
  const θ13 = bearing(a, p) * DEG
  const θ12 = bearing(a, b) * DEG
  return Math.asin(clampUnit(Math.sin(δ13) * Math.sin(θ13 - θ12))) * R_NM
}

/** Distance along the a→b track to the projection of p. Nautical miles. */
export function alongTrack(p: LatLon, a: LatLon, b: LatLon): NauticalMiles {
  const δ13 = distance(a, p) / R_NM
  const xt = crossTrack(p, a, b) / R_NM
  const c = Math.cos(δ13) / Math.cos(xt)
  return Math.acos(clampUnit(c)) * R_NM * Math.sign(Math.cos(bearing(a, p) * DEG - bearing(a, b) * DEG) || 1)
}

// ------------------------------------------------------------ rhumb lines

/** Rhumb-line (constant bearing) distance, nautical miles. */
export function rhumbDistance(a: LatLon, b: LatLon): NauticalMiles {
  const φ1 = a.lat * DEG
  const φ2 = b.lat * DEG
  const dφ = φ2 - φ1
  const dλ = wrap180(b.lon - a.lon) * DEG
  const dψ = Math.log(Math.tan(Math.PI / 4 + φ2 / 2) / Math.tan(Math.PI / 4 + φ1 / 2))
  const q = Math.abs(dψ) > 1e-12 ? dφ / dψ : Math.cos(φ1)
  return Math.hypot(dφ, q * dλ) * R_NM
}

/** Rhumb-line bearing, degrees true — what a helmsman actually steers. */
export function rhumbBearing(a: LatLon, b: LatLon): Degrees {
  const φ1 = a.lat * DEG
  const φ2 = b.lat * DEG
  const dλ = wrap180(b.lon - a.lon) * DEG
  const dψ = Math.log(Math.tan(Math.PI / 4 + φ2 / 2) / Math.tan(Math.PI / 4 + φ1 / 2))
  return wrap360(Math.atan2(dλ, dψ) * RAD)
}

// ------------------------------------------------- local tangent plane (fast)

/**
 * A local flat projection anchored at `origin`. Accurate to well under a metre
 * within ~20 nm, and roughly 40x cheaper than great-circle math — which is why
 * the start line and buoy-racing code all run in here.
 */
export class LocalFrame {
  readonly origin: LatLon
  private readonly cosLat: number

  constructor(origin: LatLon) {
    this.origin = origin
    this.cosLat = Math.cos(origin.lat * DEG)
  }

  toXY(p: LatLon): XY {
    return {
      x: wrap180(p.lon - this.origin.lon) * DEG * this.cosLat * R_NM,
      y: (p.lat - this.origin.lat) * DEG * R_NM,
    }
  }

  toLatLon(p: XY): LatLon {
    return {
      lat: this.origin.lat + (p.y / R_NM) * RAD,
      lon: wrap180(this.origin.lon + (p.x / (R_NM * this.cosLat)) * RAD),
    }
  }
}

// ---------------------------------------------------------------- vectors

export function vecAdd(a: XY, b: XY): XY {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function vecSub(a: XY, b: XY): XY {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function vecLen(a: XY): number {
  return Math.hypot(a.x, a.y)
}

export function vecScale(a: XY, k: number): XY {
  return { x: a.x * k, y: a.y * k }
}

export function vecDot(a: XY, b: XY): number {
  return a.x * b.x + a.y * b.y
}

/** Bearing (degrees true) of a local-frame vector. */
export function vecBearing(a: XY): Degrees {
  return wrap360(Math.atan2(a.x, a.y) * RAD)
}

/** Local-frame vector from a bearing and a magnitude. */
export function fromPolar(brg: Degrees, mag: number): XY {
  const θ = brg * DEG
  return { x: Math.sin(θ) * mag, y: Math.cos(θ) * mag }
}

/**
 * Intersection of two rays p1 + t·d1 and p2 + s·d2 (local frame).
 * Returns null if parallel. `t` and `s` are the ray parameters, which the
 * caller usually wants to test for >= 0.
 */
export function rayIntersect(
  p1: XY,
  d1: XY,
  p2: XY,
  d2: XY,
): { point: XY; t: number; s: number } | null {
  const den = d1.x * d2.y - d1.y * d2.x
  if (Math.abs(den) < 1e-12) return null
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const t = (dx * d2.y - dy * d2.x) / den
  const s = (dx * d1.y - dy * d1.x) / den
  return { point: { x: p1.x + d1.x * t, y: p1.y + d1.y * t }, t, s }
}

/**
 * Signed perpendicular distance from `p` to the infinite line through a and b
 * (local frame). **Positive on the RIGHT looking from a toward b** — the same
 * sense as `crossTrack`, so cross-track error is positive to starboard of the
 * intended track throughout the codebase.
 */
export function signedDistanceToLine(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  return ((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len
}

/** Do segments p1p2 and p3p4 intersect? Used for the land-crossing test. */
export function segmentsIntersect(
  p1: XY,
  p2: XY,
  p3: XY,
  p4: XY,
): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x)
  if (Math.abs(d) < 1e-15) return false
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

/** Bounding box of a set of points, padded by `padNm`. */
export function bboxOf(points: LatLon[], padNm = 0) {
  let west = 180
  let east = -180
  let south = 90
  let north = -90
  for (const p of points) {
    if (p.lon < west) west = p.lon
    if (p.lon > east) east = p.lon
    if (p.lat < south) south = p.lat
    if (p.lat > north) north = p.lat
  }
  const padLat = padNm / 60
  const midLat = (north + south) / 2
  const padLon = padNm / (60 * Math.max(0.1, Math.cos(midLat * DEG)))
  return {
    west: west - padLon,
    south: Math.max(-89.9, south - padLat),
    east: east + padLon,
    north: Math.min(89.9, north + padLat),
  }
}
